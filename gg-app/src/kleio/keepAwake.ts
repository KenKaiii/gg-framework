// Native keep-awake for Kleio voice conversations. Wraps the Rust
// `keep_awake_acquire` / `keep_awake_release` commands (macOS IOKit user-idle
// assertions; a no-op elsewhere). Never throws into the caller.
//
// Also the "keep computer awake while the agent works" setting, which the
// sidecar applies to every run (`agent_keep_awake_get` / `_set`). Those need
// the sidecar up: callers wait for it (`waitForReady` in agent.ts) first.
import { invoke } from "@tauri-apps/api/core";

export interface AwakeHold {
  /** Release this hold. Safe to call any number of times. */
  release(): void;
}

function makeHoldId(): string {
  const raw =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const id = raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return id.length > 0 ? id : `hold-${Date.now().toString(36)}`;
}

/** Keep the display and system awake until `release()` is called. */
export function holdAwake(): AwakeHold {
  const hold = makeHoldId();
  let released = false;
  // Release is sequenced after acquire settles, so an early release() can't
  // race ahead of the acquire and leave the hold leaked.
  const acquired: Promise<void> = invoke<void>("keep_awake_acquire", {
    hold,
  }).catch((e: unknown) => {
    console.warn("keepAwake: acquire failed", e);
  });
  return {
    release(): void {
      if (released) return;
      released = true;
      void acquired
        .then(() => invoke<void>("keep_awake_release", { hold }))
        .catch((e: unknown) => {
          console.warn("keepAwake: release failed", e);
        });
    },
  };
}

/** The proxy forwards sidecar error bodies (`{ error }`) as values; surface them. */
function keepAwakeEnabled(result: { enabled?: unknown; error?: unknown }): boolean {
  if (typeof result.enabled === "boolean") return result.enabled;
  throw new Error(typeof result.error === "string" ? result.error : "keep-awake request failed");
}

/** Whether the app keeps the computer from idle-sleeping while the agent works. */
export async function getKeepAwake(): Promise<boolean> {
  return keepAwakeEnabled(await invoke<{ enabled?: unknown }>("agent_keep_awake_get"));
}

/** Turn keep-awake on/off. Saved to ~/.gg/settings.json and applied live. */
export async function setKeepAwake(enabled: boolean): Promise<boolean> {
  return keepAwakeEnabled(await invoke<{ enabled?: unknown }>("agent_keep_awake_set", { enabled }));
}
