import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AskQuestion, AskUserResult } from "./ask-user.js";
import { encodeCwd } from "./encode-cwd.js";
import { atomicWrite } from "./session-storage.js";

/**
 * Goals: a long-running objective the user hands to GG Coder ("Bring p95
 * latency under 200 ms across the whole API"). Each goal is its own folder under
 * `~/.gg/goals/<id>/` holding `goal.json`; that folder is also the goal's
 * workspace (the coordinator session's cwd) and, later, its shared library.
 * Context folders and files the user attaches live elsewhere on disk and are
 * referenced by absolute path.
 */

export const GOAL_FILE = "goal.json";

/** New names stay short enough to read at a glance in the goal list. */
export const GOAL_NAME_MAX = 15;
/** Stored names may be longer (created before the limit); still bounded. */
const GOAL_NAME_STORED_MAX = 80;
export const GOAL_TEXT_MAX = 2000;
export const GOAL_CONTEXT_MAX = 20;
/** Standing instructions the user gives a goal (rules that hold throughout). */
export const GOAL_INSTRUCTIONS_MAX = 4000;
/** The goal's memory file in its folder: decisions and preferences learned along the way. */
export const GOAL_MEMORY_FILE = "MEMORY.md";
/** How much of the memory file is loaded into GG Goals' brief. */
export const GOAL_MEMORY_MAX = 16_000;

const contextItemSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(["folder", "file"]),
});

const goalRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1).max(GOAL_NAME_STORED_MAX),
  goal: z.string().min(1).max(GOAL_TEXT_MAX),
  context: z.array(contextItemSchema).max(GOAL_CONTEXT_MAX),
  createdAt: z.string(),
  /** When the coordinator's first, automatic reply was started. Set once. */
  kickoffAt: z.string().optional(),
  /** When the user chose to start the goal (briefing over, work begins). Set once. */
  startedAt: z.string().optional(),
  /** The model GG Goals' workers ("critters") run on; absent: GG Goals' own. */
  critterModel: z.object({ provider: z.string().min(1), model: z.string().min(1) }).optional(),
  /** Standing instructions: rules for the whole goal ("don't touch CI"). */
  instructions: z.string().max(GOAL_INSTRUCTIONS_MAX).optional(),
  /** Paused by the user: GG Goals stops at the next safe point and doesn't carry on by itself. */
  pausedAt: z.string().optional(),
});

/** What the app sends to create a goal. Context kinds are re-derived on disk. */
export const createGoalInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the goal a name")
    .max(GOAL_NAME_MAX, `Keep the name to ${GOAL_NAME_MAX} characters`),
  goal: z.string().trim().min(1, "Describe the goal").max(GOAL_TEXT_MAX),
  context: z.array(z.string().min(1)).max(GOAL_CONTEXT_MAX).default([]),
  instructions: z
    .string()
    .trim()
    .max(GOAL_INSTRUCTIONS_MAX, `Keep instructions to ${GOAL_INSTRUCTIONS_MAX} characters`)
    .optional(),
});

/** What the app sends to change a goal's context or instructions after it's created. */
export const updateGoalInputSchema = z.object({
  context: z.array(z.string().min(1)).max(GOAL_CONTEXT_MAX).optional(),
  instructions: z
    .string()
    .trim()
    .max(GOAL_INSTRUCTIONS_MAX, `Keep instructions to ${GOAL_INSTRUCTIONS_MAX} characters`)
    .optional(),
});
export type UpdateGoalInput = z.input<typeof updateGoalInputSchema>;

export type GoalContextItem = z.infer<typeof contextItemSchema>;
export type GoalRecord = z.infer<typeof goalRecordSchema>;
export type CreateGoalInput = z.input<typeof createGoalInputSchema>;

export type GoalResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Folder that holds every goal. */
export function goalsRoot(agentDir: string): string {
  return path.join(agentDir, "goals");
}

/** Lowercase dashed folder name; empty when the name has no usable characters. */
export function goalSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

/** True when `dir` is exactly one goal folder directly inside `root`. */
export function isGoalDir(root: string, dir: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(dir));
  return (
    relative !== "" &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative) &&
    !relative.includes(path.sep)
  );
}

