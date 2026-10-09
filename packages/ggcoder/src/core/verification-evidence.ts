import type { ContentPart, Message, ToolResult } from "@kenkaiiii/gg-ai";
import {
  hasUnsafeShellSyntax,
  isReadOnlyCommand,
  splitShellCommandSegments,
} from "../tools/read-only-bash.js";

export interface VerificationCommandClassification {
  accepted: boolean;
  /** False for ordinary shell work that was never plausibly a verification attempt. */
  candidate: boolean;
  /** True when the command can rewrite files (fixers, builders, emitters): the
   *  verification gate bumps its mutation revision when such a check STARTS,
   *  because earlier in-flight evidence cannot cover files it may change. A
   *  rejected-but-non-mutating check (an unrecognized runner like `make test`)
   * must NOT poison the revision — its green output is merely not evidence. */
  mayMutate: boolean;
  reason: string;
  /** Still rejected by transcript parsing; only the live host can prove unchanged inputs. */
  snapshotEligible?: boolean;
  /** Comparison may preserve earlier evidence, but must never certify this command. */
  snapshotPreserveOnly?: boolean;
  /** A non-zero exit may come from a non-check part (`grep` matching nothing),
   *  so it is not recorded as a failed check — only as missing evidence. */
  ambiguousFailure?: boolean;
}

export interface VerificationEvidence {
  command: string;
  status: "passed" | "failed" | "rejected";
  reason: string;
}

const LONG_RUNNING_FLAGS = new Set([
  "--watch",
  "--watchall",
  "--watchall=false",
  "--ui",
  "--inspect",
  "--inspect-brk",
  "-w",
]);
const MUTATING_FLAGS = new Set([
  "--init",
  "--build",
  "-b",
  "--clean",
  "--fix",
  "--write",
  "--update",
  "-u",
  "--updatesnapshot",
  "--incremental",
  "--tsbuildinfofile",
  "--emitdeclarationonly",
]);
const AMBIGUOUS_FLAGS = new Set([
  "--nocheck",
  "--listfilesonly",
  "--showconfig",
  "--help",
  "-h",
  "--version",
  "--generatetrace",
  "--traceresolution",
  "--diagnostics",
  "--extendeddiagnostics",
  "--generatecpuprofile",
  "--collect-only",
  "--listtests",
]);
const SAFE_PACKAGE_SCRIPTS =
  /^(?:test(?::(?:unit|integration|e2e))?|check|typecheck|type-check|lint(?::check)?|format(?::check|-check)|prettier:check)$/i;
const UNSAFE_PACKAGE_SCRIPTS =
  /^(?:build|clean|dev|serve|start|watch|preview|prepare|install|format(?!:check$)|lint:fix|test:watch)(?::|$)/i;
const VERIFIER_WORDS =
  /(?:^|\s|\/)(?:tsc|vitest|jest|pytest|eslint|prettier|pyright|mypy|ruff|cargo|go|shellcheck)(?:\s|$)/i;

