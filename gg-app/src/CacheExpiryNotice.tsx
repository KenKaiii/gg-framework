import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { theme } from "./theme";
import type { CacheExpiryStatus } from "./agent";
import { pinSize, usePresenceList } from "./usePresenceList";

/**
 * Strip above the composer warning that the provider's prompt cache for this
 * chat has lapsed, so the next message re-reads the whole context at full
 * price (mirrors langchain-ai/deepagents#6477's cold-cache notice).
 *
 * Shown only when the cache is expired, the context is large enough to matter
 * (the sidecar's `minTokens`, 40k), and no run is active. "Compact first"
 * shrinks the context before paying for the re-read; "Dismiss" hides it.
 * Either choice is remembered once per expiry per chat: the key is the session
 * plus the last cache-anchoring request, so a fresh request (which re-warms the
 * cache) and a later lapse show the notice again — but a re-render, a /state
 * poll, or a remount for the same lapse does not.
 *
 * Uses the `.queued-bar*` strip classes so both strips share one look and
 * one motion: it grows open when shown and folds shut when hidden (dismiss,
 * compact, or a run starting), held mounted for EXIT_MS so the exit can play.
 * Sending a message hides it at once instead: the send is the choice the
 * notice asked about, and it must leave in the send's own layout commit
 * (see usePresenceList's `flush`) rather than when the run starts.
 */

/** Exit duration of `.queued-bar.leaving`: equal to `--dur-strip-out` in App.css; scripts/motion-tokens.test.mjs enforces it. */
const EXIT_MS = 220;

/** Keys already acted on this app session. Module-level so a remount (chat
 *  switch and back) does not resurrect a notice the user dismissed. */
const dismissed = new Set<string>();

/** Test-only: forget dismissals between cases. */
export function resetCacheExpiryNoticeDismissals(): void {
  dismissed.clear();
}

function expiryKey(expiry: CacheExpiryStatus): string {
  return `${expiry.sessionId ?? ""}:${expiry.provider}:${expiry.lastRequestAt ?? "unknown"}`;
}

/** "~120k" style token count. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `~${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (tokens >= 1_000) return `~${Math.round(tokens / 1_000)}k`;
  return `~${tokens}`;
}

/** What the strip says, snapshotted so the exit keeps showing the last copy. */
interface Shown {
  readonly key: string;
  readonly lead: string;
  readonly tokens: string;
}

const keyOfShown = (s: Shown): string => s.key;

interface Props {
  expiry: CacheExpiryStatus | null | undefined;
  running: boolean;
  onCompact: () => void;
  /** Composer sends so far. A change hides the notice in that same commit. */
  sendCount?: number;
}

export function CacheExpiryNotice({
  expiry,
  running,
  onCompact,
  sendCount = 0,
}: Props): React.ReactElement | null {
  const [, setDismissTick] = useState(0);
  // The expiry a send went out under. A later lapse has a new key and shows
  // again; until then the send already answered this one.
  const [seenSendCount, setSeenSendCount] = useState(sendCount);
  const [sentKey, setSentKey] = useState<string | null>(null);
  let hiddenKey = sentKey;
  if (sendCount !== seenSendCount) {
    hiddenKey = expiry ? expiryKey(expiry) : null;
    setSeenSendCount(sendCount);
    setSentKey(hiddenKey);
  }
  const [now, setNow] = useState(() => Date.now());

  // /state is a snapshot: a chat left open past its TTL must flip to expired
  // without a refetch, so wake once at the known expiry time.
  const expiresAt = expiry && !expiry.expired ? expiry.expiresAt : null;
  useEffect(() => {
    if (expiresAt === null) return;
    const delay = expiresAt - Date.now();
    if (delay <= 0) {
      setNow(Date.now());
      return;
    }
    const timer = setTimeout(() => setNow(Date.now()), Math.min(delay, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [expiresAt]);

  let liveKey: string | null = null;
  let liveLead = "";
  let liveTokens = "";
  if (expiry && !running) {
    const expired = expiry.expired || (expiry.expiresAt !== null && now >= expiry.expiresAt);
    const key = expiryKey(expiry);
    if (
      expired &&
      expiry.prefixTokens >= expiry.minTokens &&
      !dismissed.has(key) &&
      key !== hiddenKey
    ) {
      liveKey = key;
      liveTokens = formatTokens(expiry.prefixTokens);
      liveLead =
        expiry.confidence === "may_be_cold"
          ? "This chat's cache may have expired"
          : "This chat's cache expired";
    }
  }
  // Stable identity: usePresenceList re-merges whenever the list changes.
  const items = useMemo<readonly Shown[]>(
    () => (liveKey === null ? [] : [{ key: liveKey, lead: liveLead, tokens: liveTokens }]),
    [liveKey, liveLead, liveTokens],
  );
  const shown = usePresenceList(items, keyOfShown, EXIT_MS, sendCount);
  // A new lapse can arrive while the previous one is still folding away; the
  // live one wins.
  const current = shown.find((p) => !p.leaving) ?? shown[0];
  const leaving = current?.leaving ?? false;
  const empty = current === undefined;
  const barRef = useRef<HTMLDivElement>(null);
  // Measure on mount (enter grows to this height) and again when leaving starts
  // (exit folds from it), so neither end guesses the strip's height.
  useLayoutEffect(() => pinSize(barRef.current), [leaving, empty]);

  if (!current) return null;
  const { key, lead, tokens } = current.item;
  const dismiss = (): void => {
    dismissed.add(key);
    setDismissTick((n) => n + 1);
  };

  return (
    <div
      ref={barRef}
      className={`queued-bar${leaving ? " leaving" : ""}`}
      role="status"
      aria-label="Prompt cache expired"
      aria-hidden={leaving || undefined}
      inert={leaving}
      style={{ borderColor: theme.border, color: theme.textMuted }}
    >
      <div className="queued-bar-row">
        <span className="queued-bar-text">
          {lead} — your next message re-reads {tokens} tokens at full price.
        </span>
        <button
          type="button"
          className="queued-toggle"
          style={{ color: theme.secondary }}
          title="Summarize older history first, so the next message re-reads less"
          onClick={() => {
            dismiss();
            onCompact();
          }}
        >
          Compact first
        </button>
        <button
          type="button"
          className="queued-toggle"
          style={{ color: theme.textDim }}
          title="Hide this. Your next message sends as is"
          onClick={dismiss}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