/** True when `target` is `root` or anything beneath it. */
export function isInsideGoalsRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Read and validate one goal folder's record; null when absent or invalid. */
export async function readGoal(dir: string): Promise<GoalRecord | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, GOAL_FILE), "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = goalRecordSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

// A goal's record is read, changed and written back; two changes at once (the
// start and a pause, say) would each write a copy missing the other's change.
// One daemon process serves every window, so a per-goal queue covers it.
const goalWrites = new Map<string, Promise<unknown>>();

function withGoalLock<T>(dir: string, change: () => Promise<T>): Promise<T> {
  const next = (goalWrites.get(dir) ?? Promise.resolve()).catch(() => {}).then(change);
  goalWrites.set(dir, next);
  void next
    .catch(() => {})
    .finally(() => {
      if (goalWrites.get(dir) === next) goalWrites.delete(dir);
    });
  return next;
}

// A unique temp name per write (two goal writes at once used to share one), and
// Windows' replace retries: a failed write left the goal stuck in its briefing.
async function writeGoal(dir: string, record: GoalRecord): Promise<void> {
  await atomicWrite(path.join(dir, GOAL_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Resolve the user's context picks to absolute, existing paths. Kinds come
 * from the filesystem, never from the client. Duplicates collapse; order is
 * kept so the list reads the way the user built it.
 */
async function resolveContext(paths: readonly string[]): Promise<GoalResult<GoalContextItem[]>> {
  const items: GoalContextItem[] = [];
  const seen = new Set<string>();
  for (const entry of paths) {
    if (!path.isAbsolute(entry)) return { ok: false, error: `Not an absolute path: ${entry}` };
    const resolved = path.resolve(entry);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(resolved);
    } catch {
      return { ok: false, error: `Not found: ${resolved}` };
    }
    if (stat.isDirectory()) items.push({ path: resolved, kind: "folder" });
    else if (stat.isFile()) items.push({ path: resolved, kind: "file" });
    else return { ok: false, error: `Not a file or folder: ${resolved}` };
  }
  return { ok: true, value: items };
}

/**
 * Create a goal folder and its record. The folder name is the slug, suffixed
 * `-2`, `-3`… when taken; `mkdir` without `recursive` makes the claim atomic.
 */
export async function createGoal(
  root: string,
  input: CreateGoalInput,
  now: Date,
): Promise<GoalResult<{ dir: string; record: GoalRecord }>> {
  const parsed = createGoalInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid goal" };
  }
  const { name, goal, context, instructions } = parsed.data;
  const resolved = await resolveContext(context);
  if (!resolved.ok) return resolved;

  const base = goalSlug(name) || "goal";
  await fs.mkdir(root, { recursive: true });
  for (let attempt = 1; attempt <= 100; attempt++) {
    const id = attempt === 1 ? base : `${base}-${attempt}`;
    const dir = path.join(root, id);
    try {
      await fs.mkdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    const record: GoalRecord = {
      schemaVersion: 1,
      id,
      name,
      goal,
      context: resolved.value,
      createdAt: now.toISOString(),
      ...(instructions ? { instructions } : {}),
    };
    await writeGoal(dir, record);
    return { ok: true, value: { dir, record } };
  }
  return { ok: false, error: "Too many goals share that name" };
}

/** Every valid goal under `root` with its folder. Unreadable folders are skipped. */
export async function listGoals(root: string): Promise<Array<{ dir: string; record: GoalRecord }>> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }
  const goals: Array<{ dir: string; record: GoalRecord }> = [];
  for (const entry of entries.sort()) {
    const dir = path.join(root, entry);
    const record = await readGoal(dir);
    if (record) goals.push({ dir, record });
  }
  return goals;
}

/**
 * True while a goal still needs GG Goals' automatic first reply: the kickoff
 * was never started and the conversation has no user or assistant message yet.
 * The system prompt is not conversation, so it does not count.
 */
export function goalNeedsKickoff(
  record: GoalRecord,
  messages: ReadonlyArray<{ role: string }>,
): boolean {
  return !record.kickoffAt && !messages.some((m) => m.role !== "system");
}