function tokenize(segment: string): string[] {
  return segment
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function lowerFlags(tokens: readonly string[]): Set<string> {
  return new Set(
    tokens.filter((token) => token.startsWith("-")).map((token) => token.toLowerCase()),
  );
}

function hasFlag(flags: ReadonlySet<string>, denied: ReadonlySet<string>): boolean {
  for (const flag of flags) {
    const name = flag.split("=")[0];
    if (denied.has(flag) || denied.has(name)) return true;
  }
  return false;
}

function rejected(
  candidate: boolean,
  reason: string,
  mayMutate = false,
): VerificationCommandClassification {
  return { accepted: false, candidate, reason, mayMutate };
}

function accepted(reason: string): VerificationCommandClassification {
  return { accepted: true, candidate: true, reason, mayMutate: false };
}

function classifyTsc(tokens: readonly string[]): VerificationCommandClassification {
  const flags = lowerFlags(tokens);
  if (hasFlag(flags, LONG_RUNNING_FLAGS)) return rejected(true, "long-running watch/debug mode");
  if (hasFlag(flags, MUTATING_FLAGS))
    return rejected(true, "mutating or artifact-producing mode", true);
  if (hasFlag(flags, AMBIGUOUS_FLAGS) || flags.has("-v")) {
    return rejected(true, "does not prove type correctness");
  }
  if (!flags.has("--noemit"))
    // Without --noEmit tsc EMITS files, so it is both unproven and rewriting.
    return rejected(true, "tsc must explicitly use --noEmit", true);
  return accepted("bounded TypeScript no-emit check");
}

function classifyTestRunner(
  executable: string,
  tokens: readonly string[],
): VerificationCommandClassification {
  const flags = lowerFlags(tokens);
  if (hasFlag(flags, LONG_RUNNING_FLAGS) || flags.has("--watch=false")) {
    return rejected(true, "long-running or interactive test mode");
  }
  if (hasFlag(flags, MUTATING_FLAGS)) return rejected(true, "mutating test/update mode", true);
  if (hasFlag(flags, AMBIGUOUS_FLAGS)) return rejected(true, "does not execute the test suite");
  if (executable === "vitest") {
    const positional = tokens.slice(1).filter((token) => !token.startsWith("-"));
    if (!positional.includes("run") && !flags.has("--run")) {
      return rejected(true, "vitest must explicitly use one-shot run mode");
    }
  }
  return accepted("bounded one-shot test check");
}

function classifyDirect(tokens: readonly string[]): VerificationCommandClassification {
  const executable = tokens[0]?.replace(/^.*[\\/]/, "").toLowerCase();
  if (!executable) return rejected(false, "empty command");
  if (executable === "tsc") return classifyTsc(tokens);
  if ((executable === "node" || executable === "node.exe") && tokens.includes("--test")) {
    // simplification: require --test first; supporting preceding Node options
    // needs option-arity parsing so script arguments cannot masquerade as flags.
    if (tokens[1] !== "--test") return rejected(true, "--test must lead Node arguments");
    if (tokens.some((token) => ["-e", "--eval", "-p", "--print"].includes(token))) {
      return rejected(true, "inline evaluation is not verification");
    }
    return classifyTestRunner("node", tokens);
  }
  if (/^python(?:3(?:\.\d+)?)?(?:\.exe)?$/.test(executable) && tokens[1] === "-m") {
    if (["pytest", "unittest"].includes(tokens[2])) {
      return classifyTestRunner(tokens[2], tokens.slice(2));
    }
    // `python -m ruff check` is the same bounded check as `ruff check`.
    if (["ruff", "mypy", "pyright"].includes(tokens[2])) return classifyDirect(tokens.slice(2));
  }
  if (executable === "vitest" || executable === "jest" || executable === "pytest") {
    return classifyTestRunner(executable, tokens);
  }

  const flags = lowerFlags(tokens);
  if (["eslint", "prettier", "ruff"].includes(executable)) {
    if (hasFlag(flags, LONG_RUNNING_FLAGS)) return rejected(true, "long-running mode");
    if (hasFlag(flags, MUTATING_FLAGS))
      return rejected(true, "mutating formatter/linter mode", true);
    if (hasFlag(flags, AMBIGUOUS_FLAGS)) return rejected(true, "does not execute a static check");
    if (executable === "prettier" && !flags.has("--check")) {
      return rejected(true, "prettier must explicitly use --check");
    }
    if (executable === "ruff" && tokens[1] === "format" && !flags.has("--check")) {
      return rejected(true, "ruff format must explicitly use --check");
    }
    return accepted("bounded static check");
  }
  if (["pyright", "mypy", "shellcheck"].includes(executable)) {
    if (hasFlag(flags, LONG_RUNNING_FLAGS)) return rejected(true, "long-running mode");
    if (hasFlag(flags, AMBIGUOUS_FLAGS)) return rejected(true, "does not execute a static check");
    return accepted("bounded static check");
  }
  if (executable === "cargo") {
    const subcommand = tokens[1]?.toLowerCase();
    if (subcommand === "build" || subcommand === "clean" || subcommand === "run") {
      return rejected(true, "artifact-producing Cargo command", true);
    }
    if (subcommand === "fmt" && !flags.has("--check")) {
      return rejected(true, "cargo fmt must explicitly use --check", true);
    }
    return ["check", "clippy", "test", "fmt"].includes(subcommand)
      ? accepted("bounded Cargo check")
      : rejected(false, "not a recognized verification command");
  }
  if (executable === "go") {
    const subcommand = tokens[1]?.toLowerCase();
    return subcommand === "test" || subcommand === "vet"
      ? accepted("bounded Go check")
      : rejected(
          subcommand === "build" || subcommand === "clean",
          "not a bounded Go check",
          subcommand === "build", // go build writes artifacts; clean removes them
        );
  }
  return rejected(VERIFIER_WORDS.test(tokens.join(" ")), "not a recognized verification command");
}

function classifyPackageRunner(tokens: readonly string[]): VerificationCommandClassification {
  const runner = tokens[0].toLowerCase();
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index].toLowerCase();
    if (["--filter", "-f", "--dir", "-c"].includes(token)) {
      index += 2;
      continue;
    }
    if (
      token === "--workspace-root" ||
      token === "-w" ||
      token.startsWith("--filter=") ||
      token.startsWith("--dir=")
    ) {
      index += 1;
      continue;
    }
    break;
  }

  const action = tokens[index]?.toLowerCase();
  if (!action) return rejected(false, "package runner has no command");
  if (["exec", "x", "dlx"].includes(action)) return classifyDirect(tokens.slice(index + 1));

  const scriptIndex = action === "run" ? index + 1 : index;
  const script = tokens[scriptIndex]?.toLowerCase();
  if (!script) return rejected(false, "package runner has no script");
  if (UNSAFE_PACKAGE_SCRIPTS.test(script)) {
    const result = rejected(
      true,
      "mutating, artifact-producing, or long-running package script",
      true,
    );
    const flags = lowerFlags(tokens.slice(scriptIndex + 1));
    // Only ordinary builds qualify, and only with a host-owned before/after
    // snapshot. Never infer safety for fixers, watchers or another directory.
    if (
      script === "build" &&
      !tokens.some((token) =>
        /^(?:--dir|--prefix|--cwd|-C|-c|-w|--workspace-root)(?:=|$)/.test(token),
      ) &&
      !hasFlag(flags, LONG_RUNNING_FLAGS) &&
      !hasFlag(flags, MUTATING_FLAGS) &&
      !hasFlag(flags, AMBIGUOUS_FLAGS)
    )
      result.snapshotEligible = true;
    return result;
  }
  if (!SAFE_PACKAGE_SCRIPTS.test(script)) {
    // pnpm permits omitting exec for installed binaries, e.g. pnpm vitest run.
    if (runner === "pnpm" && action !== "run") return classifyDirect(tokens.slice(index));
    return rejected(false, "package script is not a recognized verification check");
  }

  const scriptArgs = tokens.slice(scriptIndex + 1).filter((token) => token !== "--");
  const flags = lowerFlags(scriptArgs);
  if (hasFlag(flags, LONG_RUNNING_FLAGS)) return rejected(true, "long-running package-script mode");
  if (hasFlag(flags, MUTATING_FLAGS)) return rejected(true, "mutating package-script mode", true);
  if (hasFlag(flags, AMBIGUOUS_FLAGS))
    return rejected(true, "package script does not prove correctness");
  return accepted(`bounded ${runner} verification script`);
}

