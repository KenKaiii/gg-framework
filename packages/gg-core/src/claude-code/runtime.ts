import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getAppPaths } from "../paths.js";
import type { OAuthLoginCallbacks } from "../oauth/types.js";
import { extractFileFromTarGz } from "./tar.js";
import manifestJson from "./manifest.json" with { type: "json" };

export interface ClaudeCodePlatformAsset {
  url: string;
  /** npm `dist.integrity`: "sha512-<base64>". */
  integrity: string;
  bin: string;
}

export interface ClaudeCodeManifest {
  sdkVersion: string;
  claudeCodeVersion: string;
  platforms: Record<string, ClaudeCodePlatformAsset>;
}

export const CLAUDE_CODE_MANIFEST: ClaudeCodeManifest = manifestJson;

/** auth.json key for "signed in with Claude through Claude Code". Holds only the marker. */
export const CLAUDE_CODE_AUTH_KEY = "anthropic-claude-code";
export const CLAUDE_CODE_AUTH_MARKER = { via: "claude-code" } as const;

export function isClaudeCodeAuthMarker(value: unknown): boolean {
  return (value as { via?: unknown } | null | undefined)?.via === CLAUDE_CODE_AUTH_MARKER.via;
}

/** An old GG Claude sign-in token (`sk-ant-oat…`). It no longer works; the user must sign in again. */
export function isLegacyClaudeOAuth(value: unknown): boolean {
  const token = (value as { accessToken?: unknown } | null | undefined)?.accessToken;
  return typeof token === "string" && token.startsWith("sk-ant-oat");
}

export type ClaudeCodeInstallProgress =
  | { phase: "download"; receivedBytes: number; totalBytes?: number }
  | { phase: "verify" }
  | { phase: "extract" };

export interface ClaudeCodeRuntimeOptions {
  /** Defaults to `~/.gg/claude-code`. */
  home?: string;
  manifest?: ClaudeCodeManifest;
  /** Platform key in the manifest; detected from the running process by default. */
  platformKey?: string;
}

