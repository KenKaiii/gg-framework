/**
 * "Model-visible means logged" — every mid-run injection must land in the
 * persisted session JSONL (deepseek-harness takeaway #1).
 *
 * Anything that reaches a model request — queued user steering, pushed
 * notifications, loop-breaker nudges — is reconstructable only if it is
 * persisted. A replay/resume that silently drops an injection gives the model
 * a history that never happened.
 *
 * Runs the REAL AgentSession + REAL agent loop against a scripted palsu
 * provider (mock only the model boundary). Each injection site is driven
 * through its real trigger surface, then asserted in the on-disk session
 * log — the JSONL a resume/replay re-derives the request from.
 *
 * The compaction-summary case lives in agent-session-compaction.test.ts,
 * in the harness where the compactor mock is proven to apply.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerPalsuProvider,
  palsuText,
  palsuToolCall,
  type PalsuProviderHandle,
} from "@kenkaiiii/gg-ai";
import type { Message } from "@kenkaiiii/gg-ai";
import { useFakeHome } from "../test-support/fake-home.js";
import type { AgentNotificationQueue } from "./agent-notifications.js";
import { STEERING_PREFIX, NOTIFICATION_PREFIX } from "./steering.js";
import { LOOP_BREAK_PROMPT as LOOP_BREAK_TEXT } from "./loop-breaker.js";

let restoreHome: (() => void) | undefined;
let tmpHome: string;
let tmpProject: string;
let palsu: PalsuProviderHandle;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gg-injections-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "gg-injections-project-"));
  restoreHome = useFakeHome(tmpHome);
  palsu = registerPalsuProvider();

  await fs.mkdir(path.join(tmpHome, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(tmpHome, ".gg", "auth.json"),
    JSON.stringify({
      palsu: { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3_600_000 },
    }),
    "utf-8",
  );
});

afterEach(async () => {
  palsu.unregister();
  restoreHome?.();
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
  vi.clearAllMocks();
});

/** Persisted `message` rows from the session JSONL, in file order. */
async function readPersistedMessages(sessionFile: string): Promise<Message[]> {
  const raw = await fs.readFile(sessionFile, "utf-8");
  const messages: Message[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as { type?: string; message?: Message };
    if (entry.type === "message" && entry.message) messages.push(entry.message);
  }
  return messages;
}

function textOf(message: Message): string {
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

describe("model-visible injections persist to the session log", () => {
  it("persists queued steering, pushed notifications, and loop-break nudges", async () => {
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "palsu",
      model: "claude-sonnet-5", // real id so registry lookups succeed; palsu ignores it
      cwd: tmpProject,
      systemPrompt: "test system prompt",
    });
    await session.initialize();

    // Queue user steering + a pushed notification BEFORE the run: the loop's
    // initial steering poll drains them ahead of the first LLM call (the
    // "catch messages queued before the first request" boundary).
    session.queueMessage("Steering: use option B instead.");
    const notifications = (session as unknown as { notifications: AgentNotificationQueue })
      .notifications; // deliberate reach-in: notifications have no public session API
    notifications.enqueue(
      "subagent",
      "agent-test-1",
      'Child agent "research" (agent-test-1) is done after 2 turn(s).',
      { terminal: true },
    );

    // Script: 3 identical failing tool calls (unknown tool → isError →
    // consecutive-failure streak), then the loop-break stage-1 nudge is
    // injected at the next steering poll, then a clean final answer.
    for (let i = 0; i < 3; i++) {
      palsu.appendResponses(palsuToolCall("boom", { attempt: i }));
    }
    palsu.appendResponses(palsuText("Stopped as instructed."));

    await session.prompt("Do the task.");
    const sessionFile = session.getState().sessionPath; // capture before dispose() clears it
    await session.dispose();

    const persisted = await readPersistedMessages(sessionFile);
    const persistedTexts = persisted.map(textOf);

    // 1. Queued user steering — wrapped, transcript-visible.
    const steering = persisted.find((m) => textOf(m).includes(STEERING_PREFIX));
    expect(steering, `no steering message in JSONL: ${persistedTexts.length} rows`).toBeTruthy();
    expect(textOf(steering!)).toContain("use option B instead.");
    expect(steering!.provenance).toMatchObject({ source: "human", kind: "steering" });

    // 2. Pushed notification — hidden from the transcript UI but still logged.
    const notification = persisted.find((m) => textOf(m).includes(NOTIFICATION_PREFIX));
    expect(notification, "notification injection missing from JSONL").toBeTruthy();
    expect(textOf(notification!)).toContain("Child agent");
    expect(notification!.provenance).toMatchObject({
      source: "runtime",
      kind: "notification",
      visibility: "hidden",
    });

    // 3. Loop-break stage-1 nudge — runtime-injected, hidden.
    const loopBreak = persisted.find((m) => textOf(m).includes(LOOP_BREAK_TEXT.slice(0, 40)));
    expect(loopBreak, "loop-break injection missing from JSONL").toBeTruthy();
    expect(textOf(loopBreak!)).toContain("Stuck");
    expect(loopBreak!.provenance).toMatchObject({ source: "runtime", visibility: "hidden" });

    // 4. The failing tool calls that triggered it are logged as tool results
    //    (the evidence trail a replay needs to re-derive the injection).
    const boomResults = persisted.filter((m) => textOf(m).includes("Unknown tool: boom"));
    expect(boomResults.length).toBe(3);
  }, 60_000);

  it("never persists the live-run cache-anchor hint", async () => {
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "palsu",
      model: "claude-sonnet-5",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
    });
    await session.initialize();
    palsu.appendResponses(palsuText("ok"));
    await session.prompt("Do the task.");
    const anchored: Message = { role: "user", content: "anchored", cacheAnchor: true };
    // deliberate reach-in: the hint is set by the in-flight prune, not a public API
    await (
      session as unknown as { persistMessage(message: Message): Promise<void> }
    ).persistMessage(anchored);
    const sessionFile = session.getState().sessionPath;
    await session.dispose();

    const persisted = await readPersistedMessages(sessionFile);
    expect(persisted.find((m) => textOf(m) === "anchored")).toEqual({
      role: "user",
      content: "anchored",
    });
    // The live message keeps its hint.
    expect(anchored.cacheAnchor).toBe(true);
  }, 60_000);
});
