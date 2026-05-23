import { describe, expect, it } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import { messagesToHistoryItems } from "../cli.js";
import { getRestoredMessagesForDisplay } from "./session-compaction.js";
import {
  GOAL_EVENT_PAYLOAD_PREFIX,
  GOAL_VERIFIER_EVENT_PREFIX,
  GOAL_WORKER_EVENT_PREFIX,
} from "../ui/goal-events.js";

function extractText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } => block.type === "text" && "text" in block,
    )
    .map((block) => block.text)
    .join("\n");
}

function replayTexts(messages: readonly Message[]): string[] {
  return getRestoredMessagesForDisplay(messages).map((message) => extractText(message.content));
}

function replayHistory(messages: Message[]) {
  return messagesToHistoryItems(getRestoredMessagesForDisplay(messages));
}

describe("continued session replay display filtering", () => {
  it("does not replay raw persisted goal worker synthetic events as chat", () => {
    const persisted: Message[] = [
      { role: "user", content: "please keep this normal user prompt" },
      {
        role: "user",
        content: `${GOAL_WORKER_EVENT_PREFIX} run_id="run-a" goal="Fix replay" task_id="task-a" task="Repro" worker="worker-a" status=done exit_code=0\n${GOAL_EVENT_PAYLOAD_PREFIX}{"version":1,"kind":"worker","runId":"run-a","goal":"Fix replay","status":"done","exitCode":0,"summary":"done","goalState":{"status":"running","userPrerequisites":"(none)","verifier":null,"blockers":[],"prerequisites":[],"evidencePlan":[],"tasks":[],"evidenceCount":0},"taskId":"task-a","task":"Repro","worker":"worker-a","workerLogFile":"/tmp/worker.log","toolsUsed":[]}\nsummary:\ndone`,
      },
    ];

    const history = replayHistory(persisted);
    const replayedText = JSON.stringify(history);

    expect(history).toMatchObject([
      { kind: "user", text: "please keep this normal user prompt" },
      {
        kind: "goal_progress",
        phase: "worker_finished",
        title: "Done: Repro",
        detail: "done",
        workerId: "worker-a",
        status: "done",
      },
    ]);
    expect(replayedText).not.toContain(GOAL_WORKER_EVENT_PREFIX);
    expect(replayedText).not.toContain(GOAL_EVENT_PAYLOAD_PREFIX);
  });

  it("does not replay raw persisted goal verifier synthetic events as chat", () => {
    const persisted: Message[] = [
      {
        role: "user",
        content: `${GOAL_VERIFIER_EVENT_PREFIX} run_id="run-a" goal="Fix replay" status=fail exit_code=1\n${GOAL_EVENT_PAYLOAD_PREFIX}{"version":1,"kind":"verifier","runId":"run-a","goal":"Fix replay","status":"fail","exitCode":1,"summary":"failed","goalState":{"status":"verifying","userPrerequisites":"(none)","verifier":null,"blockers":[],"prerequisites":[],"evidencePlan":[],"tasks":[],"evidenceCount":0},"command":"pnpm test","fixAttempts":0,"fixLimit":3,"completionGuidance":"fix"}\nsummary:\nfailed`,
      },
    ];

    const history = replayHistory(persisted);
    const replayedText = JSON.stringify(history);

    expect(history).toMatchObject([
      {
        kind: "goal_progress",
        phase: "verifier_finished",
        title: "Verifier fail: Fix replay",
        detail: "failed",
        status: "fail",
      },
    ]);
    expect(replayedText).not.toContain(GOAL_VERIFIER_EVENT_PREFIX);
    expect(replayedText).not.toContain(GOAL_EVENT_PAYLOAD_PREFIX);
  });

  it("restores terminal goal state as a compact goal progress row", () => {
    const persisted: Message[] = [
      {
        role: "user",
        content: `${GOAL_VERIFIER_EVENT_PREFIX} run_id="run-a" goal="Fix replay" status=pass exit_code=0\n${GOAL_EVENT_PAYLOAD_PREFIX}{"version":1,"kind":"verifier","runId":"run-a","goal":"Fix replay","status":"pass","exitCode":0,"summary":"Verifier passed","goalState":{"status":"passed","userPrerequisites":"(none)","verifier":{"description":"Replay verifier","lastStatus":"pass"},"blockers":[],"prerequisites":[],"evidencePlan":[],"tasks":[{"id":"task-a","title":"Repro","status":"done","attempts":1}],"evidenceCount":3},"command":"pnpm test","fixAttempts":0,"fixLimit":3,"completionGuidance":"complete"}\nsummary:\nVerifier passed`,
      },
    ];

    const history = replayHistory(persisted);
    const replayedText = JSON.stringify(history);

    expect(history).toMatchObject([
      {
        kind: "goal_progress",
        phase: "terminal",
        title: "Goal passed: Fix replay",
        detail: "Verifier passed",
        status: "passed",
      },
    ]);
    expect(replayedText).not.toContain(GOAL_VERIFIER_EVENT_PREFIX);
    expect(replayedText).not.toContain(GOAL_EVENT_PAYLOAD_PREFIX);
  });

  it("keeps compact restore/system control out of display but preserves normal slash-command text", () => {
    const persisted: Message[] = [
      { role: "system", content: "internal system control should remain hidden" },
      { role: "user", content: "/help" },
      { role: "assistant", content: "Here are the available commands." },
    ];

    const replayedText = replayTexts(persisted).join("\n");

    expect(replayedText).not.toContain("internal system control");
    expect(replayedText).toContain("/help");
    expect(replayedText).toContain("Here are the available commands.");
  });
});