export interface EnsureClaudeCodeOptions extends ClaudeCodeRuntimeOptions {
  onProgress?: (progress: ClaudeCodeInstallProgress) => void;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

export interface ClaudeCodeRunOptions extends ClaudeCodeRuntimeOptions {
  /** Executable to run instead of the installed binary (tests). */
  binary?: string;
  /** Arguments placed before the `auth …` arguments (tests run a script via node). */
  binaryArgs?: string[];
  signal?: AbortSignal;
  /** How long sign-in waits for the browser URL before falling back to the paste-code page. */
  browserWaitMs?: number;
}

export interface ClaudeCodeAuthStatus {
  loggedIn: boolean;
  /** "claude.ai" for a Claude subscription. */
  authMethod?: string;
  email?: string;
  subscriptionType?: string;
}

interface PlatformInfo {
  platform: NodeJS.Platform;
  arch: string;
  musl: boolean;
}

function isMusl(): boolean {
  if (process.platform !== "linux") return false;
  const report =
    typeof process.report?.getReport === "function"
      ? (process.report.getReport() as { header?: { glibcVersionRuntime?: string } })
      : null;
  return report != null && report.header?.glibcVersionRuntime === undefined;
}

/** Manifest key for a platform, or null where Claude Code has no build. */
export function claudeCodePlatformKey(
  info: PlatformInfo = { platform: process.platform, arch: process.arch, musl: isMusl() },
): string | null {
  const arch = info.arch === "arm64" || info.arch === "x64" ? info.arch : null;
  if (!arch) return null;
  if (info.platform === "darwin" || info.platform === "win32") return `${info.platform}-${arch}`;
  if (info.platform === "linux") return `linux-${arch}${info.musl ? "-musl" : ""}`;
  return null;
}

function resolveAsset(opts: ClaudeCodeRuntimeOptions): {
  manifest: ClaudeCodeManifest;
  asset: ClaudeCodePlatformAsset;
} {
  const manifest = opts.manifest ?? CLAUDE_CODE_MANIFEST;
  const key = opts.platformKey ?? claudeCodePlatformKey();
  const asset = key ? manifest.platforms[key] : undefined;
  if (!asset) {
    throw new Error(
      `Claude Code isn't available for ${process.platform}-${process.arch}. Use an Anthropic API key instead.`,
    );
  }
  return { manifest, asset };
}

export function claudeCodeHome(opts: ClaudeCodeRuntimeOptions = {}): string {
  return opts.home ?? getAppPaths().claudeCodeDir;
}

export function claudeCodeConfigDir(opts: ClaudeCodeRuntimeOptions = {}): string {
  return opts.home ? path.join(opts.home, "config") : getAppPaths().claudeCodeConfigDir;
}

/** Where the pinned binary lives once installed (it may not exist yet). */
export function claudeCodeBinaryPath(opts: ClaudeCodeRuntimeOptions = {}): string {
  const { manifest, asset } = resolveAsset(opts);
  return path.join(claudeCodeHome(opts), manifest.claudeCodeVersion, asset.bin);
}

/** The installed binary for the pinned version, or null when it still needs downloading. */
export function resolveClaudeCodeBinary(opts: ClaudeCodeRuntimeOptions = {}): string | null {
  let binary: string;
  try {
    binary = claudeCodeBinaryPath(opts);
  } catch {
    return null;
  }
  try {
    return fs.statSync(binary).isFile() ? binary : null;
  } catch {
    return null;
  }
}

const installs = new Map<string, Promise<string>>();

/**
 * Download, verify and unpack the pinned Claude Code binary if it isn't
 * installed yet. Concurrent callers in this process share one download;
 * other processes race safely because each unpacks into its own staging dir
 * and only one rename wins.
 */
export async function ensureClaudeCodeBinary(opts: EnsureClaudeCodeOptions = {}): Promise<string> {
  const existing = resolveClaudeCodeBinary(opts);
  if (existing) return existing;
  const target = claudeCodeBinaryPath(opts);
  let install = installs.get(target);
  if (!install) {
    install = installClaudeCode(opts).finally(() => installs.delete(target));
    installs.set(target, install);
  }
  return install;
}

async function installClaudeCode(opts: EnsureClaudeCodeOptions): Promise<string> {
  const { manifest, asset } = resolveAsset(opts);
  const home = claudeCodeHome(opts);
  const versionDir = path.join(home, manifest.claudeCodeVersion);
  const binary = path.join(versionDir, asset.bin);
  await fsp.mkdir(home, { recursive: true });
  const tag = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const tarball = path.join(home, `.download-${tag}.tgz`);
  const staging = path.join(home, `.staging-${tag}`);
  try {
    await download(asset, tarball, opts);
    opts.onProgress?.({ phase: "extract" });
    await fsp.mkdir(staging, { recursive: true });
    const found = await extractFileFromTarGz(
      tarball,
      `package/${asset.bin}`,
      path.join(staging, asset.bin),
    );
    if (!found) throw new Error(`The Claude Code download has no ${asset.bin} binary.`);
    await fsp.chmod(path.join(staging, asset.bin), 0o755);
    try {
      await fsp.rename(staging, versionDir);
    } catch (err) {
      // Another process installed the same version first; theirs is identical.
      if (!fs.existsSync(binary)) throw err;
    }
    await removeOldVersions(home, manifest.claudeCodeVersion);
    return binary;
  } finally {
    await fsp.rm(tarball, { force: true }).catch(() => {});
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

async function download(
  asset: ClaudeCodePlatformAsset,
  dest: string,
  opts: EnsureClaudeCodeOptions,
): Promise<void> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(asset.url, { signal: opts.signal });
  if (!res.ok || !res.body) {
    throw new Error(`Claude Code download failed (HTTP ${res.status}).`);
  }
  const totalBytes = Number(res.headers.get("content-length")) || undefined;
  const hash = crypto.createHash("sha512");
  const out = await fsp.open(dest, "w");
  let receivedBytes = 0;
  let lastReported = -1;
  try {
    opts.onProgress?.({ phase: "download", receivedBytes, totalBytes });
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("Download cancelled.");
      hash.update(chunk);
      await out.write(chunk);
      receivedBytes += chunk.byteLength;
      // Report each whole percent (or every 4 MB without a length), not every chunk.
      const step = totalBytes
        ? Math.floor((receivedBytes / totalBytes) * 100)
        : Math.floor(receivedBytes / 4_194_304);
      if (step !== lastReported) {
        lastReported = step;
        opts.onProgress?.({ phase: "download", receivedBytes, totalBytes });
      }
    }
  } finally {
    await out.close();
  }
  opts.onProgress?.({ phase: "verify" });
  const expected = asset.integrity.replace(/^sha512-/, "");
  if (hash.digest("base64") !== expected) {
    throw new Error(
      "The Claude Code download didn't match its pinned checksum, so it was discarded.",
    );
  }
}

async function removeOldVersions(home: string, keep: string): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(home, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keep || entry.name === "config") continue;
    if (!/^\d+\.\d+\.\d+/.test(entry.name)) continue;
    // A window may still run the old binary; Windows refuses (EBUSY) until it exits.
    await fsp.rm(path.join(home, entry.name), { recursive: true, force: true }).catch(() => {});
  }
}

