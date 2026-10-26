import { useCallback, useEffect, useRef, useState } from "react";
import { worldSaveDelete, worldSaveGet, worldSavePut, type WorldSaveResult } from "./agent";

/** Bump when the consent box's wording changes, so it asks again. */
export const WORLD_CONSENT_VERSION = 1;
export const WORLD_CONSENT_KEY = "gg-world-save-consent";

/** The game's local state, as it posts it in `{ t: 'save' }`. */
export interface WorldProfile {
  name: string | null;
  look: unknown;
  owned: unknown;
  spent: unknown;
}

export type WorldSaveStatus = "off" | "on" | "saving" | "saved" | "error";

/** The stored answer: true = agreed, false = keep it local, null = never asked. */
export function readWorldConsent(): boolean | null {
  try {
    const raw = localStorage.getItem(WORLD_CONSENT_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as { v?: unknown; on?: unknown };
    if (o.v !== WORLD_CONSENT_VERSION || typeof o.on !== "boolean") return null;
    return o.on;
  } catch {
    return null;
  }
}

function writeWorldConsent(on: boolean): void {
  try {
    localStorage.setItem(WORLD_CONSENT_KEY, JSON.stringify({ v: WORLD_CONSENT_VERSION, on }));
  } catch {
    // Storage full or blocked: the answer lasts this session only.
  }
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
  level,
  post,
}: {
  ready: boolean;
  level: number | undefined;
  post: (msg: Record<string, unknown>) => void;
}) {
  const [consent, setConsent] = useState<boolean | null>(() => readWorldConsent());
  const [asking, setAsking] = useState(false);
  const [status, setStatus] = useState<WorldSaveStatus>(consent === true ? "on" : "off");
  const [savedAt, setSavedAt] = useState<number | null>(null);
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
    if (!ready || !on) return;
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
      setStatus("on");
      if (got.ver > 0 && got.profile) postRef.current({ t: "profile", profile: got.profile });
      if (latest.current && got.ver === 0) dirty.current = true;
      void pump();
    })();
    return () => {
      live = false;
    };
  }, [ready, on, pump]);

  // Ask once, after the game is on screen, if never answered.
  useEffect(() => {
    if (ready && consent === null) setAsking(true);
  }, [ready, consent]);

  const onGameSave = useCallback(
    (profile: WorldProfile): void => {
      latest.current = profile;
      dirty.current = true;
      if (onRef.current) void pump();
    },
    [pump],
  );

  const agree = useCallback((yes: boolean): void => {
    writeWorldConsent(yes);
    setConsent(yes);
    setAsking(false);
    if (!yes) setStatus("off");
  }, []);

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
    agree(false);
    postRef.current({ t: "note", text: "Online save deleted" });
    return true;
  }, [agree]);

  return {
    on,
    status,
    savedAt,
    asking,
    closeAsk: () => setAsking(false),
    agree,
    turnOn,
    turnOff,
    deleteSave,
    onGameSave,
  };
}
