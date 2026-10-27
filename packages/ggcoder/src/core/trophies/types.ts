// Trophies: shared types for the catalog, the pure engine, the store and the
// snapshot the app renders.

export type TrophyTier = "bronze" | "silver" | "gold" | "platinum";

export type TrophyCategory =
  "start" | "flow" | "power" | "goals" | "modes" | "ship" | "habit" | "secret";

/** Things the sidecar counts as they happen. */
export const TROPHY_COUNTERS = [
  "slashCommands",
  "customCommands",
  "enhancedSends",
  "attachments",
  "fileMentions",
  "steers",
  "newSessions",
  "modelSwitches",
  "thinkingChanges",
  "plansApproved",
  "kenQuestions",
  "questionsAnswered",
  "autopilotReviews",
  "tasksRun",
  "mcpRuns",
  "localRuns",
  "webRuns",
  "subagentRuns",
  "backgroundRuns",
  "skillRuns",
  "addDirs",
  "exports",
  "goalsStarted",
  "goalWorkers",
  "chatRuns",
  "motionRuns",
  "nightRuns",
  "longRuns",
  // Added with the 100-trophy catalog.
  "scheduledRuns",
  "compactions",
  "pushes",
  "pullRequests",
  "screenshots",
  "debugRuns",
  "uiComponents",
  "remoteStarts",
  "telegramSetups",
  "mcpServersAdded",
  "modelsPulled",
  "localEndpoints",
  "transcriptImports",
  "radioPlays",
  "goalPauses",
  "kenPins",
  "queueCancels",
  "processKills",
  "cancels",
  "memoriesSaved",
  "soulNotes",
  "checklistRecords",
  "filesTouched",
  "bigRuns",
  "earlyRuns",
  "weekendRuns",
  "autopilotOn",
  "handoffs",
] as const;
export type TrophyCounter = (typeof TROPHY_COUNTERS)[number];

/** Distinct things the sidecar remembers (models used, tools seen, …). */
export const TROPHY_SETS = [
  "slashCommandNames",
  "modelsUsed",
  "toolsUsed",
  "chatAgents",
  "skillsUsed",
  "providersUsed",
  "radioStations",
  "checklistItems",
  /** Projects worked in, as short hashes of their paths. */
  "projects",
] as const;
export type TrophySet = (typeof TROPHY_SETS)[number];

/**
 * Totals read from the XP/rank progress file rather than counted twice.
 * Trophies count only what happens after they began: each stat is measured
 * from the baseline taken when the trophies file was created.
 */
export type TrophyProgressStat = "prompts" | "commits" | "linesShipped" | "level";

export type TrophyStat =
  | { kind: "count"; key: TrophyCounter }
  | { kind: "distinct"; key: TrophySet }
  | { kind: "progress"; key: TrophyProgressStat }
  /** Best run of consecutive days with a finished run, since trophies began. */
  | { kind: "streak" }
  /** How many other trophies are earned. */
  | { kind: "earned" };

export interface TrophyDef {
  id: string;
  title: string;
  tier: TrophyTier;
  category: TrophyCategory;
  /** What the trophy marks, and what the feature behind it does. */
  description: string;
  /** How to earn it, in plain words. */
  hint: string;
  stat: TrophyStat;
  /** The stat value that earns it. */
  goal: number;
  /** Hidden until earned: the title, description and hint stay secret. */
  secret?: boolean;
}

/** The facts the progress file contributes. */
export interface TrophyProgressFacts {
  prompts: number;
  commits: number;
  linesShipped: number;
  level: number;
}

/** A change to record: counters to add to, and members to add to sets. */
export interface TrophyDelta {
  count?: Partial<Record<TrophyCounter, number>>;
  add?: Partial<Record<TrophySet, readonly string[]>>;
  /** Local date (YYYY-MM-DD) of a finished run, for the day streak. */
  activeDay?: string;
}

/** Consecutive days with a finished run. */
export interface TrophyStreak {
  /** Last local date (YYYY-MM-DD) with a finished run, or null. */
  last: string | null;
  current: number;
  best: number;
}

/** The last recorded unlock, so every window celebrates it exactly once. */
export interface TrophyLastEvent {
  nonce: string;
  unlocked: string[];
}

/** Durable trophies file (~/.gg/trophies.json). */
export interface TrophyFile {
  /** 1 was a pre-release format that credited past XP; it's discarded on load. */
  v: 2;
  createdAt: string;
  /** XP totals when trophies began; progress stats count from here. */
  baseline: TrophyProgressFacts | null;
  streak: TrophyStreak;
  counters: Partial<Record<TrophyCounter, number>>;
  sets: Partial<Record<TrophySet, string[]>>;
  /** Trophy id to the ISO time it was earned. */
  unlocked: Record<string, string>;
  lastEvent: TrophyLastEvent | null;
}

/** One trophy as the app shows it. Secret, unearned trophies arrive redacted. */
export interface TrophyView {
  id: string;
  title: string;
  tier: TrophyTier;
  category: TrophyCategory;
  description: string;
  hint: string;
  goal: number;
  /** Progress toward `goal`, capped at `goal`. */
  current: number;
  /** ISO time it was earned, or null. */
  unlockedAt: string | null;
  secret: boolean;
}

export interface TrophyCategoryView {
  id: TrophyCategory;
  label: string;
}

/** What the sidecar serves and broadcasts; the app renders it as is. */
export interface TrophySnapshot {
  trophies: TrophyView[];
  categories: TrophyCategoryView[];
  earned: number;
  total: number;
  /** Ids earned by the event this snapshot was produced by (empty otherwise). */
  unlocked: string[];
  /** Nonce of that event, for celebration dedupe. */
  eventNonce: string | null;
  /** True only on the frame sent to the window whose action earned them. */
  origin?: boolean;
}
