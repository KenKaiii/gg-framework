// Serves ACP on real stdio, backed by a scripted session instead of a model.
//
// Run as a CHILD PROCESS so the test exercises the actual transport: pipes,
// line buffering, and the interleaving of notifications with responses. An
// in-process harness would prove the handlers work and prove nothing about the
// framing, which is the part an ACP client depends on.
//
// The session is scripted rather than real because a live provider needs
// credentials and a network, and would make the frames non-deterministic. What
// is under test is the protocol, not the model.
//
// `session/list` and `session/load` are NOT scripted: they read real session
// files that this fixture writes into a temp HOME, through the real
// `listSessions` and the real session-file parser. Faking those would test the
// fake, and "see and resume my sessions" is the whole point of the feature.
//
// Usage: node --import tsx acp-stdio-agent.mjs <cwd> [otherCwd]
// Requires HOME to point at a temp directory.

import os from "node:os";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { EventBus } from "../../core/event-bus.js";
import { SessionManager } from "../../core/session-manager.js";
import { loadSession } from "../../session.js";
import { runAcpMode } from "../acp-mode.js";

const cwd = process.argv[2];
// A second project, so the test can prove that an unscoped list spans
// checkouts rather than only reporting the directory the agent was started in.
const otherCwd = process.argv[3];
if (!cwd) throw new Error("usage: acp-stdio-agent.mjs <cwd> [otherCwd]");

const manager = new SessionManager(path.join(os.homedir(), ".gg", "sessions"));
let entrySequence = 0;

