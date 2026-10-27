import { useCallback, useEffect, useRef, useState } from "react";
import {
  worldAccountDelete,
  worldSaveDelete,
  worldSaveGet as worldSaveGetOnce,
  worldSavePut as worldSavePutOnce,
  type WorldSaveResult,
} from "./agent";

/** Unreachable (status 0: offline, a dropped connection, a slow start) is retried a couple of times before it counts. */
const RETRY_MS = [1500, 4000];
/** After that, while World stays open, the save tries again on its own this often. */
export const WORLD_SAVE_RETRY_MS = 30_000;
async function withRetry(call: () => Promise<WorldSaveResult>): Promise<WorldSaveResult> {
  let r = await call();
  for (const wait of RETRY_MS) {
    if (r.status !== 0) return r;
    await new Promise((res) => setTimeout(res, wait));
    r = await call();
  }
  return r;
}
const worldSaveGet = (): Promise<WorldSaveResult> => withRetry(worldSaveGetOnce);
const worldSavePut = (ver: number, patch: Record<string, unknown>): Promise<WorldSaveResult> =>
  withRetry(() => worldSavePutOnce(ver, patch));

/** Bump when the consent box's wording changes, so it asks again. */
export const WORLD_CONSENT_VERSION = 1;
export const WORLD_CONSENT_KEY = "gg-world-save-consent";
/** The separate "Join the live world" tick, stored and versioned the same way. */
export const WORLD_LIVE_CONSENT_VERSION = 1;
export const WORLD_LIVE_CONSENT_KEY = "gg-world-live-consent";

/** The game's local state, as it posts it in `{ t: 'save' }`. */
export interface WorldProfile {
  name: string | null;
  look: unknown;
  owned: unknown;
  spent: unknown;
}

export type WorldSaveStatus = "off" | "on" | "saving" | "saved" | "error";

/** The stored answer: true = agreed, false = keep it local, null = never asked. */
function readAnswer(key: string, version: number): boolean | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const o = JSON.parse(raw) as { v?: unknown; on?: unknown };
    if (o.v !== version || typeof o.on !== "boolean") return null;
    return o.on;
  } catch {
    return null;
  }
}

function writeAnswer(key: string, version: number, on: boolean): void {
  try {
    localStorage.setItem(key, JSON.stringify({ v: version, on }));
  } catch {
    // Storage full or blocked: the answer lasts this session only.
  }
}

export function readWorldConsent(): boolean | null {
  return readAnswer(WORLD_CONSENT_KEY, WORLD_CONSENT_VERSION);
}

/** The live-world tick: true = joined, false = not, null = never asked. */
export function readWorldLiveConsent(): boolean | null {
  return readAnswer(WORLD_LIVE_CONSENT_KEY, WORLD_LIVE_CONSENT_VERSION);
}

interface ServerSave {
  ver: number;
  name: string | null;
  owned: unknown;
}

function readSave(r: WorldSaveResult): (ServerSave & { profile: unknown }) | null {
  if (r.status < 200 || r.status >= 300) return null;
  const b =
    typeof r.body === "object" && r.body !== null ? (r.body as Record<string, unknown>) : {};
  const ver = typeof b.ver === "number" ? b.ver : 0;
  const p =
    typeof b.profile === "object" && b.profile !== null
      ? (b.profile as Record<string, unknown>)
      : {};
  return {
    ver,
    name: typeof p.name === "string" ? p.name : null,
    owned: p.owned,
    profile: b.profile,
  };
}

function errorText(r: WorldSaveResult): string {
  const b = r.body as { error?: unknown } | null;
  return typeof b?.error === "string" ? b.error : "it isn't allowed";
}

/** Items owned here or online: both kept (the server's list may come from another computer). */
function unionOwned(mine: unknown, theirs: unknown): unknown {
  if (!Array.isArray(mine) || !Array.isArray(theirs)) return mine;
  return [...new Set([...(mine as unknown[]), ...(theirs as unknown[])])];
}

/**
 * GG World's optional online save. Off until the player agrees (the consent
 * box); no World request is made before that. When on: after the game is
 * ready it fetches the save (and hands it to the game if one exists), then
 * uploads the game's `save` messages one request at a time.
 */
