import { createInterface } from "node:readline";

let running = false;
let timer;
let contextTurns = 0;

const emit = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const ack = (frame, extra = {}) =>
  emit({ type: "ack", request_id: frame.request_id, ok: true, ...extra });
const complete = (status = "completed", output = `turn-${contextTurns}`) => {
  clearTimeout(timer);
  running = false;
  emit({ type: "state", state: status === "interrupted" ? "interrupted" : "idle" });
  emit({
    type: "turn_complete",
    status,
    output,
    ...(status === "interrupted" ? { error: "Interrupted" } : {}),
  });
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.command === "initialize") {
    if (frame.options?.systemPrompt === "malformed") process.stdout.write("not-json\n");
    else if (frame.options?.systemPrompt === "die") process.exit(2);
    else if (frame.options?.systemPrompt === "hang") return;
    else {
      emit({ type: "state", state: "idle" });
      ack(frame);
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
      payload: { name: "read", args: { file_path: "a.ts" } },
    });
    emit({
      type: "event",
      event: "turn_end",
      payload: {
        usage: { inputTokens: 10, outputTokens: 2, cacheRead: 20, cacheWrite: 5 },
      },
    });
    const delay = /slow/.test(frame.task) ? 150 : 15;
    timer = setTimeout(() => complete("completed", `${frame.task}|context:${contextTurns}`), delay);
    return;
  }
  if (frame.command === "queue_message") {
    ack(frame, { queued: running ? 1 : 0 });
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