async function appendMessage(sessionPath, message) {
  entrySequence += 1;
  await manager.appendEntry(sessionPath, {
    type: "message",
    id: `fixture-message-${entrySequence}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    message,
  });
}

const summary = (text) => ({
  role: "user",
  content: `[Previous conversation summary]\n\n${text}`,
  provenance: { source: "runtime", kind: "compaction_summary", visibility: "summary" },
});
const compactionAck = {
  role: "assistant",
  content:
    "I have the full context from the summary above, including where work left off and the next step.",
  provenance: { source: "runtime", kind: "compaction_ack", visibility: "hidden" },
};

// Two stored conversations in the main project. The newer one has two real
// compaction generations; the older one deliberately points at a missing parent.
async function seedSessions() {
  const older = await manager.create(cwd, "anthropic", "claude-opus-5-5", {
    parentSessionId: "missing-parent-checkpoint",
    generation: 1,
    preview: "older: rename the widget",
  });
  await appendMessage(older.path, summary("older fallback summary"));
  await appendMessage(older.path, { role: "assistant", content: "Recovered from summary." });

  const original = await manager.create(cwd, "anthropic", "claude-opus-5-5");
  await appendMessage(original.path, { role: "user", content: "newer: add the config panel" });
  await appendMessage(original.path, {
    role: "assistant",
    content: [
      { type: "text", text: "Reading the panel first." },
      { type: "tool_call", id: "call-1", name: "read", args: { file_path: "/panel.tsx" } },
    ],
  });
  await appendMessage(original.path, {
    role: "tool",
    content: [{ type: "tool_result", toolCallId: "call-1", content: "panel source" }],
  });
  await appendMessage(original.path, { role: "assistant", content: "Added the config panel." });

  const first = await manager.create(cwd, "anthropic", "claude-opus-5-5", {
    conversationId: original.id,
    generation: 1,
    parentSessionId: original.id,
    retainedMessageCount: 2,
    preview: "newer: add the config panel",
  });
  await appendMessage(first.path, summary("first replacement summary"));
  await appendMessage(first.path, compactionAck);
  await appendMessage(first.path, {
    role: "tool",
    content: [{ type: "tool_result", toolCallId: "call-1", content: "panel source" }],
  });
  await appendMessage(first.path, { role: "assistant", content: "Added the config panel." });
  await appendMessage(first.path, { role: "user", content: "after first compaction" });
  await appendMessage(first.path, { role: "assistant", content: "First follow-up complete." });

  const newest = await manager.create(cwd, "anthropic", "claude-opus-5-5", {
    conversationId: original.id,
    generation: 2,
    parentSessionId: first.id,
    retainedMessageCount: 2,
    preview: "newer: add the config panel",
  });
  await appendMessage(newest.path, summary("second replacement summary"));
  await appendMessage(newest.path, compactionAck);
  await appendMessage(newest.path, { role: "user", content: "after first compaction" });
  await appendMessage(newest.path, { role: "assistant", content: "First follow-up complete." });
  await appendMessage(newest.path, { role: "user", content: "after second compaction" });
  await appendMessage(newest.path, { role: "assistant", content: "Second follow-up complete." });

  // An empty session must never reach the phone: it has nothing to resume.
  await manager.create(cwd, "anthropic", "claude-opus-5-5");

  let other;
  if (otherCwd) {
    other = await manager.create(otherCwd, "anthropic", "claude-opus-5-5");
    await appendMessage(other.path, { role: "user", content: "other project: fix the parser" });
    await appendMessage(other.path, { role: "assistant", content: "Fixed." });
  }

  return { older: older.id, newer: newest.id, other: other?.id };
}

const seeded = await seedSessions();

/**
 * A session whose `prompt` replays one fixed run: thinking, text, a tool that
 * succeeds, a tool that fails. Covers every event the mode maps.
 */
class ScriptedSession {
  eventBus = new EventBus();
  disposed = false;

  // A stand-in for the real registry, shaped like `SlashCommandRegistry.getAll`.
  // Two entries are enough to pin the precedence rules: `new` collides with a
  // project command file, and `quit` carries an alias that collides with one.
  slashCommands = {
    getAll: () => [
      {
        name: "new",
        aliases: [],
        description: "Start a new session",
        usage: "/new",
      },
      {
        name: "quit",
        aliases: ["q"],
        description: "Exit the agent",
        usage: "/quit",
      },
    ],
  };

  // Token accounting the mode reports as ACP `usage_update`. Scripted so the
  // test can pin exact numbers, and so the post-compaction DROP at an unchanged
  // window size — the only way a client can detect compaction — is observable
  // without a real model.
  #used = 4200;
  #contextWindow = 200_000;
  #costUsd = 0;

  #messages = [];
  #sessionId = "acp-fixture-session";
  #model = "claude-opus-5-5";
  #provider = "anthropic";
  #thinking;

  constructor(signal, hooks, context) {
    this.signal = signal;
    // What the mode built this session for: cwd, goal, and the ask_user tool
    // when the client opted in.
    this.context = context;
    // The plan-mode callbacks the real agent loop would invoke from the
    // enter_plan/exit_plan tools. Held so a scripted prompt can approve a plan
    // without a model.
    this.hooks = hooks;
  }

  setSignal(signal) {
    this.signal = signal;
  }

  async initialize() {}

  getState() {
    return { sessionId: this.#sessionId, provider: this.#provider, model: this.#model };
  }

  getContextUsage() {
    return {
      used: this.#used,
      size: this.#contextWindow,
      ...(this.#costUsd > 0 ? { costUsd: this.#costUsd } : {}),
    };
  }

  // Deliberately the REAL loader against the REAL file the fixture wrote, so
  // the replay assertions are about ggcoder's own transcript format.
  async loadSession(sessionPath) {
    const loaded = await loadSession(sessionPath);
    this.#messages = loaded.messages;
    this.#sessionId = loaded.header.id;
    this.#model = loaded.header.model;
    const raw = await manager.load(sessionPath);
    this.#markers = manager.getAutopilotMarkers(raw.entries, raw.header.leafId);
    this.#file = sessionPath;
    this.#written = this.#messages.length;
  }

  // Ken's verdict markers, written to a REAL session file (created on first
  // use, messages flushed ahead of the marker) so session/load reads them back
  // through the real parser.
  #markers = [];
  #file = null;
  #written = 0;

  async persistAutopilotMarker(phase, extra) {
    // Serialised: the done marker can fire before the first write lands.
    const snapshot = [...this.#messages];
    this.#chain = this.#chain.then(() => this.#persist(phase, extra, snapshot));
    await this.#chain;
  }

  #chain = Promise.resolve();

  async #persist(phase, extra, messages) {
    if (!this.#file) {
      const created = await manager.create(cwd, this.#provider, this.#model);
      this.#file = created.path;
      process.stderr.write(`persisted-session=${created.id} ${created.path}\n`);
    }
    for (const message of messages.slice(this.#written)) {
      await appendMessage(this.#file, message);
    }
    this.#written = messages.length;
    const payload = {
      version: 1,
      phase,
      afterMessageCount: messages.filter((m) => m.role !== "system").length,
      ...(extra?.reason !== undefined ? { reason: extra.reason } : {}),
      ...(extra?.body !== undefined ? { body: extra.body } : {}),
    };
    this.#markers.push(payload);
    await manager.appendEntry(this.#file, {
      type: "custom",
      kind: "autopilot_marker",
      id: `fixture-marker-${++entrySequence}`,
      parentId: null,
      timestamp: new Date().toISOString(),
      data: payload,
    });
  }

  getAutopilotMarkers() {
    return this.#markers;
  }

  getMessages() {
    return this.#messages;
  }

  async switchModel(provider, model) {
    this.#provider = provider;
    this.#model = model;
  }

  getThinkingLevel() {
    return this.#thinking;
  }

  setThinkingLevel(level) {
    this.#thinking = level;
  }

  #planMode = false;
  #approvedPlan;

  getPlanMode() {
    return this.#planMode;
  }

  async setPlanMode(active) {
    this.#planMode = active;
  }

  async newSession() {
    this.#sessionId = `${this.#sessionId}-fresh`;
    this.#messages = [];
    this.#markers = [];
    this.#file = null;
    this.#written = 0;
  }

  async setApprovedPlan(planPath) {
    this.#approvedPlan = planPath;
  }

  // ── GG extensions: queue, workers, images ──
  #queue = [];
  #queueSeq = 0;
  #workers = [];

  queueMessage(text) {
    this.#queue.push({ id: `q${++this.#queueSeq}`, text });
    return this.#queue.length;
  }

  listQueuedMessages() {
    return this.#queue.map((m) => ({ ...m }));
  }

  cancelQueuedMessage(id) {
    const index = this.#queue.findIndex((m) => m.id === id);
    if (index === -1) return false;
    this.#queue.splice(index, 1);
    return true;
  }

  drainQueue() {
    return this.#queue
      .splice(0)
      .map((m) => m.text)
      .join("\n\n");
  }

  listSubAgents() {
    return this.#workers;
  }

  async addDirectory(dir) {
    this.addedDirs = [...(this.addedDirs ?? []), dir];
    return { ok: true, root: dir };
  }

  async promptWithAttachments(text, attachments) {
    this.#messages.push({ role: "user", content: text });
    const first = attachments[0];
    this.eventBus.emit("text_delta", {
      text: `images=${attachments.length} kind=${first?.kind} type=${first?.mediaType} saved=${Boolean(first?.path)} text=${text}`,
    });
    this.eventBus.emit("turn_end", { turn: 1, stopReason: "end_turn" });
  }

  /**
   * Resolve once `count` messages are queued, or the turn is cancelled. A
   * caller queueing several must wait for all of them: draining after the
   * first lets a slow runner end the turn before the rest arrive.
   */
  async #waitForQueue(count = 1) {
    while (this.#queue.length < count && !this.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async prompt(content, provenance) {
    // Kleio Goals' hidden kickoff/resume instruction.
    if (provenance?.visibility === "hidden") {
      this.#messages.push({ role: "user", content, provenance });
      this.#messages.push({ role: "assistant", content: [{ type: "text", text: "Hi." }] });
      this.eventBus.emit("text_delta", { text: `goal-turn:${content.split("\n")[0]}` });
      this.#workers = [
        {
          agent_id: "w1",
          task_name: "build it",
          agent_name: "builder",
          state: "reaped",
          started_at: 1,
          updated_at: 2,
          elapsed_ms: 5,
          current_activity: "editing",
          turn_count: 1,
          tool_use_count: 3,
          token_usage: { input: 0, output: 0 },
          model: "claude-opus-5-5",
        },
      ];
      this.eventBus.emit("subagent_state", this.#workers[0]);
      this.eventBus.emit("turn_end", { turn: 1, stopReason: "end_turn" });
      return;
    }

    // Steering folds in at a boundary: drained mid-run.
    if (content === "steer me") {
      // The test queues two; drain only once both are in.
      await this.#waitForQueue(2);
      this.#queue.splice(0);
      this.eventBus.emit("queue_drained", { count: 0 });
      this.eventBus.emit("turn_end", { turn: 1, stopReason: "end_turn" });
      return;
    }

    // The turn ends before any steering boundary: the queue is left over.
    if (content === "end before steering") {
      await this.#waitForQueue();
      this.eventBus.emit("turn_end", { turn: 1, stopReason: "end_turn" });
      return;
    }

    if (content === "ask me") {
      const tool = this.context?.askUserTool;
      if (!tool) {
        this.eventBus.emit("text_delta", { text: "no ask tool" });
        return;
      }
      const result = await tool.execute(
        {
          questions: [
            {
              id: "go",
              question: "Ready?",
              kind: "choice",
              options: [
                { label: "Start the goal now", value: "start" },
                { label: "Hang on, I want to discuss it more" },
              ],
            },
          ],
        },
        {},
      );
      this.eventBus.emit("text_delta", {
        text: `asked:${typeof result === "string" ? result : JSON.stringify(result)}`,
      });
      return;
    }

    if (content === "show tool images") {
      const saved = await manager.create(cwd, "anthropic", "claude-opus-5-5");
      await appendMessage(saved.path, { role: "user", content: "tool image history" });
      const data =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
      for (const name of ["screenshot", "generate_image", "read"]) {
        const toolCallId = `image-${name}`;
        const args = {};
        this.eventBus.emit("tool_call_start", { toolCallId, name, args });
        this.eventBus.emit("tool_call_end", {
          toolCallId,
          result: "Picture ready",
          isError: false,
          durationMs: 1,
          details: {
            imagePreviews: [{ base64: data, mediaType: "image/png", path: "/not-read.png" }],
          },
        });
        await appendMessage(saved.path, {
          role: "assistant",
          content: [{ type: "tool_call", id: toolCallId, name, args }],
        });
        await appendMessage(saved.path, {
          role: "tool",
          content: [
            {
              type: "tool_result",
              toolCallId,
              content: [
                { type: "text", text: "Picture ready" },
                { type: "image", mediaType: "image/png", data },
              ],
            },
          ],
        });
      }
      this.eventBus.emit("turn_end", { turn: 1, stopReason: "end_turn" });
      this.eventBus.emit("agent_done", { totalTurns: 1 });
      return;
    }

    // A real `edit` run: the file on disk genuinely changes between the tool's
    // start and end events, which is the only way to prove the mode snapshots
    // the BEFORE contents rather than reading the finished file twice.
    if (content === "edit a file") {
      const target = path.join(cwd, "diffed.txt");
      writeFileSync(target, "before\n");
      this.eventBus.emit("tool_call_start", {
        toolCallId: "d1",
        name: "edit",
        args: { file_path: target },
      });
      writeFileSync(target, "after\n");
      this.eventBus.emit("tool_call_end", {
        toolCallId: "d1",
        result: "unified diff prose the client should not have to read",
        isError: false,
        durationMs: 2,
      });

      // A brand-new file: ACP represents that as a null oldText.
      const created = path.join(cwd, "created.txt");
      this.eventBus.emit("tool_call_start", {
        toolCallId: "d2",
        name: "write",
        args: { file_path: "created.txt" },
      });
      writeFileSync(created, "brand new\n");
      this.eventBus.emit("tool_call_end", {
        toolCallId: "d2",
        result: "wrote created.txt",
        isError: false,
        durationMs: 1,
      });

      this.eventBus.emit("turn_end", { turn: 1, stopReason: "end_turn" });
      this.eventBus.emit("agent_done", { totalTurns: 1 });
      return;
    }

    // Plan review: the model submits a plan and the turn ends.
    if (content === "submit a plan" || content.startsWith("The plan was not approved")) {
      const planFile = path.join(cwd, "plan.md");
      writeFileSync(
        planFile,
        "# Plan\n\n## Steps\n\n1. Build the first piece\n2. Build the second piece\n",
      );
      await this.hooks.onEnterPlan();
      const review = await this.hooks.onExitPlan(planFile);
      this.eventBus.emit("text_delta", {
        text: `exit:${typeof review === "string" ? review : review.content}|revise:${content.length > 20}`,
      });
      this.eventBus.emit("turn_end", { turn: 1, stopReason: "end_turn" });
      return;
    }

    // Real work for the autopilot reviewer.
    if (content === "build it") {
      this.#messages.push({ role: "user", content });
      this.#messages.push({
        role: "assistant",
        content: [
          { type: "tool_call", id: "w1", name: "write", args: { file_path: "x.ts" } },
          { type: "text", text: "Built." },
        ],
      });
      this.eventBus.emit("text_delta", { text: "Built." });
      this.eventBus.emit("turn_end", { turn: 1, stopReason: "end_turn" });
      return;
    }

    // Touches the project's checklist file.
    if (content === "touch checklist") {
      writeFileSync(path.join(cwd, ".gg-checklist.json"), "{}\n");
      this.eventBus.emit("turn_end", { turn: 1, stopReason: "end_turn" });
      return;
    }

    // Plan mode end to end: the model approves a plan, then reports progress
    // with the [DONE:n] markers the approval instruction asks for.
    if (content === "approve a plan") {
      const planFile = path.join(cwd, "plan.md");
      writeFileSync(
        planFile,
        "# Plan\n\n## Steps\n\n1. Wire the transport layer\n2. Render the results\n3. Ship the thing\n",
      );
      await this.hooks.onExitPlan(planFile);
      this.eventBus.emit("text_delta", { text: "Transport done. [DONE" });
      // Split across two deltas on purpose: a marker that straddles a chunk
      // boundary must still register.
      this.eventBus.emit("text_delta", { text: ":1] Moving on." });
      this.eventBus.emit("turn_end", { turn: 1, stopReason: "end_turn" });
      this.eventBus.emit("agent_done", { totalTurns: 1 });
      return;
    }

    // Auto-compaction: the real session compacts BEFORE the model runs, and
    // emits `compaction_end` once the compacted messages are installed.
    if (content === "compact me") {
      this.eventBus.emit("compaction_start", { messageCount: 40 });
      this.#used = 900;
      this.eventBus.emit("compaction_end", { compacted: true, originalCount: 40, newCount: 4 });
      this.#used += 1500;
      this.#costUsd += 0.25;
      this.eventBus.emit("turn_end", {
        turn: 1,
        stopReason: "end_turn",
        usage: { inputTokens: 1500, outputTokens: 60 },
      });
      this.eventBus.emit("agent_done", {
        totalTurns: 1,
        totalUsage: { inputTokens: 1500, outputTokens: 60 },
      });
      return;
    }

    if (content === "report loaded context") {
      const text = this.#messages
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join(""),
        )
        .join(" | ");
      this.eventBus.emit("text_delta", { text });
      this.eventBus.emit("agent_done", {
        totalTurns: 1,
        totalUsage: { inputTokens: 0, outputTokens: 0 },
      });
      return;
    }

    // The real `AgentSession.prompt` SWALLOWS cancellation — it returns
    // normally once the signal aborts rather than rejecting. The fixture must
    // match, or the test would pass against behaviour production never has.
    if (content === "hang") {
      if (this.signal.aborted) return;
      this.turnRunning = true;
      await new Promise((resolve) => {
        this.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      // The real session persists the turn AFTER the abort unwinds it, on a
      // later tick. Anything that disposes without waiting for prompt() to
      // return races this write and silently loses the turn's tail.
      await new Promise((resolve) => setTimeout(resolve, 50));
      this.turnRunning = false;
      return;
    }

    // The real session records the prompt, which is where its auto-generated
    // title comes from.
    this.#messages.push({ role: "user", content });

    this.eventBus.emit("thinking_delta", { text: "planning" });
    this.eventBus.emit("text_delta", { text: "Hello " });
    this.eventBus.emit("text_delta", { text: content });

    this.eventBus.emit("tool_call_start", {
      toolCallId: "t1",
      name: "read",
      args: { file_path: "/tmp/example.ts" },
    });
    this.eventBus.emit("tool_call_update", { toolCallId: "t1", update: { progress: 0.5 } });
    this.eventBus.emit("tool_call_end", {
      toolCallId: "t1",
      result: "file contents",
      isError: false,
      durationMs: 3,
    });

    this.eventBus.emit("tool_call_start", {
      toolCallId: "t2",
      name: "bash",
      args: { command: "exit 1" },
    });
    this.eventBus.emit("tool_call_end", {
      toolCallId: "t2",
      result: "boom",
      isError: true,
      durationMs: 1,
    });

    if (content === "refuse") {
      this.eventBus.emit("truncated", { reason: "refusal", continued: false });
    }

    this.#used += 5000;
    this.eventBus.emit("turn_end", {
      turn: 1,
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 20 },
    });

    this.eventBus.emit("agent_done", {
      totalTurns: 1,
      totalUsage: { inputTokens: 10, outputTokens: 20 },
    });
  }

  async dispose() {
    this.disposed = true;
    // Records whether teardown cut a turn off mid-unwind, which in the real
    // session is exactly when the final exchange fails to persist.
    writeFileSync(
      path.join(cwd, "dispose-witness.json"),
      JSON.stringify({ disposedMidTurn: this.turnRunning === true }),
    );
    this.eventBus.removeAllListeners();
  }
}

