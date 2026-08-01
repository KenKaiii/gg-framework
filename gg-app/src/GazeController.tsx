import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { gazeFocus, onGazeTarget, windowLabel } from "./agent";
import type { SafeTauriUnlisten } from "./tauri-listener";
import { error as logError, info as logInfo } from "@tauri-apps/plugin-log";
import { createDwellTracker, createPointSmoother } from "./gaze/smoothing";
import { createMouseTracker } from "./gaze/mouse-tracker";
import { loadGazeConfig, type GazeTracker } from "./gaze/types";
import { isGazeEnabled, onGazeEnabledChange, toggleGazeEnabled } from "./gaze/state";

// Webcam gaze → window focus. Look at a tiled window and, after a short dwell,
// it gets keyboard focus; a soft border highlights the window your gaze rests on.
//
// Single camera owner: only the `main` window runs the tracker (one webcam, one
// model). EVERY window listens for the `gaze-target` broadcast and paints its
// own border, so focus/highlight works across all tiled windows.
//
// Toggle with Cmd/Ctrl+Shift+G. State is shared via localStorage so the choice
// persists and new windows inherit it. Pick the source with
// localStorage "gg-app:gaze:tracker" = "camera" (default) | "mouse" (dev).

const isMain = windowLabel === "main";

// The MediaPipe tracker (and its bundled model loader) is lazy-imported so the
// vision JS never loads until gaze is actually switched on.
async function makeTracker(): Promise<GazeTracker> {
  if (localStorage.getItem("gg-app:gaze:tracker") === "mouse") return createMouseTracker();
  const { createMediaPipeTracker } = await import("./gaze/mediapipe-tracker");
  return createMediaPipeTracker();
}

export function GazeController(): React.ReactElement | null {
  const [enabled, setEnabled] = useState<boolean>(isGazeEnabled);
  // This window's highlight state, driven by the gaze-target broadcast.
  const [highlight, setHighlight] = useState<"none" | "hover" | "focused">("none");
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");

  // Hotkey: Cmd/Ctrl+Shift+G toggles (shares state with the nav button).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "g" || e.key === "G")) {
        e.preventDefault();
        toggleGazeEnabled();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Sync the local flag with any toggle source (nav button, hotkey, other window).
  useEffect(() => onGazeEnabledChange(setEnabled), []);

  // Every window: render its own border from the broadcast. The committed
  // (focused) window holds the solid ring; the un-committed gaze target shows
  // the soft "dwelling here" highlight.
  useEffect(() => {
    let disposed = false;
    let unlisten: SafeTauriUnlisten | undefined;
    void onGazeTarget((ev) => {
      if (ev.committed === windowLabel) setHighlight("focused");
      else if (ev.target === windowLabel) setHighlight("hover");
      else setHighlight("none");
    }).then((stop) => {
      if (disposed) void stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      void unlisten?.();
    };
  }, []);

  // Clear this window's border the instant gaze is turned off. The `enabled`
  // flag is synced to every window, so each clears its own stale highlight
  // (otherwise the last broadcast would leave a window ringed after disabling).
  useEffect(() => {
    if (!enabled) setHighlight("none");
  }, [enabled]);

  // Only the main window owns the camera + decision loop.
  useEffect(() => {
    if (!isMain || !enabled) return;
    let tracker: GazeTracker | null = null;
    let disposed = false;
    const cfg = loadGazeConfig();
    const smoother = createPointSmoother(cfg.smoothing);
    const dwell = createDwellTracker(cfg.dwellMs);
    let lastCall = 0;
    let inFlight = false;
    // The window the controller has committed focus to (persists the ring).
    let committed: string | null = null;

    async function onSample(s: {
      nx: number;
      ny: number;
      confidence: number;
      ts: number;
    }): Promise<void> {
      if (s.confidence < cfg.minConfidence) return;
      if (s.ts - lastCall < cfg.throttleMs || inFlight) return;
      lastCall = s.ts;
      const { nx, ny } = smoother.push(s.nx, s.ny);
      inFlight = true;
      try {
        const label = await gazeFocus(nx, ny, false, committed);
        const decision = dwell.update(label, s.ts);
        if (decision.commit) {
          committed = decision.target;
          await gazeFocus(nx, ny, true, committed);
        }
      } finally {
        inFlight = false;
      }
    }

    (async () => {
      try {
        setStatus("starting…");
        tracker = await makeTracker();
        setStatus(`starting ${tracker.kind}…`);
        await tracker.start((s) => void onSample(s));
        if (!disposed) {
          setStatus(tracker.kind);
          setError("");
          void logInfo(`gaze: tracker started (${tracker.kind})`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setStatus("");
        void logError(`gaze: tracker failed: ${msg}`);
      }
    })();

    return () => {
      disposed = true;
      tracker?.stop();
      smoother.reset();
      dwell.reset();
      setStatus("");
    };
  }, [enabled]);

  return (
    <>
      {highlight !== "none" && <div className={`gaze-frame gaze-frame-${highlight}`} aria-hidden />}
      {isMain && enabled && (
        <div className="gaze-pill" role="status">
          {error ? <EyeOff size={13} /> : <Eye size={13} />}
          <span>{error ? `gaze: ${error}` : `gaze: ${status || "off"}`}</span>
        </div>
      )}
    </>
  );
}
