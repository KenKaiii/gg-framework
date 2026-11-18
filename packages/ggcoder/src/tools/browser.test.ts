import http from "node:http";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StructuredToolResult, ToolContext } from "@kenkaiiii/gg-agent";
import { BrowserManager, createBrowserTool } from "./browser.js";
import { extractToolImagePaths } from "../core/session-history.js";

// Real-browser tests need Playwright's Chromium, which CI doesn't download.
async function hasChromium(): Promise<boolean> {
  try {
    const name: string = "playwright";
    const { chromium } = (await import(name)) as { chromium: { executablePath(): string } };
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
const noBrowser = !(await hasChromium());

const PAGE = `<!doctype html><title>Todos</title>
<label>Title <input id="t"></label>
<button onclick="add()">Add</button>
<button onclick="null.boom()">Delete</button>
<ul id="list"></ul>
<script>
  async function add() {
    const title = document.getElementById("t").value;
    const res = await fetch("/api/todos", { method: "POST", body: title });
    if (res.ok) document.getElementById("list").insertAdjacentHTML("beforeend", "<li>" + title + "</li>");
  }
</script>`;

const ctx = (signal = new AbortController().signal): ToolContext => ({ signal, toolCallId: "t" });
const text = (r: string | StructuredToolResult): string =>
  typeof r === "string"
    ? r
    : (r.content as { type: string; text?: string }[])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");

describe.skipIf(noBrowser)("browser tool in a real browser", { timeout: 60_000 }, () => {
  let server: http.Server;
  let url: string;
  let cwd: string;
  const manager = new BrowserManager();
  const tool = () => createBrowserTool(cwd, manager);

  beforeAll(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "gg-browser-"));
    server = http.createServer((req, res) => {
      if (req.url === "/api/todos") {
        let body = "";
        req.on("data", (d: Buffer) => (body += d.toString()));
        req.on("end", () => {
          res.statusCode = body.includes("&") ? 500 : 201;
          res.end();
        });
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end(PAGE);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    await manager.shutdown();
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  it("runs a multi-step flow and reports page changes and problems", async () => {
    const out = text(
      await tool().execute(
        {
          code: `log(await open(${JSON.stringify(url)}));
log(await fill({ Title: "Milk" }));
log(await click({ role: "button", name: "Add" }));
await fill({ Title: "Tom & Jerry" });
await click({ role: "button", name: "Add" });
await click({ text: "Delete" });
return await check({ texts: ["Milk"] });`,
        },
        ctx(),
      ),
    );
    expect(out).toContain('button "Add" [ref=');
    expect(out).toContain("+ listitem");
    expect(out).toContain('"pass": true');
    expect(out).toMatch(/network POST \/api\/todos → 500/);
    expect(out).toMatch(/console pageerror: .*boom/);
  });

  it("keeps the page open between calls and reports each problem once", async () => {
    const out = text(
      await tool().execute(
        { code: `return await evaluate(() => document.querySelectorAll("li").length);` },
        ctx(),
      ),
    );
    expect(out).toContain("Result: 1");
    expect(out).not.toContain("New problems");
  });

  it("attaches screenshots with previews and a path line the history can restore", async () => {
    const result = await tool().execute(
      { code: `await resize(390, 844); return await screenshot();` },
      ctx(),
    );
    expect(typeof result).not.toBe("string");
    const r = result as StructuredToolResult;
    const blocks = r.content as { type: string; text?: string; mediaType?: string }[];
    const paths = extractToolImagePaths(blocks[0]?.text ?? "");
    expect(paths).toHaveLength(1);
    expect(existsSync(paths[0]!)).toBe(true);
    expect(paths[0]!.startsWith(path.join(cwd, ".gg", "browser"))).toBe(true);
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(1);
    expect((r.details as { imagePreviews: { path: string }[] }).imagePreviews[0]?.path).toBe(
      paths[0],
    );
  });

  it("fetches with the page's origin and treats plain strings as visible text", async () => {
    const out = text(
      await tool().execute(
        {
          code: `const r = await fetch("/api/todos", { method: "POST", body: "A & B" });
await fill({ Title: "Eggs" });
await click("Add");
return [r.status, r.ok, await check({ texts: ["Eggs"] })];`,
        },
        ctx(),
      ),
    );
    expect(out).toMatch(/500,\s*false/);
    expect(out).toContain('"pass": true');
  });

  it("reports only what an action changed, even when the page changed on its own before it", async () => {
    const out = text(
      await tool().execute(
        {
          code: `await open(${JSON.stringify(url)});
await fill({ Title: "First" });
await evaluate(() => document.body.insertAdjacentHTML("beforeend", "<p>From a timer</p>"));
return await fill({ Title: "Second" });`,
        },
        ctx(),
      ),
    );
    expect(out).toContain('textbox "Title"');
    expect(out).toContain("Second");
    expect(out).not.toContain("From a timer");
  });

  it("explains a missing element instead of a raw timeout", async () => {
    const out = text(await tool().execute({ code: `await click("e999");` }, ctx()));
    expect(out).toMatch(/Script failed: No element matches e999\. Refs change/);
  });

  it("starts a fresh browser after shutdown", async () => {
    await manager.shutdown();
    expect(manager.isOpen).toBe(false);
    const out = text(
      await tool().execute(
        { code: `return (await open(${JSON.stringify(url)})).split("\\n")[0];` },
        ctx(),
      ),
    );
    expect(out).toContain("Opened http://127.0.0.1");
    expect(manager.isOpen).toBe(true);
  });
});
