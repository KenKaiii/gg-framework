/**
 * What the USER sees when the verification gate fires.
 *
 * The gate's follow-up is hidden (provenance `completion_gate`), so the only
 * things a client can render around it are the `hook` notice and the
 * `hook_armed` hold. Without both, an injection reads as the agent posting two
 * unexplained final answers in a row. This test pins the emitted event
 * sequence, which is the whole of the flow a UI can act on.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { Message } from "@kenkaiiii/gg-ai";
import { useFakeHome } from "../test-support/fake-home.js";
import type { AgentEvent } from "@kenkaiiii/gg-agent";
import type { AgentSession } from "./agent-session.js";
import type { ProcessManager } from "./process-manager.js";
import { buildKenAutopilotContext } from "./ken-context.js";
import type { VerificationEvidence } from "./verification-evidence.js";
import { createBashTool, REVIEW_REJECTED_BEFORE_START } from "../tools/bash.js";

interface FlowInternals {
  sessionPath: string;
  resetHookState(originalRequest: string): void;
  processManager: ProcessManager;
  getHookFollowUpMessages(): Promise<Message[] | null>;
  getVerificationProblem(): string | null;
  getVerificationEvidence(): VerificationEvidence[];
  trackHookEvent(event: AgentEvent): Promise<void>;
  eventBus: {
    on(event: string, handler: (data: Record<string, unknown>) => void): () => void;
  };
}

let restoreHome: (() => void) | undefined;
let tmpHome: string;
let tmpProject: string;
let session: AgentSession | undefined;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gg-verify-flow-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "gg-verify-flow-"));
  restoreHome = useFakeHome(tmpHome);
  await fs.mkdir(path.join(tmpHome, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(tmpHome, ".gg", "auth.json"),
    JSON.stringify({
      anthropic: {
        accessToken: "test-token",
        refreshToken: "test-refresh",
        expiresAt: Date.now() + 3_600_000,
      },
    }),
    "utf-8",
  );
});

afterEach(async () => {
  await session?.dispose();
  session = undefined;
  restoreHome?.();
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
});

/** Records the client-visible event stream in emission order. */
async function makeSession(
  transient = true,
  sessionId?: string,
): Promise<{ internal: FlowInternals; events: string[] }> {
  const { AgentSession: Session } = await import("./agent-session.js");
  session = new Session({
    provider: "anthropic",
    model: "claude-test",
    cwd: tmpProject,
    transient,
    sessionId,
    systemPrompt: "test",
  });
  await session.initialize();
  const internal = session as unknown as FlowInternals;
  const events: string[] = [];
  internal.eventBus.on("hook", (d) => events.push(`hook:${String(d.kind)}`));
  internal.eventBus.on("hook_armed", (d) =>
    events.push(`hook_armed:${String(d.kind)}:${String(d.armed)}`),
  );
  return { internal, events };
}

async function simulateToolCall(
  internal: FlowInternals,
  name: string,
  args: Record<string, unknown>,
  result = name === "bash" ? "Exit code: 0\n" : "",
): Promise<void> {
  const toolCallId = `call-${Math.random().toString(36).slice(2)}`;
  await internal.trackHookEvent({
    type: "tool_call_start",
    toolCallId,
    name,
    args,
  } as unknown as AgentEvent);
  await internal.trackHookEvent({
    type: "tool_call_end",
    toolCallId,
    result,
    isError: false,
    durationMs: 1,
  } as unknown as AgentEvent);
}

async function prepareBuildProject(build: string): Promise<void> {
  execFileSync("git", ["init", "--quiet"], { cwd: tmpProject });
  await fs.writeFile(path.join(tmpProject, ".gitignore"), "dist/\n");
  await fs.writeFile(path.join(tmpProject, "subject.mjs"), "export const value = 1;\n");
  await fs.writeFile(
    path.join(tmpProject, "verification.test.mjs"),
    "import assert from 'node:assert/strict'; import {value} from './subject.mjs'; assert.equal(value, 1);\n",
  );
  await fs.writeFile(path.join(tmpProject, "build.mjs"), build);
  await fs.writeFile(
    path.join(tmpProject, "package.json"),
    JSON.stringify({
      scripts: {
        check: "node --test verification.test.mjs",
        build: "node build.mjs",
      },
    }),
  );
}

