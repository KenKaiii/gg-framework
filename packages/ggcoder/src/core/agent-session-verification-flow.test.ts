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

interface FlowInternals {
  sessionPath: string;
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

  it("arms before the draft streams, then announces itself when it injects", async () => {
    const { internal, events } = await makeSession();

    // Work: one code edit, nothing run since.
    await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });

    // Arming must land on the tool call — i.e. BEFORE the model writes the
    // candidate final answer — or the client has already painted the draft it
    // is about to replace.
    expect(events).toContain("hook_armed:verification:true");
    expect(events.indexOf("hook_armed:verification:true")).toBe(0);

    // The stop: the gate injects, and says so.
    const followUp = await internal.getHookFollowUpMessages();
    expect(followUp).not.toBeNull();
    expect(String(followUp![0]!.content)).toContain("Run the project's verification");
    expect(events).toEqual([
      "hook_armed:verification:true",
      "hook:verification",
      // Disarm AFTER the notice: clients release held text on disarm, so the
      // reverse order paints the draft and then deletes it.
      "hook_armed:verification:false",
    ]);

    // One notice, one injection: the reviewed answer that follows streams live
    // and is the only final answer the user sees.
    expect(await internal.getHookFollowUpMessages()).toBeNull();
    expect(events.filter((e) => e === "hook:verification")).toHaveLength(1);
  });

  it("stays silent end to end when the run verified its own edit", async () => {
    const { internal, events } = await makeSession();

    await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });
    await simulateToolCall(internal, "bash", { command: "cd pkg && npm test" });

    // Disarmed by the verification, so no draft is ever held back.
    expect(events).toEqual(["hook_armed:verification:true", "hook_armed:verification:false"]);
    expect(await internal.getHookFollowUpMessages()).toBeNull();
  });

  it("accepts the transcript's format-check chain and only requests an internal test review", async () => {
    const { internal } = await makeSession();
    const notices: Record<string, unknown>[] = [];
    internal.eventBus.on("hook", (data) => notices.push(data));
    await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });
    await simulateToolCall(internal, "edit", { file_path: "src/a.test.ts" });
    await simulateToolCall(internal, "bash", {
      command: "pnpm check && pnpm lint && pnpm format:check && pnpm test",
    });
    expect(internal.getVerificationProblem()).toBeNull();
    const followUp = await internal.getHookFollowUpMessages();
    expect(followUp).toHaveLength(1);
    expect(String(followUp![0]!.content)).toContain("review them internally");
    expect(String(followUp![0]!.content)).toContain("task outcome");
    expect(String(followUp![0]!.content)).not.toContain("Run the project's verification");
    expect(notices).toEqual([{ kind: "verification", verificationReason: "check_review" }]);
    expect(await internal.getHookFollowUpMessages()).toBeNull();
  });

  it("combines test review with verification and does not interrupt the corrected final again", async () => {
    const { internal, events } = await makeSession();
    await simulateToolCall(internal, "edit", { file_path: "src/a.test.ts" });
    const followUp = await internal.getHookFollowUpMessages();
    expect(followUp).toHaveLength(2);
    expect(String(followUp![1]!.content)).toContain("src/a.test.ts");
    await simulateToolCall(internal, "bash", { command: "pnpm test" });
    expect(internal.getVerificationProblem()).toBeNull();
    expect(await internal.getHookFollowUpMessages()).toBeNull();
    expect(events.filter((e) => e === "hook:verification")).toHaveLength(1);
  });

  it("counts a check piped through a tail limiter, so a question turn is never hijacked", async () => {
    const { internal, events } = await makeSession();

    await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });
    // The agent-habit shape that caused the real-world incident: green suite,
    // output piped through tail. Pre-pipefail this was rejected as evidence,
    // the gate stayed armed past the turn, and the NEXT turn — a plain user
    // question — had its draft held, discarded, and replaced by the hook
    // notice. With pipefail + the limiter rule it is ordinary passing evidence.
    await simulateToolCall(
      internal,
      "bash",
      { command: "pnpm test 2>&1 | tail -6" },
      "Exit code: 0\n3 passing",
    );

    expect(internal.getVerificationProblem()).toBeNull();
    expect(await internal.getHookFollowUpMessages()).toBeNull();
    expect(events).toEqual(["hook_armed:verification:true", "hook_armed:verification:false"]);
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

    const appEvents = await fs.readFile(
      path.join(__dirname, "..", "..", "..", "..", "gg-app", "src", "useAgentEvents.ts"),
      "utf-8",
    );
    const presentation = appEvents.slice(
      appEvents.indexOf("HOOK_PRESENTATION"),
      appEvents.indexOf("function formatElapsed"),
    );
    for (const kind of ["ideal", "verification", "loop_break", "regrounding"]) {
      expect(presentation).toContain(`${kind}: {`);
    }
  });

  it("emits nothing at all when no code was touched", async () => {
    const { internal, events } = await makeSession();

    await simulateToolCall(internal, "read", { file_path: "src/a.ts" });
    await simulateToolCall(internal, "write", { file_path: "README.md" });

    expect(events).toEqual([]);
    expect(await internal.getHookFollowUpMessages()).toBeNull();
  });

  it("answers later question turns instead of re-hijacking them with the verification hook", async () => {
    // The live incident, replayed against the real session: code edited, the
    // check the agent actually ran did not count as evidence, and EVERY later
    // prompt — plain questions included — was answered by "Hook engaged"
    // plus a verification status instead of the user's question.
    const { internal, events } = await makeSession();

    await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });
    // `make test` is a real check the evidence classifier cannot vouch for:
    // green output, exit 0 — but not bounded evidence.
    await simulateToolCall(internal, "bash", { command: "make test" });
    expect(internal.getVerificationProblem()).toContain("Unverified");
    // The work turn gets its one demand, as designed.
    expect(await internal.getHookFollowUpMessages()).not.toBeNull();

    // The next user prompt: a new run with no edits. The inherited debt must
    // NOT re-arm — no hold, no notice, the answer streams untouched.
    const before = events.length;
    (internal as unknown as { verificationGate: { beginRun(): void } }).verificationGate.beginRun();
    expect(await internal.getHookFollowUpMessages()).toBeNull();
    expect(events.length).toBe(before);
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