/** Briefing until the user starts the goal; active from then on. */
export type GoalPhase = "briefing" | "active";

export function goalPhase(record: GoalRecord): GoalPhase {
  return record.startedAt ? "active" : "briefing";
}

/**
 * True when an ask_user result is the user choosing to start the goal. An
 * answer comes back as the option's `value` when it has one, so pass the
 * questions asked: an option labelled GOAL_START_OPTION counts by its value
 * too (live bug: GG Goals gave it the value "start", the answer came back as
 * "start", and the goal never started).
 */
export function isGoalStartAnswer(
  result: AskUserResult,
  questions: ReadonlyArray<AskQuestion> = [],
): boolean {
  if (result.action !== "answer") return false;
  const startValues = new Set(
    questions.flatMap((question) =>
      (question.options ?? [])
        .filter((option) => option.value && isStartLabel(option.label))
        .map((option) => (option.value ?? "").trim().toLowerCase()),
    ),
  );
  // "Start the goal now?" asked as a yes/no question.
  const startConfirms = new Set(
    questions
      .filter((question) => question.kind === "confirm" && isStartLabel(question.question))
      .map((question) => question.id),
  );
  return Object.entries(result.answers).some(([id, answer]) =>
    (Array.isArray(answer) ? answer : [answer]).some((value) => {
      const picked = value.trim().toLowerCase();
      return (
        isStartLabel(value) ||
        startValues.has(picked) ||
        (startConfirms.has(id) && (picked === "yes" || picked === "y"))
      );
    }),
  );
}

/**
 * Whether an option label means "start the goal". Local models decorate the
 * label they were told to use exactly ("Start the goal now (recommended)",
 * "✅ Yes, start the goal now!"), and an exact match left the goal stuck in its
 * briefing however often the user picked it (#133).
 */
function isStartLabel(label: string): boolean {
  const words = label
    .toLowerCase()
    .replace(/\(recommended\)/g, " ")
    .replace(/[^a-z']+/g, " ")
    .trim();
  return (
    /\bstart (the )?goal\b/.test(words) &&
    !/\b(not|don't|dont|hang|wait|later|yet|hold)\b/.test(words)
  );
}

/**
 * True when a message the user typed during the briefing tells GG Goals to
 * start ("Start the goal now", "yes, start the goal"). Small local models
 * often can't show the start card (live run: qwen3 4B wrote the ask_user call
 * as text, then retried a refused write while the user typed "start" twice),
 * so a plain instruction must start the goal too (#133). Questions and
 * conditional or delayed starts don't count.
 */
export function isGoalStartMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 200 || trimmed.endsWith("?")) return false;
  if (/\b(before|after|until|once|when|if|first|tomorrow|unless)\b/i.test(trimmed)) return false;
  return isStartLabel(trimmed);
}

/**
 * Start the goal if `result` is the user choosing to, whether it came back
 * while GG Goals was still waiting on its question or after the question's
 * deadline passed (a late answer). Returns the started record, or null when
 * the answer isn't the start option or the goal had already started.
 */
export async function startGoalOnAnswer(
  dir: string,
  record: GoalRecord,
  result: AskUserResult,
  now: Date,
  questions: ReadonlyArray<AskQuestion> = [],
): Promise<GoalRecord | null> {
  if (record.startedAt || !isGoalStartAnswer(result, questions)) return null;
  return markGoalStarted(dir, now);
}

/**
 * Pin the model the goal's workers run on, or clear it (null) so they follow
 * GG Goals' model. Returns the updated record; null when the goal is gone.
 */
export async function setGoalCritterModel(
  dir: string,
  pick: { provider: string; model: string } | null,
): Promise<GoalRecord | null> {
  return withGoalLock(dir, async () => {
    const record = await readGoal(dir);
    if (!record) return null;
    const { critterModel: _previous, ...rest } = record;
    const next: GoalRecord = pick ? { ...rest, critterModel: { ...pick } } : rest;
    await writeGoal(dir, next);
    return next;
  });
}

/**
 * Record that the user started the goal. Returns the updated record, or null
 * when it had already started (or the goal is gone), so it is set only once.
 */
export async function markGoalStarted(dir: string, now: Date): Promise<GoalRecord | null> {
  return withGoalLock(dir, async () => {
    const record = await readGoal(dir);
    if (!record || record.startedAt) return null;
    const next: GoalRecord = { ...record, startedAt: now.toISOString() };
    await writeGoal(dir, next);
    return next;
  });
}

/**
 * Change a goal's attached context or standing instructions. Paths are
 * re-resolved on disk like at creation; an empty instructions string clears
 * them. Takes effect for the goal's next session (GG Goals' brief is fixed
 * for a session, so its prompt cache holds).
 */
export async function updateGoal(
  dir: string,
  input: UpdateGoalInput,
): Promise<GoalResult<GoalRecord>> {
  const parsed = updateGoalInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid change" };
  }
  return withGoalLock(dir, async (): Promise<GoalResult<GoalRecord>> => {
    const record = await readGoal(dir);
    if (!record) return { ok: false, error: "Goal not found" };
    let next: GoalRecord = record;
    if (parsed.data.context) {
      const resolved = await resolveContext(parsed.data.context);
      if (!resolved.ok) return resolved;
      next = { ...next, context: resolved.value };
    }
    if (parsed.data.instructions !== undefined) {
      const { instructions: _old, ...rest } = next;
      next = parsed.data.instructions ? { ...rest, instructions: parsed.data.instructions } : rest;
    }
    await writeGoal(dir, next);
    return { ok: true, value: next };
  });
}

