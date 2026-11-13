// Real production components + CSS, bundled once. No provider or native calls.
// --record captures the pre-fix baseline without enforcing the continuity gates.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { build, preview } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const record = process.argv.includes("--record");
const evidence = path.resolve(
  root,
  "../.gg/reports/app-motion-review-2026-10-07",
  record ? "before" : "after",
);
await mkdir(evidence, { recursive: true });
await mkdir(path.join(root, ".gg"), { recursive: true });
const temporary = await mkdtemp(path.join(root, ".gg/motion-continuity-"));
let server;
async function sample(page, selector) {
  return page.locator(selector).evaluateAll((nodes) =>
    nodes.map((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        top: rect.top,
        height: rect.height,
        opacity: style.opacity,
        filter: style.filter,
        scrollTop: el.scrollTop,
        animations: el.getAnimations().map((a) => ({
          time: a.currentTime,
          state: a.playState,
          frames: a.effect?.getKeyframes(),
        })),
      };
    }),
  );
}
async function trace(page, name, action, selector, traces) {
  const before = await sample(page, selector);
  await action();
  const frames = await page.evaluate(async (selector) => {
    const frames = [];
    const start = performance.now();
    while (performance.now() - start < 500) {
      await new Promise(requestAnimationFrame);
      frames.push({
        time: performance.now() - start,
        elements: [...document.querySelectorAll(selector)].map((el) => ({
          height: el.getBoundingClientRect().height,
          top: el.getBoundingClientRect().top,
          opacity: getComputedStyle(el).opacity,
          filter: getComputedStyle(el).filter,
        })),
      });
    }
    return frames;
  }, selector);
  traces.push({ name, before, frames, after: await sample(page, selector) });
}
async function chatGeometry(page) {
  return page.locator(".transcript").evaluate((el) => ({
    top: el.scrollTop,
    bottom: el.scrollHeight - el.clientHeight - el.scrollTop,
    height: el.clientHeight,
  }));
}
async function zoomTabs(page, traces) {
  for (const zoom of [0.5, 0.95, 1, 1.25, 1.5, 2]) {
    await page.evaluate((zoom) => {
      document.documentElement.style.zoom = String(zoom);
    }, zoom);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const result = await page.evaluate(async () => {
      const pill = document.querySelector(".settings-tabs-pill");
      const tabs = [...document.querySelectorAll(".settings-tab")];
      const rect = (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      const samples = [];
      for (const tab of [tabs[1], tabs[2], tabs[0]]) {
        const before = rect(pill);
        tab.click();
        await new Promise(requestAnimationFrame);
        const animations = document
          .getAnimations()
          .filter(
            (a) => a.effect?.target === pill || a.effect?.target?.closest?.(".settings-tabs"),
          );
        for (const a of animations) {
          a.pause();
          a.currentTime = 0;
        }
        const first = rect(pill);
        for (const a of animations) a.currentTime = 75;
        const middle = rect(pill);
        const moving = pill.getAnimations()[0];
        const last = moving?.effect?.getKeyframes().at(-1);
        samples.push({ before, first, middle, last, count: pill.getAnimations().length });
        // Next selection reverses the currently displayed 75ms frame.
      }
      for (const a of document.getAnimations()) {
        if (a.effect?.target?.closest?.(".settings-tabs")) a.finish();
      }
      await new Promise(requestAnimationFrame);
      return { samples, final: rect(pill), target: rect(tabs[0]) };
    });
    traces.push({ name: "settings-zoom", zoom, ...result });
    if (!record) {
      for (const sample of result.samples) {
        assert(sample.count > 0, `Pill animates at zoom ${zoom}`);
        for (const key of ["x", "y", "width", "height"])
          assert(
            Math.abs(sample.first[key] - sample.before[key]) / zoom <= 1,
            `Pill starts continuously at ${zoom}: ${JSON.stringify(sample)}`,
          );
      }
      for (const key of ["x", "y", "width", "height"])
        assert(
          Math.abs(result.final[key] - result.target[key]) / zoom <= 1,
          `Pill lands within one layout pixel at ${zoom}`,
        );
    }
  }
  await page.evaluate(() => {
    document.documentElement.style.zoom = "1";
  });
}

async function disclosureChecks(page, traces, immediate = false) {
  const samples = await page.evaluate((immediate) => {
    const samples = [];
    for (const [selector, toggle] of [
      [".chat-error-details", ".chat-error-details-toggle"],
      [".code-block", ".code-expand"],
    ]) {
      const el = document.querySelector(selector);
      const button = document.querySelector(toggle);
      const height = () => el.getBoundingClientRect().height;
      const animations = () =>
        el
          .getAnimations()
          .filter((a) => a.effect?.getKeyframes().some((f) => f.height !== undefined));
      const folded = height();
      const steps = [];
      for (const direction of ["open", "close", "reopen"]) {
        const before = height();
        const old = animations();
        window.motionCommit(() => button.click());
        const active = animations();
        for (const a of active) {
          a.pause();
          a.currentTime = 0;
        }
        const first = height();
        for (const a of active) a.currentTime = 75;
        const middle = height();
        steps.push({
          direction,
          before,
          first,
          middle,
          count: active.length,
          oldCancelled: old.every((a) => a.playState === "idle"),
          inert: el.inert,
          filter: getComputedStyle(el).filter,
        });
      }
      for (const a of animations()) a.finish();
      const expanded = height();
      window.motionCommit(() => button.click());
      for (const a of animations()) a.finish();
      samples.push({ selector, folded, expanded, final: height(), steps });
    }
    return samples;
  }, immediate);
  traces.push({ name: immediate ? "immediate-disclosures" : "interrupted-disclosures", samples });
  if (record) return;
  for (const sample of samples) {
    assert(sample.expanded > sample.folded, `Disclosure actually expands: ${sample.selector}`);
    assert(
      Math.abs(sample.final - sample.folded) <= 1,
      `No final padding/height snap: ${sample.selector}`,
    );
    for (const step of sample.steps) {
      assert(step.oldCancelled, `Previous height animation is cancelled: ${sample.selector}`);
      assert.equal(step.filter, "none", "Reading text stays sharp");
      if (sample.selector !== ".code-block")
        assert.equal(
          step.inert,
          step.direction === "close",
          "Collapsed content is immediately inert",
        );
      if (immediate) assert.equal(step.count, 0, "Fallback geometry has no animation/wait");
      else {
        assert.equal(step.count, 1, `One height owner: ${sample.selector}`);
        assert(
          Math.abs(step.first - step.before) <= 1,
          `Reversal starts from visible geometry: ${JSON.stringify(step)}`,
        );
        assert(
          step.direction === "close" ? step.middle < step.first : step.middle > step.first,
          `Travel follows the new direction: ${JSON.stringify(step)}`,
        );
      }
    }
  }
}

async function contentChecks(page, traces) {
  const result = await page.evaluate(() => {
    const press = (text) =>
      window.motionCommit(() =>
        [...document.querySelectorAll("button")].find((b) => b.textContent === text).click(),
      );
    const sizes = [];
    for (const [selector, toggle, grow] of [[".code-block", ".code-expand", "Grow fixture code"]]) {
      const el = document.querySelector(selector);
      window.motionCommit(() => document.querySelector(toggle).click());
      for (const a of el.getAnimations()) a.finish();
      const before = el.getBoundingClientRect().height;
      press(grow);
      const motions = el
        .getAnimations()
        .filter((a) => a.effect?.getKeyframes().some((f) => f.height !== undefined));
      for (const a of motions) {
        a.pause();
        a.currentTime = 0;
      }
      const first = el.getBoundingClientRect().height;
      for (const a of motions) a.finish();
      sizes.push({
        selector,
        before,
        first,
        after: el.getBoundingClientRect().height,
        count: motions.length,
      });
    }
    window.motionCommit(() => document.querySelector(".code-expand").click());
    const running = document.querySelector(".code-block").getAnimations();
    press("Unmount fixture disclosures");
    return { sizes, cancelled: running.every((a) => a.playState === "idle") };
  });
  traces.push({ name: "content-growth-drain-unmount", ...result });
  if (!record) {
    for (const size of result.sizes) {
      assert.equal(size.count, 1, `Content update owns one height animation: ${size.selector}`);
      assert(Math.abs(size.first - size.before) <= 1, "Content growth starts at its old size");
      assert(size.after > size.before, "Content growth reaches its natural height");
    }
    assert(result.cancelled, "Unmount cancels owned motion");
  }
}

async function fallbackChecks(page, url, traces) {
  for (const mode of ["reduced-motion", "missing-apis"]) {
    await page.emulateMedia({
      reducedMotion: mode === "reduced-motion" ? "reduce" : "no-preference",
    });
    if (mode === "missing-apis")
      await page.addInitScript(() => {
        Element.prototype.animate = undefined;
        document.startViewTransition = undefined;
      });
    await page.goto(`${url}?components`);
    await page.getByRole("button", { name: "Show error details" }).waitFor();
    await disclosureChecks(page, traces, true);
    const trigger = page.getByRole("button", { name: "Fixture choice", exact: true });
    await trigger.click();
    await page.getByRole("option", { name: "Two", exact: true }).click();
    assert.equal(await page.getByRole("listbox").count(), 0);
    assert.match(await trigger.innerText(), /Two/);
    const opener = page.getByRole("button", { name: "Open fixture dialog" });
    await opener.focus();
    await opener.press("Enter");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert(await opener.evaluate((el) => el === document.activeElement));
    await page.goto(url);
    const input = page.locator("textarea.input");
    await input.fill(Array.from({ length: 18 }, () => "Fictional fallback draft").join("\n"));
    await input.press("Enter");
    assert.equal(await input.inputValue(), "");
    assert(Math.abs((await chatGeometry(page)).bottom) <= 2, `${mode}: send settles pinned`);
    const traveling = await page
      .locator(".transcript")
      .evaluate(
        (el) =>
          el
            .getAnimations({ subtree: true })
            .filter((a) =>
              a.effect
                ?.getKeyframes()
                .some((f) => f.translate !== undefined || f.height !== undefined),
            ).length,
      );
    assert.equal(traveling, 0, `${mode}: no layout travel`);
    assert.deepEqual(await page.evaluate(() => window.motionBridge.unknown), []);
    traces.push({ name: mode, passed: true });
  }
}

// The dock floats over the chat and hands its height to the transcript through
// an observer. A glide has to outlive that: one that is cut short, or never
// starts, moves the rows the rest of the way in a single frame.
async function dockGlide(page, name, act, traces, duration = 600) {
  const sampling = page.evaluate(async (duration) => {
    const transcript = document.querySelector(".transcript");
    const rows = [...transcript.children].slice(-4);
    const sample = (start) => ({
      time: performance.now() - start,
      tops: rows.map((row) => (row.isConnected ? row.getBoundingClientRect().top : null)),
      gliding: transcript
        .getAnimations({ subtree: true })
        .filter((a) => a.effect?.getKeyframes().some((frame) => frame.translate !== undefined))
        .length,
    });
    const start = performance.now();
    const frames = [sample(start)];
    while (performance.now() - start < duration) {
      await new Promise(requestAnimationFrame);
      // After the frame's observers and paint, not before them.
      await new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = resolve;
        channel.port2.postMessage(0);
      });
      frames.push(sample(start));
    }
    return frames;
  }, duration);
  await act();
  const frames = await sampling;
  traces.push({ name, frames });
  if (record) return;
  const row = frames[0].tops.findIndex((_, i) => frames.every((frame) => frame.tops[i] !== null));
  const travel = Math.abs(frames.at(-1).tops[row] - frames[0].tops[row]);
  const gliding = frames.filter((frame) => frame.gliding > 0);
  const lasted = gliding.length ? gliding.at(-1).time - gliding[0].time : 0;
  assert(travel > 20, `${name}: the chat has somewhere to go (${travel}px)`);
  assert(lasted >= 120, `${name}: rows glide the whole way, not ${Math.round(lasted)}ms of it`);
  assert(Math.abs((await chatGeometry(page)).bottom) <= 2, `${name}: ends pinned to the bottom`);
}

