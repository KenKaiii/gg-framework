#!/usr/bin/env node
// GG Motion cue export: load a composition the way a render does and write the
// sound cues its script marked with `kit.cue(tl, at, sfx)` to a JSON file that
// score-synth reads (`"cues": "cues.json"` in the score). Retime the animation,
// export again, and every sound moves with its event.
//
// Usage: node cues.mjs <project-dir> [--out <cues.json>] [--composition <file.html>]
// Default out: <project>/cues.json. Prints a one-line JSON summary.
//
// The page is served read-only from 127.0.0.1 to HyperFrames' own Chrome
// (`hf browser path`), driven over DevTools by HyperFrames' own puppeteer-core,
// which runs the script and returns the finished DOM. (Chrome's one-shot
// `--dump-dom` hangs in a full Chrome build on macOS, the fallback when the
// managed headless shell is missing.)
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
export const CUES_VERSION = 1;
const MAX_CUES = 2000;
const MAX_AIR_SAMPLES = 50 * 60 * 15;
const MAX_DOM_BYTES = 64 * 1024 * 1024;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
};

const ENTITIES = { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'", "#39": "'", "#34": '"' };

/**
 * Validate one cue list as the kit writes it.
 * @param {unknown} list
 * @returns {{ t: number; sfx: string; gain: number; pan: number; send?: number; name?: string }[]}
 */
export function validateCues(list) {
  if (!Array.isArray(list)) throw new Error("cues must be a list");
  if (list.length > MAX_CUES) throw new Error(`more than ${MAX_CUES} cues`);
  return list.map((cue, index) => {
    if (!cue || typeof cue !== "object") throw new Error(`cue ${index} is not an object`);
    const { t, sfx, gain = 1, pan = 0, send, name } = cue;
    if (!(typeof t === "number" && Number.isFinite(t) && t >= 0))
      throw new Error(`cue ${index}: t must be a time >= 0`);
    if (typeof sfx !== "string" || !/^[a-z][a-z-]*$/.test(sfx))
      throw new Error(`cue ${index}: sfx must be a sound name`);
    if (!(typeof gain === "number" && gain >= 0 && gain <= 2))
      throw new Error(`cue ${index}: gain must be 0..2`);
    if (!(typeof pan === "number" && pan >= -1 && pan <= 1))
      throw new Error(`cue ${index}: pan must be -1..1`);
    if (send !== undefined && !(typeof send === "number" && send >= 0 && send <= 1))
      throw new Error(`cue ${index}: send must be 0..1`);
    if (name !== undefined && typeof name !== "string")
      throw new Error(`cue ${index}: name must be text`);
    return {
      t,
      sfx,
      gain,
      pan,
      ...(send === undefined ? {} : { send }),
      ...(name ? { name: name.slice(0, 60) } : {}),
    };
  });
}

/**
 * Validate the camera's speed curve as the kit writes it.
 * @param {unknown} curve
 * @returns {{ rate: number; start: number; values: number[] }}
 */
export function validateAir(curve) {
  if (!curve || typeof curve !== "object") throw new Error("air must be an object");
  const { rate, start, values } = /** @type {Record<string, unknown>} */ (curve);
  if (!(typeof rate === "number" && rate >= 10 && rate <= 240))
    throw new Error("air: rate must be 10..240");
  if (!(typeof start === "number" && Number.isFinite(start) && start >= 0))
    throw new Error("air: start must be a time >= 0");
  if (!Array.isArray(values) || values.length > MAX_AIR_SAMPLES)
    throw new Error(`air: values must be a list of at most ${MAX_AIR_SAMPLES} samples`);
  if (!values.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0))
    throw new Error("air: every value must be a speed >= 0");
  return { rate, start, values };
}

/** Read a JSON attribute the kit wrote on the root <html> element, or null. */
function readRootAttribute(dom, attribute, label) {
  // Chrome escapes `&` and `"` in attribute values but not `<` or `>`, so skip
  // over quoted values instead of stopping at the first `>`.
  const tag = /<html\b(?:[^>"']|"[^"]*"|'[^']*')*>/i.exec(dom)?.[0] ?? "";
  const match = new RegExp(`\\s${attribute}="([^"]*)"`).exec(tag);
  if (!match) return null;
  const json = (match[1] ?? "").replace(/&(quot|amp|lt|gt|apos|#39|#34);/g, (_, e) => ENTITIES[e]);
  try {
    return { value: JSON.parse(json) };
  } catch {
    throw new Error(`the page wrote an unreadable ${label}`);
  }
}

/**
 * The camera speed curve a loaded page wrote, or null without a kit camera.
 * @param {string} dom serialized DOM
 */
export function readAir(dom) {
  const found = readRootAttribute(dom, "data-gg-air", "camera curve");
  return found ? validateAir(found.value) : null;
}

/**
 * The cue list a loaded page wrote on its root element, or null when the
 * composition marked none.
 * @param {string} dom serialized DOM, as `chrome --dump-dom` prints it
 */
export function readCues(dom) {
  const found = readRootAttribute(dom, "data-gg-cues", "cue list");
  return found ? validateCues(found.value) : null;
}

/** Serve `root` read-only on 127.0.0.1; never outside it. */
export async function serve(root) {
  const base = await realpath(root);
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405).end();
        return;
      }
      const path = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
      const file = await realpath(resolve(base, `.${path}`));
      const inside = relative(base, file);
      if (inside.startsWith("..") || isAbsolute(inside) || !(await stat(file)).isFile()) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      });
      if (request.method === "HEAD") response.end();
      else createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start the page server");
  return { server, port: address.port };
}

