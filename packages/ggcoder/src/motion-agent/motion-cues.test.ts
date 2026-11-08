import { execFile } from "node:child_process";
import type { Server } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findMotionBundle } from "../core/skills.js";

const exec = promisify(execFile);

type Cue = { t: number; sfx: string; gain: number; pan: number; send?: number; name?: string };
type Air = { rate: number; start: number; values: number[] };
/** The shipped plain-JS exporter's exports, typed here by hand. */
type CuesModule = Readonly<{
  readCues: (dom: string) => Cue[] | null;
  readAir: (dom: string) => Air | null;
  validateCues: (list: unknown) => Cue[];
  serve: (root: string) => Promise<{ server: Server; port: number }>;
  chromePath: () => Promise<string>;
}>;

let bin = "";
let cues: CuesModule;
let tmp = "";
/** The Chrome HyperFrames would use (its download, or a system Chrome), if any. */
let chrome = "";
beforeAll(async () => {
  const bundle = await findMotionBundle();
  if (!bundle) throw new Error("Missing Motion bundle");
  bin = path.join(bundle.root, "bin");
  cues = (await import(pathToFileURL(path.join(bin, "cues.mjs")).href)) as CuesModule;
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gg-motion-cues-test-"));
  chrome = await cues
    .chromePath()
    .then(async (found) => ((await fs.stat(found).catch(() => null))?.isFile() ? found : ""))
    .catch(() => "");
}, 90_000);
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const attribute = (list: unknown): string =>
  `<html lang="en" data-gg-cues="${JSON.stringify(list).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"><head></head><body></body></html>`;

describe("cue export: reading the loaded page", () => {
  it("reads the cue list the kit wrote on the root element", () => {
    const list = [
      { t: 0.4, sfx: "click", gain: 0.6, pan: -0.2 },
      { t: 2.28, sfx: "impact", gain: 1, pan: 0, name: 'the "big" <landing> & bounce' },
    ];

    expect(cues.readCues(attribute(list))).toEqual(list);
  });

  it("reports a page that marked no cues as none, not as an empty score", () => {
    expect(cues.readCues('<html><body data-gg-cues="[]"></body></html>')).toBeNull();
    expect(cues.readCues(attribute([]))).toEqual([]);
  });

  it.each([
    ["not JSON", '<html data-gg-cues="[{oops"></html>', "unreadable"],
    ["a negative time", attribute([{ t: -1, sfx: "click" }]), "t must be"],
    ["a made-up sound name", attribute([{ t: 1, sfx: "<script>" }]), "sfx must be"],
    ["a loud gain", attribute([{ t: 1, sfx: "click", gain: 9 }]), "gain must be"],
    ["a wide pan", attribute([{ t: 1, sfx: "click", pan: 4 }]), "pan must be"],
    ["a far send", attribute([{ t: 1, sfx: "click", send: 3 }]), "send must be"],
    ["a non-list", attribute({ t: 1 }), "must be a list"],
  ])("rejects %s", (_name, dom, message) => {
    expect(() => cues.readCues(dom)).toThrow(message);
  });

  it("reads a cue's distance and the camera's speed curve", () => {
    const air = { rate: 50, start: 0.5, values: [0, 1200, 0] };
    const dom = `<html data-gg-cues="${JSON.stringify([{ t: 1, sfx: "tap", gain: 1, pan: 0, send: 0.6 }]).replace(/"/g, "&quot;")}" data-gg-air="${JSON.stringify(air).replace(/"/g, "&quot;")}"></html>`;

    expect(cues.readCues(dom)).toEqual([{ t: 1, sfx: "tap", gain: 1, pan: 0, send: 0.6 }]);
    expect(cues.readAir(dom)).toEqual(air);
    expect(cues.readAir(attribute([]))).toBeNull();
    for (const [bad, message] of [
      [{ rate: 5, start: 0, values: [] }, "rate"],
      [{ rate: 50, start: -1, values: [] }, "start"],
      [{ rate: 50, start: 0, values: [-3] }, "speed >= 0"],
    ] as const) {
      const page = `<html data-gg-air="${JSON.stringify(bad).replace(/"/g, "&quot;")}"></html>`;
      expect(() => cues.readAir(page)).toThrow(message);
    }
  });
});

describe("cue export: page server", () => {
  it("serves the project read-only and nothing outside it", async () => {
    const project = path.join(tmp, "served");
    await fs.mkdir(path.join(project, "assets"), { recursive: true });
    await fs.writeFile(path.join(project, "index.html"), "<html></html>");
    await fs.writeFile(path.join(project, "assets", "moves.js"), "// kit");
    await fs.writeFile(path.join(tmp, "secret.txt"), "outside");
    const { server, port } = await cues.serve(project);
    const url = (route: string): string => `http://127.0.0.1:${port}${route}`;
    try {
      const page = await fetch(url("/index.html"));
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect((await fetch(url("/assets/moves.js"))).headers.get("content-type")).toBe(
        "text/javascript",
      );
      for (const route of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/", "/nope.js"]) {
        expect((await fetch(url(route))).status, route).toBe(404);
      }
      expect((await fetch(url("/index.html"), { method: "POST" })).status).toBe(405);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("refuses a composition outside the project", async () => {
    const project = path.join(tmp, "outside-check");
    await fs.mkdir(project, { recursive: true });
    await expect(
      exec(process.execPath, [
        path.join(bin, "cues.mjs"),
        project,
        "--composition",
        "../other/index.html",
      ]),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("inside the project") });
  });
});

describe("cue export: end to end in HyperFrames' Chrome", () => {
  it("exports the composition's cues in root-timeline time", async (context) => {
    // Needs the downloaded browser (`hf browser ensure`) and GSAP from its CDN.
    if (!chrome) context.skip();
    const project = path.join(tmp, "page");
    await fs.mkdir(path.join(project, "assets"), { recursive: true });
    await fs.copyFile(
      path.join(bin, "..", "library", "kit", "moves.js"),
      path.join(project, "assets", "moves.js"),
    );
    await fs.writeFile(
      path.join(project, "index.html"),
      `<!doctype html><html><head>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<script src="assets/moves.js"></script></head>
<body><div id="root" data-composition-id="main" data-width="640" data-height="360" data-duration="4"></div>
<script>
const kit = window.GGMotionKit;
const tl = gsap.timeline({ paused: true });
const scene = gsap.timeline();
kit.cue(scene, 0.5, "impact", { name: "landing" });
tl.add(scene, 1.5);
kit.cue(tl, 0.4, "click", { gain: 0.6 });
kit.camera(tl, document.getElementById("root"), [{ x: 320, y: 180 }, { at: 1, x: 600, y: 180, move: "whip", duration: 0.5 }], { width: 640, height: 360, duration: 3 });
window.__timelines = { main: tl };
</script></body></html>`,
    );

    const { stdout } = await exec(process.execPath, [path.join(bin, "cues.mjs"), project], {
      timeout: 90_000,
    });

    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      cues: 2,
      sounds: ["click", "impact"],
      cameraAir: true,
    });
    const file = JSON.parse(await fs.readFile(path.join(project, "cues.json"), "utf8")) as {
      version: number;
      cues: Cue[];
      air: Air;
    };
    expect(file.air.values).toHaveLength(3 * 50 + 1);
    expect(Math.max(...file.air.values)).toBeGreaterThan(300);
    expect(file.version).toBe(1);
    expect(file.cues).toEqual([
      { t: 0.4, sfx: "click", gain: 0.6, pan: 0 },
      { t: 2, sfx: "impact", gain: 1, pan: 0, name: "landing" },
    ]);
  }, 120_000);
});
