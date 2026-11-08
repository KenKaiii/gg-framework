/**
 * Release-age cooldown for every install the agent runs (P1). Each package
 * manager's native setting is applied to the command, so the manager itself
 * skips versions younger than the cooldown — transitive deps included — and
 * falls back to an older version. Locked versions still install.
 *
 * Verified (temp dirs, see package-cooldown.test.ts for the shapes):
 * - npm 11.12.1 `npm_config_min_release_age` (days), pnpm 10.17.1
 *   `npm_config_minimum_release_age` (minutes), pip 26.1.2 `PIP_UPLOADED_PRIOR_TO`.
 * - bun 1.3.14: env has no effect; `--minimum-release-age=<seconds>` on
 *   `bun install/add` skips a fresh transitive dep; `--frozen-lockfile` still
 *   installs locked fresh versions. Appended to the command (bun ≥ 1.3).
 * - yarn berry 4.10.3 `YARN_NPM_MINIMAL_AGE_GATE` (minutes) skips a fresh
 *   transitive dep; yarn 4.9 rejects the unknown setting, so ≥ 4.10 only.
 *   Yarn classic has no cooldown (own age check for named packages instead).
 * - uv 0.7.13 `UV_EXCLUDE_NEWER`: only for commands that resolve. uv records
 *   it in uv.lock `[options]`; a later plain `uv sync` works, but a plain
 *   `uv sync` with a *different* value re-resolves, so it is never set there.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { compareVersions } from "./threat-feed.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "pip" | "uv";

/** First version with a native cooldown we can apply. */
const NATIVE_SINCE: Partial<Record<PackageManager, string>> = {
  npm: "11.10.0",
  pnpm: "10.16.0",
  yarn: "4.10.0",
  bun: "1.3.0",
  pip: "26.1",
  uv: "0.0.0",
};

const versionCache = new Map<string, Promise<string | null>>();

/** How to spawn `<manager> --version`. Windows: npm/pnpm/yarn are `.cmd` shims, which need a shell. */
export function versionSpawn(
  manager: PackageManager,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[]; shell: boolean } {
  // One command string (no args array) with shell: avoids Node's DEP0190 warning.
  return platform === "win32"
    ? { file: `${manager} --version`, args: [], shell: true }
    : { file: manager, args: ["--version"], shell: false };
}

/**
 * `<manager> --version`, once per process (yarn: once per directory, since
 * berry is pinned per project); null when missing.
 */
export function managerVersion(manager: PackageManager, cwd?: string): Promise<string | null> {
  const key = manager === "yarn" ? `yarn:${cwd ?? ""}` : manager;
  let hit = versionCache.get(key);
  if (!hit) {
    const { file, args, shell } = versionSpawn(manager);
    hit = new Promise((resolve) => {
      execFile(
        file,
        args,
        {
          timeout: 3_000,
          shell,
          windowsHide: true,
          cwd: manager === "yarn" && cwd ? cwd : undefined,
          env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
        },
        (err, stdout) => {
          const m = /(\d+\.\d+(?:\.\d+)?)/.exec(String(stdout));
          resolve(err || !m ? null : (m[1] ?? null));
        },
      );
    });
    versionCache.set(key, hit);
  }
  return hit;
}

/** Whether `manager` at `version` honours the cooldown we apply. */
export function hasNativeCooldown(manager: PackageManager, version: string | null): boolean {
  const since = NATIVE_SINCE[manager];
  return since !== undefined && version !== null && compareVersions(version, since) >= 0;
}

const MENTIONS: Record<PackageManager, RegExp> = {
  npm: /\b(?:npm|npx)\b/,
  pnpm: /\bpnpm\b/,
  yarn: /\byarn\b/,
  bun: /\bbunx?\b/,
  pip: /\bpip3?\b/,
  uv: /\buvx?\b/,
};