/** Trailing stderr redirects that cannot change a check's exit status or write a
 * file: merging stderr into stdout, or discarding it. Anything else (`> file`,
 * `2> log`) still reaches the unsafe-syntax rejection. */
const HARMLESS_STDERR_SUFFIX = /\s+2>(?:&1|\/dev\/null)\s*$/;

function classifySegment(rawSegment: string): VerificationCommandClassification {
  const segment = rawSegment.replace(HARMLESS_STDERR_SUFFIX, "");
  const candidate =
    VERIFIER_WORDS.test(segment) || /(?:^|\s)(?:pnpm|npm|yarn|bun)(?:\s|$)/i.test(segment);
  if (hasUnsafeShellSyntax(segment))
    return rejected(candidate, "unsafe shell syntax or redirection");
  const tokens = tokenize(segment);
  const first = tokens[0]?.toLowerCase();
  if (["pnpm", "npm", "yarn", "bun"].includes(first)) return classifyPackageRunner(tokens);
  if (["npx", "bunx"].includes(first)) return classifyDirect(tokens.slice(1));
  return classifyDirect(tokens);
}

/** tail/head with at most a line-count argument: pure output limiters. They
 * cannot rewrite, filter, or otherwise transform what the check proved — the
 * exit status (pipefail-protected) and the kept tail are the full evidence. */
