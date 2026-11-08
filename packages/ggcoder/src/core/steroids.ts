// Agent Steroids (`steroids` CLI) detection, probe and install.
//
// The agent's `steroids` tool and the desktop Home screen both key off the
// same detection: a binary on the enriched PATH (see shell-path.ts) or the
// copy we install ourselves into ~/.gg/bin. Install mirrors the CLI's own
// self-upgrade (upgrade.rs): hard-coded GitHub release URL, sha256 verified
// against the release's SHA256SUMS, size-capped, single-entry tar extraction to
// a fixed path, then a `--version` smoke test. No shell anywhere.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export interface SteroidsStatus {
  /** A `steroids` binary was found. */
  installed: boolean;
  /** Installed, runs, and the corpus holds at least one repo. */
  connected: boolean;
  version?: string;
  repos?: number;
  documents?: number;
  /** The corpus's total size on disk as `stats` prints it, e.g. "2.0GB". */
  diskSize?: string;
  path?: string;
  /** Why the binary could not be probed (stderr line), if it was found. */
  error?: string;
}

const RELEASE_API = "https://api.github.com/repos/KenKaiii/agent-steroids/releases/latest";
const DOWNLOAD_PREFIX = "https://github.com/KenKaiii/agent-steroids/releases/download/";
/** Same cap as upgrade.rs: applied to the download AND the inflated binary. */
export const MAX_ASSET_BYTES = 100 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_CACHE_MS = 30_000;
/** Opts the CLI out of its own self-upgrade check on every invocation. Read
    per call so the PATH enrichment done at startup is picked up. */
export function steroidsEnv(): NodeJS.ProcessEnv {
  return { ...process.env, STEROIDS_NO_UPGRADE: "1" };
}

const BIN_NAME = process.platform === "win32" ? "steroids.exe" : "steroids";