/** Pause a goal (true) or let it carry on (false). Returns the updated record, or null if missing. */
export async function setGoalPaused(
  dir: string,
  paused: boolean,
  now: Date,
): Promise<GoalRecord | null> {
  return withGoalLock(dir, async () => {
    const record = await readGoal(dir);
    if (!record) return null;
    const { pausedAt: _was, ...rest } = record;
    const next: GoalRecord = paused ? { ...rest, pausedAt: now.toISOString() } : rest;
    await writeGoal(dir, next);
    return next;
  });
}

/**
 * The goal's memory: what GG Goals has written down in its folder's
 * MEMORY.md (decisions, the user's preferences and corrections, what's done
 * and what's left). Empty when there's none yet. Long files are cut to
 * GOAL_MEMORY_MAX, with a note, so the brief stays bounded.
 */
export async function readGoalMemory(dir: string): Promise<string> {
  let text: string;
  try {
    text = await fs.readFile(path.join(dir, GOAL_MEMORY_FILE), "utf-8");
  } catch {
    return "";
  }
  const trimmed = text.trim();
  if (trimmed.length <= GOAL_MEMORY_MAX) return trimmed;
  return `${trimmed.slice(0, GOAL_MEMORY_MAX)}\n\n(Memory cut at ${GOAL_MEMORY_MAX} characters: keep ${GOAL_MEMORY_FILE} short, folding old entries into a summary.)`;
}

/**
 * Delete one goal: its folder (record, notes, artifacts) and the coordinator
 * sessions stored for it. Attached context lives elsewhere and is untouched.
 * `id` must name a direct child of `root`; anything else is refused.
 */
export async function deleteGoal(
  root: string,
  sessionsDir: string,
  id: string,
): Promise<GoalResult<{ dir: string }>> {
  const dir = path.join(root, id);
  if (!id || id !== path.basename(id) || !isGoalDir(root, dir)) {
    return { ok: false, error: "Unknown goal" };
  }
  if (!(await readGoal(dir))) return { ok: false, error: "Unknown goal" };
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(path.join(sessionsDir, encodeCwd(dir)), { recursive: true, force: true });
  return { ok: true, value: { dir } };
}

/**
 * Record that the coordinator's first reply has started. Returns null when it
 * already had (or the goal is gone), so a second caller never kicks off twice.
 */
export async function markGoalKickoff(dir: string, now: Date): Promise<GoalRecord | null> {
  return withGoalLock(dir, async () => {
    const record = await readGoal(dir);
    if (!record || record.kickoffAt) return null;
    const next: GoalRecord = { ...record, kickoffAt: now.toISOString() };
    await writeGoal(dir, next);
    return next;
  });
}

