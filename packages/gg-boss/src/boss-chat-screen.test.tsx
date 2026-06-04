import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./boss-chat-screen.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("./orchestrator-app.tsx", import.meta.url), "utf8");
const storeSource = readFileSync(new URL("./boss-store.ts", import.meta.url), "utf8");
const slashSource = readFileSync(new URL("./slash-commands.ts", import.meta.url), "utf8");
const modelSelectorSource = readFileSync(
  new URL("./boss-model-selector.tsx", import.meta.url),
  "utf8",
);

describe("BossChatScreen", () => {
  it("keeps GG Coder chat layout order", () => {
    const layout = source.indexOf("<ChatLayout");
    const live = source.indexOf("{livePane}");
    const controls = source.indexOf("<ChatControls");
    const stack = source.indexOf("<ChatInputStack");
    const input = source.indexOf("<InputArea");
    const footer = source.indexOf("<BossFooter");
    const workerStatus = source.indexOf("<BossWorkerStatusRow");

    expect(layout).toBeGreaterThanOrEqual(0);
    expect(live).toBeGreaterThan(layout);
    expect(controls).toBeGreaterThan(live);
    expect(stack).toBeGreaterThan(controls);
    expect(input).toBeGreaterThan(stack);
    expect(footer).toBeGreaterThan(input);
    expect(workerStatus).toBeGreaterThan(footer);
  });

  it("reserves the shared gg-coder live response slot after submit", () => {
    const rowsSource = readFileSync(new URL("./boss-transcript-rows.tsx", import.meta.url), "utf8");

    expect(rowsSource).toContain("<ChatLivePane");
    expect(rowsSource).toContain("reserveStreamingSpacing={shouldReserveStreamingSpacing}");
    expect(rowsSource).toContain("lastPendingHistoryItem ?? lastHistoryItem");
    expect(appSource).toContain("bossStore.queueSubmittedUserItem(userItem)");
    expect(appSource).not.toContain("bossStore.submitUserItem(userItem)");
    expect(appSource).not.toContain("bossStore.commitLiveItem(userItem)");
  });

  it("passes boss running state into the shared gg-coder input", () => {
    expect(source).toContain("disabled={isRunning}");
    expect(appSource).toContain('isRunning={state.phase === "working"}');
  });

  it("keeps the banner out of the live Ink frame", () => {
    expect(source).not.toContain("bannerPane");
    expect(source).not.toContain("historyPane");
    expect(appSource).not.toContain('<BossTranscriptRow row={{ kind: "banner"');
    expect(storeSource).toContain('history: [{ kind: "banner", id: "banner" }]');
  });

  it("resets terminal-history dedupe on /clear so the durable banner reprints", () => {
    expect(appSource).toContain('resetUI?.("session-clear")');
    expect(appSource).toContain('reason === "session-clear"');
    expect(appSource).toContain("terminalHistoryPrinter.clear()");
  });

  it("does not install duplicate chat Ctrl+C handlers alongside InputArea", () => {
    expect(appSource).not.toContain('stdin.on("data"');
    expect(appSource).not.toContain("useStdin");
    expect(appSource).toContain('key.ctrl && input === "c" && overlay');
  });

  it("does not remount a second Ink frame during startup or while working", () => {
    expect(appSource).toContain("resizeListenerEnabled");
    expect(appSource).toContain("if (!resizeListenerEnabled) return;");
    expect(appSource).toContain('if (getBossState().phase === "working") return;');
  });

  it("uses a Boss-owned full GG Coder model selector", () => {
    expect(source).toContain("<BossModelSelector");
    expect(source).not.toContain("loggedInProviders={state.loggedInProviders}");
    expect(modelSelectorSource).toContain('import { MODELS } from "@kenkaiiii/gg-core"');
    expect(modelSelectorSource).toContain("MODELS.map");
    expect(modelSelectorSource).toContain("function BossModelSelectList");
    expect(modelSelectorSource).toContain("stripTerminalFocusSequences");
    expect(modelSelectorSource).not.toContain("loggedInProviders");
  });

  it("supports GG Coder-style model aliases and keeps radio opening through the overlay reset", () => {
    expect(slashSource).toContain('aliases: ["m", "model", "models"]');
    expect(appSource).toContain('case "model-boss":');
    expect(appSource).toContain('openOverlay("radio")');
    expect(appSource).toContain("scheduleOverlayReset");
    expect(appSource).toContain("setTimeout(() =>");
  });
});
