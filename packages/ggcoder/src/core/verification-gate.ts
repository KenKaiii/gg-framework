/**
 * Verification gate — the turn cannot claim "done" while a promised check is
 * still owed.
 *
 * When a run mutated code files and no test / typecheck / lint / build command
 * completed after the last mutation, the pre-stop hook injects a follow-up
 * demanding the project's verification be run. One initial demand plus at most
 * one post-verification recheck, only when new edits invalidate a completed
 * check. Unchanged work never repeats the demand. If the bounded budget runs
 * out, the demand requires disclosure of what remains unverified.
 * Prompt-only "verify before finishing" instructions can be ignored; this gate
 * is harness-owned bookkeeping on what actually executed.
 *
 * The broad runner-shape classifier below identifies verification attempts.
 * Authoritative success uses the stricter verification-evidence classifier
 * plus host-observed exit status and the revision captured at command start.
 * Missing or rejected evidence cannot clear outstanding verification.
 *
 * Check-integrity review: test/config edits and added suppression markers are
 * review candidates, not proof of tampering. A green check alone cannot tell a
 * legitimate regression test from weakened assertions, so keep these mutations
 * separate and request an internal diff review alongside owed verification.
 * Later test edits retain one standalone review request per run. This bounded
 * prompt gate cannot prove the review happened; it requires disclosure of real
 * weakening or unresolved doubt, not a defense of routine test work.
 */
import type { Message } from "@kenkaiiii/gg-ai";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { VerificationEvidence } from "./verification-evidence.js";

export const VERIFICATION_STATE_KIND = "verification_state";
const verificationStateSchema = z.object({
  version: z.literal(1),
  seq: z.number().int().nonnegative().safe(),
  mutation: z.number().int().nonnegative().safe(),
  verified: z.number().int().nonnegative().safe(),
  files: z.array(z.string()).max(10_000),
  // Legacy snapshots carry bare check-key hashes; new ones carry [key, revision]
  // pairs so a failure can be superseded by later evidence.
  failedChecks: z
    .array(
      z.union([
        z.string().regex(/^[a-f0-9]{64}$/),
        z.tuple([z.string().regex(/^[a-f0-9]{64}$/), z.number().int().nonnegative().safe()]),
      ]),
    )
    .max(10_000),
  unknown: z.boolean(),
});
const checkKey = (command: string) => createHash("sha256").update(command.trim()).digest("hex");

/** Initial demands per run; at most one separate post-verification recheck is allowed. */
export const MAX_VERIFICATION_INJECTIONS = 1;

/** Tamper-disclosure demands per run. Same reasoning as above: one is enough. */
export const MAX_TAMPER_INJECTIONS = 1;

/** Words that may precede the real command without changing its shape. */
const SHELL_WRAPPERS = new Set([
  "env",
  "nohup",
  "nice",
  "time",
  "sudo",
  "stdbuf",
  "command",
  "exec",
]);

/** Leading words that mark a command as a build/test-tool invocation. Anything
 *  else (git, grep, ./script.sh, bash …) is conservatively not verification. */
const RUNNERS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "npx",
  "nr",
  "deno",
  "python",
  "python3",
  "py",
  "uv",
  "go",
  "cargo",
  "rustc",
  "make",
  "cmake",
  "gradle",
  "mvn",
  "dotnet",
  "sbt",
  "swift",
  "tsc",
  "vitest",
  "jest",
  "mocha",
  "pytest",
  "unittest",
  "eslint",
  "biome",
  "ruff",
  "mypy",
  "pylint",
]);

/** Shells whose `-c <script>` operand is itself a command to classify. */
const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** Nested `sh -c` unwraps allowed before the classifier gives up. */
const MAX_SHELL_DEPTH = 3;

/** A non-flag word after the runner that makes the command a verification. */
const VERIFY_KEYWORDS = [
  "test",
  "tests",
  "vitest",
  "jest",
  "mocha",
  "pytest",
  "unittest",
  "tsc",
  "typecheck",
  "type-check",
  "eslint",
  "biome",
  "ruff",
  "mypy",
  "pylint",
  "lint",
  "clippy",
  "vet",
  "check",
  "build",
  "compile",
  "verify",
];

