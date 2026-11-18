import { describe, expect, it } from "vitest";
import { runBrowserScript, type BrowserHost } from "./browser-sandbox.js";

const echo: BrowserHost = async (name, args) => ({ name, args });
const run = (code: string, host: BrowserHost = echo, timeoutMs = 3000, signal?: AbortSignal) =>
  runBrowserScript(code, ["open", "fail"], host, { timeoutMs, signal });

describe("browser script sandbox", () => {
  it("calls host functions with JSON arguments and returns the script's value", async () => {
    const out = await run(
      `const r = await open("http://x", { width: 390 }); log("got", r.name); return r.args;`,
    );
    expect(out.error).toBeUndefined();
    expect(out.result).toEqual({ value: ["http://x", { width: 390 }] });
    expect(out.logs).toEqual(["got open"]);
  });

  it("sends evaluate a function's source, not the function", async () => {
    const out = await run(`return await evaluate((x) => x * 2, 21);`);
    expect(out.result?.value).toEqual({ name: "evaluate", args: [{ fn: "(x) => x * 2" }, 21] });
  });

  it("gives the script no way to reach Node", async () => {
    const probes = [
      "typeof process",
      "typeof require",
      "globalThis.constructor.constructor('return typeof process')()",
      "open.constructor('return typeof process')()",
      "open('a').constructor.constructor('return typeof process')()",
      "log.constructor('return typeof process')()",
    ];
    for (const probe of probes) {
      const out = await run(`return ${probe};`);
      expect(out.result?.value, probe).toBe("undefined");
    }
    const imported = await run(
      `return await import("node:fs").then(() => "loaded", () => "blocked");`,
    );
    expect(imported.result?.value).toBe("blocked");
  });

  it("keeps working when the script overrides built-ins the bridge uses", async () => {
    const out = await run(
      `Promise.prototype.then = function () { return 1; }; JSON.stringify = () => "{}"; const r = await open("a"); return r.name;`,
    );
    expect(out.error).toBeUndefined();
    expect(out.result?.value).toBe("open");
  });

  it("turns a host error into a catchable script error", async () => {
    const host: BrowserHost = async () => {
      throw new Error("No element matches e9.");
    };
    const caught = await run(
      `try { await fail(); } catch (e) { return "caught: " + e.message; }`,
      host,
    );
    expect(caught.result?.value).toBe("caught: No element matches e9.");
    const thrown = await run(`log("step 1"); await fail();`, host);
    expect(thrown.error).toBe("No element matches e9.");
    expect(thrown.logs).toEqual(["step 1"]);
  });

  it("stops a runaway script and keeps its logs", async () => {
    const out = await run(`log("before"); await open("a"); while (true) {}`, echo, 500);
    expect(out.error).toMatch(/stopped after 0.5 s/);
    expect(out.logs).toEqual(["before"]);
  });

  it("stops when the turn is aborted", async () => {
    const out = await run(`await new Promise(() => {});`, echo, 10_000, AbortSignal.timeout(200));
    expect(out.error).toBe("Script aborted.");
  });

  it("reports syntax errors and empty results", async () => {
    expect((await run(`return (;`)).error).toMatch(/^Syntax error/);
    const none = await run(`await open("a");`);
    expect(none.error).toBeUndefined();
    expect(none.result).toBeUndefined();
  });
});

describe("browser script sandbox: familiar globals", () => {
  it("runs setTimeout callbacks through wait and fetch through the page", async () => {
    const calls: string[] = [];
    const host: BrowserHost = async (name, args) => {
      calls.push(`${name}:${JSON.stringify(args)}`);
      return null;
    };
    const slept = await run(`await new Promise((r) => setTimeout(r, 250)); return "woke";`, host);
    expect(slept.result?.value).toBe("woke");
    expect(calls).toEqual(["wait:[250]"]);
    const page: BrowserHost = async (name, args) =>
      name === "fetch" ? { status: 500, ok: false, body: JSON.stringify({ seen: args }) } : null;
    const fetched = await run(
      `const r = await fetch("/api/todos", { method: "POST", body: "{}" }); return [r.status, r.ok, (await r.json()).seen];`,
      page,
    );
    expect(fetched.result?.value).toEqual([
      500,
      false,
      ["/api/todos", { method: "POST", body: "{}" }],
    ]);
    const formBody = await run(`await fetch("/x", { body: {} });`, page);
    expect(formBody.error).toMatch(/body must be a string/);
  });
});
