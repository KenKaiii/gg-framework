// Live preview end to end in Chromium: the real page proxy, frame server and
// built overlay (ggcoder's dist + dist-live-preview) in front of a stub dev
// server, with a stand-in for the preview's agent session (no provider calls).
// Covers pick, hover, scroll, minimise, a modal dialog, a hot update, sending,
// reload replay, and a page script trying to reach the agent.
// Run after `pnpm build`: pnpm --filter gg-app exec node scripts/check-live-preview.mjs
// (Playwright's Chromium: `npx playwright install chromium`, or point GG_CHROMIUM at one.)
import assert from "node:assert/strict";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const managerJs = path.resolve(
  root,
  "../packages/ggcoder/dist/app-sidecar/live-preview/manager.js",
);
const { createLivePreviewManager } = await import(pathToFileURL(managerJs).href).catch(() => {
  throw new Error(`${managerJs} missing: run pnpm build first`);
});
await build({ configFile: path.join(root, "vite.live-preview.config.ts"), logLevel: "warn" });

// ── Stub dev server: a CSP that would block the overlay, a modal dialog, a fake hot update ──
const PAGE = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="script-src 'self'">
<meta charset="utf-8"><title>Stub app</title>
<style>body{font:16px system-ui;margin:0;padding:40px;min-height:2400px;background:#f6f4ef;color:#222}h1{color:#333}</style>
</head><body>
<ul id="list"><li>Latte</li><li>Mocha</li></ul>
<h1 class="title" onclick="window.__h1Clicks=(window.__h1Clicks||0)+1">Hello preview</h1>
<button id="open" onclick="document.getElementById('dlg').showModal()">Open dialog</button>
<dialog id="dlg"><p>A modal</p><button onclick="this.closest('dialog').close()">Close</button></dialog>
<script>
window.__hot = function () {
  // What a hot update does: the element is replaced and a sibling shifts it.
  var h1 = document.querySelector("h1");
  var fresh = h1.cloneNode(true);
  var note = document.createElement("p");
  note.textContent = "New paragraph above";
  h1.replaceWith(note, fresh);
};
</script>
</body></html>`;
const dev = http.createServer((req, res) => {
  if (req.url !== "/") return void res.writeHead(404).end();
  res
    .writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "script-src 'self' 'unsafe-inline'",
    })
    .end(PAGE);
});
await new Promise((r) => dev.listen(0, "127.0.0.1", r));
const devUrl = `http://localhost:${dev.address().port}/`;

// ── A stand-in for the preview's session: the routes the frame server maps to ──
const prompts = [];
function fakeSession(cwd) {
  const clients = new Set();
  const broadcast = (type, data) => {
    for (const c of clients) c.res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  };
  const state = {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    cwd,
    mode: "code",
    running: false,
    contextWindow: 200000,
    gitBranch: "main",
    isGitRepo: true,
  };
  const json = (res, body) =>
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  return {
    id: "preview-session",
    cwd,
    mode: "code",
    clients,
    broadcast,
    session: { listBackgroundProcesses: () => [] },
    handle(req, res, url) {
      if (url === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "ready", data: state })}\n\n`);
        const client = { id: Math.random(), res };
        clients.add(client);
        req.on("close", () => clients.delete(client));
        return;
      }
      if (url === "/state") return json(res, state);
      if (url === "/models") return json(res, { models: [] });
      if (url === "/git/overview") return json(res, { issues: null, pulls: null, changes: [] });
      if (url === "/prompt") {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          const body = JSON.parse(raw);
          prompts.push(body);
          json(res, { ok: true });
          const el = body.meta?.livePreview?.element;
          broadcast("live_preview_prompt", {
            text: body.text,
            element: el ? `<${el.tag}> ${el.text}` : null,
            queued: false,
          });
          broadcast("run_start", { text: body.text });
          broadcast("text_delta", { text: "Done, the heading is blue now." });
          broadcast("run_end", {});
        });
        return;
      }
      json(res, {});
    },
    dispose: async () => {},
  };
}

const manager = createLivePreviewManager({
  assetsDir: path.join(root, "dist-live-preview"),
  createSession: async (cwd) => fakeSession(cwd),
  closeSession: async () => {},
  usage: async () => ({ connected: false, windows: [] }),
});
const window = {
  id: "window",
  cwd: root,
  mode: "code",
  session: { listBackgroundProcesses: () => [] },
};
const status = await manager.start(window, { url: devUrl });
assert.equal(status.running, true, JSON.stringify(status));

// GG_CHROMIUM: a Chromium to use when Playwright's own download isn't installed.
const browser = await chromium.launch({ executablePath: process.env.GG_CHROMIUM || undefined });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`page: ${e.message}`));
const step = (name) => console.log(`ok - ${name}`);

try {
  await page.goto(status.url);
  const chat = page.frameLocator('iframe[title="GG Coder chat"]');
  const input = chat.locator("textarea");
  await input.waitFor({ timeout: 15000 });
  // The part of the iframe that shows and takes clicks: its box less its clip.
  const VISIBLE = () => {
    const f = document.querySelector("gg-live-preview")?.shadowRoot?.querySelector("iframe");
    if (!f) return null;
    const r = f.getBoundingClientRect();
    const m = /inset\(([^)]*)\)/.exec(f.style.clipPath);
    if (!m) return { x: r.x, y: r.bottom, w: 0, h: 0, bottom: r.bottom };
    // CSS shorthand: 1 to 4 lengths (top, right, bottom, left).
    const v = m[1].split(/\s+/).map((x) => parseFloat(x));
    const [top, right = top, bottom = top, left = right] = v;
    const y = r.y + top;
    return {
      x: r.x + left,
      y,
      w: r.width - left - right,
      h: r.height - top - bottom,
      bottom: r.bottom - bottom,
    };
  };
  await page.waitForFunction((src) => (0, eval)(`(${src})`)()?.h > 80, VISIBLE.toString());
  const frameBox = () => page.evaluate((src) => (0, eval)(`(${src})`)(), VISIBLE.toString());
  const box = await frameBox();
  assert.ok(box.w > 400 && box.w <= 1280, `frame width ${box.w}`);
  assert.ok(Math.abs(box.bottom - 800) < 2, `frame sits at the bottom (${box.bottom})`);
  assert.ok(box.y > 300, `frame covers only the chat, not the page (top ${box.y})`);
  assert.equal(await chat.getByRole("button", { name: "More", exact: true }).count(), 0);
  step("overlay loads through the proxy despite the page's CSP, sized to the chat");

  // The page above the chat still takes clicks.
  await page.click("h1");
  assert.equal(await page.evaluate(() => window.__h1Clicks), 1);

  // ── Pick and hover ──
  await chat.getByRole("button", { name: "Pick an element on the page" }).click();
  await page.waitForFunction(() => document.documentElement.classList.contains("gg-live-picking"));
  await page.hover("#list li:nth-child(2)");
  const hover = await page.evaluate(() => {
    const o = document.querySelector("gg-live-marks").shadowRoot.querySelector(".outline.hovering");
    return { on: o.classList.contains("on"), label: o.textContent };
  });
  assert.equal(hover.on, true);
  assert.match(hover.label, /liMocha/);
  step("pick mode outlines what the pointer is over");
  await page.click("h1");
  assert.equal(
    await page.evaluate(() => window.__h1Clicks),
    1,
    "the pick click doesn't reach the page",
  );
  await chat.getByText("<h1> Hello preview").waitFor();
  assert.equal(
    await page.evaluate(() => document.documentElement.classList.contains("gg-live-picking")),
    false,
  );
  step("a click picks the element, shows its chip, and leaves pick mode");

  // ── Scroll: the picked outline stays on the element ──
  const outlineGap = () =>
    page.evaluate(() => {
      const o = document.querySelector("gg-live-marks").shadowRoot.querySelector(".outline.picked");
      const a = o.getBoundingClientRect();
      const b = document.querySelector("h1").getBoundingClientRect();
      return {
        on: o.classList.contains("on"),
        dy: Math.abs(a.top + 6 - b.top),
        dx: Math.abs(a.left + 6 - b.left),
      };
    });
  await page.evaluate(() => window.scrollTo(0, 120));
  await page.waitForTimeout(350);
  let gap = await outlineGap();
  assert.ok(
    gap.on && gap.dy < 1.5 && gap.dx < 1.5,
    `outline follows scroll ${JSON.stringify(gap)}`,
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  step("the picked outline follows the element through scrolling");

  // ── Minimise and reopen ──
  await chat.getByRole("button", { name: "Minimise GG Coder chat" }).click();
  await chat.getByRole("button", { name: "Open GG Coder chat" }).waitFor();
  await page.waitForFunction((src) => (0, eval)(`(${src})`)()?.h < 120, VISIBLE.toString());
  await chat.getByRole("button", { name: "Open GG Coder chat" }).click();
  await input.waitFor();
  step("minimise leaves a small pill, and it reopens");

  // ── A modal dialog: the chat moves inside it and stays usable ──
  await input.fill("draft kept");
  await page.click("#open");
  await page.waitForFunction(
    () => document.querySelector("gg-live-preview").parentElement?.tagName === "DIALOG",
  );
  await chat.locator("textarea").waitFor();
  await page.waitForFunction((src) => (0, eval)(`(${src})`)()?.h > 80, VISIBLE.toString());
  assert.equal(await chat.locator("textarea").inputValue(), "draft kept");
  await chat.locator("textarea").fill("typed in a dialog");
  assert.equal(await chat.locator("textarea").inputValue(), "typed in a dialog");
  await page.evaluate(() => document.getElementById("dlg").close());
  await page.waitForFunction(
    () => document.querySelector("gg-live-preview").parentElement === document.documentElement,
  );
  step("a modal dialog keeps the chat on top and usable, draft intact");

  // ── Hot update replaces the element: the pick follows it ──
  await page.evaluate(() => window.__hot());
  await page.waitForTimeout(400);
  gap = await outlineGap();
  assert.ok(gap.on && gap.dy < 1.5, `outline found the new element ${JSON.stringify(gap)}`);
  assert.equal(await chat.getByText("not on this page").count(), 0);
  step("a hot update keeps the pick on the replaced element");

  // ── Send ──
  await chat.locator("textarea").fill("Make the heading blue");
  await chat.locator("textarea").press("Enter");
  await chat.getByText("Done, the heading is blue now.").waitFor();
  assert.equal(prompts.length, 1);
  const sent = prompts[0];
  assert.equal(sent.text, "Make the heading blue");
  assert.equal(sent.meta.livePreview.url, devUrl, "the agent hears the dev server's address");
  assert.equal(sent.meta.livePreview.element.tag, "h1");
  assert.match(sent.meta.livePreview.element.html, /Hello preview/);
  step("sending carries the element and the dev URL; the reply shows in the chat");

  // ── Esc drops the pick and goes back to picking; Esc again leaves pick mode ──
  const isPicking = () =>
    page.evaluate(() => document.documentElement.classList.contains("gg-live-picking"));
  const chip = chat.locator(".inputwrap").getByText("<h1> Hello preview");
  await chip.waitFor();
  // The chip row animates and the iframe follows a frame late: the composer must not move.
  await chat.locator("textarea").evaluate((ta) => {
    window.__gaps = [];
    const tick = () => {
      window.__gaps.push(innerHeight - ta.getBoundingClientRect().top);
      if (window.__gaps.length < 40) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await chat.locator("textarea").press("Escape");
  await chip.waitFor({ state: "detached" });
  const gaps = await chat.locator("textarea").evaluate(async () => {
    while (window.__gaps.length < 40) await new Promise((r) => requestAnimationFrame(r));
    return window.__gaps;
  });
  assert.ok(Math.max(...gaps) - Math.min(...gaps) < 1, `composer moved: ${gaps.join(",")}`);
  assert.equal(await isPicking(), true, "Esc in the chat keeps pick mode on");
  await chat.locator("textarea").press("Escape");
  assert.equal(await isPicking(), false, "a second Esc leaves pick mode");
  // The same from the page itself, after a right-click pick.
  await page.click("#list li:first-child", { button: "right" });
  await chat.locator(".inputwrap").getByText("<li> Latte").waitFor();
  await page.mouse.click(1200, 40);
  await page.keyboard.press("Escape");

  await chat.locator(".inputwrap").getByText("<li> Latte").waitFor({ state: "detached" });
  assert.equal(await isPicking(), true, "Esc on the page keeps pick mode on");
  await page.keyboard.press("Escape");
  assert.equal(await isPicking(), false);
  step("Esc drops the picked element, keeps pick mode on, and the composer holds still");

  // ── The page's own scripts can't reach the agent ──
  const attack = await page.evaluate(async () => {
    const src = document.querySelector('script[src$="/page.js"]').src;
    const origin = new URL(src).origin;
    const iframe = document.querySelector("gg-live-preview").shadowRoot.querySelector("iframe");
    const out = {};
    out.withHeader = await fetch(`${origin}/api/prompt`, {
      method: "POST",
      headers: { "x-gg-live": "1", "content-type": "application/json" },
      body: JSON.stringify({ text: "pwn-1" }),
    }).then(
      (r) => r.status,
      () => "blocked",
    );
    out.simplePost = await fetch(`${origin}/api/prompt`, {
      method: "POST",
      mode: "no-cors",
      body: JSON.stringify({ text: "pwn-2" }),
    }).then(
      (r) => r.type,
      () => "blocked",
    );
    out.events = await fetch(`${origin}/api/events`, { headers: { "x-gg-live": "1" } }).then(
      (r) => r.status,
      () => "blocked",
    );
    try {
      out.frameDoc = iframe.contentDocument === null ? "null" : "readable";
    } catch {
      out.frameDoc = "blocked";
    }
    iframe.contentWindow.postMessage({ type: "gg-live:prompt", text: "pwn-3" }, origin);
    iframe.contentWindow.postMessage(
      { type: "invoke", cmd: "agent_prompt", args: { text: "pwn-4" } },
      origin,
    );
    const form = document.createElement("form");
    form.method = "POST";
    form.action = `${origin}/api/prompt`;
    form.target = "pwn";
    form.enctype = "text/plain";
    const field = document.createElement("input");
    field.name = '{"text":"pwn-5","x":"';
    field.value = '"}';
    form.append(field);
    const sink = document.createElement("iframe");
    sink.name = "pwn";
    document.body.append(sink, form);
    form.submit();
    await new Promise((r) => setTimeout(r, 600));
    return out;
  });
  assert.equal(attack.withHeader, "blocked", "the custom header needs a preflight we never grant");
  assert.equal(attack.events, "blocked");
  assert.equal(attack.frameDoc, "null");
  assert.ok(
    prompts.every((p) => !String(p.text).includes("pwn")),
    `a page script reached the agent: ${JSON.stringify(prompts.map((p) => p.text))}`,
  );
  step("page scripts can't post prompts, read events, read the frame or forge messages");

  // ── Reload: the chat rebuilds from the session ──
  await page.reload();
  await chat.getByText("Make the heading blue").waitFor({ timeout: 15000 });
  await chat.getByText("Done, the heading is blue now.").waitFor();
  step("a reload replays the conversation");

  // Let the entrance fades settle so the capture shows the resting chat.
  await page.waitForTimeout(800);
  const shot = path.join(tmpdir(), "gg-live-preview-check.png");
  await page.screenshot({ path: shot });
  console.log(`screenshot: ${shot}`);
  assert.deepEqual(errors, []);
  console.log("LIVE PREVIEW CHECK PASS");
} finally {
  await browser.close();
  await manager.stopAll();
  dev.close();
}