/** The two answers to the coordinator's "ready to start?" question. */
export const GOAL_START_OPTION = "Start the goal now";
export const GOAL_HOLD_OPTION = "Hang on, I want to discuss it more";

/**
 * The coordinator's standing brief, appended to the system prompt of a session
 * whose cwd is a goal folder. Static for the goal's lifetime.
 */
/** What GG Goals' brief carries besides the goal itself, read once per session. */
export interface GoalBriefExtras {
  /** The goal folder's MEMORY.md (see readGoalMemory); empty when there's none. */
  memory?: string;
  /** Each attached folder's instruction files (AGENTS.md, CLAUDE.md…), by folder. */
  projectRules?: ReadonlyArray<{ readonly folder: string; readonly rules: readonly string[] }>;
}

export function renderGoalPrompt(
  dir: string,
  record: GoalRecord,
  extras: GoalBriefExtras = {},
): string {
  const context =
    record.context.length > 0
      ? record.context.map((item) => `- ${item.kind}: ${item.path}`).join("\n")
      : "- (none attached yet)";
  const rules = (extras.projectRules ?? []).filter((entry) => entry.rules.length > 0);
  const memoryPath = path.join(dir, GOAL_MEMORY_FILE);
  return [
    "# Goal",
    "",
    `You are coordinating the goal "${record.name}". It is an ongoing piece of work that spans many sessions, not a single task.`,
    "",
    "Goal:",
    record.goal,
    "",
    "Context the user attached (folders are in your workspace and every worker's; read files by path and name them in the briefs of workers that need them):",
    context,
    "",
    `Goal folder (shared notes and artifacts for this goal): ${dir}`,
    "Your own commands start in the goal folder, not in an attached one: run a project's checks from its folder (`cd <attached folder> && npm test`).",
    "",
    ...(record.instructions
      ? [
          "## Standing instructions from the user",
          "They hold for the whole goal and override your own defaults.",
          record.instructions,
          "",
        ]
      : []),
    ...rules.flatMap((entry) => [
      `## Project rules: ${entry.folder}`,
      "The instruction files of an attached project (nearest last). Follow them when you work there, and give a worker the parts that apply to its task.",
      ...entry.rules,
      "",
    ]),
    "## Goal memory",
    `Your memory for this goal lives in ${memoryPath}. It's loaded here at the start of every session, so it's how you remember across sessions and app restarts.`,
    extras.memory ? `Current memory:\n${extras.memory}` : "Nothing written yet.",
    "- Write to it (create it the first time) when you learn something that should hold " +
      "for the rest of the goal: a decision, the user's preferences and corrections, what " +
      "is done and what is left. Update it in place; keep it short and current, not a log.",
    "- Give a worker the parts of it that bear on its task in its brief.",
    "",
    "## Before the goal starts",
    "A goal begins with a short briefing, not with work. Until the user has chosen " +
      `"${GOAL_START_OPTION}", do not edit files, run builds, install anything or start ` +
      "tasks. Reading the context to understand it is fine.",
    "- Your first reply opens with a written message, before any tool call: greet the " +
      "user warmly in a line, then acknowledge the goal in your own words so they can " +
      "see you understood it. Questions come after that, never first.",
    "- Look at the attached context and say briefly what you found that matters.",
    "- Once the goal starts the user may walk away until it's done, so ask now for " +
      "everything the work will need from them: choices only they can make, preferences " +
      "that change the result, access or credentials. Questions after the start should be " +
      "rare.",
    "- Ask only what changes the outcome and that you can't find out yourself. Decide " +
      "small details yourself (formatting, file names, wording, sensible defaults) and say " +
      "them in your plan instead of asking. If nothing is unclear, ask nothing but the " +
      "start question.",
    "- Then say in two or three lines how you would approach it, and ask with one " +
      "`ask_user` call: your questions first (choices where you can), then last, whether " +
      `to start (kind \`choice\`), with exactly these option labels and no custom values: ` +
      `"${GOAL_START_OPTION}" (recommended) and "${GOAL_HOLD_OPTION}". One card, so the ` +
      "user answers once. Only if an answer could change the plan a lot, ask those first " +
      "and the start question after.",
    "- If they want to discuss more, keep talking it through and ask the same question " +
      "again when it is settled.",
    "",
    "## Once the goal has started",
    "Start the work right after the user starts the goal. Do it yourself unless it " +
      "splits into big independent parts; for those, start their workers together in one " +
      "spawn_agent call (cwd: the attached folder each one works in) and handle each as " +
      'soon as it reports (wait_agent, condition "any"). Keep the user informed about ' +
      "what is happening and what needs them.",
    "- When the work is done, write what was done and what's left to your memory.",
  ].join("\n");
}