const PIPE_LIMITER = /^(?:tail|head)(?:\s+(?:-[1-9]\d*|-n\s*\d+|--lines(?:=|\s+)\d+))?\s*$/;

/** Fail-closed classifier: bounded checks with narrowly allowed non-check preludes.
 *
 * `posixShell`: the command runs under bash with pipefail (GG's bash tool on
 * macOS/Linux, or Windows with Git Bash). Only then can read-only commands
 * around a check count: cmd.exe has no pipefail, and there `;` is not a
 * separator, so `cat a; npm test` would run only `cat`. Default off, so a
 * caller that does not know the shell fails closed. */
export function classifyVerificationCommand(
  command: string,
  { posixShell = false }: { posixShell?: boolean } = {},
): VerificationCommandClassification {
  const strict = classifyStrict(command);
  if (strict.accepted || !posixShell || !checkWithReadOnlyContext(command)) return strict;
  // Never certified from the transcript: the live host must also see the
  // workspace unchanged across the run (snapshotEligible), exactly as for an
  // ordinary build. Non-preserve-only, so a clean pass is fresh evidence.
  return {
    ...rejected(true, "check with read-only commands around it"),
    snapshotEligible: true,
    ambiguousFailure: true,
  };
}

type Separator = "&&" | "||" | ";" | null;

/** Stand-in for a `( … )` group already proven to contain only read-only commands. */
const READ_ONLY_GROUP = "\u0000read-only-group";

/** Index of the `)` closing the `(` at `open`, skipping quoted text. -1 when
 * unbalanced or when the inside holds anything this cannot account for. */
function closingParen(text: string, open: number): number {
  let quote: "'" | '"' | null = null;
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(")
      return -1; // no nesting
    else if (ch === ")") return i;
  }
  return -1;
}

/** True when `inner` (a group or `$( … )` body) runs read-only commands only. */
function readOnlyInner(inner: string): boolean {
  const pipelines = parsePipelines(inner);
  return pipelines !== null && pipelines.every(({ stages }) => stages.every(isReadOnlyContext));
}

/** Quote- and operator-level parse of a command into pipelines and the
 * separator that follows each. Null for anything this cannot fully account
 * for: escapes, backticks, variable expansion (except `$?`), redirections
 * (beyond a check's stderr merge), background `&`, comments, negation, brace
 * groups. `$( … )` and `( … )` are allowed only around read-only commands. */
