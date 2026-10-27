// Cross-OS distribution smoke test: spawn the BUNDLED node runtime running the
// BUNDLED daemon, wait for the GG_APP_LISTENING handshake, create a session
// (POST /session), hit /state for that session, then terminate and assert a
// clean shutdown. Proves the per-platform runtime + single-file bundle + copied
// native deps (sharp) actually load on this OS, bundled default skills are
// present, AND the shared-daemon session protocol works in the bundle.
//
// Run AFTER `stage:node` + `bundle:sidecar`. Exits non-zero on any failure so
// it can gate CI.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcTauri = join(here, "..", "src-tauri");
const binDir = join(srcTauri, "binaries");
const sidecar = join(srcTauri, "sidecar", "app-sidecar.mjs");
const complianceSkill = join(srcTauri, "sidecar", "skills", "compliance-guard", "SKILL.md");

function fail(msg) {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
}

/** Locate the staged ggnode binary (named with the host target triple). */
function nodeBin() {
  const triple = execFileSync("rustc", ["--print", "host-tuple"], {
    encoding: "utf8",
  }).trim();
  const ext = process.platform === "win32" ? ".exe" : "";
  const expected = join(binDir, `ggnode-${triple}${ext}`);
  if (existsSync(expected)) return expected;
  // Fallback: any ggnode-* in the binaries dir.
  const found = existsSync(binDir)
    ? readdirSync(binDir).find((f) => f.startsWith("ggnode-"))
    : undefined;
  if (found) return join(binDir, found);
  fail(`staged node not found (looked for ${expected})`);
  return "";
}

/**
 * TS/JS diagnostics resolve these packages by physical path and spawn the
 * language server with the bundled Node runtime. A bundle-load smoke cannot
 * detect their absence because neither package is imported by the sidecar.
 */
function smokeTypescriptLanguageServer(node) {
  const languageServer = join(
    srcTauri,
    "sidecar",
    "node_modules",
    "typescript-language-server",
    "lib",
    "cli.mjs",
  );
  const tsserver = join(srcTauri, "sidecar", "node_modules", "typescript", "lib", "tsserver.js");
  if (!existsSync(languageServer))
    fail(`bundled TypeScript language server missing: ${languageServer}`);
  if (!existsSync(tsserver)) fail(`bundled tsserver missing: ${tsserver}`);

  const version = execFileSync(node, [languageServer, "--version"], { encoding: "utf8" }).trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    fail(`bundled TypeScript language server returned invalid version: ${version}`);
  }
  console.log(`smoke: bundled TypeScript language server starts cleanly (${version})`);
}

/** source_path also spawns a copied CLI that esbuild cannot discover. */
function smokeOpenSrc(node) {
  const bin = join(srcTauri, "sidecar", "node_modules", "opensrc", "bin", "opensrc.js");
  if (!existsSync(bin)) fail(`bundled opensrc missing: ${bin}`);
  const help = execFileSync(node, [bin, "--help"], { encoding: "utf8" });
  if (!help.includes("Fetch source code for packages")) {
    fail("bundled opensrc did not return its CLI help");
  }
  console.log("smoke: bundled opensrc starts cleanly");
}

/**
 * Motion mode runs HyperFrames through its own launcher, which resolves the
 * copied CLI from the sidecar's node_modules. Neither is imported by the
 * bundle, so a packaging slip would only surface when a user starts a video.
 */
