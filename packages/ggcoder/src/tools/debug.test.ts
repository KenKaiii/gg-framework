import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDebugTool, DebugManager } from "./debug.js";
import { formatRemoteObject } from "../core/node-debugger.js";

let dir: string;
let manager: DebugManager;

const PROGRAM = [
  "function total(items) {", // 1
  "  let sum = 0;", // 2
  "  for (const item of items) {", // 3
  "    sum += item.price * item.qty;", // 4
  "  }", // 5
  "  return sum;", // 6
  "}", // 7
  "const cart = [{ price: 2, qty: 3 }, { price: 5, qty: 1 }];", // 8
  "console.log('total', total(cart));", // 9
  "", // 10
].join("\n");

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "debug-tool-"));
  await fs.writeFile(path.join(dir, "cart.js"), PROGRAM);
  await fs.writeFile(
    path.join(dir, "boom.js"),
    "const config = { retries: 3 };\nfunction load() {\n  throw new Error('bad config: ' + config.retries);\n}\nload();\n",
  );
  manager = new DebugManager();
});

afterEach(async () => {
  manager.shutdown();
  await fs.rm(dir, { recursive: true, force: true });
});

function run(args: Record<string, unknown>, planMode = false): Promise<string> {
  const tool = createDebugTool(dir, manager, undefined, { current: planMode });
  return tool.execute(args as never, {
    signal: new AbortController().signal,
    toolCallId: "t",
  }) as Promise<string>;
}

describe("debug tool", () => {
  it(
    "stops at a breakpoint, shows real locals, steps and evaluates",
    { timeout: 30_000 },
    async () => {
      const launched = await run({
        action: "launch",
        program: "cart.js",
        breakpoints: [{ file: "cart.js", line: 4 }],
      });
      expect(launched).toContain("Breakpoints: bp1 cart.js:4");
      expect(launched).toContain("Paused at breakpoint bp1 in total (cart.js:4:17)");
      expect(launched).toContain("> 4 |     sum += item.price * item.qty;");
      expect(launched).toContain("sum = 0");
      expect(launched).toContain("item = {price: 2, qty: 3}");

      expect(await run({ action: "evaluate", expression: "item.price * item.qty" })).toBe("6");

      const second = await run({ action: "continue" });
      expect(second).toContain("sum = 6");
      expect(second).toContain("item = {price: 5, qty: 1}");

      expect(await run({ action: "stack" })).toMatch(
        /^#0 total \(cart\.js:4:17\)\n#1 .*\(cart\.js:9:\d+\)/,
      );

      await run({ action: "remove_breakpoint", breakpoint_id: "bp1" });
      const done = await run({ action: "continue" });
      expect(done).toContain("The program exited (code 0)");
      expect(done).toContain("total 11");
    },
  );

  it("supports conditional breakpoints", { timeout: 30_000 }, async () => {
    const out = await run({
      action: "launch",
      program: "cart.js",
      breakpoints: [{ file: "cart.js", line: 4, condition: "item.price === 5" }],
    });
    expect(out).toContain("sum = 6");
  });

  it(
    "binds a breakpoint to a script Node names in a spelling the path cannot predict",
    { timeout: 30_000 },
    async () => {
      // With --preserve-symlinks-main Node names the script by the link, not by
      // cart.js, so only the on-disk identity check can bind the breakpoint.
      await fs.symlink(path.join(dir, "cart.js"), path.join(dir, "entry.js"));
      const out = await run({
        action: "launch",
        program: "entry.js",
        node_args: ["--preserve-symlinks-main"],
        breakpoints: [{ file: "cart.js", line: 4, condition: "item.price === 5" }],
      });
      expect(out).toContain("Paused at breakpoint bp1 in total (cart.js:4:17)");
      expect(out).toContain("sum = 6");
      expect(await run({ action: "remove_breakpoint", breakpoint_id: "bp1" })).not.toMatch(
        /error|no breakpoint/i,
      );
      expect(await run({ action: "continue" })).toContain("The program exited (code 0)");
    },
  );

  it("pauses on an uncaught exception with the thrown value", { timeout: 30_000 }, async () => {
    const out = await run({ action: "launch", program: "boom.js" });
    expect(out).toContain("Paused on an exception: Error: bad config: 3 in load (boom.js:3:3)");
    expect(out).toContain("config = {retries: 3}");
    expect(out).toContain("Error: bad config: 3");
  });

  it("refuses to launch in plan mode and needs a session for other actions", async () => {
    expect(await run({ action: "launch", program: "cart.js" }, true)).toContain(
      "restricted in plan mode",
    );
    expect(await run({ action: "continue" })).toContain("no debug session");
  });

  it("reports a program that cannot start", { timeout: 30_000 }, async () => {
    const out = await run({ action: "launch", program: "missing.js" });
    expect(out).toMatch(/exited \(code 1\)|could not start/);
  });
});

describe("formatRemoteObject", () => {
  it.each([
    [{ type: "undefined" }, "undefined"],
    [{ type: "object", subtype: "null", value: null }, "null"],
    [{ type: "string", value: 'a"b' }, '"a\\"b"'],
    [{ type: "number", unserializableValue: "NaN" }, "NaN"],
    [{ type: "number", value: 4 }, "4"],
  ])("formats %j", (object, expected) => {
    expect(formatRemoteObject(object)).toBe(expected);
  });
});
