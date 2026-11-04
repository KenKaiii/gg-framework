import { useEffect, useState } from "react";
import type { CacheExpiryStatus } from "../agent";

/**
 * Placeholder (the fork owns the desktop design): warns that the provider's
 * prompt cache for this chat has lapsed, so the next message re-reads the whole
 * context at full price.
 *
 * Shown only when the cache is expired, the context is large enough to matter
 * (the sidecar's `minTokens`) and no run is active. "Compact first" shrinks the
 * context before paying for the re-read; "Send anyway" dismisses. Either choice
 * holds once per expiry per chat: the key is the session plus the last
 * cache-anchoring request, so a fresh request and a later lapse show it again.
 */

/** Keys already acted on this app session; module-level so a remount (chat
 *  switch and back) does not bring back a dismissed notice. */
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

interface Props {
  expiry: CacheExpiryStatus | null | undefined;
  running: boolean;
  onCompact: () => void;
}

export function CacheExpiryNotice({
  expiry,
  running,
  onCompact,
}: Props): React.ReactElement | null {
  const [, setDismissTick] = useState(0);
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

  if (!expiry || running) return null;
  const expired = expiry.expired || (expiry.expiresAt !== null && now >= expiry.expiresAt);
  if (!expired || expiry.prefixTokens < expiry.minTokens) return null;
  const key = expiryKey(expiry);
  if (dismissed.has(key)) return null;

  const dismiss = (): void => {
    dismissed.add(key);
    setDismissTick((n) => n + 1);
  };
  const lead =
    expiry.confidence === "may_be_cold"
      ? "This chat's cache may have expired"
      : "This chat's cache expired";

  return (
    <div role="status" aria-label="Prompt cache expired" style={{ color: "var(--text-muted)" }}>
      <span>
        {lead} — your next message re-reads {formatTokens(expiry.prefixTokens)} tokens at full
        price.
      </span>{" "}
      <button
        type="button"
        title="Summarize older history first, so the next message re-reads less"
        onClick={() => {
          dismiss();
          onCompact();
        }}
      >
        Compact first
      </button>{" "}
      <button type="button" title="Dismiss — send your next message as is" onClick={dismiss}>
        Send anyway
      </button>
    </div>
  );
}