function isVerifyWord(word: string): boolean {
  // Exact keyword, or a script name built on one (npm run test:unit).
  return VERIFY_KEYWORDS.some((keyword) => word === keyword || word.startsWith(`${keyword}:`));
}

/**
 * Split a command on shell control operators (`&&`, `||`, `;`, `|`, newline),
 * ignoring operators inside quotes, and strip subshell/group punctuation from
 * each piece. `cd pkg && npm test` must classify on its `npm test` half — the
 * whole-string read saw `cd` as the runner and left the gate owed forever.
 */
function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote) {
      current += char;
      if (char === "\\" && quote === '"') current += command[++i] ?? "";
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "\\") {
      current += char + (command[++i] ?? "");
      continue;
    }
    // Bare `&` is deliberately not an operator: it would split `2>&1`.
    const operator = ["&&", "||", ";", "|", "\n"].find((op) => command.startsWith(op, i));
    if (operator) {
      segments.push(current);
      current = "";
      i += operator.length - 1;
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments
    .map((segment) =>
      segment
        .trim()
        .replace(/^[({!\s]+/, "")
        .replace(/[)}\s]+$/, ""),
    )
    .filter((segment) => segment.length > 0);
}

/** Split a segment into words, honouring quotes and dropping the quote marks. */
function tokenize(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i]!;
    if (quote) {
      if (char === "\\" && quote === '"') current += segment[++i] ?? "";
      else if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current.length > 0) words.push(current);
      current = "";
      started = false;
      continue;
    }
    if (char === "\\") {
      current += segment[++i] ?? "";
      continue;
    }
    current += char;
  }
  if (started || current.length > 0) words.push(current);
  return words;
}

/**
 * True when the command looks like a test/typecheck/lint/build invocation:
 * compound segments considered independently, wrappers stripped, a known runner
 * leading, and a verification keyword among its operands. Deliberately strict —
 * `grep test x`, `git commit -m test` and `./run_tests.sh` all read as NOT
 * verification.
 */
export function isVerificationCommand(command: string): boolean {
  return splitCommandSegments(command).some((segment) => isVerificationSegment(segment, 0));
}

/** Classify one operator-free segment. `depth` bounds `sh -c` unwrapping. */
function isVerificationSegment(segment: string, depth: number): boolean {
  const words = tokenize(segment);
  let i = 0;
  while (i < words.length) {
    const word = words[i]!;
    if (SHELL_WRAPPERS.has(word) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      i += 1;
      continue;
    }
    // `timeout <duration> runner …` — skip the duration argument too.
    if (word === "timeout") {
      i += 2;
      continue;
    }
    break;
  }
  const runner = words[i] ?? "";
  // `sh -c "cd pkg && npm test"` — classify the script the shell will run.
  if (SHELL_INTERPRETERS.has(runner)) {
    if (depth >= MAX_SHELL_DEPTH) return false;
    const flagIndex = words.indexOf("-c", i + 1);
    const script = flagIndex === -1 ? undefined : words[flagIndex + 1];
    if (!script) return false;
    return splitCommandSegments(script).some((inner) => isVerificationSegment(inner, depth + 1));
  }
  if (!RUNNERS.has(runner)) return false;
  if (isVerifyWord(runner)) return true; // bare vitest / jest / tsc / eslint …
  return words
    .slice(i + 1)
    .filter((word) => !word.startsWith("-"))
    .some(isVerifyWord);
}

/** Source-file extensions whose edits count as code mutations. */
const CODE_EXT_RE =
  /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|kts|swift|c|h|cpp|cc|hpp|cs|php|vue|svelte|scala|sh|sql|m|mm|zig|ex|exs|erl|dart|lua|pl|r|jl|hs|clj)$/;

/** True for paths that look like source code (not docs, config or assets). */
export function isCodeFilePath(filePath: string): boolean {
  return CODE_EXT_RE.test(filePath);
}

/**
 * Files that define what a check ASSERTS rather than what it tests: test files
 * and test directories, test-runner configs, and the type/lint configs whose
 * strictness the checks inherit. Editing one of these can turn a failing check
 * green without touching the behaviour under test.
 *
 * Deliberately matched on path shape only. Both error directions are cheap: a
 * miss leaves today's behavior, a false positive costs one disclosure sentence.
 */