export function useWorldSave({
  ready,
  shown = true,
  level,
  post,
}: {
  ready: boolean;
  /** The world is on screen (faded in). The one-time question waits for it. */
  shown?: boolean;
  level: number | undefined;
  post: (msg: Record<string, unknown>) => void;
}) {
  const [consent, setConsent] = useState<boolean | null>(() => readWorldConsent());
  const [liveConsent, setLiveConsent] = useState<boolean | null>(() => readWorldLiveConsent());
  const [asking, setAsking] = useState(false);
  // Asking only for the live tick (online save already agreed before it existed).
  const [askingLive, setAskingLive] = useState(false);
  const [status, setStatus] = useState<WorldSaveStatus>(consent === true ? "on" : "off");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // bumped to try again (on its own every WORLD_SAVE_RETRY_MS while failing, or from "Try again")
  const [attempt, setAttempt] = useState(0);
  // The server has this player's save row (ver > 0): the live world needs it for a ticket.
  const [hasRow, setHasRow] = useState(false);
  const loaded = useRef(false);
  const server = useRef<ServerSave | null>(null);
  const latest = useRef<WorldProfile | null>(null);
  const dirty = useRef(false);
  const busy = useRef(false);
  const savedOnce = useRef(false);
  const alive = useRef(true);
  const levelRef = useRef(level);
  const postRef = useRef(post);
  useEffect(() => {
    levelRef.current = level;
    postRef.current = post;
  }, [level, post]);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const on = consent === true;
  const onRef = useRef(on);
  useEffect(() => {
    onRef.current = on;
  }, [on]);

  const fetchSave = useCallback(async (): Promise<boolean> => {
    const got = readSave(await worldSaveGet());
    if (!got) return false;
    server.current = { ver: got.ver, name: got.name, owned: got.owned };
    return true;
  }, []);

  const upload = useCallback(
    async (profile: WorldProfile): Promise<void> => {
      if (!server.current && !(await fetchSave())) {
        setStatus("error");
        return;
      }
      const patchFor = (): Record<string, unknown> => {
        const s = server.current;
        const patch: Record<string, unknown> = {
          look: profile.look,
          owned: unionOwned(profile.owned, s?.owned),
          spent: profile.spent,
        };
        if (levelRef.current !== undefined) patch.level = levelRef.current;
        if (profile.name !== null && profile.name !== s?.name) patch.name = profile.name;
        return patch;
      };
      let patch = patchFor();
      let r = await worldSavePut(server.current?.ver ?? 0, patch);
      // A taken name is also a 409 ("That name is taken"): only a stale-version 409 is retried as a conflict.
      const nameTaken = (x: { status: number; body: unknown }): boolean =>
        x.status === 409 && /name/i.test(errorText(x));
      if (r.status === 409 && !nameTaken(r) && (await fetchSave())) {
        patch = patchFor();
        r = await worldSavePut(server.current?.ver ?? 0, patch);
      }
      if ((r.status === 400 || nameTaken(r)) && "name" in patch) {
        const why = errorText(r);
        delete patch.name;
        r = await worldSavePut(server.current?.ver ?? 0, patch);
        if (alive.current)
          postRef.current({ t: "note", text: `That name can't be used online: ${why}` });
      }
      const saved = readSave(r);
      if (!saved) {
        if (r.status === 409) server.current = null;
        setStatus("error");
        return;
      }
      server.current = { ver: saved.ver, name: saved.name, owned: saved.owned };
      if (saved.ver > 0) setHasRow(true);
      setStatus("saved");
      setSavedAt(Date.now());
      if (!savedOnce.current) {
        savedOnce.current = true;
        if (alive.current) postRef.current({ t: "note", text: "Saved online" });
      }
    },
    [fetchSave],
  );

  /** Upload the latest game state; one request in flight, later saves coalesce. */
  const pump = useCallback(async (): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    try {
      while (dirty.current && onRef.current && alive.current && latest.current) {
        dirty.current = false;
        setStatus("saving");
        await upload(latest.current);
      }
    } finally {
      busy.current = false;
    }
  }, [upload]);

  // On (and ready): read the save; hand an existing one to the game.
  useEffect(() => {
    if (!ready || !on || loaded.current) return;
    let live = true;
    busy.current = true;
    setStatus("saving");
    void (async () => {
      const r = await worldSaveGet();
      busy.current = false;
      if (!live) return;
      const got = readSave(r);
      if (!got) {
        setStatus("error");
        return;
      }
      server.current = { ver: got.ver, name: got.name, owned: got.owned };
      loaded.current = true;
      setStatus("on");
      if (got.ver > 0 && got.profile) postRef.current({ t: "profile", profile: got.profile });
      if (got.ver > 0) setHasRow(true);
      else {
        // No row yet: save right away (the game's latest state, or just the level), so the live world can open.
        if (!latest.current)
          latest.current = { name: null, look: undefined, owned: undefined, spent: undefined };
        dirty.current = true;
      }
      void pump();
    })();
    return () => {
      live = false;
    };
    // the first read retries itself (attempt) until it works; later saves go through pump()
  }, [ready, on, pump, attempt]);

  // Failing: try again on its own every 30 s while World is open (the read if it never loaded, else the latest save).
  useEffect(() => {
    if (status !== "error" || !on) return;
    const t = window.setTimeout(() => {
      if (!loaded.current) setAttempt((n) => n + 1);
      else if (latest.current) {
        dirty.current = true;
        void pump();
      }
    }, WORLD_SAVE_RETRY_MS);
    return () => window.clearTimeout(t);
  }, [status, on, pump]);

  const retryNow = useCallback((): void => {
    if (!onRef.current) return;
    if (!loaded.current) setAttempt((n) => n + 1);
    else if (latest.current) {
      dirty.current = true;
      void pump();
    }
  }, [pump]);

  // Ask once, after the game is on screen, if never answered.
  // ...once the world is actually on screen (and a beat after, so it doesn't land on a black frame), never during load.
  useEffect(() => {
    if (!ready || !shown) return;
    if (consent === null) {
      const t = window.setTimeout(() => setAsking(true), 600);
      return () => window.clearTimeout(t);
    }
    // Agreed to online save before the live tick existed: ask once for it.
    if (consent === true && liveConsent === null) {
      const t = window.setTimeout(() => setAskingLive(true), 600);
      return () => window.clearTimeout(t);
    }
  }, [ready, shown, consent, liveConsent]);

  const onGameSave = useCallback(
    (profile: WorldProfile): void => {
      latest.current = profile;
      dirty.current = true;
      if (onRef.current) void pump();
    },
    [pump],
  );

  const answerLive = useCallback((yes: boolean): void => {
    writeAnswer(WORLD_LIVE_CONSENT_KEY, WORLD_LIVE_CONSENT_VERSION, yes);
    setLiveConsent(yes);
    setAskingLive(false);
  }, []);

  /** The consent box's answer; `liveYes` is the live tick (only when saving online). */
  const agree = useCallback(
    (yes: boolean, liveYes?: boolean): void => {
      writeAnswer(WORLD_CONSENT_KEY, WORLD_CONSENT_VERSION, yes);
      setConsent(yes);
      setAsking(false);
      if (yes && liveYes !== undefined) answerLive(liveYes);
      if (!yes) setStatus("off");
    },
    [answerLive],
  );

  const turnOn = useCallback((): void => setAsking(true), []);
  const turnOff = useCallback((): void => agree(false), [agree]);

  const deleteSave = useCallback(async (): Promise<boolean> => {
    setStatus("saving");
    const r = await worldSaveDelete();
    if (r.status < 200 || r.status >= 300) {
      setStatus("error");
      return false;
    }
    server.current = null;
    savedOnce.current = false;
    loaded.current = false;
    setHasRow(false);
    agree(false);
    postRef.current({ t: "note", text: "Online save deleted" });
    return true;
  }, [agree]);

  /** Delete the whole World account (server + this device's link), then turn online save off. */
  const deleteAccount = useCallback(async (): Promise<boolean> => {
    setStatus("saving");
    const r = await worldAccountDelete();
    if (r.status < 200 || r.status >= 300) {
      setStatus("error");
      return false;
    }
    server.current = null;
    savedOnce.current = false;
    loaded.current = false;
    setHasRow(false);
    agree(false);
    postRef.current({ t: "note", text: "Account deleted" });
    return true;
  }, [agree]);

  return {
    on,
    /** Online save on, its row exists on the server, and the live tick is on. */
    live: on && hasRow && liveConsent === true,
    liveConsent,
    status,
    savedAt,
    asking,
    closeAsk: () => setAsking(false),
    askingLive,
    closeAskLive: () => setAskingLive(false),
    answerLive,
    agree,
    turnOn,
    turnOff,
    deleteSave,
    deleteAccount,
    onGameSave,
    retryNow,
  };
}