function parsePipelines(command: string): Array<{ stages: string[]; next: Separator }> | null {
  // A NUL could forge the vetted-group stand-in (and never reaches a shell).
  if (command.includes("\u0000")) return null;
  const text = command.replace(/\s2>(?:&1|\/dev\/null)(?=\s*(?:\||&&|;|\n|$))/g, "");
  const pipelines: Array<{ stages: string[]; next: Separator }> = [];
  let stages: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let afterGroup = false;
  const endStage = (): boolean => {
    const stage = current.trim();
    current = "";
    afterGroup = false;
    if (!stage || stage.startsWith("!")) return false;
    stages.push(stage);
    return true;
  };
  const endPipeline = (next: Separator): boolean => {
    if (!endStage()) return false;
    pipelines.push({ stages, next });
    stages = [];
    return true;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    const nextCh = text[i + 1] ?? "";
    if (quote === "'") {
      if (ch === "'") quote = null;
      current += ch;
      continue;
    }
    if (afterGroup && !/\s/.test(ch) && !"&|;\n".includes(ch)) return null;
    if (ch === "`" || ch === "\\") return null;
    if (ch === "$") {
      if (nextCh === "?") {
        // The previous exit status: a number, it cannot run anything.
        current += "0";
        i++;
        continue;
      }
      if (nextCh === "(") {
        const close = closingParen(text, i + 1);
        if (close === -1 || !readOnlyInner(text.slice(i + 2, close))) return null;
        current += "Q";
        i = close;
        continue;
      }
      // Any other expansion (`$VAR`, `${…}`, `$'\x2d'` ANSI-C quoting) can
      // produce text this cannot see. Only a bare `$` is literal.
      if (nextCh !== "" && !/\s/.test(nextCh)) return null;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" && current.trim() === "") {
      const close = closingParen(text, i);
      if (close === -1 || !readOnlyInner(text.slice(i + 1, close))) return null;
      current = READ_ONLY_GROUP;
      afterGroup = true;
      i = close;
      continue;
    }
    if ("(){}<>".includes(ch)) return null;
    if (ch === "#" && (current === "" || /\s$/.test(current))) return null;
    if (ch === "&") {
      if (nextCh !== "&" || !endPipeline("&&")) return null;
      i++;
      continue;
    }
    if (ch === "|") {
      if (nextCh === "|") {
        if (!endPipeline("||")) return null;
        i++;
        continue;
      }
      if (nextCh === "&" || !endStage()) return null;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      if (current.trim() === "" && stages.length === 0) continue; // blank line
      if (!endPipeline(";")) return null;
      continue;
    }
    current += ch;
  }
  if (quote !== null) return null;
  if (current.trim() === "" && stages.length === 0) {
    // Trailing separator: the last pipeline has no successor after all.
    const last = pipelines.at(-1);
    if (last) last.next = null;
  } else if (!endPipeline(null)) return null;
  return pipelines.length > 0 ? pipelines : null;
}

/** Pure stream filters allowed after a check. None exists in cmd.exe, so on a
 * shell without pipefail the pipeline cannot exit 0 through them. */
const PIPE_FILTERS = new Set(["tail", "head", "grep", "egrep", "fgrep", "rg", "wc", "cat"]);
/** Read-only git around a check: no `-c`/`-C` globals (they can run helpers). */
const CONTEXT_GIT = /^git\s+(?:status|diff|log|show)(?:\s|$)/;

/** Quoted text masked so read-only screening cannot be confused by `|`, `>`
 * or `;` inside patterns; a quoted flag (`"-o"`) stays visible to it. */
function maskQuotes(stage: string): string | null {
  let hiddenFlag = false;
  const masked = stage.replace(/'[^']*'|"[^"]*"/g, (quoted) => {
    if (/^.-/.test(quoted)) hiddenFlag = true;
    return "Q";
  });
  return hiddenFlag ? null : masked;
}

function isReadOnlyContext(stage: string): boolean {
  if (stage === READ_ONLY_GROUP) return true;
  const masked = maskQuotes(stage);
  if (masked === null || !isReadOnlyCommand(masked)) return false;
  const word = masked.split(/\s+/)[0];
  return word !== "git" || CONTEXT_GIT.test(masked);
}

function isPipeFilter(stage: string): boolean {
  const masked = maskQuotes(stage);
  if (masked === null) return false;
  const words = masked.split(/\s+/);
  if (!PIPE_FILTERS.has(words[0] ?? "")) return false;
  // A follow mode never ends; it could only time the check out.
  if (words.some((w) => /^(?:-f|-F|--follow(?:=.*)?|--retry)$/.test(w))) return false;
  return isReadOnlyCommand(masked);
}

