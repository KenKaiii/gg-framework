// Live preview, per window: a dedicated agent session for the window's project,
// the page proxy in front of its dev server and the frame server for the chat.
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionContext, SseClient } from "../session-types.js";
import { detectDevUrl, type DetectOptions } from "./dev-url.js";
import { createFrameServer, type FrameServer } from "./frame-server.js";
import { createPreviewProxy, defaultDownPage, type PreviewProxy } from "./proxy.js";

export interface LivePreviewStatus {
  running: boolean;
  /** The link to open in the browser. */
  url: string | null;
  /** The dev server it shows. */
  target: string | null;
  /** No dev server runs for this project: start one, or type its address. */
  needsUrl?: boolean;
  error?: string;
}

export interface LivePreviewManagerDeps {
  /** Create (and register) a session in `cwd` that the app never shows as a window. */
  createSession: (cwd: string) => Promise<SessionContext>;
  closeSession: (id: string) => Promise<void>;
  usage: (provider: "anthropic" | "moonshot") => Promise<unknown>;
  /** The built overlay; null when this build doesn't have it. */
  assetsDir: string | null;
  /** Finds servers the user started in the project, and checks what answers (servers.ts). */
  scan?: DetectOptions["scan"];
  probe?: DetectOptions["probe"];
  log?: (message: string, fields?: Record<string, string>) => void;
  /** A window's preview started or stopped (by the user or by the agent). */
  onChange?: (windowId: string, status: LivePreviewStatus) => void;
}

interface Preview {
  windowId: string;
  cwd: string;
  target: URL;
  session: SessionContext;
  recorder: SseClient;
  proxy: PreviewProxy;
  frame: FrameServer;
  proxyPort: number;
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIRS = [
  // Single-file desktop sidecar: resources live beside app-sidecar.mjs.
  path.resolve(MODULE_DIR, "live-preview"),
  // Running from the repo (tauri dev): gg-app's own build output.
  path.resolve(MODULE_DIR, "../../../../../gg-app/dist-live-preview"),
];

/** Where the built overlay is, or null when it was never built. */
export function findLivePreviewAssets(candidates: readonly string[] = ASSET_DIRS): string | null {
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "page.js")) && fs.existsSync(path.join(dir, "frame.html")))
      return dir;
  }
  return null;
}

// Enough to rebuild a long chat after a reload, without growing forever.
const REPLAY_LIMIT = 5000;

/** A user-typed dev server address as a URL, or an error to show. */
export function parseDevUrl(raw: string): URL | { error: string } {
  const text = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { error: `"${text}" isn't a web address.` };
  }
  if (url.protocol === "https:") return { error: httpsError(url.href) };
  if (url.protocol !== "http:") return { error: `"${text}" isn't a web address.` };
  if (url.hostname === "0.0.0.0" || url.hostname === "[::1]") url.hostname = "localhost";
  return url;
}

const httpsError = (url: string): string =>
  `Your dev server runs on https (${url}). Live preview supports http dev servers only for now.`;

const linkFor = (port: number, target: URL): string =>
  `http://localhost:${port}${target.pathname}${target.search}`;

/** Listen on the port this project used before, so its address (and storage) stays the same. */
async function listenNear(listen: (p: number) => Promise<number>, port: number | undefined) {
  if (port) {
    try {
      return await listen(port);
    } catch {
      /* taken by something else now: any free port */
    }
  }
  return listen(0);
}

export interface LivePreviewManager {
  start: (window: SessionContext, opts?: { url?: string }) => Promise<LivePreviewStatus>;
  stop: (windowId: string) => Promise<LivePreviewStatus>;
  status: (windowId: string) => LivePreviewStatus;
  /** A session went away: stop the preview it owned or was. */
  onSessionClosed: (id: string) => Promise<void>;
  isPreviewSession: (id: string) => boolean;
  stopAll: () => Promise<void>;
}