export async function chromePath() {
  const override = process.env.GG_MOTION_CHROME?.trim();
  if (override) return resolve(override);
  try {
    const { stdout } = await run(
      process.execPath,
      [join(here, "hyperframes.mjs"), "browser", "path"],
      {
        timeout: 60_000,
        windowsHide: true,
      },
    );
    const found = stdout.trim().split(/\r?\n/).at(-1)?.trim();
    if (found) return found;
  } catch {
    /* fall through to the instruction below */
  }
  throw new Error("Chrome for HyperFrames is missing; run `hf browser ensure` first");
}

/** The puppeteer-core HyperFrames itself drives Chrome with. */
async function loadPuppeteer() {
  const fromHere = createRequire(import.meta.url);
  const fromHyperframes = createRequire(fromHere.resolve("hyperframes/package.json"));
  const mod = await import(pathToFileURL(fromHyperframes.resolve("puppeteer-core")).href);
  return mod.default ?? mod;
}

/** Load the page in headless Chrome and return its DOM after the script ran. */
async function dumpDom(chrome, url, signal) {
  const puppeteer = await loadPuppeteer();
  const profile = await mkdtemp(join(tmpdir(), "gg-motion-cues-"));
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: /chrome-headless-shell/i.test(basename(chrome)) ? "shell" : true,
      userDataDir: profile,
      // Linux CI containers often lack the user namespaces Chrome's sandbox needs.
      args: [
        "--disable-gpu",
        "--mute-audio",
        ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      ],
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      timeout: 60_000,
      signal,
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(60_000);
    await page.goto(url, { waitUntil: "load" });
    // Timelines may be built after fonts load (the documented async setup) and
    // are registered last; the kit writes its cues in a microtask after that.
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await page
      .waitForFunction(() => Object.keys(window.__timelines ?? {}).length > 0, { timeout: 8000 })
      .catch(() => undefined);
    await page.evaluate(() => new Promise((done) => setTimeout(done, 0)));
    const dom = await page.content();
    if (!dom) throw new Error("empty page");
    return dom.slice(0, MAX_DOM_BYTES);
  } catch (error) {
    if (signal?.aborted) throw new Error("cancelled");
    throw new Error(
      `Chrome could not load the page: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await browser?.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function parseArgs(argv) {
  const [project, ...rest] = argv;
  if (!project || project.startsWith("--"))
    throw new Error(
      "usage: cues.mjs <project-dir> [--out <cues.json>] [--composition <file.html>]",
    );
  const options = { project: resolve(project), composition: "index.html", out: "" };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    if (flag === "--out") options.out = resolve(value);
    else if (flag === "--composition") options.composition = value;
    else throw new Error(`Unsupported option ${flag}`);
  }
  options.out ||= join(options.project, "cues.json");
  return options;
}

async function main() {
  const started = performance.now();
  const options = parseArgs(process.argv.slice(2));
  if (!(await stat(options.project).catch(() => null))?.isDirectory())
    throw new Error("Expected a project folder");
  const page = resolve(options.project, options.composition);
  if (!page.startsWith(options.project + sep) || extname(page).toLowerCase() !== ".html")
    throw new Error("--composition must be an .html file inside the project");
  if (!(await stat(page).catch(() => null))?.isFile())
    throw new Error(`${options.composition} not found`);
  const chrome = await chromePath();
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  const { server, port } = await serve(options.project);
  try {
    const route = relative(options.project, page).split(sep).map(encodeURIComponent).join("/");
    const dom = await dumpDom(chrome, `http://127.0.0.1:${port}/${route}`, controller.signal);
    const cues = readCues(dom);
    const air = readAir(dom);
    // A plain page load does not mount sub-composition files, so their scripts never run.
    const unloaded = (dom.match(/\sdata-composition-src=/g) ?? []).length;
    const note = unloaded
      ? `${unloaded} sub-composition file(s) were not loaded; cues marked inside them are missing. Mark cues in the root composition's script.`
      : undefined;
    if (!cues && !air)
      throw new Error(
        `The composition marked no cues. Load the kit and call kit.cue(tl, at, sfx) where each sound belongs.${note ? ` ${note}` : ""}`,
      );
    const file = {
      version: CUES_VERSION,
      composition: options.composition,
      cues: cues ?? [],
      ...(air ? { air } : {}),
    };
    await writeFile(options.out, `${JSON.stringify(file, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        out: options.out,
        cues: file.cues.length,
        sounds: [...new Set(file.cues.map((cue) => cue.sfx))].sort(),
        ...(air ? { cameraAir: true } : {}),
        ...(note ? { note } : {}),
        elapsedMs: Math.round(performance.now() - started),
      })}\n`,
    );
  } finally {
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
    server.closeAllConnections();
    server.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `Cue export failed: ${error instanceof Error ? error.message : "invalid input"}\n`,
    );
    process.exitCode = 1;
  }
}
