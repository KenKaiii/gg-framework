import ReactDOM from "react-dom/client";
// Error Mom capture must load before anything else so startup failures are
// reported too. No-ops when VITE_ERROR_MOM_* env vars are absent.
import "./error-mom";
import { error as logError, attachConsole } from "@tauri-apps/plugin-log";
// Self-hosted Geist Sans + Mono (bundled by Vite → works offline in the
// packaged app). Imported before App so the @font-face rules land ahead of the
// stylesheet that references them.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import App from "./App";
import { ZoomController } from "./ZoomController";
import { WhatsNewModal } from "./WhatsNewModal";
import { WhatsNewWindow } from "./WhatsNewWindow";
// Experimental: webcam gaze → window focus. Disabled for now; re-enable by
// uncommenting this import + the <GazeController /> mount below (and the
// <GazeButton /> in App.tsx). The full implementation lives in src/gaze/.
// import { GazeController } from "./GazeController";
import { tagPlatform } from "./platform";

// Mirror Rust-side logs into the devtools console, and forward uncaught
// webview errors into the shared log file so failures aren't invisible.
void attachConsole();
window.addEventListener("error", (e) => {
  void logError(`window.error: ${e.message}`);
});
window.addEventListener("unhandledrejection", (e) => {
  void logError(`unhandledrejection: ${String(e.reason)}`);
});

// Tag <html> with the host OS class (platform-macos|windows|linux) before the
// first render so CSS can gate the macOS-only traffic-light insets.
tagPlatform();

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

// The dedicated, screen-centered "What's new" window reuses this same entry with
// a `?whatsnew=1` flag (see Rust `open_whatsnew_window`). Render ONLY the notes
// for that window — no agent, no sidecar, no app shell.
if (new URLSearchParams(window.location.search).get("whatsnew") === "1") {
  // Mark the root so the stylesheet can make html/body transparent — the native
  // window is transparent (see Rust `open_whatsnew_window`) so the rounded card's
  // corners show through instead of sitting on a hard rectangular window edge.
  document.documentElement.classList.add("whatsnew-root");
  root.render(<WhatsNewWindow />);
} else {
  // No StrictMode: its intentional double-invocation of effects and state
  // updaters double-registers the single Tauri `agent-event` listener and was
  // amplifying state-updater impurity. A desktop webview gains nothing from it.
  root.render(
    <>
      <App />
      <ZoomController />
      <WhatsNewModal />
      {/* <GazeController /> */}
    </>,
  );
}
