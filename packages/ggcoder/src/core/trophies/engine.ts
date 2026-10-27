// Pure trophy engine: record what happened, decide what it unlocks, and build
// the snapshot the app shows. No I/O here; the store persists the file.

import { TROPHIES, TROPHY_CATEGORIES } from "./catalog.js";
import {
  TROPHY_COUNTERS,
  TROPHY_SETS,
  type TrophyDef,
  type TrophyDelta,
  type TrophyFile,
  type TrophyProgressFacts,
  type TrophySet,
  type TrophySnapshot,
  type TrophyView,
} from "./types.js";

/** Each set stays bounded however long someone uses the app. */
const SET_CAP: Readonly<Record<TrophySet, number>> = {
  slashCommandNames: 64,
  modelsUsed: 64,
  toolsUsed: 128,
  chatAgents: 8,
  skillsUsed: 64,
  providersUsed: 32,
  radioStations: 32,
  checklistItems: 64,
  projects: 128,
};

const COUNTER_KEYS: ReadonlySet<string> = new Set(TROPHY_COUNTERS);
const SET_KEYS: ReadonlySet<string> = new Set(TROPHY_SETS);

export const EMPTY_PROGRESS_FACTS: TrophyProgressFacts = {
  prompts: 0,
  commits: 0,
  linesShipped: 0,
  level: 1,
};

/** A date as local YYYY-MM-DD, the day-streak's unit. */
export function localTrophyDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Whole days from one local YYYY-MM-DD date to another (NaN if malformed). */
function daysBetween(from: string, to: string): number {
  const parse = (d: string): number => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : Number.NaN;
  };
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}

/** Count a day with a finished run toward the streak. */
function applyActiveDay(file: TrophyFile, day: string): void {
  const { streak } = file;
  if (streak.last === day) return;
  const gap = streak.last ? daysBetween(streak.last, day) : Number.NaN;
  // A clock moved backwards (gap < 0) leaves the streak alone.
  if (gap < 0) return;
  streak.current = gap === 1 ? streak.current + 1 : 1;
  streak.last = day;
  streak.best = Math.max(streak.best, streak.current);
}

/** Add a delta to the file's counters and sets. Unknown keys are ignored. */
export function applyDelta(file: TrophyFile, delta: TrophyDelta): void {
  for (const [key, by] of Object.entries(delta.count ?? {})) {
    if (!COUNTER_KEYS.has(key) || typeof by !== "number" || !Number.isFinite(by) || by <= 0) {
      continue;
    }
    const k = key as keyof TrophyFile["counters"];
    file.counters[k] = (file.counters[k] ?? 0) + Math.floor(by);
  }
  for (const [key, members] of Object.entries(delta.add ?? {})) {
    if (!SET_KEYS.has(key) || !Array.isArray(members)) continue;
    const k = key as TrophySet;
    const current = file.sets[k] ?? [];
    for (const member of members) {
      if (typeof member !== "string" || member.length === 0 || member.length > 200) continue;
      if (current.length >= SET_CAP[k]) break;
      if (!current.includes(member)) current.push(member);
    }
    file.sets[k] = current;
  }
  if (typeof delta.activeDay === "string") applyActiveDay(file, delta.activeDay);
}

function statValue(def: TrophyDef, file: TrophyFile, facts: TrophyProgressFacts): number {
  switch (def.stat.kind) {
    case "count":
      return file.counters[def.stat.key] ?? 0;
    case "distinct":
      return file.sets[def.stat.key]?.length ?? 0;
    case "progress": {
      // Only what happened since trophies began; no baseline yet means nothing has.
      const base = file.baseline?.[def.stat.key];
      return base === undefined ? 0 : Math.max(0, facts[def.stat.key] - base);
    }
    case "streak":
      return file.streak.best;
    case "earned":
      return Object.keys(file.unlocked).filter((id) => id !== def.id).length;
  }
}

/**
 * Mark every trophy whose goal is now met. Returns the ids newly earned, in
 * catalog order. Repeats until nothing changes, since earning trophies can
 * earn the ones that count trophies.
 */
export function evaluateTrophies(
  file: TrophyFile,
  facts: TrophyProgressFacts,
  now: Date,
): string[] {
  const earned: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const def of TROPHIES) {
      if (file.unlocked[def.id]) continue;
      if (statValue(def, file, facts) >= def.goal) {
        file.unlocked[def.id] = now.toISOString();
        earned.push(def.id);
        changed = true;
      }
    }
  }
  return earned;
}