/** Package managers a command mentions (cheap regex, no spawn). */
export function mentionedManagers(command: string): PackageManager[] {
  return (Object.keys(MENTIONS) as PackageManager[]).filter((m) => MENTIONS[m].test(command));
}

const INSTALL_HINT =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|a|ci|update|up|upgrade|dlx|exec|x|create)|npx|bunx|uvx|pip3?\s+install|pipx\s+(?:run|install)|uv\s+(?:add|lock|sync|pip|tool|run))\b|(?:^|[;&|]\s*)yarn(?:\s*$|\s*[;&|]|\s+-)/m;

/** Cheap regex: could this command install packages? Non-installs skip every spawn and file read. */
export function mayInstall(command: string): boolean {
  return INSTALL_HINT.test(command);
}

/** uv commands that resolve (and so honour UV_EXCLUDE_NEWER without breaking an existing lock). */
const UV_RESOLVES =
  /\buv\s+(?:add|lock|pip\s+(?:install|compile)|tool\s+(?:run|install))\b|\buvx\b|\buv\s+sync\b[^;&|\n]*--upgrade/;

export function uvResolves(command: string): boolean {
  return UV_RESOLVES.test(command);
}

function readSmall(file: string): string {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size < 256_000 ? fs.readFileSync(file, "utf8") : "";
  } catch {
    return "";
  }
}

/**
 * Whether installs here may come from a registry other than public npm
 * (command `--registry`, `npm_config_registry`, a `registry=` /
 * `@scope:registry=` line in .npmrc up the tree or in ~/.npmrc,
 * `npmRegistryServer` in .yarnrc.yml). Cheap sync reads, install commands only.
 */
