import { existsSync } from "node:fs";
import path from "node:path";
import type { Message } from "@kenkaiiii/gg-ai";

export interface IdealReviewStats {
  changedLines: number;
  toolCalls: number;
  toolFailures: number;
  turns: number;
  writeCalls: number;
  editCalls: number;
  bashCalls: number;
}

export interface IdealReviewDecision {
  shouldReview: boolean;
  score: number;
  reasons: string[];
}

export interface ReviewCoverageEvidence {
  expected: string[];
  covered: string[];
  missing: string[];
}

/**
 * Harness-owned proof that every successfully changed file was opened with the
 * read tool after Ideal review began. Model-authored claims never enter it.
 */
export class ReviewCoverageTracker {
  private readonly expected = new Set<string>();
  private readonly covered = new Set<string>();
  private active = false;

  constructor(private readonly cwd: string) {}

  reset(): void {
    this.expected.clear();
    this.covered.clear();
    this.active = false;
  }

  /** Successful mutations are retained before and during review. */
  recordChanged(filePath: string): void {
    this.expected.add(this.normalize(filePath));
  }

  /** Start the evidence window; reads observed before this call never count. */
  start(changedFiles: Iterable<string> = []): void {
    for (const filePath of changedFiles) this.recordChanged(filePath);
    this.covered.clear();
    this.active = true;
  }

  /** Called only by the successful read-tool callback. */
  recordRead(filePath: string): void {
    if (!this.active) return;
    const normalized = this.normalize(filePath);
    if (this.expected.has(normalized)) this.covered.add(normalized);
  }

  evidence(): ReviewCoverageEvidence {
    const expected = [...this.expected].sort();
    const covered = expected.filter((filePath) => this.covered.has(filePath));
    const missing = expected.filter((filePath) => !this.covered.has(filePath));
    return {
      expected: expected.map((filePath) => this.display(filePath)),
      covered: covered.map((filePath) => this.display(filePath)),
      missing: missing.map((filePath) => this.display(filePath)),
    };
  }

  private normalize(filePath: string): string {
    return path.normalize(path.resolve(this.cwd, filePath));
  }

  private display(filePath: string): string {
    const relative = path.relative(this.cwd, filePath);
    return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".."
      ? relative
      : filePath;
  }
}

export function buildReviewCoverageMessage(missingFiles: readonly string[]): Message {
  return {
    role: "user",
    content:
      "Ideal review coverage is incomplete. Open every changed file below with the read tool " +
      "before finalizing; model-authored claims do not count as evidence:\n" +
      missingFiles.map((filePath) => `- ${filePath}`).join("\n"),
  };
}

/**
 * Put the harness-owned read checklist on the first Ideal review turn. The
 * fail-closed follow-up remains as a fallback, but compliant reviews can now
 * gather all evidence before emitting their single user-facing final answer.
 */
export function withReviewCoverageRequirements(
  message: Message,
  missingFiles: readonly string[],
): Message {
  if (missingFiles.length === 0) return message;
  const requirement = buildReviewCoverageMessage(missingFiles);
  return {
    role: "user",
    content: `${String(message.content)}\n\n${String(requirement.content)}`,
  };
}

export const IDEAL_REVIEW_PROMPT =
  "Ideal? Review the actual work against the user's request before the final response. " +
  "Is it simple, focused, correct, and aligned? Did you over-edit, leave TODOs, miss an obvious " +
  "case the request called for, or introduce risk? Judge this by reading the code you changed \u2014 " +
  "do NOT run builds, typechecks, linters, or test suites now; that happens at commit time via " +
  "/commit. If anything is wrong, fix it now. If everything is good, respond with the final " +
  "answer only; do not mention this ideal review unless it changed the work.";

const RISKY_TOOL_NAMES = new Set(["bash", "write", "edit"]);

