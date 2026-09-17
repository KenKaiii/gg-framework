import { useEffect, useState, useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isProjectColourChoice, type ProjectColourChoice } from "./projectAccent";

const PREFIX = "gg-project-colour:";
const STRIPE_KEY = "gg-project-colour-stripe";
const EVENT = "project-colours-changed";
type Override = Exclude<ProjectColourChoice, "Automatic">;

interface Preferences {
  overrides: Readonly<Record<string, Override>>;
  stripe: boolean;
  revision: number;
  error: string | null;
}

/** Browser fallback identity. Native identity additionally resolves symlinks. */
export function projectColourKey(cwd: string | null | undefined): string | null {
  if (!cwd || cwd.length > 4096 || cwd.includes("\0")) return null;
  let path = cwd.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
  const windows = /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");
  if (windows) path = path.replace(/\\/g, "/").toLowerCase();
  if (!path.startsWith("/") && !/^[a-z]:\//.test(path)) return null;
  const prefix = path.startsWith("//") ? "//" : path.startsWith("/") ? "/" : "";
  const segments: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (segments.length > (windows && !prefix ? 1 : 0)) segments.pop();
    } else segments.push(part);
  }
  if (!segments.length) return null;
  const key = prefix + segments.join("/");
  return windows && !prefix && segments.length === 1 ? key + "/" : key;
}

function parseNative(value: unknown): (Preferences & { projectKey: string | null }) | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (
    !raw.overrides ||
    typeof raw.overrides !== "object" ||
    Array.isArray(raw.overrides) ||
    typeof raw.stripe !== "boolean" ||
    !Number.isSafeInteger(raw.revision) ||
    (raw.revision as number) < 0 ||
    (raw.projectKey !== null && typeof raw.projectKey !== "string")
  )
    return null;
  const overrides: Record<string, Override> = Object.create(null);
  for (const [key, choice] of Object.entries(raw.overrides)) {
    if (
      key.length <= 4096 &&
      projectColourKey(key) &&
      isProjectColourChoice(choice) &&
      choice !== "Automatic"
    ) {
      overrides[key] = choice;
    }
  }
  const key = raw.projectKey;
  if (typeof key === "string" && !projectColourKey(key)) return null;
  return {
    overrides,
    stripe: raw.stripe,
    revision: raw.revision as number,
    projectKey: key as string | null,
    error: null,
  };
}