export function buildTrophySnapshot(
  file: TrophyFile,
  facts: TrophyProgressFacts,
  event: { unlocked: string[]; nonce: string | null } = { unlocked: [], nonce: null },
): TrophySnapshot {
  const trophies: TrophyView[] = TROPHIES.map((def) => {
    const unlockedAt = file.unlocked[def.id] ?? null;
    const current = Math.min(def.goal, Math.max(0, statValue(def, file, facts)));
    // A secret stays secret until it's earned: no title, story or progress.
    if (def.secret && !unlockedAt) {
      return {
        id: def.id,
        title: "Secret trophy",
        tier: def.tier,
        category: def.category,
        description: "",
        hint: "Keep exploring. Some trophies are a surprise.",
        goal: 1,
        current: 0,
        unlockedAt: null,
        secret: true,
      };
    }
    return {
      id: def.id,
      title: def.title,
      tier: def.tier,
      category: def.category,
      description: def.description,
      hint: def.hint,
      goal: def.goal,
      current: unlockedAt ? def.goal : current,
      unlockedAt,
      secret: def.secret === true,
    };
  });
  return {
    trophies,
    categories: [...TROPHY_CATEGORIES],
    earned: trophies.filter((t) => t.unlockedAt !== null).length,
    total: trophies.length,
    unlocked: event.unlocked,
    eventNonce: event.nonce,
  };
}

// ── Translating what happened into counters ─────────────────────────────

const WEB_TOOLS = new Set(["web_search", "web_fetch"]);
const HELPER_TOOLS = new Set(["spawn_agent", "subagent"]);
const BACKGROUND_TOOLS = new Set(["task_output", "task_stop", "task_send"]);
const MEMORY_TOOLS = new Set(["remember", "update_memory"]);
const SOUL_TOOLS = new Set(["set_jiwa", "update_jiwa"]);
/** A run of 30 minutes or more is a marathon. */
export const LONG_RUN_MS = 30 * 60 * 1000;
/** A run that touches this many files is a big change. */
export const BIG_RUN_FILES = 10;

/** One tool call: its name and, when known, its arguments. */
export interface TrophyToolCall {
  name: string;
  args?: Record<string, unknown>;
}

/** One finished, successful run, as the sidecar saw it. */
export interface TrophyRunFacts {
  mode: "code" | "chat" | "motion";
  /** Set in chat windows. */
  chatAgent?: string;
  /** True when the window is a Goal. */
  goal: boolean;
  provider: string;
  model: string;
  /** Every tool call the run made, in order, repeats included. */
  tools: readonly TrophyToolCall[];
  durationMs: number;
  /** Local hour (0-23) the run finished in. */
  hour: number;
  /** Local day of the week (0 Sunday … 6 Saturday). */
  day: number;
  /** Local date (YYYY-MM-DD) the run finished on. */
  date: string;
  /** A short hash of the project's path. */
  project: string;
}