let current = null;

// Announced on stderr so the test can assert against the ids it did not choose.
process.stderr.write(`seeded=${JSON.stringify(seeded)}\n`);

await runAcpMode({
  provider: "anthropic",
  model: "claude-opus-5-5",
  cwd,
  version: "0.0.0-test",
  // Short soft deadline for the late-answer test only.
  ...(process.env.GG_ACP_TEST_ASK_DEADLINE_MS
    ? { askUserDeadlineMs: Number(process.env.GG_ACP_TEST_ASK_DEADLINE_MS) }
    : {}),
  // The autopilot reviewer scripted from GG_ACP_TEST_KEN (JSON array of replies);
  // "WAIT" parks the review until it is aborted.
  createKenReviewer: () => {
    const replies = JSON.parse(process.env.GG_ACP_TEST_KEN ?? "[]");
    let release = null;
    return {
      async reset() {},
      async review() {
        const next = replies.shift() ?? "IGNORE";
        if (next !== "WAIT") return next;
        await new Promise((resolve) => (release = resolve));
        throw new Error("aborted");
      },
      abort() {
        release?.();
      },
      async dispose() {
        release?.();
      },
    };
  },
  createSession: (signal, hooks, context) => {
    current = new ScriptedSession(signal, hooks, context);
    return current;
  },
});

// Proves teardown ran: the test asserts this arrives on stderr once the input
// stream closes, so a leaked session cannot pass unnoticed.
process.stderr.write(`disposed=${current ? current.disposed : "none"}\n`);
