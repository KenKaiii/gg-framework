import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withFileLock } from "@kenkaiiii/gg-core";
import { atomicWrite } from "../core/session-storage.js";
import { projectModelKey } from "./app-settings.js";

/**
 * What the `!` picker offers: commands the user already ran in this project
 * (most used first) and commands that fit the project (its git repo, package
 * scripts, build tool) for one they haven't run yet.
 */

export interface ShellSuggestion {
  command: string;
  /** Times the user ran it in this project; 0 for a project suggestion. */
  count: number;
  /** Where a never-run suggestion comes from, e.g. "package.json". */
  source?: string;
}

interface HistoryEntry {
  command: string;
  count: number;
  lastUsed: number;
}

type HistoryFile = Record<string, HistoryEntry[]>;

/** Commands kept per project; the least used fall off. */
export const SHELL_HISTORY_MAX = 100;
const SUGGESTED_COMMAND_MAX = 200;

export function shellHistoryFile(): string {
  return path.join(os.homedir(), ".gg", "shell-history.json");
}

function readEntries(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v): HistoryEntry[] => {
    if (typeof v !== "object" || v === null) return [];
    const { command, count, lastUsed } = v as Record<string, unknown>;
    if (typeof command !== "string" || !command.trim()) return [];
    return [
      {
        command,
        count: typeof count === "number" && count > 0 ? Math.floor(count) : 1,
        lastUsed: typeof lastUsed === "number" ? lastUsed : 0,
      },
    ];
  });
}

async function loadHistoryFile(): Promise<HistoryFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(shellHistoryFile(), "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as HistoryFile;
  } catch {
    return {};
  }
}

/** Most used first; ties go to the most recent, then alphabetical. */
export function rankHistory(entries: readonly HistoryEntry[]): HistoryEntry[] {
  return [...entries].sort(
    (a, b) => b.count - a.count || b.lastUsed - a.lastUsed || a.command.localeCompare(b.command),
  );
}

export async function loadShellHistory(cwd: string): Promise<HistoryEntry[]> {
  const file = await loadHistoryFile();
  return rankHistory(readEntries(file[projectModelKey(cwd)]));
}

/** Count one run of `command` in this project. */
export async function recordShellCommand(
  cwd: string,
  command: string,
  now: number = Date.now(),
): Promise<void> {
  const key = projectModelKey(cwd);
  const file = shellHistoryFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await withFileLock(file, async () => {
    const all = await loadHistoryFile();
    const entries = readEntries(all[key]);
    const existing = entries.find((e) => e.command === command);
    if (existing) {
      existing.count += 1;
      existing.lastUsed = now;
    } else {
      entries.push({ command, count: 1, lastUsed: now });
    }
    all[key] = rankHistory(entries).slice(0, SHELL_HISTORY_MAX);
    await atomicWrite(file, JSON.stringify(all, null, 2));
  });
}

type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

async function packageManager(cwd: string): Promise<PackageManager> {
  if (await exists(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(path.join(cwd, "yarn.lock"))) return "yarn";
  if ((await exists(path.join(cwd, "bun.lockb"))) || (await exists(path.join(cwd, "bun.lock")))) {
    return "bun";
  }
  return "npm";
}

/** Scripts people check with most often come first. */
const SCRIPT_ORDER = ["test", "build", "lint", "check", "typecheck", "format"];
/** Servers and watchers never finish, so they make poor one-shot suggestions. */
const LONG_RUNNING = /^(dev|start|serve|preview|watch)(:|$)|:watch$/;

export function scriptCommands(scripts: Record<string, unknown>, pm: PackageManager): string[] {
  const names = Object.keys(scripts).filter(
    (name) => typeof scripts[name] === "string" && !LONG_RUNNING.test(name),
  );
  const rank = (name: string): number => {
    const i = SCRIPT_ORDER.indexOf(name);
    return i === -1 ? SCRIPT_ORDER.length : i;
  };
  names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return names.slice(0, 6).map((name) => {
    if (pm === "npm") return name === "test" ? "npm test" : `npm run ${name}`;
    return `${pm} ${name}`;
  });
}

/** Commands that fit this project, best first. */
export async function projectShellSuggestions(cwd: string): Promise<ShellSuggestion[]> {
  const out: ShellSuggestion[] = [];
  const add = (source: string, commands: readonly string[]): void => {
    for (const command of commands) out.push({ command, count: 0, source });
  };
  if (await exists(path.join(cwd, ".git"))) {
    add("git", ["git status", "git diff", "git log --oneline -10"]);
  }
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf-8")) as {
      scripts?: unknown;
    };
    if (pkg.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts)) {
      add(
        "package.json",
        scriptCommands(pkg.scripts as Record<string, unknown>, await packageManager(cwd)),
      );
    }
  } catch {
    // No package.json, or one that doesn't parse: nothing to suggest from it.
  }
  if (await exists(path.join(cwd, "Cargo.toml"))) {
    add("Cargo.toml", ["cargo check", "cargo test", "cargo build"]);
  }
  if (await exists(path.join(cwd, "go.mod"))) add("go.mod", ["go test ./...", "go build ./..."]);
  if (await exists(path.join(cwd, "Makefile"))) add("Makefile", ["make"]);
  if (out.length === 0) add("folder", ["ls -la"]);
  return out;
}

/** History first (most used), then project commands not already in it. */
export function mergeShellSuggestions(
  history: readonly HistoryEntry[],
  project: readonly ShellSuggestion[],
): ShellSuggestion[] {
  const seen = new Set<string>();
  const out: ShellSuggestion[] = [];
  for (const item of [
    ...history.map((h) => ({ command: h.command, count: h.count })),
    ...project,
  ]) {
    if (seen.has(item.command) || item.command.length > SUGGESTED_COMMAND_MAX) continue;
    seen.add(item.command);
    out.push(item);
  }
  return out;
}

export async function shellSuggestions(cwd: string): Promise<ShellSuggestion[]> {
  const [history, project] = await Promise.all([
    loadShellHistory(cwd).catch(() => []),
    projectShellSuggestions(cwd).catch(() => []),
  ]);
  return mergeShellSuggestions(history, project);
}