async function runRealCheck(
  internal: FlowInternals,
  command: string,
  background = false,
  poll = true,
): Promise<void> {
  const toolCallId = `real-${Math.random()}`;
  await internal.trackHookEvent({
    type: "tool_call_start",
    toolCallId,
    name: "bash",
    args: { command, run_in_background: background },
  } as AgentEvent);
  const proc = await internal.processManager.start(command, tmpProject);
  if (background) {
    await internal.trackHookEvent({
      type: "tool_call_end",
      toolCallId,
      result: `ID: ${proc.id}\n`,
      isError: false,
      durationMs: 1,
    } as AgentEvent);
  }
  expect(await internal.processManager.waitForExitOrWake(proc.id, 30_000)).toBe("exited");
  if (background) {
    if (poll) await simulateToolCall(internal, "task_output", { id: proc.id });
  } else {
    const exitCode = internal.processManager.list().find((p) => p.id === proc.id)!.exitCode;
    await internal.trackHookEvent({
      type: "tool_call_end",
      toolCallId,
      result: `Exit code: ${exitCode}\n`,
      isError: exitCode !== 0,
      durationMs: 1,
    } as AgentEvent);
  }
}

const artifactBuild =
  "import fs from 'node:fs'; fs.mkdirSync('dist', {recursive:true}); fs.writeFileSync('dist/app.js', 'generated');\n";