/** Plain-language status line for an install progress event. */
export function formatClaudeCodeInstallProgress(progress: ClaudeCodeInstallProgress): string {
  if (progress.phase === "verify") return "Checking the Claude Code download…";
  if (progress.phase === "extract") return "Unpacking Claude Code…";
  const mb = (bytes: number) => Math.round(bytes / 1_048_576);
  if (!progress.totalBytes) return `Downloading Claude Code… ${mb(progress.receivedBytes)} MB`;
  const pct = Math.floor((progress.receivedBytes / progress.totalBytes) * 100);
  return `Downloading Claude Code… ${pct}% (${mb(progress.receivedBytes)} of ${mb(progress.totalBytes)} MB)`;
}

// Credentials Claude Code would prefer over the subscription login.
const STRIPPED_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "NODE_OPTIONS",
];

/** Environment for every Claude Code process GG Coder starts: our own login, no stray keys. */
export function claudeCodeEnv(
  opts: ClaudeCodeRuntimeOptions = {},
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !STRIPPED_ENV.includes(key)) env[key] = value;
  }
  env.CLAUDE_CONFIG_DIR = claudeCodeConfigDir(opts);
  // The binary is pinned and checksummed; it must not replace itself.
  env.DISABLE_AUTOUPDATER = "1";
  return env;
}

function runCommand(opts: ClaudeCodeRunOptions): { command: string; prefix: string[] } {
  if (opts.binary) return { command: opts.binary, prefix: opts.binaryArgs ?? [] };
  const binary = resolveClaudeCodeBinary(opts);
  if (!binary) throw new Error("Claude Code isn't installed yet. Sign in with Claude first.");
  return { command: binary, prefix: [] };
}

function runClaude(
  args: string[],
  opts: ClaudeCodeRunOptions,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { command, prefix } = runCommand(opts);
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, ...args], {
      env: claudeCodeEnv(opts),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      signal: opts.signal,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** `claude auth status` for GG Coder's own login. Logged out when the binary is missing. */
export async function claudeCodeAuthStatus(
  opts: ClaudeCodeRunOptions = {},
): Promise<ClaudeCodeAuthStatus> {
  if (!opts.binary && !resolveClaudeCodeBinary(opts)) return { loggedIn: false };
  const { stdout } = await runClaude(["auth", "status", "--json"], opts);
  // Exits 1 when logged out but still prints the JSON.
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    return {
      loggedIn: parsed.loggedIn === true,
      ...(typeof parsed.authMethod === "string" ? { authMethod: parsed.authMethod } : {}),
      ...(typeof parsed.email === "string" ? { email: parsed.email } : {}),
      ...(typeof parsed.subscriptionType === "string"
        ? { subscriptionType: parsed.subscriptionType }
        : {}),
    };
  } catch {
    return { loggedIn: false };
  }
}

export async function logoutClaudeCode(opts: ClaudeCodeRunOptions = {}): Promise<void> {
  if (!opts.binary && !resolveClaudeCodeBinary(opts)) return;
  const { code, stderr } = await runClaude(["auth", "logout"], opts);
  if (code !== 0) throw new Error(stderr.trim() || `claude auth logout exited with ${code}`);
}

