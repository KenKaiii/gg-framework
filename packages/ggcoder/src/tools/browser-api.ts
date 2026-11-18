import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { Locator, Page, Request } from "playwright";
import type { BrowserHost } from "./browser-sandbox.js";
import { SLOW_REQUEST_MS, shortUrl, type BrowserManager } from "./browser-session.js";
import { describeResize, interactiveLines, snapshotChanges } from "./browser-snapshot.js";

/** Host functions the sandbox exposes by name (evaluate, wait and log have their own wrappers). */
export const BROWSER_API_NAMES = [
  "open",
  "snapshot",
  "click",
  "fill",
  "check",
  "resize",
  "screenshot",
  "problems",
  "requests",
  "request",
  "fetch",
] as const;

export interface Target {
  ref?: string;
  selector?: string;
  role?: string;
  name?: string;
  text?: string;
  label?: string;
  placeholder?: string;
  testid?: string;
  exact?: boolean;
  nth?: number;
}

export interface Screenshot {
  path: string;
  data: Buffer;
}

const TARGET_KEYS = [
  "ref",
  "selector",
  "role",
  "name",
  "text",
  "label",
  "placeholder",
  "testid",
] as const;
const LOCATOR_KEYS = TARGET_KEYS.filter((k) => k !== "name");
const ACTION_TIMEOUT_MS = 5000;
const MAX_WAIT_MS = 30_000;

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

// Snapshot refs look like e12, or f2e12 inside a frame.
const REF_SHAPE = /^(f\d+)?e\d+$/;

/** A ref string ("e12"), other text to find on the page, or an object naming the element. */
export function toTarget(v: unknown): Target {
  if (typeof v === "string") return REF_SHAPE.test(v) ? { ref: v } : { text: v };
  const o = obj(v);
  const t: Target = {};
  for (const k of TARGET_KEYS) if (typeof o[k] === "string") t[k] = o[k];
  if (typeof o.exact === "boolean") t.exact = o.exact;
  if (num(o.nth) !== undefined) t.nth = num(o.nth);
  return t;
}

export const hasTarget = (t: Target): boolean => LOCATOR_KEYS.some((k) => t[k] !== undefined);

export const describeTarget = (t: Target): string =>
  t.ref ??
  t.selector ??
  (t.role ? `${t.role}${t.name ? ` "${t.name}"` : ""}` : undefined) ??
  t.label ??
  t.placeholder ??
  t.testid ??
  t.text ??
  "page";

export function locate(p: Page, t: Target): Locator {
  let loc: Locator;
  if (t.ref) loc = p.getByRef(t.ref);
  else if (t.selector) loc = p.locator(t.selector);
  else if (t.role)
    loc = p.getByRole(
      t.role as Parameters<Page["getByRole"]>[0],
      t.name ? { name: t.name, exact: t.exact ?? true } : {},
    );
  else if (t.label) loc = p.getByLabel(t.label, { exact: t.exact });
  else if (t.placeholder) loc = p.getByPlaceholder(t.placeholder, { exact: t.exact });
  else if (t.testid) loc = p.getByTestId(t.testid);
  else if (t.text) loc = p.getByText(t.text, { exact: t.exact ?? false });
  else
    throw new Error(
      "No element given: use a ref, or role (+name), text, label, placeholder, testid or selector.",
    );
  return t.nth !== undefined ? loc.nth(t.nth) : loc;
}

/** Run an element action; if it fails, say why in terms the script can act on. */
async function onElement<T>(p: Page, t: Target, fn: (loc: Locator) => Promise<T>): Promise<T> {
  const loc = locate(p, t);
  try {
    return await fn(loc);
  } catch (err) {
    const first = err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);
    const n = await loc.count().catch(() => -1);
    const what = describeTarget(t);
    if (n === 0)
      throw new Error(
        `No element matches ${what}.${t.ref ? " Refs change when the page changes; use refs from the latest result or snapshot." : ""}`,
        { cause: err },
      );
    if (n > 1 && t.nth === undefined)
      throw new Error(`${n} elements match ${what}; add nth (0-based) or a more specific target.`, {
        cause: err,
      });
    if (
      n >= 1 &&
      !(await loc
        .first()
        .isVisible()
        .catch(() => true))
    )
      throw new Error(`${what} exists but is hidden.`, { cause: err });
    if (
      n >= 1 &&
      !(await loc
        .first()
        .isEnabled()
        .catch(() => true))
    )
      throw new Error(`${what} is disabled.`, { cause: err });
    throw new Error(first, { cause: err });
  }
}

/** Resolve to `fallback` if `promise` takes longer than `ms`. */
const within = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((r) => setTimeout(() => r(fallback), ms).unref()),
  ]);

