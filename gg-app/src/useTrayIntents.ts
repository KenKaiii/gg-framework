import {
  useState,
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  setUpdateAvailable,
  waitForReady,
  getServeStatus,
  setRemoteActive as setRemoteActiveIPC,
  type TrayIntent,
  stopServe,
  startServe,
  onTrayIntent,
  takeTrayIntent,
  type WorkspaceMode,
} from "./agent";
import type { EntryView } from "./app-entry-view";
import { talkToKleio } from "./kleio/VoiceMode";
import { useAppUpdate } from "./update";
import { toast } from "./toast";

export function useTrayIntents({
  needsProject,
  setWorkspaceMode,
  setEntryView,
  setShowPicker,
}: {
  needsProject: boolean;
  setWorkspaceMode: Dispatch<SetStateAction<WorkspaceMode>>;
  setEntryView: Dispatch<SetStateAction<EntryView>>;
  setShowPicker: Dispatch<SetStateAction<boolean>>;
}) {
  // App self-update (GitHub releases). Drives the footer update banner.
  const appUpdate = useAppUpdate();

  // ── macOS menu-bar tray ───────────────────────────────────────────────────
  // Settings opened from the tray. Owned HERE, not by HomeScreen, because the
  // tray targets a WINDOW and that window may be showing Home, a picker, or a
  // live workspace — only App renders in all three.
  const [showTraySettings, setShowTraySettings] = useState(false);
  // Bumped to ask HomeScreen to re-read serve/auth state after the tray changed
  // it. A counter, not a boolean, so repeat tray clicks always re-fire.
  const [homeRefreshSignal, setHomeRefreshSignal] = useState(0);

  const closeTraySettings = useCallback((): void => {
    setShowTraySettings(false);
    // Home gates Code/Chat on the projects folder + a provider; re-read them in
    // case this modal is where they were just set.
    setHomeRefreshSignal((n) => n + 1);
  }, []);

  // Rust owns the tray menu but not the updater — the webview polls GitHub. Push
  // availability down so "Update now" shows only while an update is pending.
  const updateVersion = appUpdate.phase === "available" ? appUpdate.version : null;
  useEffect(() => {
    void setUpdateAvailable(updateVersion);
  }, [updateVersion]);

  // Remote (the Telegram serve loop) lives in the sidecar, so the tray can't
  // know its state — poll it and push it down, which keeps the menu item's label
  // honest even when Remote is toggled from Home or another window. Nothing in
  // React renders it, so this returns the value instead of holding state; Rust
  // is the one that needs it, and it already de-dupes unchanged pushes.
  const syncRemote = useCallback(async (): Promise<boolean> => {
    try {
      await waitForReady();
      const { running } = await getServeStatus();
      void setRemoteActiveIPC(running);
      return running;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    void syncRemote();
    const id = setInterval(() => void syncRemote(), 30_000);
    return () => clearInterval(id);
  }, [syncRemote]);

  const applyTrayIntent = useCallback(
    (intent: TrayIntent): void => {
      switch (intent) {
        case "update":
          void appUpdate.install();
          break;
        // Talk to Kleio (or hear the briefing) over whatever this window shows.
        case "brief":
          void talkToKleio();
          break;
        // Route to the session picker for the requested mode. On Home that's the
        // entry view; over an open workspace it's the picker overlay, which keeps
        // the running session intact until a different one is chosen.
        case "new-chat":
        case "new-code": {
          const mode = intent === "new-chat" ? "chat" : "code";
          setWorkspaceMode(mode);
          if (needsProject) setEntryView(mode === "chat" ? "chats" : "projects");
          else setShowPicker(true);
          break;
        }
        // A toggle, matching the menu item's label. Re-read the live status
        // first rather than trusting the poll, so a stale cache can't start a
        // second serve loop or stop one the user just started elsewhere.
        case "remote":
          void syncRemote()
            .then(async (running) => {
              if (running) {
                await stopServe();
                toast("Remote is off.", "success");
              } else {
                await startServe();
                toast("Remote is on.", "success");
              }
            })
            .catch((e: unknown) => toast(`Remote failed: ${String(e)}`, "error"))
            .finally(() => {
              void syncRemote();
              setHomeRefreshSignal((n) => n + 1);
            });
          break;
        case "settings":
          setShowTraySettings(true);
          break;
      }
    },
    [appUpdate, needsProject, syncRemote, setEntryView, setShowPicker, setWorkspaceMode],
  );

  // The handler is re-created on most renders (it closes over `appUpdate`, a
  // fresh object each render). Holding it in a ref keeps the Tauri listener
  // registered exactly ONCE for the window's lifetime — re-subscribing per
  // render raced listen/unlisten and threw inside the event plugin.
  const trayIntentRef = useRef(applyTrayIntent);
  useEffect(() => {
    trayIntentRef.current = applyTrayIntent;
  }, [applyTrayIntent]);

  // Two delivery paths, because a window built BY the tray isn't listening yet
  // when the menu is clicked: an existing window gets the event, a new one
  // claims the parked intent on mount.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void onTrayIntent((intent) => trayIntentRef.current(intent)).then((un) => {
      if (disposed) un();
      else unlisten = un;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    void takeTrayIntent().then((intent) => {
      if (intent) applyTrayIntent(intent);
    });
    // Mount-only: the parked intent is consumed once, by the window it opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return {
    appUpdate,
    showTraySettings,
    homeRefreshSignal,
    setHomeRefreshSignal,
    closeTraySettings,
  };
}