/**
 * A real check with read-only commands around it, as models write them:
 * `cat a.js; npm test 2>&1 | grep -E "pass|fail"`, `npm test && git diff --stat`,
 * `(rg -n old || echo none) && npm test 2>&1 | tail -15`.
 *
 * Exit 0 still proves every check passed, because:
 * - every check pipeline is a recognised bounded check piped only through pure
 *   filters, and the agent shell runs with pipefail;
 * - a check is never reached through `||` (`cat a || npm test` exits 0 without
 *   testing), and from the first check on everything is joined by `&&`, so no
 *   later command's status can replace a failed check's;
 * - everything else is read-only; before the first check, `;` and `||` are
 *   fine because those statuses never become the command's;
 * - a leading `cd dir &&` may pick the directory, as for a bare check. If it
 *   fails, a later `;` runs the check in the project root, which is still the
 *   workspace the host compares.
 * The host additionally compares workspace inputs before and after the run
 * (snapshotEligible), so nothing in the chain can rewrite what was checked.
 */
function checkWithReadOnlyContext(command: string): boolean {
  const pipelines = parsePipelines(command);
  if (pipelines === null) return false;
  let seenCheck = false;
  let previous: Separator = null;
  for (const [index, { stages, next }] of pipelines.entries()) {
    const [head, ...rest] = stages as [string, ...string[]];
    const isCheck = classifySegment(head).accepted && rest.every(isPipeFilter);
    if (isCheck) {
      if (previous === "||") return false;
      seenCheck = true;
    } else if (index === 0 && rest.length === 0 && next === "&&" && /^cd\s+\S+$/.test(head)) {
      // working-directory prelude
    } else if (!stages.every(isReadOnlyContext)) return false;
    if (seenCheck && (next === ";" || next === "||")) return false;
    previous = next;
  }
  return seenCheck;
}

function classifyStrict(command: string): VerificationCommandClassification {
  const candidate =
    VERIFIER_WORDS.test(command) || /(?:^|\s)(?:pnpm|npm|yarn|bun)(?:\s|$)/i.test(command);
  // Only && preserves fail-closed evidence across a chain. OR, semicolons, and
  // newlines can still hide a failed check behind a later zero exit status.
  if (command.includes("||") || command.includes(";") || command.includes("\n")) {
    return rejected(candidate, "shell control operator can hide a failed check");
  }
  // Pipes are evidence ONLY as `check | tail/head`: the agent shell runs with
  // pipefail, so the pipeline reports the check's own status, and a limiter
  // cannot transform results. Any other pipe stage can (grep, tee, wc…) — rejected.
  if (/(^|[^|])\|([^|]|$)/.test(command)) {
    const stages = command.split("|");
    const check = stages[0]!.replace(/\s*2>&1\s*$/, "").trim();
    const limitersOk = stages.slice(1).every((stage) => PIPE_LIMITER.test(stage.trim()));
    if (!limitersOk || !check) {
      return rejected(candidate, "pipe stage can transform check results");
    }
    const head = classifyVerificationCommand(check);
    return head.accepted
      ? accepted("piped check with output limiter (pipefail)")
      : rejected(head.candidate || candidate, head.reason, head.mayMutate);
  }
  const segments = splitShellCommandSegments(command);
  if (segments.length === 0) return rejected(false, "empty command");
  const results = segments.map((segment, index) => {
    const tokens = tokenize(segment);
    // A leading directory change is not itself evidence. && ensures it must
    // succeed, and a real bounded check must still follow it.
    if (
      index < segments.length - 1 &&
      tokens[0] === "cd" &&
      tokens.length === 2 &&
      !hasUnsafeShellSyntax(segment)
    )
      return accepted("working-directory prelude");
    // Status is not evidence itself; a real check must follow through &&.
    // simplification: only basic status flags; expand with vetted flags, not arbitrary Git commands.
    if (
      index < segments.length - 1 &&
      /^git\s+status(?:\s+(?:--short|-s|--branch|-b|--porcelain(?:=[12])?))*$/.test(segment.trim())
    )
      return accepted("git status prelude");
    return classifySegment(segment);
  });
  const firstRejected = results.find((result) => !result.accepted);
  if (firstRejected) {
    // Preludes are `accepted` only so a real check may follow them; they are
    // never checks themselves, so they must not make a chain a check candidate
    // or qualify it for snapshot comparison.
    const isPrelude = (entry: VerificationCommandClassification): boolean =>
      entry.reason === "git status prelude" || entry.reason === "working-directory prelude";
    const hasRealCheck = results.some((entry) => entry.accepted && !isPrelude(entry));
    const result = rejected(
      results.some((entry) => entry.candidate && !isPrelude(entry)),
      firstRejected.reason,
      results.some((entry) => entry.mayMutate),
    );
    if (
      results.every((entry) => entry.accepted || entry.snapshotEligible) &&
      !results.some((entry) => entry.reason === "working-directory prelude")
    ) {
      result.snapshotEligible = true;
    } else if (
      !result.mayMutate &&
      hasRealCheck &&
      !results.some((entry) => entry.reason === "working-directory prelude") &&
      segments.every((segment) => !hasUnsafeShellSyntax(segment))
    ) {
      // Mixed check/script chains remain rejected. A host-observed successful
      // exit plus unchanged inputs can only retain evidence from earlier checks.
      result.snapshotEligible = true;
      result.snapshotPreserveOnly = true;
    }
    return result;
  }
  return accepted(segments.length === 1 ? results[0].reason : "bounded verification command chain");
}