/** One shared subscription per webview; factory also exercises fresh loads in tests. */
export function createProjectColourStore(native = isTauri()) {
  let current: Preferences = {
    overrides: Object.create(null),
    stripe: false,
    revision: 0,
    error: null,
  };
  const listeners = new Set<() => void>();
  let ready: Promise<void> = Promise.resolve();
  let stop: (() => void) | null = null;

  function publish(next: Preferences): void {
    current = next;
    for (const callback of listeners) callback();
  }
  function fail(): void {
    publish({ ...current, error: "Could not load project colours. Please try again." });
  }
  function applyNative(raw: unknown): ReturnType<typeof parseNative> {
    const next = parseNative(raw);
    if (next && next.revision >= current.revision) {
      publish({
        overrides: next.overrides,
        stripe: next.stripe,
        revision: next.revision,
        error: null,
      });
    }
    return next;
  }
  function loadBrowser(): boolean {
    try {
      const storage = window.localStorage;
      const overrides: Record<string, Override> = Object.create(null);
      for (let index = 0; index < storage.length; index++) {
        const storageKey = storage.key(index);
        if (!storageKey?.startsWith(PREFIX)) continue;
        const key = storageKey.slice(PREFIX.length);
        const choice = storage.getItem(storageKey);
        if (
          projectColourKey(key) === key &&
          isProjectColourChoice(choice) &&
          choice !== "Automatic"
        ) {
          overrides[key] = choice;
        }
      }
      publish({ overrides, stripe: storage.getItem(STRIPE_KEY) === "1", revision: 0, error: null });
      return true;
    } catch {
      fail();
      return false;
    }
  }
  async function loadNative(cwd: string | null = null): Promise<string | null> {
    const next = applyNative(await invoke<unknown>("project_colours_get", { cwd }));
    if (!next) throw new Error("Invalid project colour preferences");
    return next.projectKey;
  }
  function onStorage(event: StorageEvent): void {
    if (event.key === null || event.key === STRIPE_KEY || event.key.startsWith(PREFIX))
      loadBrowser();
  }
  function onFocus(): void {
    if (native) void ready.then(() => loadNative()).catch(fail);
    else loadBrowser();
  }
  function start(): void {
    let active = true;
    let unlisten: UnlistenFn | null = null;
    window.addEventListener("focus", onFocus);
    if (native) {
      // Listen FIRST, then read. The revision rejects an older read/response
      // arriving after a newer change from another native window.
      ready = listen<unknown>(EVENT, (event: { payload: unknown }) => {
        if (active) applyNative(event.payload);
      }).then((off: UnlistenFn) => {
        if (!active) {
          off();
          return;
        }
        unlisten = off;
      });
      void ready
        .then(() => {
          if (active) return loadNative();
        })
        .catch(() => {
          if (active) fail();
        });
    } else {
      window.addEventListener("storage", onStorage);
      loadBrowser();
    }
    stop = () => {
      active = false;
      unlisten?.();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("storage", onStorage);
    };
  }

  if (!native) loadBrowser();

  return {
    getSnapshot: (): Preferences => current,
    subscribe(callback: () => void): () => void {
      listeners.add(callback);
      if (listeners.size === 1) start();
      return () => {
        listeners.delete(callback);
        if (!listeners.size) {
          stop?.();
          stop = null;
        }
      };
    },
    async resolveProject(cwd: string): Promise<string | null> {
      if (!projectColourKey(cwd)) return null;
      if (!native) return projectColourKey(cwd);
      try {
        await ready;
        return await loadNative(cwd);
      } catch {
        fail();
        return null;
      }
    },
    async setChoice(cwd: string, choice: ProjectColourChoice): Promise<void> {
      const key = projectColourKey(cwd);
      if (!key || !isProjectColourChoice(choice))
        throw new Error("A project and a known colour are required");
      if (native) {
        await ready;
        const saved = applyNative(
          await invoke<unknown>("project_colours_save", { cwd, choice, stripe: null }),
        );
        if (!saved) throw new Error("Could not confirm the saved project colour");
      } else {
        // A key per project, NOT a read-modify-write map: other windows cannot
        // overwrite each other's choices for different projects.
        if (choice === "Automatic") window.localStorage.removeItem(PREFIX + key);
        else window.localStorage.setItem(PREFIX + key, choice);
        if (!loadBrowser()) throw new Error("Could not confirm the saved project colour");
      }
    },
    async setStripe(stripe: boolean): Promise<void> {
      if (typeof stripe !== "boolean") throw new Error("Invalid stripe visibility");
      if (native) {
        await ready;
        const saved = applyNative(
          await invoke<unknown>("project_colours_save", { cwd: null, choice: null, stripe }),
        );
        if (!saved) throw new Error("Could not confirm saved stripe visibility");
      } else {
        window.localStorage.setItem(STRIPE_KEY, stripe ? "1" : "0");
        if (!loadBrowser()) throw new Error("Could not confirm saved stripe visibility");
      }
    },
  };
}

export const projectColourStore = createProjectColourStore();

export function useProjectColour(cwd: string | undefined) {
  const preferences = useSyncExternalStore(
    projectColourStore.subscribe,
    projectColourStore.getSnapshot,
    projectColourStore.getSnapshot,
  );
  const [identity, setIdentity] = useState<{ cwd: string; key: string | null } | null>(null);
  useEffect(() => {
    if (!cwd) return;
    let active = true;
    void projectColourStore.resolveProject(cwd).then((key) => {
      if (active) setIdentity({ cwd, key });
    });
    return () => {
      active = false;
    };
  }, [cwd, preferences.error]);
  const key = identity && identity.cwd === cwd ? identity.key : null;
  return {
    choice: (key && preferences.overrides[key]) || ("Automatic" as const),
    stripe: preferences.stripe,
    error: preferences.error,
    ready: key !== null,
  };
}
