import { useCallback, useEffect, useRef, useState } from "react";
import { worldLive } from "./agent";

/** Game -> server messages larger than this (UTF-8 bytes) are dropped, as the server would. */
export const WORLD_LIVE_MAX_BYTES = 2048;
/** World paused (app switched away) this long closes the socket; resuming reopens it. */
export const WORLD_LIVE_PAUSE_MS = 60_000;
/** Reconnect waits 2 s, 4 s, 8 s ... capped here. */
export const WORLD_LIVE_MAX_BACKOFF_MS = 30_000;
/** Give up (reason 'offline') after this many failed reconnects in a row. */
export const WORLD_LIVE_MAX_TRIES = 8;

export type WorldLiveState = "off" | "connecting" | "online";
/** Why the live world is off (MULTIPLAYER.md §5). */
export type WorldLiveOffReason =
  "offline" | "kicked" | "banned" | "elsewhere" | "consent" | "deleted" | "error";

/** Server close codes: every one is final for this World session. */
const FINAL_CODES: Readonly<Record<number, WorldLiveOffReason>> = {
  4000: "elsewhere",
  4001: "banned",
  4002: "kicked",
  4003: "consent",
  4004: "deleted",
};

function backoff(tries: number): number {
  return Math.min(WORLD_LIVE_MAX_BACKOFF_MS, 2000 * 2 ** tries);
}

function readTicket(body: unknown): { ticket: string; url: string; world: string | null } | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.ticket !== "string" || typeof b.url !== "string") return null;
  if (!b.url.startsWith("wss://") && !b.url.startsWith("ws://localhost")) return null;
  return { ticket: b.ticket, url: b.url, world: typeof b.world === "string" ? b.world : null };
}

/**
 * GG World's live world (MULTIPLAYER.md §1, §3). The app, not the sealed game,
 * owns the socket: when `enabled` (online save on and loaded) it gets a
 * one-time ticket from the sidecar, connects, relays every server message to
 * the game as `{ t: 'live', m }` and the game's `{ t: 'live', m }` to the
 * server. Reconnects with a fresh ticket (2/4/8.. max 30 s) unless the server
 * ended the session (close 4000-4004, ticket 403) or retrying gave up: those
 * stay off, with a reason for the game, until World is reopened (remount) or
 * live is turned off and on again. Closes when disabled, unmounted or paused
 * for over 60 s.
 */
export function useWorldLive({
  enabled,
  paused,
  post,
}: {
  enabled: boolean;
  paused: boolean;
  post: (msg: Record<string, unknown>) => void;
}): { state: WorldLiveState; onGameMessage: (data: { t?: unknown; m?: unknown }) => boolean } {
  const [idle, setIdle] = useState(false);
  const [state, setState] = useState<WorldLiveState>("off");
  const [ended, setEnded] = useState(false);
  const postRef = useRef(post);
  const socket = useRef<WebSocket | null>(null);
  useEffect(() => {
    postRef.current = post;
  }, [post]);

  useEffect(() => {
    if (!paused) {
      setIdle(false);
      return;
    }
    const t = window.setTimeout(() => setIdle(true), WORLD_LIVE_PAUSE_MS);
    return () => window.clearTimeout(t);
  }, [paused]);

  useEffect(() => {
    if (!enabled) setEnded(false);
  }, [enabled]);

  const active = enabled && !idle && !ended;
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let tries = 0;
    let timer: number | null = null;
    let world: string | null = null;
    let count: number | undefined;
    let retrying = false;
    const status = (s: "connecting" | "online"): void => {
      setState(s);
      const msg: Record<string, unknown> = { t: "live-status", state: s };
      if (s === "online") {
        if (world !== null) msg.world = world;
        if (count !== undefined) msg.count = count;
      } else if (retrying) msg.retry = true;
      postRef.current(msg);
    };
    const end = (reason: WorldLiveOffReason): void => {
      stopped = true;
      setState("off");
      setEnded(true);
      postRef.current({ t: "live-status", state: "off", reason });
    };
    const retry = (): void => {
      if (tries >= WORLD_LIVE_MAX_TRIES) {
        end("offline");
        return;
      }
      retrying = true;
      status("connecting");
      timer = window.setTimeout(() => {
        timer = null;
        void connect();
      }, backoff(tries));
      tries += 1;
    };
    const connect = async (): Promise<void> => {
      status("connecting");
      const r = await worldLive();
      if (stopped) return;
      const t = r.status >= 200 && r.status < 300 ? readTicket(r.body) : null;
      if (!t) {
        // 403: online save / live consent off, or banned. Asking again won't
        // change that; nor will another 4xx.
        if (r.status === 403) end(/ban/i.test(JSON.stringify(r.body ?? "")) ? "banned" : "consent");
        else if (r.status >= 400 && r.status < 500) end("error");
        else retry();
        return;
      }
      world = t.world;
      let ws: WebSocket;
      try {
        ws = new WebSocket(`${t.url}?ticket=${encodeURIComponent(t.ticket)}`);
      } catch {
        retry();
        return;
      }
      socket.current = ws;
      ws.onopen = () => {
        if (stopped) return;
        tries = 0;
        retrying = false;
        status("online");
      };
      ws.onmessage = (e: MessageEvent) => {
        if (stopped || typeof e.data !== "string") return;
        let m: unknown;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        if (typeof m !== "object" || m === null) return;
        const o = m as Record<string, unknown>;
        postRef.current({ t: "live", m });
        if (o.t === "welcome") {
          if (typeof o.world === "string") world = o.world;
          if (typeof o.count === "number") count = o.count;
          status("online");
        } else if (o.t === "count" && typeof o.n === "number") {
          count = o.n;
          status("online");
        }
      };
      ws.onclose = (e: CloseEvent) => {
        if (socket.current === ws) socket.current = null;
        if (stopped) return;
        const reason = FINAL_CODES[e.code];
        if (reason) end(reason);
        else retry();
      };
    };
    void connect();
    return () => {
      if (stopped) return; // already ended, and told the game why
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      const ws = socket.current;
      socket.current = null;
      ws?.close(1000);
      setState("off");
      postRef.current({ t: "live-status", state: "off", reason: "offline" });
    };
  }, [active]);

  const onGameMessage = useCallback((data: { t?: unknown; m?: unknown }): boolean => {
    if (data.t !== "live") return false;
    const ws = socket.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return true;
    if (typeof data.m !== "object" || data.m === null) return true;
    let text: string;
    try {
      text = JSON.stringify(data.m);
    } catch {
      return true;
    }
    if (new TextEncoder().encode(text).length > WORLD_LIVE_MAX_BYTES) return true;
    ws.send(text);
    return true;
  }, []);

  return { state, onGameMessage };
}
