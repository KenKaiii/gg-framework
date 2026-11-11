// Stage a per-platform Node runtime into src-tauri/binaries/ as a Tauri
// `externalBin`. Tauri requires the file to be named with the host target
// triple suffix (e.g. ggnode-aarch64-apple-darwin) and auto-copies it next to
// the app executable at bundle time, so the packaged app never depends on a
// Node install on the user's PATH.
//
// We download the *official* Node.js distribution for the build platform/arch
// (NOT `process.execPath` — package-manager Node builds like Homebrew's are
// dynamically linked to libnode.dylib and are not self-contained). Official
// nodejs.org builds are standalone (link only against system libraries).
//
// Because each OS/arch bundle is produced on its own CI runner, the staged
// binary always matches the platform it ships to. Override the version with
// GG_NODE_VERSION, or point GG_NODE_SOURCE at a prebuilt standalone binary to
// skip the download.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcTauri = join(here, "..", "src-tauri");
const binDir = join(srcTauri, "binaries");

// Stay on 22.x: native addons are built for its ABI (127). 22.23.5 keeps that
// ABI and bundles undici 6.29.1, which fixes the global fetch advisories 22.12.0 (6.21.0) has.
const NODE_VERSION = process.env.GG_NODE_VERSION || "22.23.5";

// A single dropped connection to nodejs.org once failed a whole release build
// (connect timeout on the macOS runner), so the download retries with backoff:
// waits of 2s, 4s and 8s between four attempts.
const DOWNLOAD_ATTEMPTS = 4;
const DOWNLOAD_RETRY_BASE_MS = 2_000;
// Cap each attempt so a stalled transfer turns into a retry instead of hanging
// the job. The archive is ~50 MB, a few seconds on a CI runner.
const DOWNLOAD_ATTEMPT_TIMEOUT_MS = 5 * 60_000;

/** Resolve the Rust host target triple (e.g. aarch64-apple-darwin). */
function hostTriple() {
  return execFileSync("rustc", ["--print", "host-tuple"], {
    encoding: "utf8",
  }).trim();
}

/** Map the build platform/arch → official Node dist slug + archive extension. */
function nodeDist() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  switch (process.platform) {
    case "darwin":
      return { slug: `darwin-${arch}`, ext: "tar.gz" };
    case "linux":
      return { slug: `linux-${arch}`, ext: "tar.xz" };
    case "win32":
      return { slug: `win-${arch}`, ext: "zip" };
    default:
      throw new Error(`unsupported platform: ${process.platform}`);
  }
}

/** Worth retrying: timeouts, rate limits and server errors. A 404 (a wrong
 *  version) will not fix itself, so it fails at once. */
function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

/** `fetch failed` alone hides the reason; the network error sits in `cause`. */
function describeError(err) {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
  return cause ? `${message}: ${cause}` : message;
}

/**
 * Download `url` to `dest`, retrying network errors, stalled transfers and
 * retryable HTTP statuses with exponential backoff. Each attempt rewrites
 * `dest` from scratch, so a transfer cut off midway never leaves a partial file
 * behind. `fetchImpl`, `sleep` and `log` are injectable for tests.
 */
export async function download(url, dest, options = {}) {
  const {
    attempts = DOWNLOAD_ATTEMPTS,
    baseDelayMs = DOWNLOAD_RETRY_BASE_MS,
    attemptTimeoutMs = DOWNLOAD_ATTEMPT_TIMEOUT_MS,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
    log = console.warn,
  } = options;
  for (let attempt = 1; ; attempt++) {
    let retryable = true;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(attemptTimeoutMs) });
      if (!res.ok) {
        retryable = isRetryableStatus(res.status);
        // Release the connection before the next attempt.
        await res.body?.cancel().catch(() => {});
        throw new Error(`download failed (${res.status}): ${url}`);
      }
      if (!res.body) throw new Error(`download failed (empty body): ${url}`);
      await pipeline(res.body, createWriteStream(dest));
      return;
    } catch (err) {
      if (!retryable || attempt >= attempts) throw err;
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      log(
        `download attempt ${attempt}/${attempts} failed (${describeError(err)}); ` +
          `retrying in ${delayMs / 1000}s`,
      );
      await sleep(delayMs);
    }
  }
}

/** Download + extract official Node, returning the path to the node binary. */
async function fetchNode(work) {
  const { slug, ext } = nodeDist();
  const name = `node-v${NODE_VERSION}-${slug}`;
  const archive = join(work, `node.${ext}`);
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${name}.${ext}`;
  console.log(`downloading ${url}`);
  await download(url, archive);

  if (ext === "zip") {
    // Windows: PowerShell Expand-Archive is always available on CI runners.
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${archive}' -DestinationPath '${work}' -Force`,
      ],
      { stdio: "inherit" },
    );
    return join(work, name, "node.exe");
  }
  execFileSync("tar", ["xf", archive, "-C", work], { stdio: "inherit" });
  return join(work, name, "bin", "node");
}

async function main() {
  const triple = hostTriple();
  const isWindows = process.platform === "win32";
  const ext = isWindows ? ".exe" : "";

  mkdirSync(binDir, { recursive: true });
  const dest = join(binDir, `ggnode-${triple}${ext}`);

  let source = process.env.GG_NODE_SOURCE;
  let work;
  if (!source) {
    work = mkdtempSync(join(tmpdir(), "ggnode-"));
    source = await fetchNode(work);
  }
  if (!existsSync(source)) {
    throw new Error(`node source not found: ${source}`);
  }

  copyFileSync(source, dest);
  if (!isWindows) {
    chmodSync(dest, 0o755);
  }
  if (work) {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`staged node runtime (v${NODE_VERSION}): ${dest}`);
}

// Run only when executed directly, so tests can import `download`.
const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