export function isCheckOwnFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  // A test/spec file, by suffix (foo.test.ts, foo_test.go, test_foo.py).
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(base)) return true;
  if (/_test\.(?:go|py|rb|rs)$/.test(base) || /^test_.+\.py$/.test(base)) return true;
  if (/(?:^|\.)spec\.[cm]?[jt]sx?$/.test(base)) return true;
  // Anything under a tests directory.
  if (/(?:^|\/)(?:tests?|__tests__|spec|specs|e2e|testdata|fixtures)\//.test(normalized)) {
    return true;
  }
  // Test-runner and check configuration.
  if (
    /^(?:vitest|jest|playwright|cypress|karma|mocha|ava|nightwatch|wdio)\.config\.[cm]?[jt]s$/.test(
      base,
    )
  ) {
    return true;
  }
  if (/^(?:jest|vitest|mocha|ava|nyc|c8)\.(?:config|setup)\./.test(base)) return true;
  // Type / lint configuration whose strictness the checks inherit.
  if (/^tsconfig(?:\.[\w-]+)?\.json$/.test(base)) return true;
  if (/^(?:\.eslintrc(?:\.[\w-]+)?|eslint\.config\.[cm]?[jt]s)$/.test(base)) return true;
  if (/^(?:biome|\.golangci|\.rubocop|phpstan|psalm)\.(?:jsonc?|ya?ml|neon|xml|toml)$/.test(base)) {
    return true;
  }
  if (/^(?:pyproject\.toml|setup\.cfg|tox\.ini|pytest\.ini|mypy\.ini|\.flake8)$/.test(base)) {
    return true;
  }
  if (/^conftest\.py$/.test(base)) return true;
  return false;
}

/**
 * Markers that silence or skip a check rather than satisfy it. Matched only
 * against text the model ADDED, so pre-existing suppressions in a file never
 * trip the gate.
 *
 * Deliberately limited to unambiguous intent (an explicit suppression pragma, a
 * skipped or narrowed test). Judgement calls that are ordinary in real test code
 * — `as any`, a loosened assertion — are NOT matched: at one extra model turn
 * per false positive, a noisy signal costs more than the rare miss.
 */
