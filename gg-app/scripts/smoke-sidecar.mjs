// Cross-OS distribution smoke test: spawn the BUNDLED node runtime running the
// BUNDLED daemon, wait for the GG_APP_LISTENING handshake, create a session
// (POST /session), hit /state for that session, then terminate and assert a
// clean shutdown. Proves the per-platform runtime + single-file bundle + copied
// native deps (sharp) actually load on this OS, bundled default skills are
// present, AND the shared-daemon session protocol works in the bundle.
//
// Run AFTER `stage:node` + `bundle:sidecar`. Exits non-zero on any failure so
// it can gate CI.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcTauri = join(here, "..", "src-tauri");
const binDir = join(srcTauri, "binaries");
const sidecar = join(srcTauri, "sidecar", "app-sidecar.mjs");
const evidenceSkill = join(srcTauri, "sidecar", "skills", "evidence-led-ui", "SKILL.md");

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
 * The bundled kencode-search MCP server must START from the copied
 * node_modules tree. It's spawned as a stdio child (never imported), so the
 * main bundle-load check can't catch a broken copy — v0.14.x shipped a
 * kencode-search whose MCP SDK dep tree was incomplete (pnpm symlink +
 * exports-map stub in bundle-sidecar's packageRoot) and it crashed on every
 * spawn with "Connection closed". This gate makes that class of bug fail CI.
 */
async function smokeKencode(node) {
  const bin = join(
    srcTauri,
    "sidecar",
    "node_modules",
    "@kenkaiiii",
    "kencode-search",
    "dist",
    "index.js",
  );
  if (!existsSync(bin)) fail(`bundled kencode-search missing: ${bin}`);
  const ok = await new Promise((resolve) => {
    const child = spawn(node, [bin], { stdio: ["pipe", "pipe", "pipe"] });
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      // Must have printed "ready" — a silently-hung child is a failure too.
      resolve(/ready/.test(err));
    }, 8000);
    child.stderr.on("data", (d) => {
      err += d.toString();
      if (/ready/.test(err)) {
        clearTimeout(timer);
        child.kill("SIGKILL");
        resolve(true);
      }
    });
    child.on("exit", () => {
      clearTimeout(timer);
      if (!/ready/.test(err)) {
        process.stderr.write(err);
        resolve(false);
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.stdin.end();
  });
  if (!ok) fail("bundled kencode-search failed to start (broken dependency copy?)");
  console.log("smoke: bundled kencode-search starts cleanly");
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

async function main() {
  if (!existsSync(sidecar)) fail(`bundled sidecar missing: ${sidecar}`);
  if (!existsSync(evidenceSkill)) fail(`bundled evidence-led-ui skill missing: ${evidenceSkill}`);
  const node = nodeBin();
  console.log(`smoke: ${node} ${sidecar}`);

  await smokeKencode(node);
  smokeTypescriptLanguageServer(node);
  smokeOpenSrc(node);

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
  // Timeout is generous (120s): session.initialize() connects the default
  // `kencode-search` MCP server via `npx -y …` with a 30s connect timeout, and a
  // cold npx cache on a fresh CI runner can take the full 30s before MCP fails
  // gracefully and boot continues to server.listen(). 30s here used to race that
  // and time out; 120s clears it with margin.
  const LOADED_BUT_UNAUTHED = Symbol("loaded-but-unauthed");

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for GG_APP_LISTENING")),
      120000,
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
      const m = out.match(/GG_APP_LISTENING (\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
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

  if (port === LOADED_BUT_UNAUTHED) {
    console.log("smoke: bundle loaded cleanly (sidecar reached auth check; no credentials on CI)");
    console.log("SMOKE PASS");
    process.exit(0);
  }

  // The daemon holds sessions as in-process objects keyed by id. Create one
  // (POST /session), then read its /state via the `x-gg-session` header — the
  // same protocol the Rust shell uses. This proves both the bundle loads AND
  // the session multiplexing works on this OS.
  let sessionId;
  try {
    const mk = await fetch(`http://127.0.0.1:${port}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
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
      headers: { "x-gg-session": sessionId },
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