export function usesCustomNpmRegistry(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (/--registry[=\s]/.test(command)) return true;
  const reg = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY;
  if (reg && !/^https?:\/\/registry\.(?:npmjs\.org|yarnpkg\.com)\/?$/.test(reg)) return true;
  const files: string[] = [];
  for (let dir = path.resolve(cwd), i = 0; i < 30; i++) {
    files.push(path.join(dir, ".npmrc"), path.join(dir, ".yarnrc.yml"));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const home = env.HOME ?? env.USERPROFILE;
  if (home) files.push(path.join(home, ".npmrc"));
  return files.some((f) => {
    const text = readSmall(f);
    if (!text) return false;
    return f.endsWith(".yml")
      ? /^\s*npmRegistryServer\s*:/m.test(text) || /^\s*npmScopes\s*:/m.test(text)
      : /^\s*(?:@[^:\s]+:)?registry\s*=\s*(?!https?:\/\/registry\.npmjs\.org\/?\s*$)\S/m.test(text);
  });
}

/** Whether pip/uv may install from an index other than PyPI (flags, env, pip.conf). */
export function usesCustomPypiIndex(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (
    /(?:^|\s)(?:-i|--index-url|--extra-index-url|--index|--default-index|-f|--find-links)[=\s]/.test(
      command,
    )
  )
    return true;
  for (const k of [
    "PIP_INDEX_URL",
    "PIP_EXTRA_INDEX_URL",
    "UV_INDEX_URL",
    "UV_EXTRA_INDEX_URL",
    "UV_INDEX",
    "UV_DEFAULT_INDEX",
  ]) {
    if (env[k]) return true;
  }
  const home = env.HOME ?? env.USERPROFILE;
  if (!home) return false;
  return [
    path.join(home, ".config", "pip", "pip.conf"),
    path.join(home, ".pip", "pip.conf"),
    path.join(home, "AppData", "Roaming", "pip", "pip.ini"),
  ].some((f) => /^\s*(?:extra-)?index-url\s*=/m.test(readSmall(f)));
}

export interface CooldownEnvOptions {
  days: number;
  now: number;
  cwd: string;
  /** Detected versions; a manager without one gets nothing (avoids unknown-config warnings/errors). */
  versions: Partial<Record<PackageManager, string | null>>;
  /** Environment to read registry settings from (default process.env). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Cooldown environment variables for `command`:
 * - npm `min-release-age` (days), npm ≥ 11.10 only (older npm warns on it).
 * - pnpm `minimum-release-age` (minutes) via npm_config_, only when the
 *   command runs pnpm (npm warns on this key).
 * - yarn berry ≥ 4.10 `YARN_NPM_MINIMAL_AGE_GATE` (minutes).
 * - pip `PIP_UPLOADED_PRIOR_TO` relative ISO duration (older pip ignores it).
 * - uv `UV_EXCLUDE_NEWER` absolute timestamp: always without `uv.lock`; with
 *   one only for resolving commands (plain `uv sync`/`uv run` keep the lock;
 *   the lockfile check covers those).
 */
export function packageCooldownEnv(
  command: string,
  opts: CooldownEnvOptions,
): Record<string, string> {
  if (!(opts.days > 0)) return {};
  const env: Record<string, string> = {};
  if (hasNativeCooldown("npm", opts.versions.npm ?? null)) {
    env.npm_config_min_release_age = String(opts.days);
  }
  const minutes = String(Math.round(opts.days * 1440));
  // pnpm fails hard (ERR_PNPM_MISSING_TIME) on registries that serve no
  // publish times, common for private ones; npm and bun just allow such versions.
  const pnpm = MENTIONS.pnpm.test(command) && hasNativeCooldown("pnpm", opts.versions.pnpm ?? null);
  const yarn = MENTIONS.yarn.test(command) && hasNativeCooldown("yarn", opts.versions.yarn ?? null);
  const custom = (pnpm || yarn) && usesCustomNpmRegistry(command, opts.cwd, opts.env);
  if (pnpm && !custom) {
    env.npm_config_minimum_release_age = minutes;
  }
  if (yarn && !custom) {
    env.YARN_NPM_MINIMAL_AGE_GATE = minutes;
  }
  env.PIP_UPLOADED_PRIOR_TO = `P${opts.days}D`;
  if (
    MENTIONS.uv.test(command) &&
    (uvResolves(command) || !fs.existsSync(path.join(opts.cwd, "uv.lock")))
  ) {
    env.UV_EXCLUDE_NEWER = new Date(opts.now - opts.days * 86_400_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
  }
  return env;
}

const BUN_RESOLVE = /(^|[;&|(]\s*|\n\s*)(bun\s+(?:install|i|add|a|update)|bunx|bun\s+x)(?=\s|$)/g;

/**
 * bun has no env setting: append `--minimum-release-age=<seconds>` to each
 * `bun install/add/update` / `bunx` (bun ≥ 1.3, only when not already given).
 */
export function bunCooldownCommand(command: string, days: number, version: string | null): string {
  if (!(days > 0) || !hasNativeCooldown("bun", version)) return command;
  if (command.includes("--minimum-release-age")) return command;
  const flag = ` --minimum-release-age=${Math.round(days * 86_400)}`;
  return command.replace(BUN_RESOLVE, (_m, pre: string, cmd: string) => `${pre}${cmd}${flag}`);
}

/** Env prefix per program, for shells whose environment is fixed at start (persistent bash). */
const SCOPED: Array<[RegExp, string]> = [
  [/(^|[;&|(]\s*|\n\s*)(npm|npx)\b/g, "npm_config_min_release_age"],
  [/(^|[;&|(]\s*|\n\s*)(pnpm)\b/g, "npm_config_minimum_release_age"],
  [/(^|[;&|(]\s*|\n\s*)(yarn)\b/g, "YARN_NPM_MINIMAL_AGE_GATE"],
  [/(^|[;&|(]\s*|\n\s*)(uvx?)\b/g, "UV_EXCLUDE_NEWER"],
];

/**
 * Prefix each package-manager invocation with its own cooldown variable from
 * `env` (`npm i` → `npm_config_min_release_age=2 npm i`). Used where one
 * long-lived shell serves every command.
 */
export function scopeCooldown(command: string, env: Record<string, string>): string {
  let out = command;
  for (const [re, key] of SCOPED) {
    const value = env[key];
    if (value)
      out = out.replace(re, (_m, pre: string, prog: string) => `${pre}${key}=${value} ${prog}`);
  }
  return out;
}

/** Detect versions of the managers a command mentions (cached; nothing for non-installs). */
export async function detectMentionedVersions(
  command: string,
  cwd?: string,
): Promise<Partial<Record<PackageManager, string | null>>> {
  const out: Partial<Record<PackageManager, string | null>> = {};
  if (!mayInstall(command)) return out;
  const wanted = mentionedManagers(command).filter(
    (m) => m === "npm" || m === "pnpm" || m === "yarn" || m === "bun",
  );
  await Promise.all(
    wanted.map(async (m) => {
      out[m] = await managerVersion(m, cwd);
    }),
  );
  return out;
}

/**
 * Manager errors the cooldown causes, verified against npm 11.12, pnpm 10.17,
 * bun 1.3.14, yarn 4.10, pip 26.1 and uv 0.7. First group = the manager names
 * the cooldown itself; second = a generic "no such version" that the cooldown
 * may have caused (also printed for versions that truly don't exist).
 */
const COOLDOWN_SURE: RegExp[] = [
  /No matching version found for (\S+) with a date before/, // npm
  /No matching version found for (\S+) published by/, // pnpm
  /"([^"]+)" found for specifier "([^"]+)" \(blocked by minimum-release-age/, // bun
];
const COOLDOWN_MAYBE: RegExp[] = [
  /YN0082: [│|]?\s*(\S+): No candidates found/, // yarn berry
  /No matching distribution found for (\S+)/, // pip
  /there is no version of (\S+?)(?:\s|$)/, // uv
];

/**
 * One plain line explaining a failed install the cooldown caused, so the
 * agent doesn't misread a cryptic ETARGET / "no candidates". Null otherwise.
 */
export function cooldownFailureHint(output: string, days: number): string | null {
  if (!(days > 0) || output.length === 0) return null;
  const tail = output.length > 20_000 ? output.slice(-20_000) : output;
  for (const re of COOLDOWN_SURE) {
    const m = re.exec(tail);
    if (!m) continue;
    const pkg = m[2] ? `${m[1]}@${m[2]}` : (m[1] ?? "that version");
    return `Kleio Coder's ${days}-day release-age cooldown hid ${pkg}: it was published less than ${days} days ago. Pin the newest older version (or drop the version so the manager picks one); if the user needs this exact version, tell them it is held back by the cooldown (setting packageCooldownDays).`;
  }
  for (const re of COOLDOWN_MAYBE) {
    const m = re.exec(tail);
    if (!m) continue;
    return `If ${m[1] ?? "that version"} was published in the last ${days} days, Kleio Coder's release-age cooldown hid it: pin the newest older version instead (if the user needs that exact version, tell them it is held back by the cooldown, setting packageCooldownDays).`;
  }
  return null;
}

/** Test hook. */
export function clearManagerVersionCache(): void {
  versionCache.clear();
}

/** Cooldown env for an MCP stdio launch (`npx …`/`uvx …`); {} for anything else. */
export async function launchCooldownEnv(
  command: string,
  args: readonly string[],
  cwd: string,
  days = 2,
): Promise<Record<string, string>> {
  const base = path
    .basename(command)
    .toLowerCase()
    .replace(/\.(cmd|exe)$/, "");
  if (!["npx", "npm", "pnpm", "uvx", "uv"].includes(base)) return {};
  const line = [base, ...args].join(" ");
  return packageCooldownEnv(line, {
    days,
    now: Date.now(),
    cwd,
    versions: await detectMentionedVersions(line, cwd),
  });
}