export function createLivePreviewManager(deps: LivePreviewManagerDeps): LivePreviewManager {
  const log = deps.log ?? (() => {});
  const previews = new Map<string, Preview>();
  const starting = new Map<string, Promise<LivePreviewStatus>>();
  // Per project for the app's lifetime: reopening keeps the same address.
  const ports = new Map<string, { proxy: number; frame: number }>();

  const statusOf = (p: Preview | undefined): LivePreviewStatus =>
    p
      ? { running: true, url: linkFor(p.proxyPort, p.target), target: p.target.href }
      : { running: false, url: null, target: null };

  async function teardown(p: Preview): Promise<void> {
    previews.delete(p.windowId);
    p.session.clients.delete(p.recorder);
    await Promise.all([p.proxy.close(), p.frame.close()]);
    await deps.closeSession(p.session.id).catch(() => {});
    log("live preview stopped", { window: p.windowId });
    deps.onChange?.(p.windowId, statusOf(undefined));
  }

  async function launch(window: SessionContext, target: URL): Promise<LivePreviewStatus> {
    const assetsDir = deps.assetsDir;
    if (!assetsDir) {
      return { ...statusOf(undefined), error: "Live preview isn't included in this build." };
    }
    const session = await deps.createSession(window.cwd);
    // Record what the session broadcasts, so a reloaded page rebuilds its chat.
    const replay: string[] = [];
    const recorder: SseClient = {
      id: -1,
      res: {
        write: (frame: string) => {
          replay.push(frame);
          if (replay.length > REPLAY_LIMIT) replay.splice(0, replay.length - REPLAY_LIMIT);
          return true;
        },
        end: () => {},
      } as unknown as http.ServerResponse,
    };
    session.clients.add(recorder);
    const remembered = ports.get(window.cwd);
    let proxyPort = 0;
    const frame = createFrameServer({
      assetsDir,
      session: () => (previews.get(window.id)?.session === session ? session : null),
      config: () => ({
        devUrl: target.href,
        proxyOrigins: proxyPort
          ? [`http://localhost:${proxyPort}`, `http://127.0.0.1:${proxyPort}`]
          : [],
      }),
      replay: () => replay,
      usage: deps.usage,
    });
    let proxy: PreviewProxy | null = null;
    try {
      const framePort = await listenNear(frame.listen, remembered?.frame);
      const inject = `<script defer src="http://127.0.0.1:${framePort}/page.js"></script>`;
      proxy = createPreviewProxy({
        target,
        inject,
        downPage: (t) => defaultDownPage(t, inject),
      });
      proxyPort = await listenNear(proxy.listen, remembered?.proxy);
      ports.set(window.cwd, { proxy: proxyPort, frame: framePort });
    } catch (err) {
      session.clients.delete(recorder);
      await Promise.all([proxy?.close(), frame.close()]);
      await deps.closeSession(session.id).catch(() => {});
      throw err;
    }
    const preview: Preview = {
      windowId: window.id,
      cwd: window.cwd,
      target,
      session,
      recorder,
      proxy,
      frame,
      proxyPort,
    };
    previews.set(window.id, preview);
    log("live preview started", {
      window: window.id,
      session: session.id,
      target: target.href,
      port: String(proxyPort),
    });
    deps.onChange?.(window.id, statusOf(preview));
    return statusOf(preview);
  }

  async function startOnce(
    window: SessionContext,
    opts: { url?: string },
  ): Promise<LivePreviewStatus> {
    let target: URL;
    if (opts.url !== undefined && opts.url.trim()) {
      const parsed = parseDevUrl(opts.url);
      if (!(parsed instanceof URL))
        return { ...statusOf(previews.get(window.id)), error: parsed.error };
      target = parsed;
    } else {
      const found = await detectDevUrl(window.session.listBackgroundProcesses(), undefined, {
        cwd: window.cwd,
        scan: deps.scan,
        probe: deps.probe,
      });
      const current = previews.get(window.id);
      if (found.kind === "https") return { ...statusOf(current), error: httpsError(found.url) };
      if (found.kind === "none") {
        if (current) return statusOf(current);
        return {
          ...statusOf(undefined),
          needsUrl: true,
          error: "No web app is running for this project.",
        };
      }
      target = new URL(found.url);
    }
    const current = previews.get(window.id);
    if (current) {
      if (current.target.origin === target.origin) return statusOf(current);
      await teardown(current);
    }
    return launch(window, target);
  }

  return {
    start: (window, opts = {}) => {
      // A double click, or the agent and the user at once: one preview.
      const pending = starting.get(window.id);
      if (pending) return pending;
      const run = startOnce(window, opts).finally(() => starting.delete(window.id));
      starting.set(window.id, run);
      return run;
    },
    stop: async (windowId) => {
      await starting.get(windowId)?.catch(() => {});
      const p = previews.get(windowId);
      if (p) await teardown(p);
      return statusOf(undefined);
    },
    status: (windowId) => statusOf(previews.get(windowId)),
    onSessionClosed: async (id) => {
      for (const p of [...previews.values()]) {
        if (p.windowId === id || p.session.id === id) await teardown(p);
      }
    },
    isPreviewSession: (id) => [...previews.values()].some((p) => p.session.id === id),
    stopAll: async () => {
      await Promise.all([...previews.values()].map((p) => teardown(p).catch(() => {})));
    },
  };
}
