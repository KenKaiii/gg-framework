import { useCallback, useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { error as logError, info as logInfo } from "@tauri-apps/plugin-log";
import { playSound } from "./sounds";
import { announceUpdate } from "./update-announce";
import { claimUpdateCheck, recordUpdateCheck, versionFromStorageEvent } from "./update-schedule";

/**
 * App self-update, driven by the Tauri updater plugin (GitHub releases of this
 * repo — see `plugins.updater` in tauri.conf.json). One shared hook powers both
 * the footer banner and the home-screen button: it polls for an update on mount
 * + hourly, and `install()` downloads → installs → relaunches the app.
 */

export type UpdatePhase = "idle" | "checking" | "available" | "installing" | "error";

export interface UpdateInfo {
  /** The pending update (null until one is detected). */
  update: Update | null;
  /** Newer version string, e.g. "0.2.0" (null when up to date). */
  version: string | null;
  phase: UpdatePhase;
  /** Download progress 0–100 while installing (null otherwise). */
  progress: number | null;
  /** Kick off download → install → relaunch. No-op unless an update is pending. */
  install: () => Promise<void>;
}

const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
/** In-window signal: one hook's check found an update the others should load. */
const UPDATE_FOUND_EVENT = "gg-update-found";

/**
 * DEV ONLY — fake a pending update so the banner + home button + install flow
 * can be eyeballed before any real GitHub release exists. Flip to `false` (or
 * just ship a production build, where it's ignored) to disable. The simulated
 * install runs a fake download-progress sweep without downloading or
 * relaunching, then returns to "available" so the flow can be re-tested.
 * Set to `true` only while visually testing the update UI locally.
 */
const DEV_FAKE_UPDATE = false;
const devFakeEnabled = import.meta.env.DEV && DEV_FAKE_UPDATE;
const FAKE_VERSION = "9.9.9";

function storageOrNull(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** The update-ready sound, once per version across every window. */
function announce(version: string): void {
  announceUpdate(version, storageOrNull(), () => playSound("updateReady"));
}

export function useAppUpdate(): UpdateInfo {
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [progress, setProgress] = useState<number | null>(null);
  const [fakeVersion, setFakeVersion] = useState<string | null>(null);

  const hasUpdateRef = useRef(false);

  const runCheck = useCallback(async (force = false): Promise<void> => {
    if (devFakeEnabled) {
      setFakeVersion(FAKE_VERSION);
      setPhase((p) => (p === "installing" ? p : "available"));
      announce(FAKE_VERSION);
      return;
    }
    // One check per lease across all windows/hooks (update-schedule.ts).
    const storage = storageOrNull();
    const decision = force ? { kind: "check" as const } : claimUpdateCheck(storage, Date.now());
    if (decision.kind === "skip") return;
    // Don't interrupt an in-flight install with a re-check.
    setPhase((p) => (p === "installing" ? p : "checking"));
    try {
      const found = await check();
      hasUpdateRef.current = Boolean(found?.available);
      if (decision.kind === "check") {
        recordUpdateCheck(storage, Date.now(), found?.available ? found.version : null);
        // storage events skip the writing window; tell this window's other hook.
        if (found?.available) window.dispatchEvent(new Event(UPDATE_FOUND_EVENT));
      }
      if (found?.available) {
        setUpdate(found);
        setPhase((p) => (p === "installing" ? p : "available"));
        announce(found.version);
        logInfo(`Update available: ${found.version}`);
      } else {
        setUpdate(null);
        setPhase((p) => (p === "installing" ? p : "idle"));
      }
    } catch (e) {
      // No endpoint / no release yet / offline — stay quiet, just no banner.
      setPhase((p) => (p === "installing" ? p : "idle"));
      logError(`Update check failed: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    void runCheck();
    const id = setInterval(() => void runCheck(), POLL_INTERVAL_MS);
    // Another window's check found an update: fetch this window's own handle.
    const onStorage = (e: StorageEvent): void => {
      if (!hasUpdateRef.current && versionFromStorageEvent(e.key, e.newValue)) void runCheck(true);
    };
    const onFound = (): void => {
      if (!hasUpdateRef.current) void runCheck(true);
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(UPDATE_FOUND_EVENT, onFound);
    return () => {
      clearInterval(id);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(UPDATE_FOUND_EVENT, onFound);
    };
  }, [runCheck]);

  const install = useCallback(async (): Promise<void> => {
    if (devFakeEnabled) {
      // Simulate a download sweep without touching disk or relaunching. Uneven
      // steps read like a real download; afterwards we land back on
      // "available" so the banner → progress flow can be eyeballed repeatedly.
      setPhase("installing");
      setProgress(0);
      logInfo("[dev] Simulating update install\u2026");
      let pct = 0;
      while (pct < 100) {
        await new Promise((r) => setTimeout(r, 220));
        pct = Math.min(100, pct + 3 + Math.floor(Math.random() * 9));
        setProgress(pct);
      }
      await new Promise((r) => setTimeout(r, 1200));
      logInfo("[dev] Fake install done (no relaunch in dev).");
      setProgress(null);
      setPhase("available");
      return;
    }
    if (!update) return;
    setPhase("installing");
    setProgress(0);
    try {
      let total = 0;
      let downloaded = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          // Cap at 99 until Finished — the install + relaunch tail isn't
          // download time, so 100% early would lie.
          if (total > 0) setProgress(Math.min(99, Math.round((downloaded / total) * 100)));
        } else {
          setProgress(100);
        }
      });
      await relaunch();
    } catch (e) {
      setPhase("error");
      setProgress(null);
      logError(`Update install failed: ${String(e)}`);
    }
  }, [update]);

  return {
    update,
    version: update?.version ?? fakeVersion,
    phase,
    progress,
    install,
  };
}