const clip = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more chars)` : s;

// Request types an action's effects depend on; long-lived streams and media are ignored.
const AWAITED = new Set(["document", "fetch", "xhr", "script", "stylesheet"]);

export function createBrowserApi(m: BrowserManager, cwd: string, shots: Screenshot[]): BrowserHost {
  /** Let an action's effects land; a slow endpoint costs at most ~0.5 s. Returns what's still loading. */
  const settle = async (p: Page, since = performance.now()): Promise<string[]> => {
    await p.waitForLoadState("domcontentloaded").catch(() => {});
    // Two frames let a click's re-render and fetches start; capped in case frames are paused.
    await Promise.race([
      p
        .evaluate(
          () =>
            new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
        )
        .catch(() => {}),
      p.waitForTimeout(100),
    ]);
    const mine = (): [Request, number][] =>
      [...m.pending].filter(([r, t0]) => t0 >= since && AWAITED.has(r.resourceType()));
    const deadline = performance.now() + 400;
    while (mine().length && performance.now() < deadline) await p.waitForTimeout(50);
    return mine().map(
      ([r, t0]) =>
        `${r.method()} ${shortUrl(r.url())} (${Math.round(performance.now() - t0)} ms so far)`,
    );
  };

  const changeCount = (p: Page): Promise<string> =>
    p
      .evaluate(() => String((globalThis as { __ggChanges?: string }).__ggChanges ?? ""))
      .catch(() => "");

  /** Take the page tree, noting the change count first so a change during the walk isn't missed. */
  const freshSnapshot = async (p: Page): Promise<string> => {
    const at = await changeCount(p);
    const snap = await p.ariaSnapshot({ mode: "ai" });
    m.lastSnapshot.set(p, { snap, at });
    return snap;
  };

  /** The tree before an action: the last one, if the page hasn't changed since it was taken. */
  const beforeSnapshot = async (p: Page): Promise<string> => {
    const cached = m.lastSnapshot.get(p);
    if (cached?.at && cached.at === (await changeCount(p))) return cached.snap;
    return freshSnapshot(p);
  };

  const snapshotText = async (p: Page, interactiveOnly: boolean): Promise<string> => {
    const snap = await freshSnapshot(p);
    return interactiveOnly ? interactiveLines(snap) : snap;
  };

  /** Run an action and describe its effect: page changes, or the new page after a navigation. */
  const act = async (
    p: Page,
    run: () => Promise<string>,
    describeChanges?: (changes: string[]) => string,
  ): Promise<string> => {
    const before = await beforeSnapshot(p).catch(() => null);
    const url0 = p.url();
    const t0 = performance.now();
    const msg = await run();
    const loading = await settle(p, t0);
    const page = await m.page();
    const out = [msg];
    if (page !== p || page.url() !== url0)
      out.push(
        `Now at ${page.url()} — "${await page.title().catch(() => "")}"`,
        await snapshotText(page, true).catch(() => ""),
      );
    else if (before !== null) {
      const after = await freshSnapshot(page).catch(() => null);
      if (after !== null) {
        const changes = snapshotChanges(before, after);
        out.push(
          describeChanges
            ? describeChanges(changes)
            : changes.length
              ? `Page changes:\n${changes.join("\n")}`
              : "No visible change on the page.",
        );
      }
    }
    if (loading.length) out.push(`Still loading:\n${loading.join("\n")}`);
    return out.filter(Boolean).join("\n");
  };

  const probe = async (fn: () => Promise<boolean>): Promise<boolean> => {
    try {
      return await fn();
    } catch {
      return false;
    }
  };

  const api: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    async open(url) {
      if (typeof url !== "string" || !url) throw new Error("open(url) needs a URL string.");
      const p = await m.page();
      await p.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await settle(p);
      return `Opened ${p.url()} — "${await p.title()}"\n${await snapshotText(p, true)}`;
    },

    async snapshot(opts) {
      const o = obj(opts);
      return clip(await snapshotText(await m.page(), o.interactiveOnly === true), 20_000);
    },

    async click(target, opts) {
      const t = toTarget(target);
      const double = obj(opts).double === true;
      const p = await m.page();
      return act(p, async () => {
        await onElement(p, t, (loc) =>
          double
            ? loc.dblclick({ timeout: ACTION_TIMEOUT_MS })
            : loc.click({ timeout: ACTION_TIMEOUT_MS }),
        );
        return `${double ? "Double-clicked" : "Clicked"} ${describeTarget(t)}.`;
      });
    },

    async fill(fields, opts) {
      const list = Array.isArray(fields)
        ? fields.map((f) => {
            const o = obj(f);
            return { t: toTarget(o.target ?? o), value: String(o.value ?? ""), type: str(o.type) };
          })
        : Object.entries(obj(fields)).map(([label, value]) => ({
            t: { label } as Target,
            value: String(value),
            type: undefined,
          }));
      if (!list.length)
        throw new Error("fill() needs fields: {Label: value} or [{...target, value}].");
      const submit = obj(opts).submit === true;
      const p = await m.page();
      return act(p, async () => {
        for (const f of list) {
          await onElement(p, f.t, (loc) => {
            if (f.type === "checkbox" || f.type === "radio")
              return loc.setChecked(f.value === "true", { timeout: ACTION_TIMEOUT_MS });
            if (f.type === "combobox")
              return loc
                .selectOption(f.value, { timeout: ACTION_TIMEOUT_MS })
                .then(() => undefined);
            return loc.fill(f.value, { timeout: ACTION_TIMEOUT_MS });
          });
        }
        if (submit) await locate(p, list.at(-1)!.t).press("Enter");
        return `Filled ${list.length} field(s)${submit ? " and submitted" : ""}.`;
      });
    },

    async check(spec) {
      const s = obj(spec);
      const t = toTarget(s.target ?? s);
      const p = await m.page();
      type Check = { label: string; ok: () => Promise<boolean>; got?: () => Promise<unknown> };
      const checks: Check[] = [];
      const url = str(s.url);
      const title = str(s.page_title);
      if (url !== undefined)
        checks.push({
          label: `URL contains "${url}"`,
          ok: async () => p.url().includes(url),
          got: async () => p.url(),
        });
      if (title !== undefined)
        checks.push({
          label: `title contains "${title}"`,
          ok: async () => (await p.title()).includes(title),
          got: () => p.title(),
        });
      const texts = Array.isArray(s.texts)
        ? s.texts.filter((x): x is string => typeof x === "string")
        : [];
      for (const text of texts)
        checks.push({
          label: `"${text}" is visible`,
          ok: () => probe(() => p.getByText(text).first().isVisible()),
        });
      const elementTarget = t;
      if (hasTarget(elementTarget)) {
        const loc = locate(p, elementTarget);
        const one = loc.first();
        const label = `"${describeTarget(elementTarget)}"`;
        const value = str(s.value);
        const count = num(s.count);
        const inputValue = (): Promise<string | false> =>
          one.inputValue({ timeout: 200 }).catch(() => false as const);
        if (value !== undefined)
          checks.push({
            label: `${label} has value "${value}"`,
            ok: async () => (await inputValue()) === value,
            got: inputValue,
          });
        if (count !== undefined)
          checks.push({
            label: `${label} matches ${count} element(s)`,
            ok: async () => (await loc.count()) === count,
            got: () => loc.count(),
          });
        const state =
          str(s.state) ?? (value === undefined && count === undefined ? "visible" : undefined);
        const states: Record<string, () => Promise<boolean>> = {
          visible: () => probe(() => one.isVisible()),
          hidden: async () => !(await probe(() => one.isVisible())),
          enabled: () => probe(() => one.isEnabled({ timeout: 200 })),
          disabled: () => probe(() => one.isDisabled({ timeout: 200 })),
          checked: () => probe(() => one.isChecked({ timeout: 200 })),
          unchecked: async () =>
            !(await probe(() => one.isChecked({ timeout: 200 }))) && (await loc.count()) > 0,
          editable: () => probe(() => one.isEditable({ timeout: 200 })),
        };
        if (state) {
          const ok = states[state];
          if (!ok)
            throw new Error(`Unknown state "${state}": use ${Object.keys(states).join(", ")}.`);
          checks.push({ label: `${label} is ${state}`, ok });
        }
      }
      if (!checks.length)
        throw new Error("Nothing to check: give text, texts, url, page_title or an element.");
      const deadline = performance.now() + Math.min(num(s.timeout_ms) ?? 3000, MAX_WAIT_MS);
      let failed: Check[];
      for (;;) {
        failed = [];
        for (const c of checks) if (!(await c.ok())) failed.push(c);
        if (!failed.length || performance.now() >= deadline) break;
        await p.waitForTimeout(100);
      }
      if (!failed.length)
        return { pass: true, detail: `PASS: ${checks.map((c) => c.label).join("; ")}.` };
      const lines: string[] = [];
      for (const c of failed)
        lines.push(`${c.label}${c.got ? ` (got ${JSON.stringify(await c.got())})` : ""}`);
      return { pass: false, detail: `FAIL: ${lines.join("; ")}.` };
    },

    async resize(width, height) {
      const w = num(width);
      const h = num(height);
      if (!w || !h)
        throw new Error("resize(width, height) needs two numbers, e.g. resize(390, 844).");
      const p = await m.page();
      const size = `${Math.round(w)}×${Math.round(h)}`;
      return act(
        p,
        async () => {
          await p.setViewportSize({ width: Math.round(w), height: Math.round(h) });
          return `Viewport ${size}.`;
        },
        (changes) => describeResize(changes, size),
      );
    },

    async screenshot(opts) {
      const o = obj(opts);
      const p = await m.page();
      const element = o.element === undefined ? undefined : toTarget(o.element);
      const data =
        element && hasTarget(element)
          ? await onElement(p, element, (loc) => loc.screenshot({ timeout: ACTION_TIMEOUT_MS }))
          : await p.screenshot({ fullPage: o.full_page === true });
      const out = path.join(cwd, ".gg", "browser", `shot-${Date.now()}-${shots.length + 1}.png`);
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, data);
      shots.push({ path: out, data });
      return `Saved ${out}`;
    },

    async evaluate(what, ...rest) {
      const w = obj(what);
      const p = await m.page();
      if (typeof w.fn === "string")
        return p.evaluate(`(${w.fn})(${rest.length ? JSON.stringify(rest[0]) : ""})`);
      if (typeof w.expr === "string") return p.evaluate(w.expr);
      throw new Error("evaluate() needs a function or an expression string.");
    },

    async problems() {
      return {
        console: m.console
          .filter((c) => c.level === "error" || c.level === "pageerror")
          .map((c) => `[${c.level}] ${c.text}${c.where ? ` (${c.where})` : ""}`),
        network: m.network
          .filter((n) => n.status >= 400 || n.failure)
          .map((n) => `#${n.id} ${n.method} ${shortUrl(n.url)} → ${n.failure ?? n.status}`),
      };
    },

    async requests(opts) {
      const o = obj(opts);
      const all = o.all === true;
      const filter = str(o.filter);
      const lines = m.network
        .filter(
          (n) =>
            (!filter || n.url.includes(filter)) &&
            (all || n.status >= 400 || n.failure || (n.ms ?? 0) > SLOW_REQUEST_MS),
        )
        .map(
          (n) => `#${n.id} ${n.method} ${shortUrl(n.url)} → ${n.failure ?? n.status} (${n.ms} ms)`,
        );
      const now = performance.now();
      for (const [r, t0] of m.pending)
        if ((!filter || r.url().includes(filter)) && (all || now - t0 > SLOW_REQUEST_MS))
          lines.push(
            `${r.method()} ${shortUrl(r.url())} → pending (${Math.round(now - t0)} ms so far)`,
          );
      return lines.length
        ? clip(lines.join("\n"), 8000)
        : all
          ? "No requests."
          : "No failed or slow requests.";
    },

    async request(id) {
      const n = m.network.find((r) => r.id === num(id));
      if (!n) return `No request #${String(id)}.`;
      const out = [
        `#${n.id} ${n.method} ${n.url} → ${n.failure ?? n.status} (${n.ms} ms, ${n.type})`,
      ];
      const body = n.request.postData();
      if (body)
        out.push(
          `Request body (${n.request.headers()["content-type"] ?? "unknown type"}): ${clip(body, 2000)}`,
        );
      if (n.response) {
        out.push(`Response type: ${n.response.headers()["content-type"] ?? "unknown"}`);
        // Chrome never delivers a body the page didn't read (e.g. an ignored 500).
        out.push(
          `Response body: ${clip(await within(n.response.text(), 2000, "(not available: the page never read it)"), 4000)}`,
        );
      }
      return out.join("\n");
    },

    async fetch(url, init) {
      if (typeof url !== "string") throw new Error("fetch(url) needs a URL string.");
      const o = obj(init);
      const p = await m.page();
      return p.evaluate(
        async ([u, i]) => {
          const r = await fetch(u, i);
          return {
            status: r.status,
            ok: r.ok,
            statusText: r.statusText,
            url: r.url,
            headers: Object.fromEntries(r.headers),
            body: await r.text(),
          };
        },
        [
          url,
          {
            method: str(o.method),
            headers: obj(o.headers) as Record<string, string>,
            body: str(o.body),
            credentials: "include" as const,
          },
        ] as const,
      );
    },

    async wait(ms) {
      const t = Math.max(0, Math.min(num(ms) ?? 0, MAX_WAIT_MS));
      await new Promise((r) => setTimeout(r, t));
      return null;
    },
  };

  return async (name, args) => {
    const fn = Object.hasOwn(api, name) ? api[name] : undefined;
    if (!fn) throw new Error(`Unknown browser function ${name}.`);
    return fn(...args);
  };
}
