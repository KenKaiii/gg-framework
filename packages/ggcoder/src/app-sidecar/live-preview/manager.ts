// Live preview, per window: the page proxy in front of the project's dev server
// and the frame server for the chat, with one agent session per browser tab.
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionContext, SseClient } from "../session-types.js";
import { detectDevUrl, type DetectOptions } from "./dev-url.js";
import { createFrameServer, type FrameServer, type FrameTab } from "./frame-server.js";
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
  /** How long a tab's session outlives its last connection (a reload reconnects well within it). */
  tabIdleMs?: number;
}

interface Tab {
  dropped: boolean;
  session: SessionContext;
  recorder: SseClient;
  replay: string[];
  streams: number;
  idle: ReturnType<typeof setTimeout> | null;
  usedAt: number;
}

interface Preview {
  windowId: string;
  cwd: string;
  target: URL;
  /** Made at start, so the first tab doesn't wait and a failure shows when starting. */
  spare: SessionContext | null;
  tabs: Map<string, Promise<Tab>>;
  /** The tabs whose session is up, by tab id. */
  ready: Map<string, Tab>;
  /** Every session this preview made, settled or not. */
  sessionIds: Set<string>;
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
// Each tab is a whole agent session: past this, the oldest idle tab's chat closes.
const MAX_TABS = 8;
const TAB_IDLE_MS = 10 * 60_000;

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

  const tabIdleMs = deps.tabIdleMs ?? TAB_IDLE_MS;
  const current = (p: Preview): boolean => previews.get(p.windowId) === p;

  function dropTab(p: Preview, id: string, tab: Tab): void {
    if (tab.dropped) return;
    tab.dropped = true;
    if (p.ready.get(id) === tab) {
      p.ready.delete(id);
      p.tabs.delete(id);
    }
    p.sessionIds.delete(tab.session.id);
    if (tab.idle) clearTimeout(tab.idle);
    tab.session.clients.delete(tab.recorder);
    void deps.closeSession(tab.session.id).catch(() => {});
    log("live preview tab closed", { window: p.windowId, session: tab.session.id });
  }

  // Closed tabs never come back (a new tab gets a new id): close their sessions once idle.
  function armIdle(p: Preview, id: string, tab: Tab): void {
    if (tab.idle) clearTimeout(tab.idle);
    tab.idle = setTimeout(() => {
      tab.idle = null;
      if (!current(p) || tab.streams > 0) return;
      if (tab.session.isBusy()) armIdle(p, id, tab);
      else dropTab(p, id, tab);
    }, tabIdleMs);
    tab.idle.unref?.();
  }

  async function makeTab(p: Preview, id: string): Promise<Tab> {
    let session = p.spare;
    p.spare = null;
    if (!session) {
      session = await deps.createSession(p.cwd);
      p.sessionIds.add(session.id);
    }
    if (!current(p)) {
      p.sessionIds.delete(session.id);
      await deps.closeSession(session.id).catch(() => {});
      throw new Error("live preview stopped");
    }
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
    const tab: Tab = {
      dropped: false,
      session,
      recorder,
      replay,
      streams: 0,
      idle: null,
      usedAt: Date.now(),
    };
    p.ready.set(id, tab);
    armIdle(p, id, tab);
    log("live preview tab opened", { window: p.windowId, session: session.id });
    return tab;
  }

  async function tabFor(
    p: Preview,
    id: string,
  ): Promise<FrameTab | { status: number; error: string }> {
    if (!current(p)) {
      return { status: 503, error: "Live preview has stopped. Start it again from GG Coder." };
    }
    let pending = p.tabs.get(id);
    // No await until the new tab is in the map: a tab's parallel first requests share it.
    if (!pending) {
      if (p.tabs.size >= MAX_TABS) {
        const idle = [...p.ready]
          .filter(([, t]) => t.streams === 0 && !t.session.isBusy())
          .sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
        if (!idle) {
          return {
            status: 429,
            error: "Too many tabs have this preview open. Close one, then reload this page.",
          };
        }
        dropTab(p, idle[0], idle[1]);
      }
      pending = makeTab(p, id);
      p.tabs.set(id, pending);
      pending.catch(() => {
        if (p.tabs.get(id) === pending) p.tabs.delete(id);
      });
    }
    const tab = await pending;
    if (!current(p)) {
      return { status: 503, error: "Live preview has stopped. Start it again from GG Coder." };
    }
    tab.usedAt = Date.now();
    return {
      session: tab.session,
      replay: tab.replay,
      watch: () => {
        tab.streams++;
        if (tab.idle) clearTimeout(tab.idle);
        tab.idle = null;
        let open = true;
        return () => {
          if (!open) return;
          open = false;
          tab.streams--;
          tab.usedAt = Date.now();
          if (tab.streams === 0 && p.ready.get(id) === tab) armIdle(p, id, tab);
        };
      },
    };
  }

  async function teardown(p: Preview): Promise<void> {
    previews.delete(p.windowId);
    const tabs = await Promise.all([...p.tabs.values()].map((t) => t.catch(() => null)));
    p.tabs.clear();
    p.ready.clear();
    for (const tab of tabs) {
      if (!tab) continue;
      if (tab.idle) clearTimeout(tab.idle);
      tab.session.clients.delete(tab.recorder);
    }
    await Promise.all([p.proxy.close(), p.frame.close()]);
    const ids = [...p.sessionIds];
    p.sessionIds.clear();
    p.spare = null;
    await Promise.all(ids.map((id) => deps.closeSession(id).catch(() => {})));
    log("live preview stopped", { window: p.windowId });
    deps.onChange?.(p.windowId, statusOf(undefined));
  }

  async function launch(window: SessionContext, target: URL): Promise<LivePreviewStatus> {
    const assetsDir = deps.assetsDir;
    if (!assetsDir) {
      return { ...statusOf(undefined), error: "Live preview isn't included in this build." };
    }
    const session = await deps.createSession(window.cwd);
    const remembered = ports.get(window.cwd);
    let proxyPort = 0;
    let preview: Preview | null = null;
    const frame = createFrameServer({
      assetsDir,
      tab: (id) =>
        preview
          ? tabFor(preview, id)
          : Promise.resolve({ status: 503, error: "Live preview is still starting." }),
      config: () => ({
        devUrl: target.href,
        proxyOrigins: proxyPort
          ? [`http://localhost:${proxyPort}`, `http://127.0.0.1:${proxyPort}`]
          : [],
      }),
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
      await Promise.all([proxy?.close(), frame.close()]);
      await deps.closeSession(session.id).catch(() => {});
      throw err;
    }
    preview = {
      windowId: window.id,
      cwd: window.cwd,
      target,
      spare: session,
      tabs: new Map(),
      ready: new Map(),
      sessionIds: new Set([session.id]),
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
        if (p.windowId === id) {
          await teardown(p);
          continue;
        }
        if (!p.sessionIds.has(id)) continue;
        // One tab's session went away: only that tab starts over.
        if (p.spare?.id === id) p.spare = null;
        for (const [key, tab] of [...p.ready]) {
          if (tab.session.id === id) dropTab(p, key, tab);
        }
        p.sessionIds.delete(id);
      }
    },
    isPreviewSession: (id) => [...previews.values()].some((p) => p.sessionIds.has(id)),
    stopAll: async () => {
      await Promise.all([...previews.values()].map((p) => teardown(p).catch(() => {})));
    },
  };
}
