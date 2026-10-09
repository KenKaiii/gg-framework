import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CHECKLIST_FILE } from "../core/checklist-items.js";
import { readGitState } from "../core/checklist-git.js";
import { createChecklistTool, type ChecklistToolDeps } from "./checklist.js";

const NOW = new Date("2026-10-05T09:12:44.000Z");

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-checklist-tool-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function git(...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    { cwd: root, encoding: "utf-8" },
  ).trim();
}

async function initRepo(): Promise<string> {
  git("init", "--quiet");
  await fs.writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
  git("add", "a.ts");
  git("commit", "--quiet", "-m", "init");
  return git("rev-parse", "--short", "HEAD");
}

function harness(deps: ChecklistToolDeps = {}) {
  const tool = createChecklistTool(root, { now: () => NOW, ...deps });
  const call = (args: unknown, signal = new AbortController().signal): Promise<string> =>
    Promise.resolve(
      tool.execute(tool.parameters.parse(args), {
        signal,
        toolCallId: "c1",
      } as never),
    ) as Promise<string>;
  return { tool, call };
}

async function readRecord(): Promise<{ items: Record<string, Record<string, unknown>> }> {
  return JSON.parse(await fs.readFile(path.join(root, CHECKLIST_FILE), "utf-8")) as {
    items: Record<string, Record<string, unknown>>;
  };
}

const passArgs = {
  action: "record",
  id: "quality-tools",
  result: "pass",
  summary: "Lint, format and types all pass.",
  evidence: ["pnpm lint — 0 errors"],
};

