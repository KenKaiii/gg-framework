/** Mirrors ggcoder `core/project-health-score.ts` ProjectHealthCategory. */
export interface ProjectHealthCategory {
  id: "files" | "hygiene" | "safety" | "debt";
  label: string;
  /** 0–100, or null when the category doesn't apply (left out of the total). */
  score: number | null;
  summary: string;
  findings: string[];
  /** Hands this category to the agent; null when there's nothing to fix. */
  fixPrompt: string | null;
}

/** Mirrors ggcoder `core/project-health-score.ts` ProjectHealth. */
export interface ProjectHealth {
  score: number;
  /** Hands every category with findings to the agent; null when clean. */
  fixPrompt: string | null;
  /** Why the score was held down (a committed secret, failing CI); null when it wasn't. */
  cappedBy: string | null;
  categories: ProjectHealthCategory[];
  truncated: boolean;
}

export type ProjectHealthTier = "poor" | "fair" | "healthy";

const CATEGORY_IDS = new Set(["files", "hygiene", "safety", "debt"]);
const MAX_CATEGORIES = 10;
const MAX_FINDINGS = 10;
const MAX_TEXT = 500;
const MAX_PROMPT = 40_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isScore(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;
}
function isText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_TEXT;
}
function isPrompt(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length <= MAX_PROMPT);
}
function isCategory(value: unknown): value is ProjectHealthCategory {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    CATEGORY_IDS.has(value.id) &&
    isText(value.label) &&
    (value.score === null || isScore(value.score)) &&
    isText(value.summary) &&
    Array.isArray(value.findings) &&
    value.findings.length <= MAX_FINDINGS &&
    value.findings.every(isText) &&
    isPrompt(value.fixPrompt)
  );
}

/** Validates the sidecar's `projectHealth` field; anything malformed hides the badge. */
export function parseProjectHealth(value: unknown): ProjectHealth | null {
  if (
    !isRecord(value) ||
    !isScore(value.score) ||
    typeof value.truncated !== "boolean" ||
    !isPrompt(value.fixPrompt) ||
    !(value.cappedBy === null || isText(value.cappedBy)) ||
    !Array.isArray(value.categories) ||
    value.categories.length > MAX_CATEGORIES ||
    !value.categories.every(isCategory)
  ) {
    return null;
  }
  return {
    score: value.score,
    fixPrompt: value.fixPrompt,
    cappedBy: value.cappedBy,
    categories: value.categories,
    truncated: value.truncated,
  };
}

/** Red below 50, orange to 79, green from 80. */
export function projectHealthTier(score: number): ProjectHealthTier {
  if (score < 50) return "poor";
  if (score < 80) return "fair";
  return "healthy";
}

export const PROJECT_HEALTH_TIER_LABELS: Readonly<Record<ProjectHealthTier, string>> = {
  poor: "Needs attention",
  fair: "Getting there",
  healthy: "Healthy",
};
