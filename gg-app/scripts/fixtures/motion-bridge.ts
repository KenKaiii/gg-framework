// Fictional, local-only bridge. Never forwards calls to a desktop or provider.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { flushSync } from "react-dom";
import type { SidecarEvent } from "../../src/agent";

const state = {
  cwd: "/fictional/motion-fixture",
  mode: "code",
  provider: "anthropic",
  model: "fixture-model",
  running: false,
};
export const bridge = {
  unknown: [] as string[],
  prompts: [] as unknown[],
  checklist: "loaded",
  toggleTools: (): void =>
    flushSync(() => {
      const button = document.querySelector<HTMLButtonElement>(".tools-toggle");
      if (!button) throw new Error("Fixture tool toggle is missing");
      button.click();
    }),
  // Mock IPC delivers listeners synchronously. Commit those updates before
  // returning so the runner can inspect WAAPI before its first frame.
  emit: (event: SidecarEvent): Promise<void> => flushSync(() => emit("agent-event", event)),
};
mockWindows("main");
mockIPC(
  (command, payload) => {
    switch (command) {
      case "window_restore_target":
        return { mode: "code", cwd: state.cwd, sessionPath: null };
      case "sidecar_port":
        return 12345;
      case "agent_state":
        return state;
      case "plugin:updater|check":
      case "window_tray_intent":
        return null;
      case "set_update_available":
      case "set_remote_active":
      case "agent_prewarm":
        return null;
      case "agent_progress":
        return {
          level: 1,
          rankName: "Fixture",
          tier: 1,
          tierName: "Fixture",
          tierGlyph: "",
          effectId: "",
          xp: 0,
          xpIntoLevel: 0,
          xpForLevel: 100,
          percent: 0,
          streak: { current: 0, best: 0 },
          totals: { prompts: 0, commits: 0, linesShipped: 0, projects: 0 },
          xpBySource: { prompts: 0, commits: 0, streakBonus: 0 },
          memberSince: "2026-10-07",
          ladder: [],
          levelUp: null,
          eventNonce: null,
        };
      case "agent_serve_status":
        return { running: false, configured: false };
      case "agent_radio_state":
        return { stations: [], current: null, volume: 0 };
      case "agent_usage":
        return {
          provider: state.provider,
          displayName: "Fixture",
          connected: false,
          windows: [],
          fetchedAt: 0,
        };
      case "agent_models":
        return { models: [{ id: state.model, provider: state.provider }] };
      case "agent_commands":
        return { commands: [{ name: "help", description: "Fixture help" }] };
      case "agent_tasks":
        return { tasks: [] };
      case "agent_history":
        return {
          history: Array.from({ length: 30 }, (_, i) => ({
            role: i % 2 ? "assistant" : "user",
            text: `Fictional conversation ${i}. ${"Reading anchor. ".repeat(10)}`,
          })),
        };
      case "agent_checklist":
        if (bridge.checklist === "loading") return new Promise(() => {});
        if (bridge.checklist === "error") throw new Error("Fictional checklist load failure");
        return {
          staleAfterDays: 30,
          detectionWarnings: [],
          items: [
            {
              id: "git-github",
              group: "Source control",
              title: "Git & GitHub",
              description: "Fictional repository",
              check: "Inspect git",
              skill: null,
              setupCommand: null,
              status: "not-run",
              checkedAt: null,
              commit: null,
              uncommittedChanges: false,
              result: null,
              summary: null,
              findings: [],
              evidence: [],
              detection: null,
              runPrompt: "Fixture only; do not execute",
            },
          ],
        };
      case "agent_prompt":
        bridge.prompts.push(payload);
        return null;
      case "agent_trophies":
        return {
          trophies: [],
          categories: [],
          earned: 0,
          total: 0,
          unlocked: [],
          eventNonce: null,
        };
      case "agent_shell_trust":
        return { trusted: false };
      case "agent_cancel_queued":
        return { cancelled: true };
      case "agent_ask_user":
        return null;
      case "plugin:app|version":
        return "0.0.0";
      case "plugin:log|log":
      case "plugin:window|set_title":
        return null;
      default:
        bridge.unknown.push(command);
        console.error(`Unsupported fixture bridge call: ${command}`);
        throw new Error(`Unsupported fixture bridge call: ${command}`);
    }
  },
  { shouldMockEvents: true },
);
Object.assign(window, { motionBridge: bridge });