/** Where the desktop install lands; also the last place detection looks. */
export function defaultInstallDir(): string {
  return path.join(os.homedir(), ".gg", "bin");
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Locate the `steroids` binary: every PATH entry first (Cargo installs land
 * in ~/.cargo/bin, already on the enriched PATH), then ~/.gg/bin. `null` when
 * absent — callers hide the tool and drop the prompt sentence, never guess.
 */
export function findSteroidsBinary(
  opts: { pathEnv?: string; installDir?: string } = {},
): string | null {
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  dirs.push(opts.installDir ?? defaultInstallDir());
  for (const dir of dirs) {
    const candidate = path.join(dir, BIN_NAME);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function run(bin: string, args: string[], timeout = PROBE_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { env: steroidsEnv(), timeout, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const line =
            String(stderr || err.message)
              .trim()
              .split("\n")[0] ?? "";
          reject(new Error(line || `${path.basename(bin)} ${args[0]} failed`));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

function parseCount(stats: string, label: string): number | undefined {
  const m = new RegExp(`^\\s*${label}\\s*:\\s*(\\d+)`, "m").exec(stats);
  return m ? Number(m[1]) : undefined;
}

/** The corpus figures from `steroids stats`; a missing line reads as 0 / absent. */
export function parseStats(stats: string): {
  repos: number;
  documents: number;
  diskSize?: string;
} {
  const size = /^\s*TOTAL ON DISK\s*:\s*(\d+(?:\.\d+)?\s*[KMGT]?i?B)\b/im.exec(stats)?.[1];
  return {
    repos: parseCount(stats, "repositories") ?? 0,
    documents: parseCount(stats, "documents") ?? 0,
    ...(size ? { diskSize: size.replace(/\s+/g, "") } : {}),
  };
}

let cache: { bin: string; at: number; status: SteroidsStatus } | null = null;

/** Run `--version` and `stats`; cached 30s per binary path. */
export async function probeSteroids(
  opts: { bin?: string | null; force?: boolean } = {},
): Promise<SteroidsStatus> {
  const bin = opts.bin === undefined ? findSteroidsBinary() : opts.bin;
  if (!bin) {
    cache = null;
    return { installed: false, connected: false };
  }
  if (!opts.force && cache && cache.bin === bin && Date.now() - cache.at < PROBE_CACHE_MS) {
    return cache.status;
  }
  let status: SteroidsStatus;
  try {
    const version = (await run(bin, ["--version"])).trim().replace(/^steroids\s+/, "");
    const stats = await run(bin, ["stats"]);
    const { repos, documents, diskSize } = parseStats(stats);
    status = {
      installed: true,
      connected: repos > 0,
      version,
      repos,
      documents,
      ...(diskSize ? { diskSize } : {}),
      path: bin,
    };
  } catch (err) {
    status = {
      installed: true,
      connected: false,
      path: bin,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  cache = { bin, at: Date.now(), status };
  return status;
}

/** Rust target triple for the release asset, or null when there is no build. */
export function releaseTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : null;
  if (!cpu) return null;
  if (platform === "darwin") return `${cpu}-apple-darwin`;
  if (platform === "linux") return `${cpu}-unknown-linux-musl`;
  if (platform === "win32" && cpu === "x86_64") return "x86_64-pc-windows-msvc";
  return null;
}

export const CARGO_FALLBACK =
  "No prebuilt Steroids binary for this platform. Install with: cargo install --git https://github.com/KenKaiii/agent-steroids";

/** Check `archive` against the SHA256SUMS line for `name`. */
export function verifySha256(archive: Uint8Array, sums: string, name: string): void {
  const expected = sums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file?.replace(/^\*/, "") === name)?.[0];
  if (!expected) throw new Error(`SHA256SUMS has no entry for ${name}`);
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${name} does not match its published checksum; not installing it`);
  }
}

function tarString(block: Buffer, start: number, len: number): string {
  const raw = block.subarray(start, start + len);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? len : end).toString("utf8");
}

/**
 * The one executable inside a release tarball. Minimal ustar walk (512-byte
 * headers, octal size); the archive must hold exactly one regular file named
 * `steroids`/`steroids.exe` — anything else is rejected outright.
 */
export function extractBinary(archive: Uint8Array): Buffer {
  // `maxOutputLength` refuses to inflate past the cap, so a tiny gzip that
  // expands to gigabytes never gets the chance.
  const tar = gunzipSync(archive, { maxOutputLength: MAX_ASSET_BYTES + 512 * 4 });
  let binary: Buffer | null = null;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive blocks
    const name = tarString(header, 0, 100);
    const size = parseInt(tarString(header, 124, 12).trim() || "0", 8);
    const type = tarString(header, 156, 1);
    if (!Number.isFinite(size) || size > MAX_ASSET_BYTES) {
      throw new Error(`release binary is larger than ${MAX_ASSET_BYTES} bytes`);
    }
    const base = path.posix.basename(name);
    if ((type !== "0" && type !== "") || (base !== "steroids" && base !== "steroids.exe")) {
      throw new Error(`release archive contains an unexpected entry: ${name}`);
    }
    if (binary) throw new Error("release archive contains more than one binary");
    const start = offset + 512;
    if (start + size > tar.length) throw new Error("release archive is truncated");
    binary = Buffer.from(tar.subarray(start, start + size));
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (!binary) throw new Error("release archive contains no steroids binary");
  return binary;
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

async function download(fetchFn: typeof fetch, url: string, cap: number): Promise<Buffer> {
  const res = await fetchFn(url, { headers: { "user-agent": "gg-coder" } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > cap) throw new Error(`asset exceeds ${cap} bytes`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > cap) throw new Error(`asset exceeds ${cap} bytes`);
  return body;
}

export interface InstallOptions {
  fetchFn?: typeof fetch;
  installDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Smoke test of the staged binary; tests inject one since fixtures can't run. */
  probe?: (bin: string) => Promise<SteroidsStatus>;
}

/**
 * Download the latest release for this platform into `installDir`, verifying
 * it against the release's own SHA256SUMS before a single byte is written.
 * Resolves to a fresh probe of the installed binary.
 */
export async function installSteroids(opts: InstallOptions = {}): Promise<SteroidsStatus> {
  const fetchFn = opts.fetchFn ?? fetch;
  const target = releaseTarget(opts.platform, opts.arch);
  if (!target) throw new Error(CARGO_FALLBACK);
  const wanted = `steroids-${target}.tar.gz`;

  const release = (await (
    await fetchFn(RELEASE_API, { headers: { "user-agent": "gg-coder" } })
  ).json()) as {
    assets?: ReleaseAsset[];
  };
  const urlOf = (name: string): string => {
    const asset = release.assets?.find((a) => a.name === name);
    if (!asset?.browser_download_url.startsWith(DOWNLOAD_PREFIX)) {
      throw new Error(`latest release has no ${name}`);
    }
    return asset.browser_download_url;
  };
  const [archive, sums] = await Promise.all([
    download(fetchFn, urlOf(wanted), MAX_ASSET_BYTES),
    download(fetchFn, urlOf("SHA256SUMS"), 64 * 1024),
  ]);
  verifySha256(archive, sums.toString("utf8"), wanted);
  const binary = extractBinary(archive);

  const installDir = opts.installDir ?? defaultInstallDir();
  await mkdir(installDir, { recursive: true });
  const dest = path.join(installDir, BIN_NAME);
  const staged = `${dest}.${process.pid}.tmp`;
  await writeFile(staged, binary, { mode: 0o755 });
  await chmod(staged, 0o755);
  // Prove it runs before it replaces anything.
  const status = await (opts.probe ?? ((bin) => probeSteroids({ bin, force: true })))(staged);
  if (status.error) {
    await rm(staged, { force: true });
    throw new Error(`downloaded binary failed to run: ${status.error}`);
  }
  await rename(staged, dest);
  const installed = { ...status, path: dest };
  cache = { bin: dest, at: Date.now(), status: installed };
  return installed;
}
