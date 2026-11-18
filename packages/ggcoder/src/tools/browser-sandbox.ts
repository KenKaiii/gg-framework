import { Worker } from "node:worker_threads";

/**
 * Runs a model-written browser script with no Node access. The script lives in
 * a worker thread (so a runaway loop can be stopped) inside a fresh vm context,
 * and reaches the host only through a bridge that passes JSON strings: no host
 * object ever enters the context, which is what makes vm escapes impossible.
 */

// Strict mode everywhere on the host side: a context-created Error's stack
// callsites cannot hand back a strict function.
const WORKER_SOURCE = `"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const ctx = vm.createContext(vm.constants.DONT_CONTEXTIFY);
const send = (kind, id, name, json) => {
  try {
    if (typeof kind !== "string" || typeof id !== "number" || typeof name !== "string" || typeof json !== "string") return;
    parentPort.postMessage({ kind, id, name, json });
  } catch {}
};
const install = vm.runInContext(workerData.bridge, ctx, { filename: "browser-bridge" });
const bridge = install(send, workerData.names);
parentPort.on("message", (m) => {
  try {
    bridge.receive(m.id, m.ok === true, typeof m.json === "string" ? m.json : "null");
  } catch {}
});
let script;
try {
  script = vm.runInContext("(async function () {\\n" + workerData.code + "\\n})", ctx, { filename: "script.js", lineOffset: -1 });
} catch (err) {
  send("done", 0, "err", JSON.stringify("Syntax error: " + String(err && err.message)));
}
if (script) bridge.start(script);
`;

// Evaluated inside the context. Built-ins are captured before the script runs,
// so a script that overwrites JSON or Promise.prototype.then can't break or
// observe the bridge.
const BRIDGE_SOURCE = `(function (send, names) {
  "use strict";
  const g = globalThis;
  const parse = JSON.parse, stringify = JSON.stringify, apply = Reflect.apply;
  const then = Promise.prototype.then, P = Promise, E = Error, S = String;
  const map = new Map(), get = Map.prototype.get, set = Map.prototype.set, del = Map.prototype.delete;
  let next = 0;
  const show = (v) => {
    if (typeof v === "string") return v;
    try { const s = stringify(v, null, 2); return s === undefined ? S(v) : s; } catch { return S(v); }
  };
  const call = (name, args) => new P((res, rej) => {
    let json;
    try { json = stringify(args); } catch (err) { rej(new E(name + "(): arguments must be JSON-serializable")); return; }
    const id = ++next;
    apply(set, map, [id, { res, rej }]);
    send("call", id, name, json);
  });
  for (const name of names) g[name] = (...args) => call(name, args);
  g.evaluate = (fn, arg) =>
    call("evaluate", arg === undefined ? [typeof fn === "function" ? { fn: S(fn) } : { expr: S(fn) }] : [typeof fn === "function" ? { fn: S(fn) } : { expr: S(fn) }, arg]);
  const log = (...values) => { const parts = []; for (const v of values) parts[parts.length] = show(v); send("log", 0, "", parts.join(" ")); };
  g.log = log;
  g.console = { log, info: log, warn: log, error: log, debug: log };
  g.wait = (ms) => call("wait", [ms]);
  // Scripts written for Node or a page reach for these; map them onto the API.
  g.setTimeout = (fn, ms) => { if (typeof fn === "function") apply(then, call("wait", [ms]), [() => fn()]); return 0; };
  // fetch runs in the page (its cookies and origin) and resolves to a minimal Response.
  g.fetch = (url, init) => {
    const o = init && typeof init === "object" ? init : {};
    if (o.body !== undefined && typeof o.body !== "string") return P.reject(new E("fetch(): body must be a string, e.g. JSON.stringify(data)"));
    return apply(then, call("fetch", [S(url), { method: o.method, headers: o.headers, body: o.body }]), [(r) => {
      const body = r.body;
      return { status: r.status, ok: r.ok, statusText: r.statusText, url: r.url, headers: r.headers, text: () => P.resolve(body), json: () => P.resolve(parse(body)) };
    }]);
  };
  const message = (err) => { try { return err && typeof err === "object" && "message" in err ? S(err.message) : S(err); } catch { return "script threw"; } };
  return {
    receive(id, ok, json) {
      const p = apply(get, map, [id]);
      if (!p) return;
      apply(del, map, [id]);
      const value = parse(json);
      if (ok) p.res(value);
      else p.rej(new E(S(value)));
    },
    start(fn) {
      let promise;
      try { promise = fn(); } catch (err) { send("done", 0, "err", stringify(message(err))); return; }
      apply(then, promise, [
        (v) => { let json; try { json = v === undefined ? "null" : stringify({ v }); } catch { json = stringify({ v: S(v) }); } send("done", 0, v === undefined ? "none" : "ok", json === undefined ? "null" : json); },
        (err) => send("done", 0, "err", stringify(message(err))),
      ]);
    },
  };
})`;

export type BrowserHost = (name: string, args: unknown[]) => Promise<unknown>;

export interface ScriptOutcome {
  logs: string[];
  /** Set when the script returned something other than undefined. */
  result?: { value: unknown };
  error?: string;
}

export interface RunScriptOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Cap on the worker's heap, so a runaway allocation can't take down the engine. */
  maxHeapMb?: number;
}

export function runBrowserScript(
  code: string,
  names: readonly string[],
  host: BrowserHost,
  opts: RunScriptOptions,
): Promise<ScriptOutcome> {
  const logs: string[] = [];
  return new Promise<ScriptOutcome>((resolve) => {
    let settled = false;
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { bridge: BRIDGE_SOURCE, names: [...names], code },
      resourceLimits: { maxOldGenerationSizeMb: opts.maxHeapMb ?? 256 },
      stdout: true,
      stderr: true,
    });
    const finish = (outcome: Omit<ScriptOutcome, "logs">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      resolve({ logs, ...outcome });
    };
    const timer = setTimeout(
      () => finish({ error: `Script stopped after ${opts.timeoutMs / 1000} s.` }),
      opts.timeoutMs,
    );
    const onAbort = (): void => finish({ error: "Script aborted." });
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    worker.on("message", (m: { kind: string; id: number; name: string; json: string }) => {
      if (m.kind === "log") {
        logs.push(m.json);
        return;
      }
      if (m.kind === "done") {
        const value: unknown = JSON.parse(m.json);
        if (m.name === "err") finish({ error: String(value) });
        else if (m.name === "ok") finish({ result: { value: (value as { v: unknown }).v } });
        else finish({});
        return;
      }
      if (m.kind !== "call") return;
      void (async () => {
        let reply: { ok: boolean; json: string };
        try {
          const value = await host(m.name, JSON.parse(m.json) as unknown[]);
          reply = { ok: true, json: JSON.stringify(value ?? null) ?? "null" };
        } catch (err) {
          reply = {
            ok: false,
            json: JSON.stringify(err instanceof Error ? err.message : String(err)),
          };
        }
        if (!settled) worker.postMessage({ id: m.id, ...reply });
      })();
    });
    worker.on("error", (err: Error) => finish({ error: err.message }));
    worker.on("exit", () => finish({ error: "Script ended without finishing." }));
  });
}