/** MCP tools are named `mcp__<server>__<tool>`; one server counts once. */
function toolFamily(name: string): string {
  if (name.startsWith("mcp__")) {
    const server = name.slice(5).split("__")[0];
    return server ? `mcp__${server}` : "mcp";
  }
  return name;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Files a write or edit call touched (edit takes `file_path` or a `files` list). */
function touchedFiles(call: TrophyToolCall): string[] {
  if (call.name !== "write" && call.name !== "edit") return [];
  const out: string[] = [];
  const top = str(call.args?.file_path);
  if (top) out.push(top);
  const files = call.args?.files;
  if (Array.isArray(files)) {
    for (const f of files) {
      const p =
        typeof f === "object" && f !== null ? str((f as Record<string, unknown>).file_path) : null;
      if (p) out.push(p);
    }
  }
  return out;
}

/** `git push` anywhere in a shell line (not `git push --dry-run`). */
const GIT_PUSH = /(?:^|[;&|(\s])git\s+(?:-C\s+\S+\s+)?push\b(?![^;&|]*--dry-run)/;
/** `gh pr create` anywhere in a shell line. */
const GH_PR_CREATE = /(?:^|[;&|(\s])gh\s+pr\s+create\b/;

export function runDelta(run: TrophyRunFacts): TrophyDelta {
  const names = run.tools.map((c) => c.name);
  const used = new Set(names);
  const has = (set: ReadonlySet<string>) => names.some((n) => set.has(n));
  const count: NonNullable<TrophyDelta["count"]> = {};
  const bash = run.tools
    .filter((c) => c.name === "bash")
    .map((c) => ({
      command: str(c.args?.command) ?? "",
      background: c.args?.run_in_background === true,
    }));

  if (has(WEB_TOOLS)) count.webRuns = 1;
  if (has(HELPER_TOOLS) && !run.goal) count.subagentRuns = 1;
  if (has(BACKGROUND_TOOLS) || bash.some((b) => b.background)) count.backgroundRuns = 1;
  if (used.has("skill")) count.skillRuns = 1;
  if (names.some((n) => n.startsWith("mcp__"))) count.mcpRuns = 1;
  if (used.has("screenshot")) count.screenshots = 1;
  if (used.has("debug")) count.debugRuns = 1;
  if (used.has("ui_adopt")) count.uiComponents = 1;
  if (has(MEMORY_TOOLS)) count.memoriesSaved = 1;
  if (has(SOUL_TOOLS)) count.soulNotes = 1;
  if (used.has("delegate_to_agent")) count.handoffs = 1;
  if (bash.some((b) => GIT_PUSH.test(b.command))) count.pushes = 1;
  if (bash.some((b) => GH_PR_CREATE.test(b.command))) count.pullRequests = 1;
  if (run.provider === "local") count.localRuns = 1;
  if (run.mode === "chat") count.chatRuns = 1;
  if (run.mode === "motion") count.motionRuns = 1;
  if (run.goal) {
    const workers = names.filter((n) => HELPER_TOOLS.has(n)).length;
    if (workers > 0) count.goalWorkers = workers;
  }
  const records = run.tools.filter((c) => c.name === "checklist" && c.args?.action === "record");
  if (records.length > 0) count.checklistRecords = records.length;
  const files = new Set(run.tools.flatMap(touchedFiles));
  if (files.size > 0) count.filesTouched = files.size;
  if (files.size >= BIG_RUN_FILES) count.bigRuns = 1;
  if (run.hour >= 0 && run.hour < 5) count.nightRuns = 1;
  if (run.hour >= 5 && run.hour < 7) count.earlyRuns = 1;
  if (run.day === 0 || run.day === 6) count.weekendRuns = 1;
  if (run.durationMs >= LONG_RUN_MS) count.longRuns = 1;

  const add: NonNullable<TrophyDelta["add"]> = {
    toolsUsed: [...new Set(names.map(toolFamily))].sort(),
  };
  if (run.model) add.modelsUsed = [`${run.provider}/${run.model}`];
  if (run.provider) add.providersUsed = [run.provider];
  if (run.project) add.projects = [run.project];
  if (run.mode === "chat" && run.chatAgent) add.chatAgents = [run.chatAgent];
  const skills = run.tools
    .filter((c) => c.name === "skill")
    .map((c) => str(c.args?.skill)?.toLowerCase())
    .filter((v): v is string => !!v);
  if (skills.length > 0) add.skillsUsed = [...new Set(skills)].sort();
  const items = records.map((c) => str(c.args?.id)).filter((v): v is string => !!v);
  if (items.length > 0) add.checklistItems = [...new Set(items)].sort();
  return { count, add, activeDay: run.date };
}

/** What a sent prompt says about how it was written. */
export interface TrophyPromptFacts {
  /** The slash command it ran (`commit` for `/commit …`), if any. */
  command: string | null;
  /** The command is the user's own, from `.gg/commands`. */
  customCommand: boolean;
  /** Sent after Enhance rewrote it. */
  enhanced: boolean;
  attachments: number;
  /** How many `@file` mentions point at real files. */
  fileMentions: number;
  /** Sent while a run was in progress (steering). */
  steer: boolean;
}

export function promptDelta(p: TrophyPromptFacts): TrophyDelta {
  const count: NonNullable<TrophyDelta["count"]> = {};
  const add: NonNullable<TrophyDelta["add"]> = {};
  if (p.command) {
    if (p.command === "add-dir") {
      count.addDirs = 1;
    } else {
      count.slashCommands = 1;
      add.slashCommandNames = [p.command];
      if (p.customCommand) count.customCommands = 1;
    }
  }
  if (p.enhanced) count.enhancedSends = 1;
  if (p.attachments > 0) count.attachments = 1;
  if (p.fileMentions > 0) count.fileMentions = 1;
  if (p.steer) count.steers = 1;
  return { count, add };
}

/** `/name args` → `name` (lowercase), or null for anything else. */
export function slashCommandName(text: string): string | null {
  const match = /^\/([a-z0-9][\w:-]*)/i.exec(text.trim());
  return match?.[1] ? match[1].toLowerCase() : null;
}

/** The heading the app's @-picker uses for the files it attaches to a prompt. */
const REF_HEADING = "Referenced files:";

/**
 * Files a prompt points at: the app's @-picker sends them as a
 * "Referenced files:" list after the text; a typed `@path` counts too.
 * `@Ken` is a person, not a file.
 */
export function mentionedPaths(text: string, limit = 10): string[] {
  const out: string[] = [];
  const push = (p: string): void => {
    if (out.length < limit && p && !out.includes(p)) out.push(p);
  };
  const at = text.lastIndexOf(REF_HEADING);
  if (at === 0 || (at > 0 && text.slice(at - 2, at) === "\n\n")) {
    for (const line of text
      .slice(at + REF_HEADING.length)
      .split("\n")
      .slice(1)) {
      const m = /^- (.+)$/.exec(line);
      if (!m?.[1]) break;
      push(m[1].trim());
    }
  }
  const re = /(?:^|\s)@([\w./-]*[\w-])/g;
  for (let m = re.exec(text); m && out.length < limit; m = re.exec(text)) {
    const token = m[1];
    if (token && token.toLowerCase() !== "ken") push(token);
  }
  return out;
}
