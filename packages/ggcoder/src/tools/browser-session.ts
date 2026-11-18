import type { Browser, BrowserContext, Page, Request, Response } from "playwright";

export const BROWSER_INSTALL_HINT =
  "No browser available. Install Google Chrome, or add the optional dependency and download Chromium:\n" +
  "  pnpm add -w playwright && npx playwright install chromium\n" +
  "Then run the script again.";

/** Thrown when neither Playwright's Chromium nor an installed Chrome can start. */
export class BrowserUnavailableError extends Error {}

export const SLOW_REQUEST_MS = 1000;

// Per document: a random id and a count of DOM changes and input events, so an
// action can reuse the page tree taken after the previous one when nothing changed.
const CHANGE_COUNTER = `(() => {
  let n = 0;
  const id = Math.random().toString(36).slice(2);
  const bump = () => { n++; };
  Object.defineProperty(globalThis, "__ggChanges", { get: () => id + ":" + n, configurable: true });
  new MutationObserver(bump).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  addEventListener("input", bump, true);
  addEventListener("change", bump, true);
})()`;
// An idle Chromium holds hundreds of MB in a long-lived app session.
export const IDLE_CLOSE_MS = 10 * 60_000;

export interface ConsoleEntry {
  id: number;
  level: string;
  text: string;
  where?: string;
  stack?: string;
}

export interface NetworkEntry {
  id: number;
  method: string;
  url: string;
  type: string;
  status: number;
  failure?: string;
  ms: number | null;
  request: Request;
  response?: Response;
}

export interface CaptureMark {
  console: number;
  network: number;
  events: number;
}

interface Chromium {
  launch(opts: { headless: boolean; channel?: string }): Promise<Browser>;
}

let chromiumModule: Promise<Chromium> | undefined;
function loadChromium(): Promise<Chromium> {
  chromiumModule ??= (async () => {
    // Non-literal specifier: playwright is optional and externalized by the sidecar bundle.
    const name: string = "playwright";
    const mod = (await import(name)) as { chromium?: Chromium };
    if (!mod.chromium) throw new Error("playwright.chromium unavailable");
    return mod.chromium;
  })();
  chromiumModule.catch(() => (chromiumModule = undefined));
  return chromiumModule;
}

const isModuleNotFound = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
};
const isBinaryMissing = (err: unknown): boolean =>
  /executable doesn't exist|playwright install|chromium distribution .* is not found/i.test(
    err instanceof Error ? err.message : String(err),
  );

export const shortUrl = (u: string): string => {
  try {
    const x = new URL(u);
    return x.pathname + x.search;
  } catch {
    return u;
  }
};

/**
 * One browser per session that stays open between `browser` calls, so a flow
 * (sign in, then test) spans several scripts. Records console messages, page
 * errors and requests so every call can report what went wrong.
 */
export class BrowserManager {
  console: ConsoleEntry[] = [];
  network: NetworkEntry[] = [];
  events: string[] = [];
  readonly pending = new Map<Request, number>();
  reported: CaptureMark = { console: 0, network: 0, events: 0 };
  /** The latest page tree per tab and the change count it was taken at. */
  readonly lastSnapshot = new WeakMap<Page, { snap: string; at: string }>();

  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private current: Page | undefined;
  private launching: Promise<Page> | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private closedWhileIdle = false;

  get isOpen(): boolean {
    return this.context !== undefined;
  }

  /** The active tab, launching the browser on first use. */
  async page(): Promise<Page> {
    if (this.current && !this.current.isClosed()) return this.current;
    if (this.context) {
      const open = this.context.pages().filter((p) => !p.isClosed());
      this.current = open.at(-1) ?? (await this.context.newPage());
      return this.current;
    }
    this.launching ??= this.launch().finally(() => (this.launching = undefined));
    return this.launching;
  }

