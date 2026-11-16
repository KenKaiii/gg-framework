// The frame's stand-in for Tauri's invoke(): only the commands the live
// preview chat uses, each mapped to the frame server's matching route. Any
// other command fails closed, the same way it would if it didn't exist.

export const LIVE_HEADER = "x-gg-live";

type Args = Record<string, unknown>;
type Call = { method: "GET" | "POST"; path: string; body?: unknown };

const s = (v: unknown): string => (typeof v === "string" ? v : "");

export const FRAME_COMMANDS: Record<string, (a: Args) => Call | { local: unknown }> = {
  // The preview's session exists before the frame loads.
  sidecar_port: () => ({ local: 1 }),
  agent_state: () => ({ method: "GET", path: "/api/state" }),
  agent_models: () => ({ method: "GET", path: "/api/models" }),
  agent_switch_model: (a) => ({
    method: "POST",
    path: "/api/model",
    body: { model: s(a.model), confirmPaid: a.confirmPaid === true },
  }),
  agent_prompt: (a) => ({
    method: "POST",
    path: "/api/prompt",
    body: {
      text: s(a.text),
      attachments: Array.isArray(a.attachments) ? a.attachments : [],
      meta: a.meta ?? null,
    },
  }),
  agent_cancel: () => ({ method: "POST", path: "/api/cancel" }),
  agent_enhance_prompt: (a) => ({
    method: "POST",
    path: "/api/enhance",
    body: { text: s(a.text) },
  }),
  agent_usage: (a) => ({
    method: "GET",
    path: `/api/usage?provider=${encodeURIComponent(s(a.provider))}`,
  }),
  agent_git_overview: () => ({ method: "GET", path: "/api/git/overview" }),
};

export async function frameInvoke<T>(
  cmd: string,
  args: Args = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const route = Object.prototype.hasOwnProperty.call(FRAME_COMMANDS, cmd)
    ? FRAME_COMMANDS[cmd]
    : undefined;
  // Tauri rejects with a string; callers expect the same.
  if (!route) throw `${cmd} isn't available in the live preview`;
  const call = route(args);
  if ("local" in call) return call.local as T;
  const res = await fetchImpl(call.path, {
    method: call.method,
    headers: {
      [LIVE_HEADER]: "1",
      ...(call.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: call.body !== undefined ? JSON.stringify(call.body) : undefined,
    credentials: "omit",
  }).catch((e: unknown) => {
    throw `GG Coder isn't reachable (${e instanceof Error ? e.message : String(e)})`;
  });
  const body = (await res.json().catch(() => null)) as {
    error?: unknown;
    message?: unknown;
  } | null;
  if (!res.ok) {
    const msg = body?.message ?? body?.error;
    throw typeof msg === "string" ? msg : `${res.status} ${res.statusText}`;
  }
  return body as T;
}
