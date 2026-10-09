import { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { error as logError, attachConsole } from "@tauri-apps/plugin-log";
import App from "./App";
import { AppErrorBoundary } from "./AppErrorBoundary";
import { ZoomController } from "./ZoomController";
import { TooltipLayer } from "./TooltipLayer";
import { WhatsNewModal } from "./WhatsNewModal";
import { tagPlatform } from "./platform";
import { parseMode } from "./whatsnew-content";
import { installMotionAttribute } from "./window-motion";

// Release history belongs to the notes window, not every workspace's startup.
const WhatsNewWindow = lazy(() =>
  import("./WhatsNewWindow").then((module) => ({ default: module.WhatsNewWindow })),
);
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

// <html data-motion> drives every CSS loop's play state (App.css), so set it
// before the first paint: a window restored in the background starts still.
installMotionAttribute();

// React render/effect failures land in the shared log file like window errors do.
function captureReactError(culprit: string, error: unknown, componentStack?: string): void {
  void logError(`${culprit}: ${String(error)}${componentStack ? `\n${componentStack}` : ""}`);
}

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement, {
  onUncaughtError: (error, info) => captureReactError("react.uncaught", error, info.componentStack),
  onCaughtError: (error, info) => captureReactError("react.caught", error, info.componentStack),
  onRecoverableError: (error, info) =>
    captureReactError("react.recoverable", error, info.componentStack),
});

// The dedicated, screen-centered "What's new" window reuses this same entry with
// a `?whatsnew=1` flag (see Rust `open_whatsnew_window`). Render ONLY the notes
// for that window — no agent, no sidecar, no app shell.
const params = new URLSearchParams(window.location.search);
if (params.get("whatsnew") === "1") {
  // Mark the root so the stylesheet can make html/body transparent — the native
  // window is transparent (see Rust `open_whatsnew_window`) so the rounded card's
  // corners show through instead of sitting on a hard rectangular window edge.
  document.documentElement.classList.add("whatsnew-root");
  root.render(
    <Suspense fallback={null}>
      <WhatsNewWindow mode={parseMode(params.get("mode"))} />
    </Suspense>,
  );
} else {
  // No StrictMode: its intentional double-invocation of effects and state
  // updaters double-registers the single Tauri `agent-event` listener and was
  // amplifying state-updater impurity. A desktop webview gains nothing from it.
  root.render(
    <>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
      <ZoomController />
      <TooltipLayer />
      <WhatsNewModal />
    </>,
  );
}