  /** Close the browser after a quiet spell; the next call starts a fresh one. */
  touch(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.closedWhileIdle = true;
      void this.shutdown();
    }, IDLE_CLOSE_MS);
    this.idleTimer.unref();
  }

  async shutdown(): Promise<void> {
    clearTimeout(this.idleTimer);
    const browser = this.browser;
    this.reset();
    await browser?.close().catch(() => {});
  }

  mark(): CaptureMark {
    return {
      console: this.console.length,
      network: this.network.length,
      events: this.events.length,
    };
  }

  /** Problems and events since `from`, so bugs surface without asking for them. */
  newSince(from: CaptureMark): { problems: string[]; events: string[] } {
    const problems: string[] = [];
    for (const c of this.console.slice(from.console))
      if (c.level === "error" || c.level === "pageerror")
        problems.push(`console ${c.level}: ${c.text}`);
    for (const n of this.network.slice(from.network)) {
      if (n.status >= 400 || n.failure)
        problems.push(`network ${n.method} ${shortUrl(n.url)} → ${n.failure ?? n.status}`);
      else if (n.ms !== null && n.ms > SLOW_REQUEST_MS)
        problems.push(`slow ${n.method} ${shortUrl(n.url)} ${n.ms} ms`);
    }
    return { problems, events: this.events.slice(from.events) };
  }

  private reset(): void {
    this.browser = undefined;
    this.context = undefined;
    this.current = undefined;
    this.console = [];
    this.network = [];
    this.events = [];
    this.pending.clear();
    this.reported = { console: 0, network: 0, events: 0 };
  }

  private async launch(): Promise<Page> {
    let chromium: Chromium;
    try {
      chromium = await loadChromium();
    } catch (err) {
      if (isModuleNotFound(err)) throw new BrowserUnavailableError(BROWSER_INSTALL_HINT);
      const reason = err instanceof Error ? err.message : String(err);
      throw new BrowserUnavailableError(`${BROWSER_INSTALL_HINT}\n(load error: ${reason})`);
    }
    let browser: Browser;
    try {
      browser = await chromium.launch({ headless: true });
    } catch (err) {
      if (!isBinaryMissing(err)) throw err;
      // Playwright's own Chromium isn't downloaded; an installed Chrome works as well.
      browser = await chromium.launch({ headless: true, channel: "chrome" }).catch((): never => {
        throw new BrowserUnavailableError(BROWSER_INSTALL_HINT);
      });
    }
    this.reset();
    if (this.closedWhileIdle) {
      this.closedWhileIdle = false;
      this.events.push(
        `The browser was closed after ${IDLE_CLOSE_MS / 60_000} idle minutes; this is a fresh one (logins and cookies were reset).`,
      );
    }
    browser.on("disconnected", () => {
      if (this.browser === browser) this.reset();
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript({ content: CHANGE_COUNTER });
    context.on("page", (p) => this.attach(p));
    this.browser = browser;
    this.context = context;
    this.current = await context.newPage();
    return this.current;
  }

  private attach(p: Page): void {
    p.on("console", (m) => {
      const loc = m.location();
      this.console.push({
        id: this.console.length + 1,
        level: m.type(),
        text: m.text(),
        where: loc?.url ? `${shortUrl(loc.url)}:${(loc.lineNumber ?? 0) + 1}` : undefined,
      });
    });
    p.on("pageerror", (e) => {
      this.console.push({
        id: this.console.length + 1,
        level: "pageerror",
        text: e.message,
        stack: e.stack,
      });
    });
    // An unanswered dialog blocks the page; the click that opened it meant to go ahead.
    p.on("dialog", (d) => {
      this.events.push(`${d.type()} dialog "${d.message()}" was accepted`);
      void d.accept(d.type() === "prompt" ? d.defaultValue() : undefined).catch(() => {});
    });
    p.on("popup", (pop) => {
      this.current = pop;
      void pop
        .waitForLoadState("domcontentloaded")
        .catch(() => {})
        .then(() => this.events.push(`Switched to a new tab: ${pop.url()}`));
    });
    p.on("download", (dl) =>
      this.events.push(`Download started: ${dl.suggestedFilename()} (not saved)`),
    );
    p.on("request", (r) => this.pending.set(r, performance.now()));
    const done = (r: Request, status: number, failure?: string, response?: Response): void => {
      const t0 = this.pending.get(r);
      this.pending.delete(r);
      this.network.push({
        id: this.network.length + 1,
        method: r.method(),
        url: r.url(),
        type: r.resourceType(),
        status,
        failure,
        ms: t0 === undefined ? null : Math.round(performance.now() - t0),
        request: r,
        response,
      });
    };
    // Logged at response headers: Chrome skips requestfinished when a body is never read.
    p.on("response", (res) => done(res.request(), res.status(), undefined, res));
    p.on("requestfailed", (r) => done(r, 0, r.failure()?.errorText ?? "failed"));
  }
}
