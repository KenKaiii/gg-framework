import { useCallback, useEffect, useState } from "react";
import {
  getLivePreviewStatus,
  openUrl,
  startLivePreview,
  stopLivePreview,
  subscribe,
  type LivePreviewStatus,
} from "./agent";

export interface LivePreview {
  status: LivePreviewStatus | null;
  busy: boolean;
  error: string | null;
  /** No dev server was found: the panel asks for its address. */
  needsUrl: boolean;
  /** Start (or reuse) the preview, then open it in the browser. */
  start: (url?: string) => Promise<void>;
  stop: () => Promise<void>;
  open: () => void;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** This window's live preview. The agent can start one too: the sidecar says so with `live_preview`. */
export function useLivePreview(enabled: boolean): LivePreview {
  const [status, setStatus] = useState<LivePreviewStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsUrl, setNeedsUrl] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    getLivePreviewStatus()
      .then((s) => live && setStatus(s))
      .catch(() => {});
    const off = subscribe((e) => {
      if (e.type === "live_preview" && e.data && typeof e.data === "object")
        setStatus(e.data as LivePreviewStatus);
    });
    return () => {
      live = false;
      off();
    };
  }, [enabled]);

  const start = useCallback(async (url?: string) => {
    setBusy(true);
    setError(null);
    try {
      const next = await startLivePreview(url);
      setStatus(next);
      setNeedsUrl(Boolean(next.needsUrl));
      setError(next.error ?? null);
      if (next.running && next.url) await openUrl(next.url);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const stop = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await stopLivePreview());
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const open = useCallback(() => {
    if (status?.url) void openUrl(status.url);
  }, [status]);

  return { status, busy, error, needsUrl, start, stop, open };
}