export function evaluateIdealReview(stats: IdealReviewStats): IdealReviewDecision {
  const reasons: string[] = [];
  let score = 0;

  if (stats.changedLines >= 120) {
    score += 2;
    reasons.push(`${stats.changedLines} changed lines`);
  } else if (stats.changedLines >= 60) {
    score += 1;
    reasons.push(`${stats.changedLines} changed lines`);
  }

  if (stats.toolCalls >= 8) {
    score += 1;
    reasons.push(`${stats.toolCalls} tool calls`);
  }

  if (stats.writeCalls + stats.editCalls >= 4) {
    score += 2;
    reasons.push(`${stats.writeCalls + stats.editCalls} file mutation calls`);
  } else if (stats.writeCalls + stats.editCalls >= 2) {
    score += 1;
    reasons.push(`${stats.writeCalls + stats.editCalls} file mutation calls`);
  }

  if (stats.bashCalls > 0 && stats.writeCalls + stats.editCalls > 0) {
    score += 1;
    reasons.push("shell command plus file mutation");
  }

  if (stats.toolFailures > 0) {
    score += 2;
    reasons.push(`${stats.toolFailures} failed tool calls`);
  }

  if (stats.turns >= 6) {
    score += 1;
    reasons.push(`${stats.turns} agent turns`);
  }

  return { shouldReview: score >= 4, score, reasons };
}

export function buildIdealReviewMessage(
  reasons: readonly string[],
  driftedFiles: readonly string[] = [],
): Message {
  const reasonText = reasons.length > 0 ? ` Triggered because: ${reasons.join(", ")}.` : "";
  const driftText =
    driftedFiles.length > 0
      ? ` Also: you changed ${driftedFiles.join(", ")} but the matching test file was not updated. ` +
        `Update the test to match the new behavior, or state plainly why the existing test is still valid. ` +
        `Edit the test only \u2014 do not run the suite now.`
      : "";
  return {
    role: "user",
    content: `${IDEAL_REVIEW_PROMPT}${reasonText}${driftText}`,
  };
}

// A test file: foo.test.ts, foo.spec.tsx, foo.test.mjs, etc.
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
// A source code file we can pair with a sibling test.
const CODE_EXT_RE = /\.([cm]?[jt]sx?)$/;

/**
 * Test-drift detector \u2014 the one stranding signal a typechecker is blind to.
 * Given the set of files the run mutated, return the source files whose sibling
 * test exists on disk but was NOT touched this run (a green-but-stale test).
 *
 * Pure structural check: no sibling test on disk \u2192 no signal, so it stays
 * silent on projects (or files) without co-located tests. `fileExists` is
 * injectable for tests; paths are resolved against `cwd` so relative tool paths
 * and absolute ones compare consistently.
 */
export function detectTestDrift(
  touchedFiles: Iterable<string>,
  cwd: string,
  fileExists: (p: string) => boolean = existsSync,
): string[] {
  const resolved = new Map<string, string>(); // absolute -> original (as the model wrote it)
  for (const f of touchedFiles) resolved.set(path.resolve(cwd, f), f);
  const touchedSet = new Set(resolved.keys());

  const drifted: string[] = [];
  for (const [abs, original] of resolved) {
    const base = path.basename(abs);
    if (TEST_FILE_RE.test(base)) continue; // the file itself is a test
    const match = base.match(CODE_EXT_RE);
    if (!match) continue; // not a code file
    const ext = match[1];
    const dir = path.dirname(abs);
    const stem = base.slice(0, base.length - ext.length - 1);
    // Tests commonly drop the JSX `x` (Button.tsx -> Button.test.ts), so try the
    // source ext and its non-JSX variant against both .test and .spec.
    const testExts = ext.endsWith("x") ? [ext, ext.slice(0, -1)] : [ext];
    const candidates = testExts
      .flatMap((e) => [`${stem}.test.${e}`, `${stem}.spec.${e}`])
      .map((c) => path.join(dir, c));
    if (candidates.some((c) => touchedSet.has(c))) continue; // sibling test was updated
    if (candidates.some((c) => fileExists(c))) drifted.push(original);
  }
  return drifted;
}

export function shouldCountAsRiskyTool(toolName: string): boolean {
  return RISKY_TOOL_NAMES.has(toolName);
}