/**
 * True when some segment of `command` is, on its own, a bounded check — i.e.
 * the chain wraps a real verification attempt. Used to decide whether a
 * rejected classification deserves user-visible feedback: exploration that
 * merely mentions a verifier (`ls .venv/bin | grep ruff`, `ruff --version`)
 * was never a verification attempt and gets no nag.
 */
export function containsBoundedCheck(command: string): boolean {
  return command
    .split(/(?:&&|\|\||[;|\n])/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .some((segment) => classifySegment(segment).accepted);
}

function resultText(result: ToolResult): string {
  if (typeof result.content === "string") return result.content;
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** Extract harness-owned evidence from completed bash calls in a transcript. */
export function collectVerificationEvidence(messages: readonly Message[]): VerificationEvidence[] {
  const calls = new Map<
    string,
    { command: string; classification: VerificationCommandClassification; background: boolean }
  >();
  const evidence: VerificationEvidence[] = [];

  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content as ContentPart[]) {
        if (part.type !== "tool_call" || part.name !== "bash") continue;
        const command = typeof part.args.command === "string" ? part.args.command.trim() : "";
        const background = part.args.run_in_background === true || part.args.persist === true;
        calls.set(part.id, {
          command,
          classification: classifyVerificationCommand(command),
          background,
        });
      }
    }
    if (message.role !== "tool") continue;
    for (const result of message.content as ToolResult[]) {
      const call = calls.get(result.toolCallId);
      if (!call || !call.classification.candidate) continue;
      if (call.background) {
        evidence.push({
          command: call.command,
          status: "rejected",
          reason: "background or persistent commands are not bounded evidence",
        });
        continue;
      }
      if (!call.classification.accepted) {
        evidence.push({
          command: call.command,
          status: "rejected",
          reason: call.classification.reason,
        });
        continue;
      }
      const passed = !result.isError && /^Exit code:\s*0(?:\s|$)/i.test(resultText(result).trim());
      evidence.push({
        command: call.command,
        status: passed ? "passed" : "failed",
        reason: passed ? call.classification.reason : "bounded check did not exit successfully",
      });
    }
  }
  return evidence;
}