const SUPPRESSION_MARKERS: ReadonlyArray<{ re: RegExp; what: string }> = [
  { re: /@ts-(?:ignore|expect-error|nocheck)\b/, what: "TypeScript error suppression" },
  { re: /eslint-disable(?:-next-line|-line)?\b/, what: "ESLint rule suppression" },
  { re: /#\s*type:\s*ignore\b/, what: "mypy type-ignore" },
  { re: /#\s*noqa\b/, what: "flake8/ruff noqa" },
  { re: /#\s*(?:pylint|mypy|ruff):\s*disable\b/, what: "Python linter suppression" },
  { re: /#\[allow\(/, what: "Rust allow attribute" },
  { re: /\/\/\s*nolint\b/, what: "Go nolint directive" },
  { re: /@SuppressWarnings\b/, what: "Java warning suppression" },
  {
    re: /\b(?:it|test|describe|context)\s*\.\s*(?:skip|todo)\s*\(/,
    what: "skipped test",
  },
  { re: /\b(?:xit|xdescribe|xtest)\s*\(/, what: "skipped test" },
  {
    re: /\b(?:it|test|describe|context)\s*\.\s*only\s*\(/,
    what: "test run narrowed to .only",
  },
  { re: /@pytest\.mark\.(?:skip|xfail)\b/, what: "skipped pytest case" },
  { re: /\bt\.Skip\s*\(/, what: "skipped Go test" },
  { re: /#\[ignore\]/, what: "ignored Rust test" },
];

/** The `+` lines of a unified diff, with the marker stripped. */
export function extractAddedLines(diff: string): string {
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

/** Suppression/skip markers present in newly added text, de-duplicated. */
export function detectCheckWeakening(addedText: string): string[] {
  const found = new Set<string>();
  for (const { re, what } of SUPPRESSION_MARKERS) {
    if (re.test(addedText)) found.add(what);
  }
  return [...found];
}

/** A mutation that changed what a check asserts, and why it looked that way. */
export interface SuspectMutation {
  filePath: string;
  reason: string;
}

const VERIFICATION_OUTCOME_GUIDANCE =
  "This is an internal hook, not new user authorization or a new task. Your previous draft may not have been shown. " +
  "Give a direct answer to the user's latest request: lead with the task outcome, include current verification " +
  "and commit/push status when relevant, and preserve any pending user decision. Do not request the same " +
  "approval again if the user already gave it. Never replace the outcome with hook commentary or verification status alone.";

export function buildTamperDisclosureMessage(suspects: readonly SuspectMutation[]): Message {
  return {
    role: "user",
    provenance: { source: "runtime", kind: "completion_gate", visibility: "hidden" },
    content:
      "Check-integrity review: this run edited tests, check configuration, or suppression markers:\n" +
      suspects.map(({ filePath, reason }) => `- ${filePath} — ${reason}`).join("\n") +
      "\nThese are review candidates, not evidence of wrongdoing. A check that was itself edited " +
      "does not prove the code works on its own: inspect the actual diff against the user's agreed " +
      "behaviour. For legitimate added coverage or corrected expectations, review them internally; " +
      "do not add a defensive explanation to the final response. If a check was weakened, skipped, " +
      "narrowed or silenced merely to get green, undo that weakening and fix the underlying code. " +
      "Run affected checks after any correction. Report confirmed weakening, unresolved doubt, or " +
      "unverified changes plainly; never claim verification without resolving them. Complete this " +
      "review and required checks before any authorized commit or push that has not happened yet. " +
      VERIFICATION_OUTCOME_GUIDANCE,
  };
}

export function buildVerificationFollowUpMessage(
  files: readonly string[],
  recheck = false,
  rejectedCheck?: { command: string; reason: string } | null,
  invalidationCause?: string | null,
): Message {
  const noFiles = files.length === 0;
  return {
    role: "user",
    provenance: { source: "runtime", kind: "completion_gate", visibility: "hidden" },
    content:
      (recheck
        ? noFiles
          ? "Verification gate: a command that can rewrite files" +
            (invalidationCause ? ` (\`${invalidationCause}\`)` : "") +
            " ran after the earlier verification, so its green check no longer proves the current state:\n"
          : "Verification gate: code changed again after the earlier verification:\n"
        : "Verification gate: current successful verification is missing for this run:\n") +
      files.map((filePath) => `- ${filePath}`).join("\n") +
      (noFiles ? "" : "\n") +
      (recheck
        ? noFiles
          ? "Re-run the project's checks against the current state and address any failures. "
          : "Re-run the affected checks against these changes and address any failures. "
        : "Run the project's verification now (its test command, or the closest equivalent) and " +
          "address any failures. ") +
      "Do not describe the change as tested or working without having run it. " +
      "There is no repeated reminder for unchanged code: if you cannot run it, say plainly in your final " +
      "response which of these changes went unverified and why, so the user can check them." +
      // Why a green run already in the transcript did not count. Without this,
      // the agent re-ran the same untrusted command shape every turn and the
      // gate never cleared — the user got verification status instead of
      // answers on every prompt.
      (rejectedCheck
        ? `\nA check you ran did not count as verification evidence: \`${rejectedCheck.command}\` — ${rejectedCheck.reason}. ` +
          "Green output from that command shape cannot clear this gate; run a bounded check instead " +
          "(the project's test script via pnpm/npm/yarn test, vitest run, jest, pytest, or tsc --noEmit)."
        : "") +
      " " +
      VERIFICATION_OUTCOME_GUIDANCE,
  };
}

/**
 * Bookkeeping for "code was edited, nothing proved it since". Callers record
 * successful edit/write mutations on code files and host-observed check results.
 * Approval requires current successful evidence and no unresolved failures;
 * exhausting the reminder budget never clears the underlying problem.
 */
export class VerificationGate {
  private seq = 0;
  private lastMutationSeq = 0;
  private lastVerificationSeq = 0;
  private injections = 0;
  private recheckInjections = 0;
  private lastDemandedMutationSeq = 0;
  private tamperInjections = 0;
  private lastSuspectSeq = 0;
  private lastReviewRequestedSeq = 0;
  private failedChecks = new Map<string, number>(); // checkKey → mutation revision at failure
  private passedChecks = new Map<string, number>();
  private unknownVerification = false;
  /** A check the evidence classifier refused to vouch for, kept so the demand
   *  can explain WHY a green run in the transcript did not clear the gate. */
  private lastRejectedCheck: { command: string; reason: string } | null = null;
  /** The file-rewriting command that last invalidated evidence, if any — named
   *  in a recheck demand that has no tracked file edits to list instead. */
  private lastInvalidationCause: string | null = null;
  /**
   * Did THIS run touch what the gate guards — a code mutation, or a check that
   * may have rewritten files? Inherited debt alone never re-arms the gate: a
   * run that edited nothing is a question or review turn, and hijacking it
   * with a verification demand answered the user's prompt with verification
   * status instead of an answer, on every prompt, forever.
   */
  private runTouched = false;
  /** Code files mutated since the last verification — the gate's file list. */
  private mutatedFiles = new Set<string>();
  /**
   * Mutations that changed what a check asserts. Keyed by path so repeated edits
   * to one file disclose once. Deliberately NOT cleared by recordVerification():
   * the whole point is that the passing check cannot clear the suspicion that it
   * was the thing edited.
   */
  private suspects = new Map<string, string>();
  private evidenceRecords = new Map<string, VerificationEvidence & { revision: number }>();

  private rememberEvidence(
    command: string,
    status: VerificationEvidence["status"],
    reason: string,
    revision = this.revision,
  ): void {
    const key = checkKey(command);
    if ((this.evidenceRecords.get(key)?.revision ?? -1) > revision) return;
    this.evidenceRecords.delete(key);
    this.evidenceRecords.set(key, {
      command: command.slice(0, 2000),
      status,
      reason: reason.slice(0, 1000),
      revision,
    });
    if (this.evidenceRecords.size > 64)
      this.evidenceRecords.delete(this.evidenceRecords.keys().next().value!);
  }

  /** The same host-observed results used by the completion gate, not a second transcript verdict. */
  evidence(): VerificationEvidence[] {
    return [...this.evidenceRecords.values()].map(({ revision, ...entry }) =>
      revision === this.revision
        ? entry
        : {
            ...entry,
            status: "rejected",
            reason: "Superseded: result belongs to an earlier source revision",
          },
    );
  }

  /**
   * @param addedText Text the model ADDED in this mutation (the `+` lines of a
   * diff, or a written file's full content). Scanned for suppression and skip
   * markers; omit it and only the path check applies.
   */
  recordMutation(filePath: string, addedText?: string): void {
    this.lastMutationSeq = ++this.seq;
    this.runTouched = true;
    this.passedChecks.clear();
    this.mutatedFiles.add(filePath);

    const reasons: string[] = [];
    if (isCheckOwnFile(filePath)) reasons.push("edits a test or check configuration");
    if (addedText) reasons.push(...detectCheckWeakening(addedText).map((what) => `adds ${what}`));
    if (reasons.length === 0) return;
    this.lastSuspectSeq = this.lastMutationSeq;
    // Keep the fullest reason seen for this file rather than the newest.
    const existing = this.suspects.get(filePath);
    const merged = [...new Set([...(existing?.split("; ") ?? []), ...reasons])].join("; ");
    this.suspects.set(filePath, merged);
  }

  get revision(): number {
    return this.lastMutationSeq;
  }

  recordVerification(revision = this.revision, command = "verification"): void {
    // A check that started before a later edit cannot verify that edit.
    if (revision !== this.revision) return;
    this.rememberEvidence(
      command,
      "passed",
      "Host-observed successful exit at the current source revision",
      revision,
    );
    const key = checkKey(command);
    this.passedChecks.set(key, revision);
    // Eviction may require an extra check; it can never create an approval.
    if (this.passedChecks.size > 256) {
      const oldest = this.passedChecks.keys().next().value;
      if (oldest !== undefined) this.passedChecks.delete(oldest);
    }
    this.failedChecks.delete(key);
    // A pass against the current file revision supersedes failures recorded
    // against OLDER code. Exact-command-only clearing let one stale failure —
    // a check that failed once and was never re-run byte-identically — block
    // every later green run: verified never advanced and the gate re-injected
    // "a check failed" on every turn, the endless recheck loop.
    for (const [staleKey, failedAt] of this.failedChecks) {
      if (failedAt < revision) this.failedChecks.delete(staleKey);
    }
    if (this.failedChecks.size > 0) return;
    this.lastVerificationSeq = ++this.seq;
    this.unknownVerification = false;
    this.mutatedFiles.clear();
  }

  recordFailedVerification(command: string, revision = this.revision): void {
    const key = checkKey(command);
    // A failure remains outstanding unless this SAME check already passed on
    // a newer revision. An unrelated successful lint/build cannot erase it at
    // the same revision — but a pass at a NEWER revision supersedes it in
    // recordVerification, because it verified newer code.
    if ((this.passedChecks.get(key) ?? -1) > revision) return;
    this.failedChecks.set(key, revision);
    this.rememberEvidence(command, "failed", "Host-observed unsuccessful exit", revision);
  }

  requireFreshVerification(invalidateRevision = false, cause?: string): void {
    this.unknownVerification = true;
    if (invalidateRevision) {
      this.lastMutationSeq = ++this.seq;
      this.passedChecks.clear();
      this.runTouched = true; // the command may have rewritten files
      this.lastInvalidationCause = cause?.trim().slice(0, 200) || null;
    }
  }

  /** Remember a check shape the evidence classifier refused, for the demand's
   *  explanation. Command text is model-authored: capped, never executed. */
  recordRejectedCheck(command: string, reason: string): void {
    if (!command.trim() || !reason.trim()) return;
    this.rememberEvidence(command, "rejected", reason);
    this.lastRejectedCheck = {
      command: command.trim().slice(0, 200),
      reason: reason.trim().slice(0, 200),
    };
  }

  verificationProblem(): string | null {
    if (!this.isOwed()) return null;
    if (this.failedChecks.size > 0) {
      return "Unverified: a check failed or did not confirm success. Rerun that check successfully before approval.";
    }
    return "Unverified: no successful check covers the current changes. Run the project's verification before approval.";
  }

  snapshot() {
    return {
      version: 1 as const,
      seq: this.seq,
      mutation: this.lastMutationSeq,
      verified: this.lastVerificationSeq,
      files: [...this.mutatedFiles],
      failedChecks: [...this.failedChecks],
      unknown: this.unknownVerification,
    };
  }

  restore(value: unknown): void {
    this.reset();
    const parsed = verificationStateSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.mutation > parsed.data.seq ||
      parsed.data.verified > parsed.data.seq
    ) {
      this.requireFreshVerification();
      return;
    }
    const state = parsed.data;
    this.seq = state.seq;
    this.lastMutationSeq = state.mutation;
    this.lastVerificationSeq = state.verified;
    this.mutatedFiles = new Set(state.files);
    // Legacy bare-hash entries restore as revision 0 (ancient): any current
    // green pass supersedes them, unblocking sessions poisoned by the old
    // exact-command-only clearing.
    this.failedChecks = new Map(
      state.failedChecks.map((entry) => (Array.isArray(entry) ? entry : [entry, 0])),
    );
    // Only an OWED snapshot restores as owed. The old `|| state.mutation > 0`
    // forced every restart of an edited session to re-verify before any final
    // answer — so reopening the app and asking a plain question hijacked the
    // turn with a hook notice mid-stream. A session that was verified when it
    // closed stays verified: genuinely unverified work still restores owed
    // (mutation > verified), and any NEW edit in the resumed run bumps
    // mutation above verified and demands re-verification as usual.
    this.unknownVerification = state.unknown;
  }

  beginRun(): void {
    this.injections = 0;
    this.recheckInjections = 0;
    this.lastDemandedMutationSeq = 0;
    this.tamperInjections = 0;
    this.lastSuspectSeq = 0;
    this.lastReviewRequestedSeq = 0;
    this.suspects.clear();
    this.runTouched = false;
    this.lastRejectedCheck = null;
    this.lastInvalidationCause = null;
  }

  isOwed(): boolean {
    return (
      this.unknownVerification ||
      this.failedChecks.size > 0 ||
      this.lastMutationSeq > this.lastVerificationSeq
    );
  }

  /**
   * A passing check with test edits not yet covered by a review request. Without
   * a pass, the standard demand includes the review instead of adding a stop.
   * Requesting review is not proof of integrity; this is a bounded prompt gate.
   */
  isTamperOwed(): boolean {
    return this.lastSuspectSeq > this.lastReviewRequestedSeq && this.lastVerificationSeq > 0;
  }

  /** Suspect mutations recorded this run, sorted for stable output. */
  tamperSuspects(): SuspectMutation[] {
    return [...this.suspects]
      .map(([filePath, reason]) => ({ filePath, reason }))
      .sort((a, b) => a.filePath.localeCompare(b.filePath));
  }

  /**
   * Would a stop right now inject? Lets the session arm clients BEFORE the
   * candidate final answer streams, so the draft the injection replaces is held
   * rather than painted and then superseded.
   */
  willInject(): boolean {
    return this.pendingReason() !== null;
  }

  pendingReason(): "initial" | "recheck" | "tamper" | null {
    // A run that neither edited code nor started a file-rewriting command
    // cannot owe a NEW demand: inherited debt already had its turns, and
    // re-arming here is what turned every later question prompt into a
    // "Hook engaged" hijack. The debt itself stays recorded — the next run
    // that edits code re-arms the demand as usual.
    if (!this.runTouched) return null;
    if (this.isOwed()) {
      if (this.injections < MAX_VERIFICATION_INJECTIONS) {
        return this.lastVerificationSeq > 0 && this.lastMutationSeq > this.lastVerificationSeq
          ? "recheck"
          : "initial";
      }
      // One extra pass only after the demanded check completed AND code changed
      // again. Ignoring a prompt or editing without checking cannot re-arm it.
      if (
        this.recheckInjections === 0 &&
        this.lastVerificationSeq > this.lastDemandedMutationSeq &&
        this.lastMutationSeq > this.lastVerificationSeq
      )
        return "recheck";
    }
    if (this.isTamperOwed() && this.tamperInjections < MAX_TAMPER_INJECTIONS) return "tamper";
    return null;
  }

  /**
   * The blocking message for the pre-stop hook, or null when nothing is owed
   * or its bounded budget is spent. A later edit after the demanded check gets
   * one additional pass; unchanged/unverified work never repeats a reminder.
   */
  followUp(): Message[] | null {
    // Missing evidence and test-integrity review share one intervention.
    const reason = this.pendingReason();
    if (reason === "initial" || reason === "recheck") {
      if (this.injections < MAX_VERIFICATION_INJECTIONS) this.injections += 1;
      if (reason === "recheck") this.recheckInjections += 1;
      this.lastDemandedMutationSeq = this.lastMutationSeq;
      const messages = [
        buildVerificationFollowUpMessage(
          [...this.mutatedFiles].sort(),
          reason === "recheck",
          this.lastRejectedCheck,
          this.lastInvalidationCause,
        ),
      ];
      // Review the current test edits alongside verification, not in a second
      // stop after it. Later test edits still get the independent review budget.
      if (this.lastSuspectSeq > this.lastReviewRequestedSeq) {
        messages.push(buildTamperDisclosureMessage(this.tamperSuspects()));
        this.lastReviewRequestedSeq = this.lastSuspectSeq;
      }
      return messages;
    }
    if (reason === "tamper") {
      this.tamperInjections += 1;
      this.lastReviewRequestedSeq = this.lastSuspectSeq;
      return [buildTamperDisclosureMessage(this.tamperSuspects())];
    }
    return null;
  }

  reset(): void {
    this.seq = 0;
    this.lastMutationSeq = 0;
    this.lastVerificationSeq = 0;
    this.injections = 0;
    this.recheckInjections = 0;
    this.lastDemandedMutationSeq = 0;
    this.tamperInjections = 0;
    this.lastSuspectSeq = 0;
    this.lastReviewRequestedSeq = 0;
    this.mutatedFiles.clear();
    this.suspects.clear();
    this.failedChecks.clear();
    this.passedChecks.clear();
    this.evidenceRecords.clear();
    this.unknownVerification = false;
    this.runTouched = false;
    this.lastRejectedCheck = null;
    this.lastInvalidationCause = null;
  }
}
