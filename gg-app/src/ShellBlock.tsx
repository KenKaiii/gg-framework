import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { formatElapsed } from "./ActivityBar";
import {
  SHELL_PREVIEW_LINES,
  formatShellDuration,
  plainShellOutput,
  shellSegments,
  shellTail,
  trimTrailingNewline,
} from "./shell-output";
import { useLiveText } from "./live-text";
import { toast } from "./toast";
import { basename } from "./tool-format";
import type { ShellItem } from "./transcript-item";
import type { ShellActions } from "./useShellRuns";

function useElapsed(startedAt: number | undefined, live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return startedAt === undefined ? 0 : Math.max(0, now - startedAt);
}

function ShellConfirm({
  item,
  actions,
}: {
  item: ShellItem;
  actions?: ShellActions;
}): React.ReactElement {
  return (
    <div
      className="ask-band shell-confirm"
      role="group"
      aria-label="Run this command?"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        actions?.confirm(item.id, "cancel");
      }}
    >
      <p className="ask-subq-q">Run this command?</p>
      <pre className="shell-confirm-cmd">{item.command}</pre>
      <p className="shell-confirm-where">
        In <code>{item.cwd}</code>, with your normal permissions
      </p>
      <div className="shell-confirm-actions">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          // Enter in the input asked for it, so Enter here runs it.
          autoFocus
          onClick={() => actions?.confirm(item.id, "once")}
        >
          Run once
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => actions?.confirm(item.id, "always")}
        >
          Always allow in this project
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => actions?.confirm(item.id, "cancel")}
        >
          Cancel
        </button>
        <span className="shell-confirm-keys" aria-hidden="true">
          Enter runs · Esc cancels
        </span>
      </div>
    </div>
  );
}

function exitLabel(item: ShellItem): { text: string; tone: "ok" | "bad" | "plain" } {
  if (item.status === "failed" || item.error) {
    return { text: `Couldn't run: ${item.error ?? "unknown error"}`, tone: "bad" };
  }
  if (item.cancelled) return { text: "Stopped", tone: "plain" };
  if (item.exitCode === 0) return { text: "exit 0", tone: "ok" };
  return { text: `exit ${item.exitCode ?? "?"}`, tone: "bad" };
}

function ShellRun({
  item,
  actions,
  onGrow,
}: {
  item: ShellItem;
  actions?: ShellActions;
  onGrow?: () => void;
}): React.ReactElement {
  const { text } = useLiveText(item.id, item.output);
  const running = item.status === "running";
  const elapsed = useElapsed(item.startedAt, running);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const { start, total } = shellTail(text);
  const folded = total > SHELL_PREVIEW_LINES && !expanded;
  const segments = trimTrailingNewline(shellSegments(text, folded ? start : 0));

  useEffect(() => {
    onGrow?.();
  }, [text, expanded, onGrow]);

  const copy = (): void => {
    void navigator.clipboard
      .writeText(plainShellOutput(text).replace(/\n$/, ""))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => toast("Couldn't copy to the clipboard.", "error"));
  };

  const exit = exitLabel(item);
  const note = item.truncated
    ? item.restored
      ? "Saved output shows the last lines only"
      : "Output stopped showing after 1 MB"
    : null;
  return (
    <div className="shell-run" role="group" aria-label={`Command: ${item.command}`}>
      <div className="shell-run-head">
        <code className="shell-run-cmd">
          <span className="shell-run-prompt" aria-hidden="true">
            $
          </span>
          {item.command}
        </code>
        <span className="shell-run-cwd" title={item.cwd}>
          {basename(item.cwd)}
        </span>
      </div>
      {(text || running) && (
        <pre className={`shell-run-out${folded ? " folded" : ""}`}>
          {segments.map((seg, i) =>
            seg.error ? (
              <span key={i} className="shell-run-err">
                {seg.text}
              </span>
            ) : (
              seg.text
            ),
          )}
        </pre>
      )}
      {total > SHELL_PREVIEW_LINES && (
        <button type="button" className="shell-run-more" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : `Show all ${total.toLocaleString()} lines`}
        </button>
      )}
      <div className="shell-run-foot">
        {running ? (
          <span className="shell-run-status">Running · {formatElapsed(elapsed)}</span>
        ) : (
          <span className={`shell-run-status is-${exit.tone}`} role="status">
            {exit.text}
          </span>
        )}
        {!running && item.durationMs !== undefined && item.status !== "failed" && (
          <span>{formatShellDuration(item.durationMs)}</span>
        )}
        {note && <span>{note}</span>}
        {item.status !== "failed" && (
          <span className="shell-run-share">
            {item.shared ? "Shared with GG" : "GG will see this with your next message"}
          </span>
        )}
        {running ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => actions?.stop(item.id)}
            aria-label={`Stop ${item.command}`}
          >
            Stop
          </button>
        ) : (
          text && (
            <button
              type="button"
              className="btn btn-sm btn-ghost shell-run-copy"
              onClick={copy}
              aria-label={copied ? "Copied" : "Copy output"}
            >
              {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
              {copied ? "Copied" : "Copy"}
            </button>
          )
        )}
      </div>
    </div>
  );
}

export function ShellBlock({
  item,
  actions,
  onGrow,
}: {
  item: ShellItem;
  actions?: ShellActions;
  onGrow?: () => void;
}): React.ReactElement {
  if (item.status === "confirm") return <ShellConfirm item={item} actions={actions} />;
  if (item.status === "declined") {
    return (
      <p className="shell-declined">
        Didn't run <code>{item.command}</code>
      </p>
    );
  }
  return <ShellRun item={item} actions={actions} onGrow={onGrow} />;
}