describe("checklist tool", () => {
  it("allows completed checks from normal chat without initiating extra audits", () => {
    const { tool } = harness();
    expect(tool.description).toContain("checks requested in normal chat");
    expect(tool.description).toContain("never start extra audits unasked");
    expect(tool.description).not.toContain("Only use during checklist runs");
  });

  it("tells the agent to re-record an item after fixing its findings", () => {
    const { tool } = harness();
    expect(tool.description).toContain("After fixing an item's recorded findings");
    expect(tool.description).toContain("record that item again");
    expect(tool.description).toContain(
      "Findings the user explicitly chose to leave go in `accepted`",
    );
  });

  it("stamps the date from the clock and the commit from HEAD", async () => {
    const head = await initRepo();
    const { call } = harness();

    const out = await call(passArgs);

    expect(out).toBe(`Recorded Lint, format & type checks: pass on 2026-10-05 at ${head}.`);
    const record = await readRecord();
    expect(record.items["quality-tools"]).toEqual({
      checkedAt: NOW.toISOString(),
      commit: head,
      uncommittedChanges: false,
      result: "pass",
      summary: "Lint, format and types all pass.",
      findings: [],
      evidence: ["pnpm lint — 0 errors"],
    });
  });

  it("notes uncommitted changes but ignores its own record file", async () => {
    await initRepo();
    const { call } = harness();
    await call(passArgs);
    expect((await readRecord()).items["quality-tools"]?.uncommittedChanges).toBe(false);

    await fs.writeFile(path.join(root, "a.ts"), "export const a = 2;\n");
    const out = await call({ ...passArgs, id: "tests" });

    expect(out).toContain("(with uncommitted changes)");
    expect((await readRecord()).items.tests?.uncommittedChanges).toBe(true);
  });

  it("reports dirty files before the first Git commit", async () => {
    git("init", "--quiet");
    await fs.writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
    expect(await readGitState(root)).toEqual({ commit: null, uncommittedChanges: true });
  });

  it("does not record after cancellation or a failed Git lookup", async () => {
    const controller = new AbortController();
    const cancelled = harness({
      gitState: async () => {
        controller.abort();
        return { commit: null, uncommittedChanges: false };
      },
    });
    expect(await cancelled.call(passArgs, controller.signal)).toContain("cancelled");
    const failed = harness({
      gitState: async () => {
        throw new Error("git unavailable");
      },
    });
    expect(await failed.call(passArgs)).toContain("Could not read Git state");
    await expect(fs.access(path.join(root, CHECKLIST_FILE))).rejects.toThrow();
  });

  it("keeps records from independent sessions of the same project", async () => {
    const deps: ChecklistToolDeps = {
      gitState: async () => ({ commit: null, uncommittedChanges: false }),
    };
    const first = harness(deps);
    const second = harness(deps);
    await Promise.all([first.call(passArgs), second.call({ ...passArgs, id: "tests" })]);
    expect(Object.keys((await readRecord()).items)).toEqual(["quality-tools", "tests"]);
  });

  it("records commit null outside a Git repo", async () => {
    expect(await readGitState(root)).toEqual({ commit: null, uncommittedChanges: false });
    const { call } = harness();
    expect(await call(passArgs)).toBe("Recorded Lint, format & type checks: pass on 2026-10-05.");
    expect((await readRecord()).items["quality-tools"]?.commit).toBeNull();
  });

  it.each([
    ["an unknown id", { ...passArgs, id: "made-up" }],
    ["no evidence", { ...passArgs, evidence: [] }],
    ["a missing summary", { ...passArgs, summary: "" }],
    ["blank summary", { ...passArgs, summary: "  \n\t" }],
    ["blank evidence", { ...passArgs, evidence: [" \t"] }],
    ["blank findings", { ...passArgs, result: "issues", findings: [" \n"] }],
  ])("rejects %s", (_label, args) => {
    const { tool } = harness();
    expect(tool.parameters.safeParse(args).success).toBe(false);
  });

  it("drops a model-supplied date or commit", async () => {
    const { call } = harness({
      gitState: async () => ({ commit: "abc1234", uncommittedChanges: false }),
    });

    await call({ ...passArgs, checkedAt: "1999-01-01T00:00:00.000Z", commit: "deadbeef" });

    expect((await readRecord()).items["quality-tools"]).toMatchObject({
      checkedAt: NOW.toISOString(),
      commit: "abc1234",
    });
  });

  it("passes with findings the user chose to leave, and lists them in status", async () => {
    const { call } = harness({
      gitState: async () => ({ commit: null, uncommittedChanges: false }),
    });
    const accepted = ["MED core/agent-session.ts: god file (deferred by owner)"];

    const out = await call({ ...passArgs, accepted });

    expect(out).toBe(
      "Recorded Lint, format & type checks: pass with 1 accepted as is on 2026-10-05.",
    );
    expect((await readRecord()).items["quality-tools"]?.accepted).toEqual(accepted);
    const status = await call({ action: "status" });
    expect(status).toContain(
      "quality-tools — Lint, format & type checks: reviewed, 1 accepted as is",
    );
    expect(await call({ ...passArgs, id: "docs", result: "not-applicable", accepted })).toMatch(
      /^Error: .*cannot have accepted findings/,
    );
  });

  it("rejects issues without findings and pass with findings", async () => {
    const { call } = harness({
      gitState: async () => ({ commit: null, uncommittedChanges: false }),
    });

    expect(await call({ ...passArgs, result: "issues" })).toMatch(/^Error: .*at least one finding/);
    expect(await call({ ...passArgs, findings: ["a.ts:1 — bad"] })).toMatch(
      /^Error: .*cannot have findings/,
    );
    await expect(fs.access(path.join(root, CHECKLIST_FILE))).rejects.toThrow();
  });

  it("keeps both entries when two records run at once", async () => {
    const { call } = harness({
      gitState: async () => ({ commit: "abc1234", uncommittedChanges: false }),
    });

    await Promise.all([
      call(passArgs),
      call({
        ...passArgs,
        id: "security",
        result: "issues",
        findings: ["x.ts:1 — no auth (high)"],
      }),
    ]);

    expect(Object.keys((await readRecord()).items)).toEqual(["quality-tools", "security"]);
  });

  it("status lists every item with its state", async () => {
    const { call } = harness({
      gitState: async () => ({ commit: "abc1234", uncommittedChanges: false }),
    });
    await call(passArgs);

    const out = await call({ action: "status" });

    expect(out.split("\n")[0]).toBe("24 project checks. Setup detection is not a passing review.");
    expect(out).toContain(
      "- quality-tools — Lint, format & type checks: reviewed, checked 2026-10-05 at abc1234",
    );
    expect(out).toContain("- security — Security audit: never run, —");
  });

  it("status flags findings recorded before the code changed", async () => {
    let head = "abc1234";
    const { call } = harness({
      gitState: async () => ({ commit: head, uncommittedChanges: false }),
    });
    await call({ ...passArgs, id: "security", result: "issues", findings: ["x.ts:1 — bad"] });
    await call(passArgs);
    head = "def5678";

    const out = await call({ action: "status" });

    expect(out).toContain(
      "- security — Security audit: needs work, checked 2026-10-05 at abc1234, code changed since this check",
    );
    expect(out).toContain(
      "- quality-tools — Lint, format & type checks: reviewed, checked 2026-10-05 at abc1234\n",
    );
  });

  it("status reports a corrupt record instead of hiding it", async () => {
    await fs.writeFile(path.join(root, CHECKLIST_FILE), "{ nope");
    const { call } = harness();
    expect(await call({ action: "status" })).toMatch(/^Error: .*not valid JSON/);
  });
});
