import path from "node:path";
import { createInterface } from "node:readline";

let running = false;
let timer;
// Task text of a "hold" turn: it stays running until a queued message releases it.
let heldTask;
let contextTurns = 0;

const emit = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const ack = (frame, extra = {}) =>
  emit({ type: "ack", request_id: frame.request_id, ok: true, ...extra });
const complete = (status = "completed", output = `turn-${contextTurns}`) => {
  clearTimeout(timer);
  heldTask = undefined;
  running = false;
  emit({ type: "state", state: status === "interrupted" ? "interrupted" : "idle" });
  emit({
    type: "turn_complete",
    status,
    output,
    // Stand-in for the engine-built receipt the real worker attaches.
    receipt: "Receipt (1 call): read a.ts",
    ...(status === "interrupted" ? { error: "Interrupted" } : {}),
  });
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.command === "initialize") {
    // Named agents arrive as `agentPrompt` (composed with the standard prompt
    // scaffolding); `systemPrompt` remains the full-replacement path.
    const prompt = frame.options?.agentPrompt ?? frame.options?.systemPrompt;
    if (prompt === "malformed") process.stdout.write("not-json\n");
    else if (prompt === "die") process.exit(2);
    else if (prompt === "hang") return;
    else {
      emit({ type: "state", state: "idle" });
      const childSessionPath =
        frame.options?.childSessionPath ??
        path.join(frame.options?.sessionRootDir ?? process.cwd(), `fake-${process.pid}.jsonl`);
      ack(frame, {
        child_session_id: path.basename(childSessionPath, ".jsonl"),
        child_session_path: childSessionPath,
      });
    }
    return;
  }
  if (frame.command === "start" || frame.command === "followup") {
    running = true;
    contextTurns++;
    ack(frame, { status: "running" });
    emit({ type: "state", state: "running" });
    emit({
      type: "event",
      event: "tool_call_start",
      payload: { toolCallId: "fake-read", name: "read", args: { file_path: "a.ts" } },
    });
    emit({
      type: "event",
      event: "tool_call_end",
      payload: { toolCallId: "fake-read", result: "x", isError: false, durationMs: 1 },
    });
    emit({
      type: "event",
      event: "turn_end",
      payload: {
        usage: { inputTokens: 10, outputTokens: 2, cacheRead: 20, cacheWrite: 5 },
      },
    });
    // A timer only approximates "still running": process startup on a loaded
    // runner can outlast it. A "hold" turn runs until the test releases it.
    if (/hold/.test(frame.task)) {
      heldTask = frame.task;
      return;
    }
    const delay = /slow/.test(frame.task) ? 150 : 15;
    timer = setTimeout(() => complete("completed", `${frame.task}|context:${contextTurns}`), delay);
    return;
  }
  if (frame.command === "queue_message") {
    ack(frame, { queued: running ? 1 : 0 });
    if (heldTask !== undefined) complete("completed", `${heldTask}|context:${contextTurns}`);
    return;
  }
  if (frame.command === "interrupt") {
    ack(frame);
    complete("interrupted", "partial");
    return;
  }
  if (frame.command === "shutdown") {
    ack(frame);
    process.exit(0);
  }
});
