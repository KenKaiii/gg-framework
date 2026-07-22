import { useCallback, useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { error as logError, info as logInfo } from "@tauri-apps/plugin-log";

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

export function useAppUpdate(): UpdateInfo {
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [progress, setProgress] = useState<number | null>(null);
  const [fakeVersion, setFakeVersion] = useState<string | null>(null);

  const runCheck = useCallback(async (): Promise<void> => {
    if (devFakeEnabled) {
      setFakeVersion(FAKE_VERSION);
      setPhase((p) => (p === "installing" ? p : "available"));
      return;
    }
    // Don't interrupt an in-flight install with a re-check.
    setPhase((p) => (p === "installing" ? p : "checking"));
    try {
      const found = await check();
      if (found?.available) {
        setUpdate(found);
        setPhase((p) => (p === "installing" ? p : "available"));
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
    return () => clearInterval(id);
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