async function toolTransaction(page, events, traces, moves = true) {
  const result = await page.evaluate(async (events) => {
    const transcript = document.querySelector(".transcript");
    const row = transcript.lastElementChild;
    const before = row.getBoundingClientRect().top;
    if (events === "toggle") window.motionBridge.toggleTools();
    else for (const event of events) await window.motionBridge.emit(event);
    const animations = document
      .getAnimations()
      .filter((a) => a.effect?.getKeyframes().some((frame) => frame.translate !== undefined));
    // Read live, then paused where they are. Not rewound: a glide already
    // under way takes the new destination on its own clock, so its time 0 is
    // not this moment. Not paused first either: WebKit's styles run on a live
    // clock inside a task while pause() holds the frame's earlier time.
    const first = row.getBoundingClientRect().top;
    for (const animation of animations) animation.pause();
    const scroll = transcript.scrollTop;
    for (const animation of animations)
      animation.currentTime = Number(animation.currentTime ?? 0) + 75;
    const middle = row.getBoundingClientRect().top;
    for (const animation of animations) animation.finish();
    const last = row.getBoundingClientRect().top;
    await new Promise(requestAnimationFrame);
    return {
      before,
      first,
      middle,
      last,
      scroll,
      finalScroll: transcript.scrollTop,
      count: animations.length,
      bottom: transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop,
    };
  }, events);
  traces.push({ name: "tool-layout", ...result });
  if (!record) {
    // The tool line is one row that changes in place: only its arrival, its
    // leaving and the tools toggle move the chat.
    if (moves) assert(result.count > 0, "Tool geometry uses a coordinated transition");
    else assert(Math.abs(result.last - result.before) <= 1, "A later tool leaves the chat still");
    // Never back from where it was, and at most a frame's worth on toward
    // where it is going: a snap covers the whole way at once.
    const ahead = (result.first - result.before) * Math.sign(result.last - result.before || 1);
    assert(
      ahead >= -1 && ahead <= Math.abs(result.last - result.before) * 0.35 + 1,
      `First tool frame must be continuous: ${JSON.stringify(result)}`,
    );
    assert(Math.abs(result.finalScroll - result.scroll) <= 1, "No late tool scroll correction");
    assert(Math.abs(result.bottom) <= 2, "Tool change retains bottom follow");
  }
}
try {
  const entry = path.join(temporary, "index.html");
  const original = await readFile(path.join(root, "index.html"), "utf8");
  await writeFile(
    entry,
    original.replace("/src/main.tsx", "/scripts/fixtures/motion-continuity.tsx"),
  );
  const outDir = path.join(temporary, "dist");
  await build({ root, build: { outDir, rolldownOptions: { input: entry } } });
  server = await preview({ root, build: { outDir }, preview: { host: "127.0.0.1", port: 0 } });
  const address = server.httpServer.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/${path.relative(root, entry).split(path.sep).join("/")}`;
  const {
    app: {
      security: { csp },
    },
  } = JSON.parse(await readFile(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const executablePath = process.env[`${name.toUpperCase()}_EXECUTABLE`];
    const browser = await engine.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      for (const width of [1280, 640]) {
        const page = await browser.newPage({
          viewport: { width, height: 900 },
          recordVideo: {
            dir: path.join(evidence, `${name}-${width}-video`),
            size: { width, height: 900 },
          },
        });
        const traces = [];
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/index.html*", async (route) => {
          const response = await route.fetch();
          await route.fulfill({
            response,
            body: (await response.text()).replace(
              '<style id="app-style-nonce">',
              '<style id="app-style-nonce" nonce="motion-test">',
            ),
            headers: {
              ...response.headers(),
              "content-security-policy": csp.replace(
                /style-src([^;]*)/,
                "style-src$1 'nonce-motion-test'",
              ),
            },
          });
        });
        try {
          await page.goto(url);
          const input = page.locator("textarea.input");
          await input.waitFor();
          await input.fill(
            Array.from({ length: 18 }, (_, i) => `Fictional draft line ${i}`).join("\n"),
          );
          await trace(
            page,
            "long-send",
            () => input.press("Enter"),
            ".inputwrap, .transcript, .transcript > :last-child",
            traces,
          );
          if (!record)
            assert(
              Math.abs((await chatGeometry(page)).bottom) <= 2,
              "Long send ends at the bottom",
            );
          await page.evaluate(() => window.motionBridge.emit({ type: "run_start", data: {} }));
          await toolTransaction(
            page,
            [
              {
                type: "tool_call_start",
                data: {
                  toolCallId: "fixture-1",
                  name: "read",
                  args: { file_path: "fictional.ts" },
                },
              },
            ],
            traces,
          );
          await toolTransaction(
            page,
            [2, 3].map((i) => ({
              type: "tool_call_start",
              data: {
                toolCallId: `fixture-${i}`,
                name: "read",
                args: { file_path: `fictional-${i}.ts` },
              },
            })),
            traces,
            false,
          );
          await toolTransaction(page, "toggle", traces);
          await toolTransaction(page, "toggle", traces);
          // A message sent mid-run: its glide is under way when the sidecar's
          // answer marks the bubble queued.
          const queuedPrompt = { id: "queued-1", text: "Fictional queued prompt" };
          await input.fill(queuedPrompt.text);
          await dockGlide(
            page,
            "queued-send-glide",
            async () => {
              await input.press("Enter");
              await page.waitForTimeout(30);
              await page.evaluate(
                (message) =>
                  window.motionBridge.emit({
                    type: "queued",
                    data: { count: 1, messages: [message] },
                  }),
                queuedPrompt,
              );
            },
            traces,
          );
          await dockGlide(
            page,
            "queued-cancel-glide",
            () =>
              page.evaluate(
                (id) =>
                  window.motionBridge.emit({
                    type: "queued",
                    data: { count: 0, messages: [], cancelledId: id },
                  }),
                queuedPrompt.id,
              ),
            traces,
          );
          await dockGlide(
            page,
            "first-reply-glide",
            () =>
              page.evaluate(async () => {
                await window.motionBridge.emit({ type: "turn_end", data: {} });
                await window.motionBridge.emit({
                  type: "text_delta",
                  data: { text: "Fictional first words of a reply." },
                });
              }),
            traces,
          );
          // An answered question holds, dissolves, then leaves its place for a
          // one-line answer at the end of the chat.
          await page.evaluate(() =>
            window.motionBridge.emit({
              type: "ask_user",
              data: {
                id: "fixture-ask",
                questions: [
                  {
                    id: "fixture-question",
                    question: "Fictional question?",
                    kind: "choice",
                    options: [{ label: "Fictional one" }, { label: "Fictional two" }],
                  },
                ],
              },
            }),
          );
          await page.waitForTimeout(400);
          await dockGlide(
            page,
            "answered-question-glide",
            () => page.getByText("Fictional one", { exact: true }).click(),
            traces,
            1100,
          );
          // Steps in the dock's own height that no state setter announces: a
          // Deck panel taking the message box's place, and a draft deleted.
          await dockGlide(
            page,
            "deck-panel-open-glide",
            () => page.getByRole("button", { name: "More", exact: true }).click(),
            traces,
          );
          await dockGlide(
            page,
            "deck-panel-close-glide",
            () => page.keyboard.press("Escape"),
            traces,
          );
          await input.fill(Array.from({ length: 6 }, (_, i) => `Fictional draft ${i}`).join("\n"));
          await page.waitForTimeout(400);
          await dockGlide(page, "draft-cleared-glide", () => input.fill(""), traces);
          await input.fill("Fictional short queued send");
          await trace(
            page,
            "queued-send-and-new-draft",
            async () => {
              await input.press("Enter");
              await input.fill("New draft typed during send motion");
            },
            ".inputwrap, .transcript, .transcript > :last-child",
            traces,
          );
          if (!record) {
            assert.equal(await input.inputValue(), "New draft typed during send motion");
            assert(
              Math.abs((await chatGeometry(page)).bottom) <= 2,
              "Queued send keeps its final bottom anchor",
            );
          }
          // Real wheel input must both release follow and restore it. Emit text
          // while reading older content, then again after returning to the bottom.
          await page.locator(".transcript").hover();
          await page.mouse.wheel(0, -350);
          await page.waitForTimeout(100);
          const reading = await chatGeometry(page);
          await page.evaluate(() =>
            window.motionBridge.emit({
              type: "text_delta",
              data: { text: "Fictional streaming reply. ".repeat(20) },
            }),
          );
          await page.waitForTimeout(400);
          if (!record)
            assert(
              Math.abs((await chatGeometry(page)).top - reading.top) <= 2,
              "Streaming must not pull an unpinned reader down",
            );
          const wordFrames = await page
            .locator(".markdown .md-word")
            .evaluateAll((words) =>
              words.flatMap((word) =>
                word.getAnimations().flatMap((a) => a.effect?.getKeyframes() ?? []),
              ),
            );
          if (!record) {
            assert(wordFrames.length > 0, "Real streaming words exercise their entrance");
            assert(
              wordFrames.every((frame) => !frame.filter && !frame.transform && !frame.translate),
              "Streaming text stays sharp and does not compete with layout",
            );
          }
          await page.mouse.wheel(0, 100000);
          await page.waitForTimeout(100);
          await page.evaluate(() =>
            window.motionBridge.emit({
              type: "text_delta",
              data: { text: "More fictional lines. ".repeat(30) },
            }),
          );
          await page.waitForTimeout(400);
          if (!record)
            assert(
              Math.abs((await chatGeometry(page)).bottom) <= 2,
              "Returning to the bottom resumes streaming follow",
            );
          for (const zoom of [0.5, 0.95, 1, 1.25, 1.5, 2]) {
            await page.evaluate((zoom) => {
              document.documentElement.style.zoom = String(zoom);
            }, zoom);
            await input.fill(Array.from({ length: 18 }, () => "Zoom fixture draft").join("\n"));
            await input.press("Enter");
            const height = await input.evaluate((el) => parseFloat(getComputedStyle(el).height));
            await page.waitForTimeout(250);
            const { finalHeight, naturalHeight } = await input.evaluate((el) => {
              const style = getComputedStyle(el);
              const clone = el.cloneNode();
              clone.removeAttribute("id");
              Object.assign(clone.style, {
                position: "absolute",
                width: style.width,
                height: "auto",
                transition: "none",
                overflow: "hidden",
                visibility: "hidden",
              });
              el.parentElement.appendChild(clone);
              const naturalHeight = clone.scrollHeight;
              clone.remove();
              return { finalHeight: parseFloat(style.height), naturalHeight };
            });
            traces.push({ name: "composer-zoom-send", zoom, height, finalHeight, naturalHeight });
            if (!record) {
              // At 200% / narrow width, the empty placeholder can wrap too.
              assert(
                Math.abs(height - finalHeight) <= 1 && Math.abs(height - naturalHeight) <= 1,
                `Composer settles to its empty intrinsic height at zoom ${zoom}: ${height}/${finalHeight}/${naturalHeight}`,
              );
              const pinned = await chatGeometry(page);
              assert(
                Math.abs(pinned.bottom) <= 2,
                `Zoom ${zoom} send retains bottom pin: ${JSON.stringify(pinned)}`,
              );
            }
          }
          await page.evaluate(() => {
            document.documentElement.style.zoom = "1";
          });
          // Record the resting screen as well as the timed intermediate traces.
          await page.waitForTimeout(350);
          await page.screenshot({ path: path.join(evidence, `${name}-${width}-chat.png`) });
          const unknown = await page.evaluate(() => window.motionBridge.unknown);
          assert.deepEqual(unknown, [], "Every bridge call must be explicitly modeled");
          await page.goto(`${url}?components`);
          await page.getByRole("button", { name: "Show error details" }).waitFor();
          await zoomTabs(page, traces);
          await trace(
            page,
            "details-open",
            () => page.getByRole("button", { name: "Show error details" }).click(),
            ".chat-error-details",
            traces,
          );
          await trace(
            page,
            "details-close",
            () => page.getByRole("button", { name: "Hide error details" }).click(),
            ".chat-error-details",
            traces,
          );
          await trace(
            page,
            "code-reverse",
            async () => {
              await page.getByRole("button", { name: /Show full output/ }).click();
              await page.waitForTimeout(75);
              await page.getByRole("button", { name: "Show less", exact: true }).click();
            },
            ".code-block",
            traces,
          );
          await disclosureChecks(page, traces);
          await page.evaluate(() => {
            window.motionExits = [];
            const start = document.startViewTransition?.bind(document);
            if (!start) return;
            document.startViewTransition = (update) => {
              const transition = start(update);
              void (async () => {
                try {
                  await transition.ready;
                  const animations = document
                    .getAnimations()
                    .filter((a) => a.effect?.pseudoElement?.includes("view-transition"));
                  // Menus shrink back toward their trigger (pop-out); dialogs fade (surface-out).
                  const exits = animations.filter((a) =>
                    ["surface-out", "pop-out"].includes(a.animationName),
                  );
                  for (const a of exits) {
                    a.pause();
                    a.currentTime = 75;
                  }
                  window.motionExits.push({
                    exits: exits.length,
                    roots: animations.filter((a) => a.effect.pseudoElement.includes("(root)"))
                      .length,
                    timing: exits.map((a) => a.effect.getTiming().duration),
                    frames: exits.map((a) => a.effect.getKeyframes()),
                  });
                  for (const a of exits) a.finish();
                } catch (error) {
                  window.motionExits.push({ error: String(error) });
                }
              })();
              return transition;
            };
          });
          for (const method of ["toggle", "escape", "outside", "select"]) {
            await page.getByRole("button", { name: "Fixture choice", exact: true }).click();
            await trace(
              page,
              `dropdown-${method}`,
              async () => {
                if (method === "toggle")
                  await page.getByRole("button", { name: "Fixture choice", exact: true }).click();
                else if (method === "escape") await page.getByRole("listbox").press("Escape");
                else if (method === "outside") await page.locator(".settings-tabs").first().click();
                else await page.getByRole("option", { name: "Two", exact: true }).click();
              },
              ".dropdown-menu",
              traces,
            );
          }
          await page.getByTitle("Fixture model", { exact: true }).click();
          await trace(
            page,
            "model-select",
            () => page.getByRole("menuitemradio", { name: "Fictional model" }).click(),
            ".model-menu",
            traces,
          );
          await page.getByRole("button", { name: /1 schedule$/ }).click();
          await trace(
            page,
            "schedule-last-stop",
            () => page.getByTitle("Stop this schedule", { exact: true }).click(),
            ".schedules-menu",
            traces,
          );
          for (const [kind, item] of [
            ["plays", "/fictional"],
            ["files", "fictional.ts"],
          ]) {
            await page.getByRole("button", { name: `Open fixture ${kind}` }).click();
            await trace(
              page,
              `${kind}-select`,
              () => page.locator(".slash-item").filter({ hasText: item }).click(),
              ".slash-menu",
              traces,
            );
          }
          const exits = await page.evaluate(() => window.motionExits);
          traces.push({ name: "floating-exits", exits });
          if (
            !record &&
            (await page.evaluate(() => typeof document.startViewTransition === "function"))
          ) {
            assert(exits.length > 0, "Menu close requests a visual snapshot");
            assert(
              exits.every((e) => e.exits === 1 && e.roots === 0),
              `Only the menu animates out: ${JSON.stringify(exits)}`,
            );
          }
          for (const method of ["Cancel", "Close", "Escape", "backdrop"]) {
            // WebKit mousedown clears even a previously focused button.
            // Open by keyboard to test focus return; dismiss by pointer/key.
            await page.getByRole("button", { name: "Open fixture dialog" }).focus();
            await page.getByRole("button", { name: "Open fixture dialog" }).press("Enter");
            await trace(
              page,
              `dialog-${method}`,
              async () => {
                if (method === "Escape") await page.keyboard.press("Escape");
                else if (method === "backdrop")
                  await page.locator(".modal-backdrop").click({ position: { x: 2, y: 2 } });
                else await page.getByRole("button", { name: method, exact: true }).click();
              },
              ".modal",
              traces,
            );
            assert.equal(await page.getByRole("dialog").count(), 0);
            assert.equal(
              await page
                .getByRole("button", { name: "Open fixture dialog" })
                .evaluate((el) => el === document.activeElement),
              true,
              "Dismissal restores focus",
            );
            if (
              !record &&
              (await page.evaluate(() => typeof document.startViewTransition === "function"))
            ) {
              const exit = await page.evaluate(() => window.motionExits.at(-1));
              assert.equal(exit.exits, 1, `Dialog ${method} retains a visual exit`);
            }
          }
          await page.locator(".app").evaluate((el) => {
            el.scrollTop = 0;
          });
          await page.waitForTimeout(350);
          assert(
            await page
              .locator(".chat-error-copy")
              .evaluate((el) => el.getBoundingClientRect().width > 200),
            "Fixture uses the real error-notice grid, including a valid critter",
          );
          await page.screenshot({ path: path.join(evidence, `${name}-${width}-components.png`) });
          await contentChecks(page, traces);
          await fallbackChecks(page, url, traces);
          assert.deepEqual(errors, [], "No uncaught fixture errors");
          console.log(
            `PASS ${name} ${width}px: real app + component traces${record ? " (baseline)" : ""}`,
          );
        } finally {
          await page.screenshot({ path: path.join(evidence, `${name}-${width}-last.png`) });
          await writeFile(
            path.join(evidence, `${name}-${width}.json`),
            JSON.stringify(traces, null, 2),
          );
          await page.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  if (server)
    await new Promise((resolve, reject) =>
      server.httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  await rm(temporary, { recursive: true, force: true });
}
