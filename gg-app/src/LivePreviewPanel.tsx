import { useState } from "react";
import type { LivePreview } from "./useLivePreview";

/**
 * The Live preview tool: the project's running web app in the browser, with
 * GG Coder's chat on it. Shows the link while it runs. When no dev server runs
 * for the project, GG starts one; typing an address is the fallback.
 */
export function LivePreviewPanel({
  preview,
  onStartDevServer,
}: {
  preview: LivePreview;
  /** Asks this window's GG to start the project's dev server and open the preview. */
  onStartDevServer?: () => void;
}): React.ReactElement {
  const { status, busy, error, needsUrl } = preview;
  const [address, setAddress] = useState("");
  const [typing, setTyping] = useState(false);
  const running = Boolean(status?.running && status.url);
  const shown = bare(status?.target ?? "") || "your dev server";
  const note = busy
    ? "Looking for this project's dev server…"
    : running
      ? `Shows ${shown}. Right-click anything on the page to ask GG Coder about it, in a chat of its own.`
      : error && !needsUrl
        ? error
        : needsUrl && onStartDevServer
          ? "GG Coder starts it in the background, then opens the preview in your browser."
          : null;
  return (
    <div>
      <ul className="deck-list deck-rows" aria-label="Live preview">
        {running && status?.url ? (
          <li className="deck-row">
            <span className="row-main code" title={status.url}>
              {bare(status.url)}
            </span>
            <button type="button" className="key key-sm" onClick={preview.open}>
              Open
            </button>
            <button
              type="button"
              className="key key-sm"
              disabled={busy}
              onClick={() => void preview.stop()}
            >
              Stop
            </button>
          </li>
        ) : (
          <li className="deck-row">
            <span className="row-main">
              {needsUrl ? "No web app running" : "Your app, with GG's chat"}
            </span>
            {needsUrl && onStartDevServer ? (
              <button
                type="button"
                className="key key-sm"
                disabled={busy}
                onClick={onStartDevServer}
              >
                Start dev server
              </button>
            ) : (
              <button
                type="button"
                className="key key-sm"
                disabled={busy}
                onClick={() => void preview.start()}
              >
                Open
              </button>
            )}
            {!typing && (
              <button type="button" className="key key-sm" onClick={() => setTyping(true)}>
                Other address
              </button>
            )}
          </li>
        )}
      </ul>
      {note && (
        <p className="deck-note" role={error && !needsUrl && !busy ? "alert" : "status"}>
          {note}
        </p>
      )}
      {!running && typing && (
        <form
          className="deck-field"
          onSubmit={(e) => {
            e.preventDefault();
            if (address.trim()) void preview.start(address.trim());
          }}
        >
          <input
            type="text"
            aria-label="Dev server address"
            placeholder="Dev server address, e.g. localhost:3000"
            value={address}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoFocus
            onChange={(e) => setAddress(e.target.value)}
          />
          <button type="submit" className="key key-sm" disabled={busy || !address.trim()}>
            Open
          </button>
        </form>
      )}
    </div>
  );
}

/** An address as people say it: localhost:5173, not http://localhost:5173/. */
function bare(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}