/** What GG Goals is told when the user changes the goal's settings mid-session. */
export function goalSettingsNote(record: GoalRecord): string {
  const context =
    record.context.length > 0
      ? record.context.map((item) => `- ${item.kind}: ${item.path}`).join("\n")
      : "- (none)";
  return [
    "The user changed this goal's settings. These replace what your brief says:",
    `Standing instructions: ${record.instructions ?? "(none)"}`,
    "Attached context:",
    context,
  ].join("\n");
}

/**
 * Whether a started goal was cut off mid-work and should pick itself back up
 * when its session opens again: it isn't paused, and either a worker was
 * interrupted by the restart or GG Goals' own last turn never finished (its
 * last message is a tool call, or a tool result or message with no reply
 * after it).
 */
export function goalWasInterrupted(
  record: GoalRecord,
  messages: ReadonlyArray<{ role: string; content?: unknown }>,
  workers: ReadonlyArray<{ state: string; recovered?: boolean }>,
): boolean {
  if (record.pausedAt) return false;
  // Still briefing: only its first reply can be cut off (the window closed
  // or switched away mid-question), which leaves the user with no question
  // to answer and the goal stuck. Started: anything mid-work counts too.
  if (!record.startedAt && !record.kickoffAt) return false;
  if (workers.some((w) => w.recovered && w.state === "interrupted")) return true;
  const last = [...messages].reverse().find((m) => m.role !== "system");
  if (!last) return false;
  // A tool result or a message with no reply after it: the turn never finished.
  if (last.role === "tool" || last.role === "user") return true;
  if (last.role !== "assistant" || !Array.isArray(last.content)) return false;
  return last.content.some(
    (part: unknown) =>
      typeof part === "object" && part !== null && (part as { type?: string }).type === "tool_call",
  );
}

/**
 * The note behind GG Goals' first run after the goal was interrupted (the
 * app closed or crashed mid-work): workers don't survive a restart, so it
 * checks what got done and carries on with the rest. Cut off mid-briefing,
 * it asks its question again instead.
 */
export function goalResumePrompt(record: GoalRecord): string {
  if (!record.startedAt) {
    return [
      `The briefing for the goal "${record.name}" was cut off before the user could ` +
        "answer your question.",
      "Ask it again now, in one ask_user card: what you still need (if anything) and " +
        "whether to start. Don't repeat your greeting or what you already found; one short " +
        "line before the card is enough.",
    ].join("\n");
  }
  return [
    `The app was closed while you were working on the goal "${record.name}", so any ` +
      "workers you had running were stopped.",
    "Pick it up where it left off: check what is already done (your memory, the files " +
      "themselves, and this conversation), then carry on with what's left, the same way " +
      "as before. Don't redo finished work, and don't ask the user anything you could " +
      "check yourself. Start with one short line saying you're picking it back up.",
  ].join("\n");
}

/** The hidden instruction behind the coordinator's first, automatic reply. */
export function goalKickoffPrompt(record: GoalRecord): string {
  return [
    `The user just created the goal "${record.name}" and opened it for the first time.`,
    "Start the briefing described in your Goal instructions, in this order:",
    "1. Before any tool call, write a short message: greet the user, then say the goal " +
      "back in your own words.",
    "2. Look through the attached context if there is any, with read, ls and find only " +
      "(bash, edit and write stay locked until the user starts the goal), and say briefly " +
      "what matters in it.",
    "3. Say how you'd approach it, and in one ask_user card ask what you still need " +
      "(if anything) and whether to start.",
    "Do not start the work itself in this reply.",
  ].join("\n");
}
