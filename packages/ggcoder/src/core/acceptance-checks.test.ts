import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatCheckResults,
  parseAcceptanceChecks,
  summarizeCheckResults,
  verifyAcceptanceChecks,
  type AcceptanceCheck,
} from "./acceptance-checks.js";
import { ReceiptRecorder, type ReceiptCall } from "./subagent-receipt.js";

let cwd: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acceptance-"));
  await fs.writeFile(path.join(cwd, "present.ts"), "x");
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

const bash = (target: string, exitCode?: string): ReceiptCall => ({
  name: "bash",
  target,
  outcome: "ok",
  ...(exitCode !== undefined && { exitCode }),
});
const edit = (target: string, outcome: ReceiptCall["outcome"] = "ok"): ReceiptCall => ({
  name: "edit",
  target,
  outcome,
});

function verifyOne(check: AcceptanceCheck, calls: ReceiptCall[]) {
  const [result] = verifyAcceptanceChecks([check], calls, cwd);
  return result;
}

describe("file_exists", () => {
  it.each([
    ["present.ts", "PASS"],
    ["missing.ts", "FAIL"],
  ])("%s → %s", (target, status) => {
    expect(verifyOne({ type: "file_exists", target }, [])?.status).toBe(status);
  });
});

describe("file_changed", () => {
  const check: AcceptanceCheck = { type: "file_changed", target: "src/a.ts" };

  it("passes when the helper edited the file, matching relative and absolute paths", () => {
    expect(verifyOne(check, [edit(path.join(cwd, "src/a.ts"))])?.status).toBe("PASS");
  });

  it("fails when every edit of it failed", () => {
    expect(verifyOne(check, [edit("src/a.ts", "error")])?.status).toBe("FAIL");
  });

  it("fails when nothing could have changed it", () => {
    expect(verifyOne(check, [edit("src/b.ts")])?.status).toBe("FAIL");
  });

  it("is unverified when a shell command might have changed it", () => {
    expect(verifyOne(check, [bash("sed -i s/a/b/ src/a.ts", "0")])?.status).toBe("UNVERIFIED");
  });
});

describe("command_passed", () => {
  const check: AcceptanceCheck = { type: "command_passed", target: "pnpm test" };

  it("passes on a clean last run, ignoring output limiters", () => {
    expect(verifyOne(check, [bash("pnpm test 2>&1 | tail -20", "0")])?.status).toBe("PASS");
  });

  it("judges the LAST run, not the first", () => {
    const calls = [bash("pnpm test", "0"), bash("pnpm test", "1")];
    expect(verifyOne(check, calls)).toMatchObject({
      status: "FAIL",
      reason: "its last run exited 1",
    });
  });

  it("is unverified when files changed after the passing run", () => {
    const calls = [bash("pnpm test", "0"), edit("src/a.ts")];
    expect(verifyOne(check, calls)?.status).toBe("UNVERIFIED");
  });

  it("is unverified when the helper never ran it or it has no exit code", () => {
    expect(verifyOne(check, [bash("pnpm lint", "0")])?.status).toBe("UNVERIFIED");
    expect(verifyOne(check, [bash("pnpm test")])?.status).toBe("UNVERIFIED");
  });

  it("does not count a narrower command as the requested one", () => {
    expect(verifyOne(check, [bash("pnpm test --filter x", "0")])?.status).toBe("UNVERIFIED");
  });

  it("reads exit codes from real bash results through the receipt recorder", () => {
    const recorder = new ReceiptRecorder();
    recorder.start("1", "bash", { command: "pnpm test" });
    recorder.end("1", "Exit code: 0\nok", false);
    expect(verifyOne(check, recorder.snapshot())?.status).toBe("PASS");
  });
});

describe("formatting", () => {
  it("summarizes and lists every check", () => {
    const results = verifyAcceptanceChecks(
      [
        { type: "file_exists", target: "present.ts" },
        { type: "file_exists", target: "missing.ts" },
        { type: "command_passed", target: "pnpm test" },
      ],
      [],
      cwd,
    );
    expect(summarizeCheckResults(results)).toBe("1/3 passed, 1 failed, 1 unverified");
    expect(formatCheckResults(results)).toBe(
      [
        "Acceptance checks (1/3 passed, 1 failed, 1 unverified):",
        "- PASS file_exists present.ts: it exists",
        "- FAIL file_exists missing.ts: it does not exist",
        "- UNVERIFIED command_passed `pnpm test`: the helper never ran it",
      ].join("\n"),
    );
  });

  it("renders nothing without checks", () => {
    expect(formatCheckResults([])).toBe("");
  });
});

describe("parseAcceptanceChecks", () => {
  it("drops malformed input instead of throwing", () => {
    expect(parseAcceptanceChecks(undefined)).toEqual([]);
    expect(parseAcceptanceChecks([{ type: "rm_rf", target: "/" }])).toEqual([]);
    expect(parseAcceptanceChecks([{ type: "file_exists", target: "a" }])).toEqual([
      { type: "file_exists", target: "a" },
    ]);
  });
});