// Claude Code runs $BROWSER with the sign-in URL as its only argument. Pointing
// it at Node with this preload hands us the URL instead of opening a tab, so the
// app opens it (once). Node resolves argv[1] like a script path, so only the
// callback port is read back from it.
const OPEN_URL_HOOK = `const arg = String(process.argv[1] || "");
const file = process.env.GG_CLAUDE_CODE_URL_FILE;
if (file && /https?:/.test(arg)) {
  require("node:fs").appendFileSync(file, arg + "\\n");
  process.exit(0);
}
`;

const CAPTURE_WAIT_MS = 3_000;

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

/** The browser sign-in URL with Claude Code's localhost callback instead of the paste-code page. */
export function claudeCodeCallbackUrl(manualUrl: string, captured: string): string | null {
  const port = /localhost(?::|%3A)(\d{2,5})(?:\/|%2F)callback/i.exec(captured)?.[1];
  if (!port) return null;
  try {
    const url = new URL(manualUrl);
    url.searchParams.set("redirect_uri", `http://localhost:${port}/callback`);
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Run `claude auth login` for GG Coder's own Claude login. The browser URL goes
 * to `onOpenUrl`; Claude Code's localhost callback finishes sign-in, and a
 * pasted code (from the fallback page) is accepted too.
 */
export async function loginClaudeCode(
  callbacks: OAuthLoginCallbacks,
  opts: ClaudeCodeRunOptions = {},
): Promise<void> {
  const { command, prefix } = runCommand(opts);
  const home = claudeCodeHome(opts);
  await fsp.mkdir(claudeCodeConfigDir(opts), { recursive: true });
  const tag = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const hookFile = path.join(home, `.open-url-${tag}.cjs`);
  const urlFile = path.join(home, `.open-url-${tag}.txt`);
  await fsp.writeFile(hookFile, OPEN_URL_HOOK);
  const env = {
    ...claudeCodeEnv(opts),
    BROWSER: process.execPath,
    NODE_OPTIONS: `--require ${JSON.stringify(hookFile)}`,
    GG_CLAUDE_CODE_URL_FILE: urlFile,
  };
  const promptAbort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, [...prefix, "auth", "login", "--claudeai"], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let manualUrl: string | null = null;
      let opened = false;
      const onAbort = () => child.kill();
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      const open = (url: string, needsCode: boolean) => {
        if (opened) return;
        opened = true;
        clearInterval(timer);
        callbacks.onOpenUrl(url);
        callbacks.onStatus("Finish signing in to Claude in your browser…");
        if (!needsCode) return;
        // Fallback page shows a code to paste back ("code#state").
        void callbacks
          .onPromptCode("Paste the code shown after signing in to Claude:", promptAbort.signal)
          .then((code) => {
            const trimmed = code.trim();
            if (trimmed && !child.stdin.destroyed) child.stdin.write(`${trimmed}\n`);
          })
          .catch(() => {});
      };

      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
        if (manualUrl) return;
        const match = /visit:\s*(https:\/\/\S+)/.exec(stripAnsi(stdout));
        if (!match) return;
        manualUrl = match[1]!;
        const started = Date.now();
        timer = setInterval(() => {
          let captured = "";
          try {
            captured = fs.readFileSync(urlFile, "utf8");
          } catch {
            // Not written yet.
          }
          const callbackUrl = captured ? claudeCodeCallbackUrl(manualUrl!, captured) : null;
          if (callbackUrl) open(callbackUrl, false);
          else if (Date.now() - started > (opts.browserWaitMs ?? CAPTURE_WAIT_MS))
            open(manualUrl!, true);
        }, 100);
      });
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => {
        opts.signal?.removeEventListener("abort", onAbort);
        if (opts.signal?.aborted) reject(new Error("Sign-in cancelled."));
        else if (code === 0) resolve();
        else {
          const detail = stripAnsi(stderr).trim().split("\n").pop()?.trim();
          reject(new Error(detail || `Claude sign-in failed (exit ${code}).`));
        }
      });
    });
  } finally {
    clearInterval(timer);
    promptAbort.abort();
    await fsp.rm(hookFile, { force: true }).catch(() => {});
    await fsp.rm(urlFile, { force: true }).catch(() => {});
  }
}