describe("verification gate flow", () => {
  it.each([
    { review: true, result: `Exit code: 1\n${REVIEW_REJECTED_BEFORE_START}` },
    { review: false, result: REVIEW_REJECTED_BEFORE_START },
  ])(
    "never treats check output or another execution mode as a review rejection: %j",
    async ({ review, result }) => {
      const { internal } = await makeSession();
      await simulateToolCall(internal, "edit", { file_path: "subject.mjs" });
      await simulateToolCall(internal, "bash", { command: "npm run check", review }, result);
      expect(internal.getVerificationEvidence()).toContainEqual(
        expect.objectContaining({ command: "npm run check", status: "failed" }),
      );
      expect(internal.getVerificationProblem()).toContain("failed");
    },
  );

  it.each([false, true])(
    "treats a rejected review as not-run without clearing actual failures (prior failure=%s)",
    async (priorFailure) => {
      await prepareBuildProject(artifactBuild);
      const { internal } = await makeSession();
      await simulateToolCall(internal, "edit", { file_path: "subject.mjs" });
      if (priorFailure) {
        await fs.writeFile(path.join(tmpProject, "subject.mjs"), "export const value = 2;\n");
        await runRealCheck(internal, "npm run check");
      }
      const tool = createBashTool(tmpProject, internal.processManager);
      const invoke = async (command: string): Promise<void> => {
        const toolCallId = `review-${command}`;
        const args = { command, review: true };
        await internal.trackHookEvent({
          type: "tool_call_start",
          toolCallId,
          name: "bash",
          args,
        } as AgentEvent);
        const result = await tool.execute(args, {
          signal: new AbortController().signal,
          toolCallId,
        });
        expect(typeof result).toBe("string");
        if (typeof result !== "string") throw new Error("Expected string result");
        await internal.trackHookEvent({
          type: "tool_call_end",
          toolCallId,
          result,
          isError: false,
          durationMs: 1,
        } as AgentEvent);
      };
      const rejected = "npm run check && git diff --check";
      await invoke(rejected);
      expect(internal.getVerificationEvidence()).toContainEqual(
        expect.objectContaining({ command: rejected, status: "rejected" }),
      );
      expect(internal.getVerificationProblem()).not.toBeNull();

      if (priorFailure) {
        await runRealCheck(internal, "npm run build");
        expect(internal.getVerificationProblem()).toContain("failed");
      } else {
        await invoke("npm run check");
        expect(internal.getVerificationProblem()).toBeNull();
        expect(internal.getVerificationEvidence()).toContainEqual(
          expect.objectContaining({ command: "npm run check", status: "passed" }),
        );
      }
    },
  );

  it.each([true, false])(
    "keeps real check results out of the next read-only turn (passed=%s)",
    async (passed) => {
      const { internal } = await makeSession();
      await prepareBuildProject("");
      if (!passed)
        await fs.writeFile(path.join(tmpProject, "subject.mjs"), "export const value = 2;\n");
      await runRealCheck(internal, "npm run check");
      expect(
        session!
          .getRunVerificationActivity()
          .evidence.some((entry) => entry.status === (passed ? "passed" : "failed")),
      ).toBe(true);
      const problem = internal.getVerificationProblem();
      const evidence = internal.getVerificationEvidence();
      internal.resetHookState("Explain what you found. Do not edit anything.");
      await simulateToolCall(internal, "read", { file_path: "subject.mjs" });
      expect(session!.getRunVerificationActivity()).toEqual({
        changed: false,
        checked: false,
        evidence: [],
      });
      expect(internal.getVerificationProblem()).toBe(problem);
      expect(internal.getVerificationEvidence()).toEqual(evidence);
    },
  );
  it.each([false, true])(
    "preserves earlier verification after a mixed check/help chain (background=%s)",
    async (background) => {
      await prepareBuildProject(artifactBuild);
      const { internal } = await makeSession();
      await simulateToolCall(internal, "edit", { file_path: "subject.mjs" });
      await runRealCheck(internal, "npm run check");
      const command = "npm run check && node build.mjs --help";
      await runRealCheck(internal, command, background, false);
      expect(await internal.getHookFollowUpMessages()).toBeNull();
      expect(internal.getVerificationProblem()).toBeNull();
      expect(internal.getVerificationEvidence()).not.toContainEqual(
        expect.objectContaining({ command, status: "passed" }),
      );
    },
  );

  it("requires fresh verification when a mixed chain cannot compare workspace inputs", async () => {
    const { internal } = await makeSession();
    await simulateToolCall(internal, "edit", { file_path: "subject.mjs" });
    await simulateToolCall(internal, "bash", { command: "npm run check" });
    expect(internal.getVerificationProblem()).toBeNull();
    await simulateToolCall(internal, "bash", {
      command: "npm run check && node script.mjs --help",
    });
    expect(internal.getVerificationProblem()).not.toBeNull();
  });

  it("does not turn a mixed check/help chain into fresh verification", async () => {
    await prepareBuildProject(artifactBuild);
    const { internal } = await makeSession();
    await simulateToolCall(internal, "edit", { file_path: "subject.mjs" });
    await runRealCheck(internal, "npm run check && node build.mjs --help");
    expect(internal.getVerificationProblem()).not.toBeNull();
  });

  it.each([
    ["failure", "process.exit(1);"],
    [
      "source mutation",
      "import fs from 'node:fs'; fs.writeFileSync('subject.mjs', 'export const value = 2;');",
    ],
  ])("keeps a mixed check/help chain unverified after %s", async (_label, script) => {
    await prepareBuildProject(script);
    const { internal } = await makeSession();
    await simulateToolCall(internal, "edit", { file_path: "subject.mjs" });
    await runRealCheck(internal, "npm run check");
    await runRealCheck(internal, "npm run check && node build.mjs --help");
    expect(internal.getVerificationProblem()).not.toBeNull();
  });
  it("collects a completed background build/check without demanding a polling turn", async () => {
    await prepareBuildProject(artifactBuild);
    const { internal, events } = await makeSession();
    await simulateToolCall(internal, "edit", { file_path: "subject.mjs" });
    await runRealCheck(internal, "npm run check && npm run build", true, false);
    expect(await internal.getHookFollowUpMessages()).toBeNull();
    expect(internal.getVerificationProblem()).toBeNull();
    expect(events.filter((event) => event.startsWith("hook:"))).toEqual([]);
    expect(internal.getVerificationEvidence()).toContainEqual(
      expect.objectContaining({ status: "passed" }),
    );
  });

  it("collects an unread failed background check as a failure, never as success", async () => {
    await prepareBuildProject("process.exit(1);\n");
    const { internal } = await makeSession();
    await simulateToolCall(internal, "edit", { file_path: "subject.mjs" });
    await runRealCheck(internal, "npm run build", true, false);
    await internal.getHookFollowUpMessages();
    expect(internal.getVerificationProblem()).toContain("failed");
    expect(internal.getVerificationEvidence()).toContainEqual(
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("does not repeat verification after a real artifact-only build", async () => {
    await prepareBuildProject(artifactBuild);
    const { internal, events } = await makeSession();
    await simulateToolCall(internal, "edit", { file_path: "subject.mjs" });
    await runRealCheck(internal, "npm run check");
    await runRealCheck(internal, "npm run build");
    expect(await fs.readFile(path.join(tmpProject, "dist/app.js"), "utf8")).toBe("generated");
    expect(internal.getVerificationProblem()).toBeNull();
    expect(await internal.getHookFollowUpMessages()).toBeNull();
    expect(events.filter((e) => e.startsWith("hook:"))).toEqual([]);
  });

  it("accepts a real background check/build chain in both the gate and Ken's digest", async () => {
    await prepareBuildProject(artifactBuild);
    const { internal } = await makeSession();
    await simulateToolCall(internal, "edit", { file_path: "subject.mjs" });
    const command = "npm run check && npm run build";
    await runRealCheck(internal, command, true);
    expect(internal.getVerificationProblem()).toBeNull();
    expect(await internal.getHookFollowUpMessages()).toBeNull();
    const digest = buildKenAutopilotContext({
      cwd: tmpProject,
      gitBranch: null,
      messages: [],
      verificationEvidence: internal.getVerificationEvidence(),
    });
    expect(digest).toContain(`PASSED: \`${command}\``);
  });

  it("still invalidates checks when a real build rewrites source", async () => {
    await prepareBuildProject(
      "import fs from 'node:fs'; fs.writeFileSync('subject.mjs', 'export const value = 2;');\n",
    );
    const { internal } = await makeSession();
    await simulateToolCall(internal, "edit", { file_path: "subject.mjs" });
    await runRealCheck(internal, "npm run check");
    await runRealCheck(internal, "npm run build");
    expect(internal.getVerificationProblem()).toContain("Unverified");
    const digest = buildKenAutopilotContext({
      cwd: tmpProject,
      gitBranch: null,
      messages: [],
      verificationEvidence: internal.getVerificationEvidence(),
    });
    expect(digest).not.toContain("PASSED:");
    await runRealCheck(internal, "npm run check");
    expect(internal.getVerificationProblem()).toContain("failed");
  });

  it("never treats a failed build as verified just because source is unchanged", async () => {
    await prepareBuildProject("process.exit(1);\n");
    const { internal } = await makeSession();
    await simulateToolCall(internal, "edit", { file_path: "subject.mjs" });
    await runRealCheck(internal, "npm run check");
    await runRealCheck(internal, "npm run build", true);
    expect(internal.getVerificationProblem()).toContain("failed");
    expect(internal.getVerificationEvidence()).toContainEqual(
      expect.objectContaining({ command: "npm run build", status: "failed" }),
    );
  });

  it("never forces another turn after an unverified edit, but still reports it", async () => {
    const { internal, events } = await makeSession();

    await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });

    // No hold, no notice, no injected turn: the first final answer is the answer.
    expect(await internal.getHookFollowUpMessages()).toBeNull();
    expect(events).toEqual([]);
    // Evidence stays honest for run status and autopilot.
    expect(internal.getVerificationProblem()).toContain("Unverified");
  });

  it("does not count a code write refused in plan mode as an unverified change", async () => {
    const { internal } = await makeSession();
    await session?.setPlanMode(true);

    await simulateToolCall(
      internal,
      "write",
      { file_path: "src/a.ts" },
      "Error: write is restricted in plan mode. You can only write to .gg/plans/. Got: src/a.ts",
    );

    expect(internal.getVerificationProblem()).toBeNull();
  });

  it("tracks every file of a multi-file edit as needing verification", async () => {
    const { internal } = await makeSession();

    // The `files` form carries no top-level file_path; missing it would let a
    // multi-file change skip verification entirely.
    await simulateToolCall(internal, "edit", {
      files: [
        { file_path: "src/a.ts", edits: [] },
        { file_path: "src/b.ts", edits: [] },
      ],
    });

    expect(internal.getVerificationProblem()).toContain("Unverified");
  });

  it("stays silent end to end when the run verified its own edit", async () => {
    const { internal, events } = await makeSession();

    await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });
    await simulateToolCall(internal, "bash", { command: "cd pkg && npm test" });

    expect(events).toEqual([]);
    expect(internal.getVerificationProblem()).toBeNull();
    expect(await internal.getHookFollowUpMessages()).toBeNull();
  });

  it("accepts the transcript's format-check chain and never asks for a test-edit review", async () => {
    const { internal } = await makeSession();
    const notices: Record<string, unknown>[] = [];
    internal.eventBus.on("hook", (data) => notices.push(data));
    await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });
    await simulateToolCall(internal, "edit", { file_path: "src/a.test.ts" });
    await simulateToolCall(internal, "bash", {
      command: "pnpm check && pnpm lint && pnpm format:check && pnpm test",
    });
    expect(internal.getVerificationProblem()).toBeNull();
    expect(await internal.getHookFollowUpMessages()).toBeNull();
    expect(notices).toEqual([]);
  });

  it("counts a check piped through a tail limiter as passing evidence", async () => {
    const { internal, events } = await makeSession();

    await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });
    await simulateToolCall(
      internal,
      "bash",
      { command: "pnpm test 2>&1 | tail -6" },
      "Exit code: 0\n3 passing",
    );

    expect(internal.getVerificationProblem()).toBeNull();
    expect(await internal.getHookFollowUpMessages()).toBeNull();
    expect(events).toEqual([]);
  });

  it("still rejects piped checks whose stages can transform results", async () => {
    const { internal } = await makeSession();
    await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });
    await simulateToolCall(
      internal,
      "bash",
      { command: "pnpm test | grep -q 'all passed'" },
      "Exit code: 0",
    );
    expect(internal.getVerificationProblem()).toContain("Unverified");
  });

  // Haiku 5.5 runs (2026-10-09) ended "Unverified" on passing suites written as
  // `cat …; npm test | grep …` or `npm test && git diff --stat`. Real processes,
  // real exit codes: they count when they pass, and a grep that merely matches
  // nothing is never recorded as a failed check.
  it.each([
    "cat subject.mjs; npm run check 2>&1 | grep -E 'pass|fail'",
    "npm run check && git status --short",
    "ls && npm run check 2>&1 | tail -3",
  ])("verifies a real passing check with read-only commands around it: %s", async (command) => {
    await prepareBuildProject(artifactBuild);
    execFileSync("git", ["add", "."], { cwd: tmpProject });
    const { internal } = await makeSession();
    await simulateToolCall(internal, "edit", { file_path: "subject.mjs" });

    // processManager runs commands through resolveShell, i.e. bash -o pipefail.
    await runRealCheck(internal, command);

    expect(internal.getVerificationProblem()).toBeNull();
  });

  it("never counts a real failing check piped through grep as verified", async () => {
    await prepareBuildProject(artifactBuild);
    await fs.writeFile(path.join(tmpProject, "subject.mjs"), "export const value = 2;\n");
    const { internal } = await makeSession();
    await simulateToolCall(internal, "edit", { file_path: "subject.mjs" });

    await runRealCheck(internal, "npm run check 2>&1 | grep -c fail");

    expect(internal.getVerificationProblem()).toContain("Unverified");
  });

  it("does not treat a nonzero bash exit as passing merely because the tool returned normally", async () => {
    const { internal } = await makeSession();
    await simulateToolCall(internal, "edit", { file_path: "src/foo.ts" });
    await simulateToolCall(internal, "bash", { command: "pnpm test" }, "Exit code: 1\nfailed");
    expect(internal.getVerificationProblem()).toContain("failed");
    await simulateToolCall(internal, "bash", { command: "pnpm lint" });
    expect(internal.getVerificationProblem()).toContain("failed");
    await simulateToolCall(internal, "bash", { command: "pnpm test" });
    expect(internal.getVerificationProblem()).toBeNull();
  });

  it("does not accept claimed success or a shell command that can mask failure", async () => {
    const { internal } = await makeSession();
    await simulateToolCall(internal, "edit", { file_path: "src/foo.ts" });
    await simulateToolCall(internal, "bash", { command: "pnpm test" }, "All tests passed!");
    expect(internal.getVerificationProblem()).toContain("Unverified");
    await simulateToolCall(internal, "bash", { command: "pnpm test || true" });
    expect(internal.getVerificationProblem()).toContain("Unverified");
    await simulateToolCall(internal, "bash", { command: "node script.js --test" });
    expect(internal.getVerificationProblem()).toContain("Unverified");
  });

  it("invalidates an earlier check when a later check can rewrite files", async () => {
    const { internal } = await makeSession();
    await simulateToolCall(internal, "edit", { file_path: "src/foo.ts" });
    await internal.trackHookEvent({
      type: "tool_call_start",
      toolCallId: "before-fix",
      name: "bash",
      args: { command: "pnpm test" },
    } as unknown as AgentEvent);
    await simulateToolCall(internal, "bash", { command: "pnpm eslint --fix src/foo.ts" });
    await internal.trackHookEvent({
      type: "tool_call_end",
      toolCallId: "before-fix",
      result: "Exit code: 0\n",
      isError: false,
      durationMs: 1,
    } as unknown as AgentEvent);
    expect(internal.getVerificationProblem()).toContain("Unverified");
    await simulateToolCall(internal, "bash", { command: "pnpm test" });
    expect(internal.getVerificationProblem()).toBeNull();
  });

  it("does not let a check finishing after an intervening edit verify that edit", async () => {
    const { internal } = await makeSession();
    await simulateToolCall(internal, "edit", { file_path: "src/foo.ts" });
    await internal.trackHookEvent({
      type: "tool_call_start",
      toolCallId: "stale",
      name: "bash",
      args: { command: "pnpm test" },
    } as unknown as AgentEvent);
    await simulateToolCall(internal, "edit", { file_path: "src/foo.ts" });
    await internal.trackHookEvent({
      type: "tool_call_end",
      toolCallId: "stale",
      result: "Exit code: 0\n",
      isError: false,
      durationMs: 1,
    } as unknown as AgentEvent);
    expect(internal.getVerificationProblem()).toContain("Unverified");
    await simulateToolCall(internal, "bash", { command: "pnpm test" });
    expect(internal.getVerificationProblem()).toBeNull();
  });

  it("uses real background exit codes and never reuses old output after another edit", async () => {
    const { internal } = await makeSession();
    await fs.writeFile(path.join(tmpProject, "subject.mjs"), "export const value = 0;\n");
    await fs.writeFile(
      path.join(tmpProject, "verification.test.mjs"),
      "import assert from 'node:assert/strict'; import {value} from './subject.mjs'; assert.equal(value, 1);\n",
    );
    await simulateToolCall(internal, "edit", { file_path: "subject.mjs" });
    const command = "node --test verification.test.mjs";
    const check = async () => {
      const started = await internal.processManager.start(command, tmpProject);
      await simulateToolCall(
        internal,
        "bash",
        { command, run_in_background: true },
        `ID: ${started.id}\n`,
      );
      expect(internal.getVerificationProblem()).toContain("Unverified");
      expect(await internal.processManager.waitForExitOrWake(started.id, 5000)).toBe("exited");
      await simulateToolCall(internal, "task_output", { id: started.id });
      return started.id;
    };
    await check();
    expect(internal.getVerificationProblem()).toContain("failed");
    await fs.writeFile(path.join(tmpProject, "subject.mjs"), "export const value = 1;\n");
    await simulateToolCall(internal, "edit", { file_path: "subject.mjs" });
    const passedId = await check();
    expect(internal.getVerificationProblem()).toBeNull();
    await fs.writeFile(path.join(tmpProject, "subject.mjs"), "export const value = 2;\n");
    await simulateToolCall(internal, "edit", { file_path: "subject.mjs" });
    await simulateToolCall(internal, "task_output", { id: passedId });
    expect(internal.getVerificationProblem()).toContain("Unverified");
  });

  it("recognizes a real background npm test after a git status prelude", async () => {
    const { internal } = await makeSession();
    execFileSync("git", ["init", "--quiet"], { cwd: tmpProject });
    await fs.writeFile(
      path.join(tmpProject, "package.json"),
      JSON.stringify({ scripts: { test: "node --test verification.test.mjs" } }),
    );
    await fs.writeFile(
      path.join(tmpProject, "verification.test.mjs"),
      "import assert from 'node:assert/strict'; assert.equal(1 + 1, 2);\n",
    );
    await simulateToolCall(internal, "edit", { file_path: "verification.test.mjs" });
    const command = "git status --short && npm run test";
    const started = await internal.processManager.start(command, tmpProject);
    await simulateToolCall(
      internal,
      "bash",
      { command, run_in_background: true },
      `ID: ${started.id}\n`,
    );
    expect(internal.getVerificationProblem()).toContain("Unverified");
    // The npm chain (npm.cmd → node → npm → script) cold-starts far slower on a
    // loaded Windows CI runner than the 5s cap used for direct `node --test`
    // runs — waitForExitOrWake still returns the instant the process exits, this only
    // raises the hang ceiling so a slow spawn is not misread as a hang.
    expect(await internal.processManager.waitForExitOrWake(started.id, 30_000)).toBe("exited");
    await simulateToolCall(internal, "task_output", { id: started.id });
    expect(internal.getVerificationProblem()).toBeNull();
    const digest = buildKenAutopilotContext({
      cwd: tmpProject,
      gitBranch: null,
      messages: [],
      verificationEvidence: internal.getVerificationEvidence(),
    });
    expect(digest).toContain(`PASSED: \`${command}\``);
    expect(digest).not.toContain("background or persistent commands are not bounded evidence");
  });

  it.each([
    "git status --short && git diff --stat",
    "rm -r scratch.html && git status --short && echo CLEAN",
  ])("does not demand verification after ordinary shell work: %s", async (command) => {
    const { internal } = await makeSession();
    execFileSync("git", ["init", "--quiet"], { cwd: tmpProject });
    await fs.writeFile(path.join(tmpProject, "subject.mjs"), "export const value = 1;\n");
    await simulateToolCall(internal, "bash", { command });
    expect(internal.getVerificationProblem()).toBeNull();
    expect(internal.getVerificationEvidence()).toEqual([]);
  });

  it("persists unresolved verification and requires fresh evidence after resuming", async () => {
    const { internal } = await makeSession(false);
    await simulateToolCall(internal, "edit", { file_path: "subject.ts" });
    await simulateToolCall(internal, "bash", { command: "pnpm test" }, "Exit code: 1\n");
    const saved = internal.sessionPath;
    await session!.dispose();
    const resumed = await makeSession(false, saved);
    expect(resumed.internal.getVerificationProblem()).toContain("failed");
    await simulateToolCall(resumed.internal, "bash", { command: "pnpm test" });
    expect(resumed.internal.getVerificationProblem()).toBeNull();
  });

  it("has notice copy for every hook kind the session can emit", async () => {
    // Both surfaces render from a fixed map keyed by hook kind; a kind with no
    // entry renders nothing at all, which is the silent-duplicate bug again.
    const { VERIFICATION_HOOK_NOTICE_TEXT } = await import("../ui/app-items.js");
    expect(VERIFICATION_HOOK_NOTICE_TEXT).toContain("verification");

    const hookNotice = await fs.readFile(
      path.join(__dirname, "..", "..", "..", "..", "gg-app", "src", "HookNotice.tsx"),
      "utf-8",
    );
    const start = hookNotice.indexOf("export const HOOK_LINES");
    expect(start).toBeGreaterThan(-1);
    const presentation = hookNotice.slice(
      start,
      hookNotice.indexOf("export function describeHook"),
    );
    for (const kind of ["ideal", "verification", "loop_break", "regrounding"]) {
      expect(presentation).toContain(`${kind}: [`);
    }
  });

  it("emits nothing at all when no code was touched", async () => {
    const { internal, events } = await makeSession();

    await simulateToolCall(internal, "read", { file_path: "src/a.ts" });
    await simulateToolCall(internal, "write", { file_path: "README.md" });

    expect(events).toEqual([]);
    expect(await internal.getHookFollowUpMessages()).toBeNull();
  });

  it("never hijacks a work or question turn, even when a check did not count", async () => {
    const { internal, events } = await makeSession();

    await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });
    // `make test` is a real check the evidence classifier cannot vouch for.
    await simulateToolCall(internal, "bash", { command: "make test" });
    expect(internal.getVerificationProblem()).toContain("Unverified");
    expect(await internal.getHookFollowUpMessages()).toBeNull();

    (internal as unknown as { verificationGate: { beginRun(): void } }).verificationGate.beginRun();
    expect(await internal.getHookFollowUpMessages()).toBeNull();
    expect(events).toEqual([]);
  });

  it.each([
    ["an unrecognized check", { command: "npx biome ci ." }],
    ["an unrecognized package check script", { command: "npm run check:local-discovery" }],
    ["a persistent-shell check", { command: "pnpm test", persist: true }],
  ])("does not re-open verified work when %s runs after a passing check", async (_label, args) => {
    // The live incident: edit, `tsc --noEmit` passes, then `biome ci` runs
    // last. Neither its start nor its end can produce evidence, yet the
    // start flagged the workspace unknown and nothing ever cleared it — every
    // later run ended Unverified and autopilot silently refused to review.
    const { internal } = await makeSession();
    await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });
    await simulateToolCall(internal, "bash", { command: "npx tsc --noEmit -p apps/web" });
    expect(internal.getVerificationProblem()).toBeNull();

    await simulateToolCall(internal, "bash", args);

    expect(internal.getVerificationProblem()).toBeNull();
  });

  it("records neither pass nor failure for persistent-shell checks, however they exit", async () => {
    const { internal } = await makeSession();

    await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });
    await simulateToolCall(internal, "bash", { command: "pnpm test", persist: true });
    // Not evidence — but not a FAILED check either: a false failure here
    // poisoned every later green run of a different command spelling.
    expect(internal.getVerificationProblem()).toContain("Unverified");
    expect(internal.getVerificationProblem()).not.toContain("failed");
  });
});