function smokeMotionBundle(node) {
  const motion = join(srcTauri, "sidecar", "motion");
  for (const rel of [
    "plugin.json",
    join("skills", "motion", "SKILL.md"),
    join("skills", "brand-kit", "SKILL.md"),
    join("skills", "source-ingest", "SKILL.md"),
    join("references", "runtime", "minimal-composition.md"),
    join("references", "build-sheet.md"),
    join("assets", "sfx", "sfx-analysis.md"),
  ]) {
    if (!existsSync(join(motion, rel))) fail(`bundled Motion file missing: ${rel}`);
  }
  const skillNames = readdirSync(join(motion, "skills")).sort();
  if (
    JSON.stringify(skillNames) !==
    JSON.stringify([
      "app-walkthrough",
      "before-after",
      "brand-kit",
      "dev-tool-video",
      "launch-video",
      "match-reference",
      "motion",
      "source-ingest",
      "website-video",
    ])
  ) {
    fail(`unexpected Motion skill catalog: ${skillNames.join(", ")}`);
  }
  if (existsSync(join(motion, "guidance")) || existsSync(join(motion, "references", "authoring"))) {
    fail("obsolete guidance or After Effects authoring material leaked into the runtime bundle");
  }
  const music = join(motion, "assets", "music");
  const tracks = readdirSync(music).filter((name) => name.endsWith(".mp3"));
  if (tracks.length === 0) fail("shared Motion music is missing");
  for (const track of tracks) {
    if (!existsSync(join(music, "cues", track.replace(/\.mp3$/, ".music-cues.json"))))
      fail(`missing music cue map: ${track}`);
  }
  const { version } = JSON.parse(readFileSync(join(motion, "plugin.json"), "utf8"));
  const launcher = join(motion, "bin", "hyperframes.mjs");
  const reported = execFileSync(node, [launcher, "--version"], { encoding: "utf8" }).trim();
  if (reported !== version) {
    fail(`bundled HyperFrames CLI reports ${reported}, Motion skills expect ${version}`);
  }
  console.log(`smoke: bundled HyperFrames ${reported} starts through the Motion launcher`);

  const motionGate = spawnSync(node, [join(motion, "bin", "motion-check.mjs")], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (motionGate.status !== 1 || !motionGate.stderr?.includes("usage: motion-check.mjs")) {
    fail("bundled motion verification gate failed to load or accepted missing evidence");
  }
  console.log("smoke: bundled motion verification gate rejects missing evidence");

  const blurStep = spawnSync(node, [join(motion, "bin", "motion-blur.mjs")], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (blurStep.status !== 1 || !blurStep.stderr?.includes("usage: motion-blur.mjs")) {
    fail("bundled motion-blur render step failed to load");
  }
  console.log("smoke: bundled motion-blur render step loads");

  for (const [script, usage] of [
    ["cues.mjs", "usage: cues.mjs"],
    ["reference-study.mjs", "usage: reference-study.mjs"],
    ["music-fit.mjs", "usage: music-fit.mjs"],
    ["flash-check.mjs", "usage: flash-check.mjs"],
  ]) {
    const helper = spawnSync(node, [join(motion, "bin", script)], {
      encoding: "utf8",
      timeout: 10_000,
    });
    // Some helpers print their usage as a JSON error on stdout, others on stderr.
    if (helper.status !== 1 || !`${helper.stdout}${helper.stderr}`.includes(usage)) {
      fail(`bundled ${script} failed to load`);
    }
  }
  console.log("smoke: bundled sound-cue export, reference study, music fit and flash check load");

  // The font library ships as plain files; a packaging filter dropping woff2
  // would silently fall back to generic fonts in every video.
  const fonts = JSON.parse(
    execFileSync(node, [join(motion, "bin", "fonts.mjs"), "list"], { encoding: "utf8" }),
  );
  const manifest = JSON.parse(readFileSync(join(motion, "fonts", "fonts.json"), "utf8"));
  for (const entry of manifest) {
    for (const file of entry.files) {
      if (!existsSync(join(motion, "fonts", entry.dir, file.file))) {
        fail(`bundled Motion font missing: ${entry.dir}/${file.file}`);
      }
    }
  }
  console.log(`smoke: ${fonts.families.length} bundled Motion font families present`);

  // 3D shots import this vendored Three.js through an importmap; a missing
  // addon would only surface as a blank canvas mid-render.
  const three = JSON.parse(readFileSync(join(motion, "vendor", "three", "three.json"), "utf8"));
  for (const rel of ["build/three.module.min.js", "build/three.core.min.js"]) {
    if (!existsSync(join(motion, "vendor", "three", rel))) fail(`bundled Three.js missing: ${rel}`);
  }
  for (const addon of three.addons) {
    if (!existsSync(join(motion, "vendor", "three", "addons", addon))) {
      fail(`bundled Three.js addon missing: ${addon}`);
    }
  }
  console.log(`smoke: bundled Three.js ${three.version} with ${three.addons.length} addon files`);

  // The style library is plain files the agent reads by path; check the
  // helper lists it and every entry it names actually shipped.
  const library = JSON.parse(
    execFileSync(node, [join(motion, "bin", "library.mjs"), "list"], { encoding: "utf8" }),
  );
  if (!library.ok) fail(`Motion style library failed to list: ${library.error}`);
  for (const entry of [...library.looks, ...library.pieces]) {
    if (!existsSync(entry.preview)) fail(`style library preview missing: ${entry.id}`);
  }
  for (const piece of library.pieces) {
    const source = join(motion, "library", "pieces", piece.id, "piece.html");
    if (!existsSync(source)) fail(`style library piece missing: ${piece.id}`);
  }
  // Kit pieces call the move kit, which `library.mjs add` copies from here.
  if (!existsSync(join(motion, "library", "kit", "moves.js"))) {
    fail("bundled Motion move kit missing: library/kit/moves.js");
  }
  console.log(
    `smoke: style library with ${library.looks.length} looks, ${library.pieces.length} pieces and the move kit`,
  );
}

/** Bash executes through SRT's copied physical CLI; bundling it is load-bearing. */
function smokeSandboxRuntime(node) {
  const bin = join(
    srcTauri,
    "sidecar",
    "node_modules",
    "@anthropic-ai",
    "sandbox-runtime",
    "dist",
    "cli.js",
  );
  if (!existsSync(bin)) fail(`bundled sandbox runtime missing: ${bin}`);
  const help = execFileSync(node, [bin, "--help"], { encoding: "utf8" });
  if (!help.includes("sandbox")) fail("bundled sandbox runtime did not return its CLI help");
  console.log("smoke: bundled sandbox runtime starts cleanly");
}

/**
 * Payload gate: bundle-sidecar strips dev-only weight after copying the
 * dependency tree (source maps; onnxruntime-web's browser wasm/webgl/webgpu
 * payloads, which the Node exports map never resolves). If either returns,
 * ~120 MB of dead files ships in every desktop build unnoticed.
 */
function smokeLeanPayload() {
  const nodeModules = join(srcTauri, "sidecar", "node_modules");
  const files = existsSync(nodeModules)
    ? readdirSync(nodeModules, { recursive: true }).filter((f) => {
        const base = basename(String(f));
        return (
          base.endsWith(".map") || (String(f).includes("onnxruntime-web") && base.endsWith(".wasm"))
        );
      })
    : [];
  if (files.length > 0) {
    fail(`bundled payload carries pruned file types (first 3: ${files.slice(0, 3).join(", ")})`);
  }
  console.log("smoke: bundled payload is lean (no source maps, no browser onnx wasm)");
}

async function main() {
  if (!existsSync(sidecar)) fail(`bundled sidecar missing: ${sidecar}`);
  if (!existsSync(complianceSkill)) fail(`bundled compliance-guard skill missing: ${complianceSkill}`);
  const node = nodeBin();
  console.log(`smoke: ${node} ${sidecar}`);

  smokeTypescriptLanguageServer(node);
  smokeOpenSrc(node);
  smokeSandboxRuntime(node);
  smokeMotionBundle(node);
  smokeLeanPayload();

  const child = spawn(node, [sidecar], {
    env: { ...process.env, GG_APP_PORT: "0", GG_APP_CWD: process.cwd() },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // The sidecar is boot-tolerant: with no credentials it no longer fatals, it
  // boots logged-out and binds a port so the login endpoints are reachable. So
  // on credential-less CI we now reach the GG_APP_LISTENING handshake and
  // exercise /state below — proving the bundled runtime + single-file bundle +
  // native deps (sharp) loaded on this OS. (Older bundles fataled with "Not
  // logged in" instead; that's still accepted as a legacy pass.)
  //
  // Timeout is generous (120s): session.initialize() may connect user MCP
  // servers via `npx -y …` with a 30s connect timeout, and a cold npx cache on
  // a fresh CI runner can take the full 30s before MCP fails gracefully and
  // boot continues to server.listen(). 120s clears it with margin.
  const LOADED_BUT_UNAUTHED = Symbol("loaded-but-unauthed");

  const handshake = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for GG_APP_LISTENING")),
      120000,
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
      const m = out.match(/GG_APP_LISTENING (\d+) (\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ port: Number(m[1]), token: m[2] });
      }
    });
    child.stderr.on("data", (d) => {
      err += d.toString();
      process.stderr.write(d);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (/Not logged in to any provider/.test(err)) {
        resolve(LOADED_BUT_UNAUTHED);
      } else {
        reject(new Error(`sidecar exited early (code ${code})`));
      }
    });
  }).catch((err) => {
    child.kill("SIGKILL");
    fail(err.message);
  });

  if (handshake === LOADED_BUT_UNAUTHED) {
    console.log("smoke: bundle loaded cleanly (sidecar reached auth check; no credentials on CI)");
    console.log("SMOKE PASS");
    process.exit(0);
  }
  const { port, token } = handshake;

  // The daemon holds sessions as in-process objects keyed by id. Create one
  // (POST /session), then read its /state via the `x-gg-session` header — the
  // same protocol the Rust shell uses. This proves both the bundle loads AND
  // the session multiplexing works on this OS.
  let sessionId;
  try {
    const mk = await fetch(`http://127.0.0.1:${port}/session`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gg-token": token },
      body: JSON.stringify({ cwd: process.cwd() }),
    });
    if (mk.status !== 200) {
      child.kill("SIGKILL");
      fail(`POST /session returned ${mk.status}`);
    }
    sessionId = (await mk.json()).sessionId;
    if (!sessionId) {
      child.kill("SIGKILL");
      fail(`POST /session returned no sessionId`);
    }
  } catch (err) {
    child.kill("SIGKILL");
    fail(`POST /session failed: ${err.message}`);
  }

  // /state must answer 200 with a JSON body carrying a `ready` field.
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/state`, {
      headers: { "x-gg-session": sessionId, "x-gg-token": token },
    });
  } catch (err) {
    child.kill("SIGKILL");
    fail(`GET /state failed: ${err.message}`);
  }
  if (res.status !== 200) {
    child.kill("SIGKILL");
    fail(`GET /state returned ${res.status}`);
  }
  const body = await res.json();
  if (!("ready" in body)) {
    child.kill("SIGKILL");
    fail(`/state body missing "ready": ${JSON.stringify(body)}`);
  }
  console.log(`smoke: session ${sessionId.slice(0, 8)} /state 200 ready=${body.ready}`);

  // A Motion session must build from the packaged bundle (skills + prompt).
  const motionCwd = mkdtempSync(join(tmpdir(), "gg-smoke-motion-"));
  try {
    const mk = await fetch(`http://127.0.0.1:${port}/session`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gg-token": token },
      body: JSON.stringify({ mode: "motion", cwd: join(motionCwd, "GG Motion") }),
    });
    const created = await mk.json().catch(() => ({}));
    if (mk.status !== 200 || !created.sessionId) {
      child.kill("SIGKILL");
      fail(`POST /session (motion) returned ${mk.status}: ${JSON.stringify(created)}`);
    }
    console.log(`smoke: motion session ${created.sessionId.slice(0, 8)} created`);
  } catch (err) {
    child.kill("SIGKILL");
    fail(`POST /session (motion) failed: ${err.message}`);
  }

  // Clean shutdown: SIGTERM (SIGKILL fallback on Windows) and wait for exit.
  const exited = new Promise((resolve) => child.on("exit", resolve));
  child.kill(process.platform === "win32" ? "SIGKILL" : "SIGTERM");
  const exitTimer = setTimeout(() => child.kill("SIGKILL"), 8000);
  await exited;
  clearTimeout(exitTimer);

  console.log("SMOKE PASS");
  process.exit(0);
}

main().catch((err) => fail(err.message));
