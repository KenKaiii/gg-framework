import type { HfPullState } from "./session-types.js";
import { AuthStorage } from "../core/auth-storage.js";
import {
  type HfSearchRow,
  toHfSearchRow,
  type GgufFile,
  pickGgufQuant,
  isGgufShard,
  SHARDED_MESSAGE,
  parseOllamaPullLine,
  advancesPhase,
  explainPullFailure,
} from "../hf-pull.js";
import { spawn } from "node:child_process";
import type { AppPaths, LocalEndpointProbe, LocalEndpoint } from "@kleio/core";

export interface HfPullManager {
  hfPull: HfPullState | null;
  readonly hfPullPayload: (s: HfPullState) => Record<string, unknown>;
  readonly hfSearch: (query: string) => Promise<HfSearchRow[]>;
  readonly startHfPull: (repo: string) => Promise<Record<string, unknown>>;
  readonly cancelHfPull: () => boolean;
}

export function createHfPullManager(deps: {
  paths: AppPaths;
  broadcast: (type: string, data: unknown) => void;
  scanLocalModels: (force: boolean) => Promise<LocalEndpointProbe[]>;
  broadcastAll: (type: string, data: unknown) => void;
  localStatePayload: () => {
    endpoints: {
      id: string;
      label: string;
      baseUrl: string;
      kind: LocalEndpoint["kind"];
      custom: boolean;
      reachable: boolean;
      reason?: string;
      models: {
        id: string;
        rawId: string;
        contextWindow: number;
        contextWindowKnown: boolean;
        supportsTools: boolean;
        supportsImages: boolean;
        supportsThinking: boolean;
        loaded?: boolean;
      }[];
    }[];
  };
}): HfPullManager {
  const { paths, broadcast, scanLocalModels, broadcastAll, localStatePayload } = deps;
  let hfPull: HfPullState | null = null;

  const hfPullPayload = (s: HfPullState): Record<string, unknown> => ({
    repo: s.repo,
    model: s.model,
    tag: s.tag,
    file: s.file,
    sizeBytes: s.sizeBytes,
    phase: s.phase,
    percent: s.percent,
    ...(s.detail ? { detail: s.detail } : {}),
    ...(s.error ? { error: s.error } : {}),
  });

  /** Stored HF token, if the user connected the huggingface provider. */
  async function hfToken(): Promise<string | undefined> {
    try {
      const auth = new AuthStorage(paths.authFile);
      const creds = await auth.resolveCredentials("huggingface");
      return creds.accessToken || undefined;
    } catch {
      return undefined;
    }
  }

  async function hfHubJson(pathname: string): Promise<unknown> {
    const token = await hfToken();
    const res = await fetch(`https://huggingface.co${pathname}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Hugging Face responded ${res.status}`);
    return res.json();
  }

  /** Search the Hub for GGUF repos (what Ollama can pull). */
  async function hfSearch(query: string): Promise<HfSearchRow[]> {
    // `filter=gguf` (the tag the Hub applies to repos that actually contain
    // GGUF files) — `library=gguf` also matches safetensors-only base repos,
    // which then fail at pull time. `expand[]=gguf` confirms per row.
    const params = new URLSearchParams({
      search: query,
      filter: "gguf",
      sort: "downloads",
      direction: "-1",
      limit: "12",
    });
    for (const field of ["gguf", "downloads", "likes", "lastModified"]) {
      params.append("expand[]", field);
    }
    const data = (await hfHubJson(`/api/models?${params.toString()}`)) as {
      id?: unknown;
      downloads?: unknown;
      likes?: unknown;
      lastModified?: unknown;
      gguf?: unknown;
    }[];
    return (Array.isArray(data) ? data : [])
      .map(toHfSearchRow)
      .filter((r): r is HfSearchRow => r !== null);
  }

  /**
   * Start `ollama pull hf.co/<repo>[:quant]`. Resolves once the child is
   * spawned; progress streams as `hf_pull` events. The chosen quant comes from
   * the repo's real file list — the client only ever sends a repo id, so there
   * is no injection surface into argv.
   */
  async function startHfPull(repo: string): Promise<Record<string, unknown>> {
    if (hfPull?.child) {
      throw Object.assign(new Error("A download is already running."), { status: 409 });
    }
    // `recursive=true`: many repos (unsloth, mradermacher) keep quants in
    // per-quant subfolders, and a flat listing reports them as GGUF-less.
    const tree = (await hfHubJson(`/api/models/${repo}/tree/main?recursive=true`)) as unknown[];
    const files: GgufFile[] = (Array.isArray(tree) ? tree : []).flatMap((entry) => {
      const e = entry as {
        path?: unknown;
        type?: unknown;
        size?: unknown;
        lfs?: { size?: unknown };
      };
      // `type` guards a directory entry (size 0) from beating real files in the
      // size fallback; the Hub marks folders as "directory".
      if (e.type !== undefined && e.type !== "file") return [];
      if (typeof e.path !== "string" || !e.path.toLowerCase().endsWith(".gguf")) return [];
      const size = Number(e.lfs?.size ?? e.size ?? 0);
      return [{ path: e.path, sizeBytes: Number.isFinite(size) ? size : 0 }];
    });
    const choice = pickGgufQuant(files);
    if (!choice) {
      const sharded = files.some((f) => isGgufShard(f.path));
      throw Object.assign(
        new Error(sharded ? SHARDED_MESSAGE : "That repo has no GGUF file for Ollama to pull."),
        { status: 400 },
      );
    }
    const model = `hf.co/${repo}${choice.tag ? `:${choice.tag}` : ""}`;
    const token = await hfToken();
    const state: HfPullState = {
      repo,
      model,
      tag: choice.tag,
      file: choice.file.path,
      sizeBytes: choice.file.sizeBytes,
      phase: "preparing",
      percent: 0,
      child: null,
    };
    hfPull = state;
    broadcast("hf_pull", hfPullPayload(state));

    // ollama prints progress to stderr (stdout on some builds); parse both.
    let stderrTail = "";
    let lastBroadcast = "";
    const feed = (chunk: string): void => {
      // Once the pull is terminal (success, failure, or user cancel) stop
      // parsing: a killed ollama dumps a burst of stderr that would otherwise
      // spam the modal with garbage frames after the outcome is already shown.
      if (state.phase === "success" || state.phase === "error") return;
      for (const line of chunk.split(/\r\n|\r|\n/)) {
        const parsed = parseOllamaPullLine(line);
        if (!parsed) continue;
        // A redrawn frame repeats `pulling manifest` next to live progress; it
        // must not drag the modal back to "Contacting Ollama…".
        if (!advancesPhase(state.phase, parsed.phase)) continue;
        if (parsed.phase !== "error") {
          state.phase = parsed.phase;
          if (parsed.percent !== undefined) state.percent = parsed.percent;
          state.detail = parsed.detail;
        }
        // ollama redraws its TUI frame several times a second, mostly with
        // identical numbers. Broadcasting each one re-rendered the modal for no
        // visible change; only a frame that actually reads differently ships.
        const next = JSON.stringify(hfPullPayload(state));
        if (next === lastBroadcast) continue;
        lastBroadcast = next;
        broadcast("hf_pull", hfPullPayload(state));
      }
    };

    try {
      const child = spawn("ollama", ["pull", model], {
        env: { ...process.env, ...(token ? { HF_TOKEN: token } : {}) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      state.child = child;
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", feed);
      child.stderr?.on("data", (d: string) => {
        stderrTail = (stderrTail + d).slice(-2000);
        feed(d);
      });
      child.on("error", (err: NodeJS.ErrnoException) => {
        state.child = null;
        state.phase = "error";
        state.error =
          err.code === "ENOENT"
            ? "Ollama isn't installed (or isn't on PATH). Install it from ollama.com, then retry."
            : `Could not start Ollama: ${err.message}`;
        broadcast("hf_pull", hfPullPayload(state));
      });
      child.on("close", (code: number | null) => {
        state.child = null;
        if (state.phase === "success" || state.phase === "error") return; // cancelled
        if (code === 0) {
          state.phase = "success";
          state.percent = 100;
          state.detail = undefined;
          broadcast("hf_pull", hfPullPayload(state));
          // The new model only exists to the app once Ollama lists it. Ollama's
          // library is machine-wide, like the shared auth file, so every window
          // gets the refresh — not just the one that ran the download.
          void scanLocalModels(true)
            .then(() => broadcastAll("models_change", { local: localStatePayload() }))
            .catch(() => undefined);
        } else {
          state.phase = "error";
          state.error = state.error ?? explainPullFailure(stderrTail);
          broadcast("hf_pull", hfPullPayload(state));
        }
      });
    } catch (err) {
      state.child = null;
      state.phase = "error";
      state.error = `Could not start Ollama: ${err instanceof Error ? err.message : String(err)}`;
      broadcast("hf_pull", hfPullPayload(state));
    }
    return hfPullPayload(state);
  }

  function cancelHfPull(): boolean {
    const child = hfPull?.child;
    if (!child) return false;
    // Terminal state FIRST, then the kill: the child's death rattle must not
    // overwrite the clean "cancelled" outcome with raw stderr.
    if (hfPull) {
      hfPull.phase = "error";
      hfPull.error = "Download cancelled.";
      hfPull.detail = undefined;
      hfPull.child = null;
      broadcast("hf_pull", hfPullPayload(hfPull));
    }
    child.kill("SIGTERM");
    return true;
  }

  return {
    get hfPull() {
      return hfPull;
    },
    set hfPull(v) {
      hfPull = v;
    },
    hfPullPayload,
    hfSearch,
    startHfPull,
    cancelHfPull,
  };
}
