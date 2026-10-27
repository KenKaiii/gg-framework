import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BackgroundGitError, runBackgroundGit } from "../utils/git.js";
import { log } from "./logger.js";

/**
 * Destructive-git guard: refuses model-issued shell commands that would throw
 * away the user's uncommitted work.
 *
 * Checkpoints only capture edits made through write/edit, so one
 * `git reset --hard` from the shell would otherwise lose work with no undo.
 *
 * Two phases:
 * 1. {@link findDestructiveGitCommands} — pure parse. A small quote-aware shell
 *    scanner splits the command into simple commands (through `&&`/`;`/`||`/
 *    pipes, subshells, `$(…)`/backticks, `if`/`for`/`while` bodies), unwraps
 *    `bash -c`/`sh -c`/`eval` scripts and exec wrappers (`sudo`, `env`,
 *    `timeout`, `nohup`, `xargs`, …), follows `cd` and `git -C`, and classifies
 *    each git invocation.
 * 2. {@link checkDestructiveGit} — context. Discarding commands are blocked
 *    only when `git status` in the target directory shows something they would
 *    destroy; a clean tree passes. Plain force-push is always blocked.
 *
 * Fails OPEN on guard errors (git missing, timeout): the guard is a seatbelt
 * against an agent mistake, not a sandbox, and must never wedge the bash tool.
 */

type DestructiveGitKind =
  | "reset-hard"
  | "checkout-paths"
  | "restore-worktree"
  | "clean"
  | "stash-drop"
  | "stash-clear"
  | "branch-force-delete"
  | "force-push";

export interface DestructiveGitMatch {
  kind: DestructiveGitKind;
  /** The git invocation as parsed, for the block message. */
  display: string;
  /** Directory git would run in (after `cd` and `git -C`). */
  dir: string;
  /** `--git-dir=`/`--work-tree=` globals to forward to inspection commands. */
  gitArgs: string[];
  /** Pathspecs limiting what is discarded; empty means the whole tree. */
  pathspecs: string[];
  /** checkout with one operand that may be a branch rather than a path. */
  maybeRef?: string;
  /** clean: also/only removes ignored files (`-x` / `-X`). */
  ignored?: "also" | "only";
  /** clean: `-d` also removes untracked directories. */
  directories?: boolean;
  /** branch -D targets; stash drop target. */
  refs: string[];
}

const MAX_DEPTH = 6;
const GIT_TIMEOUT_MS = 3_000;
const MAX_LISTED_FILES = 5;

// ── Shell scanning ─────────────────────────────────────────

/**
 * Split shell source into simple commands (arrays of unquoted words).
 * Not a full shell parser: it errs toward surfacing commands (heredoc bodies
 * fed to a shell, substitutions inside double quotes), because a false
 * positive costs only a `git status` call.
 */
function scanShell(src: string, depth: number, out: string[][]): void {
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let skipNextWord = false;
  let heredocPending = false;
  const heredocs: { delimiter: string; stripTabs: boolean }[] = [];
  let heredocStripTabs = false;

  const nested = (inner: string): void => {
    if (depth < MAX_DEPTH) scanShell(inner, depth + 1, out);
  };
  const endWord = (): void => {
    if (inWord) {
      if (skipNextWord) {
        skipNextWord = false;
        if (heredocPending) {
          heredocs.push({ delimiter: word, stripTabs: heredocStripTabs });
          heredocPending = false;
        }
      } else {
        words.push(word);
      }
    }
    word = "";
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) out.push(words);
    words = [];
    skipNextWord = false;
    heredocPending = false;
  };

  let i = 0;
  while (i < src.length) {
    const ch = src.charAt(i);
    const next = src.charAt(i + 1);

    if (ch === "\\") {
      if (next !== "\n") {
        word += next;
        inWord = true;
      }
      i += 2;
      continue;
    }
    if (ch === "'") {
      const close = src.indexOf("'", i + 1);
      const end = close === -1 ? src.length : close;
      word += src.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      i = scanDoubleQuoted(src, i + 1, (text) => (word += text), nested);
      inWord = true;
      continue;
    }
    if (ch === "`") {
      const close = findBacktickClose(src, i + 1);
      nested(src.slice(i + 1, close));
      inWord = true;
      i = close + 1;
      continue;
    }
    if (ch === "$" && next === "(") {
      const close = findParenClose(src, i + 2);
      nested(src.slice(i + 2, close));
      inWord = true;
      i = close + 1;
      continue;
    }
    if (ch === "$" && next === "'") {
      i += 1; // ANSI-C quoting: treat the body as a plain single-quoted string
      continue;
    }
    if ((ch === "<" || ch === ">") && next === "(") {
      endWord();
      const close = findParenClose(src, i + 2);
      nested(src.slice(i + 2, close));
      i = close + 1;
      continue;
    }
    if (ch === " " || ch === "\t") {
      endWord();
      i += 1;
      continue;
    }
    if (ch === "\n") {
      const commandWords = [...words, ...(inWord && !skipNextWord ? [word] : [])];
      endCommand();
      i += 1;
      // Heredoc bodies start on the next line. Scan them only when they feed
      // a shell (`bash <<EOF`); for `cat <<EOF > notes.md` they are data.
      while (heredocs.length > 0) {
        const doc = heredocs.shift();
        if (!doc) break;
        const { body, resume } = readHeredoc(src, i, doc.delimiter, doc.stripTabs);
        if (commandWords.some((w) => SHELLS.has(commandName(w)))) nested(body);
        i = resume;
      }
      continue;
    }
    if (ch === "#" && !inWord) {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (ch === ";" || ch === "(" || ch === ")") {
      endCommand();
      i += 1;
      continue;
    }
    if (ch === "|") {
      endCommand();
      i += next === "|" || next === "&" ? 2 : 1;
      continue;
    }
    if (ch === "&") {
      if (next === ">") {
        endWord();
        i += src.charAt(i + 2) === ">" ? 3 : 2;
        skipNextWord = true;
        continue;
      }
      endCommand();
      i += next === "&" ? 2 : 1;
      continue;
    }
    if (ch === "<" || ch === ">") {
      // A bare fd number glued to the operator (`2>`) is not a word.
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else {
        endWord();
      }
      const op = /^(?:<<<|<<-|<<|<>|>>|>\||>&|<&|>|<)/.exec(src.slice(i))?.[0] ?? ch;
      if (op === "<<" || op === "<<-") {
        heredocPending = true;
        heredocStripTabs = op === "<<-";
      }
      skipNextWord = true;
      i += op.length;
      continue;
    }
    word += ch;
    inWord = true;
    i += 1;
  }
  endCommand();
}

/** Consume a double-quoted string starting after the opening quote; returns
 *  the index after the closing quote. Substitutions inside are scanned. */
function scanDoubleQuoted(
  src: string,
  start: number,
  append: (text: string) => void,
  nested: (inner: string) => void,
): number {
  let i = start;
  while (i < src.length) {
    const ch = src.charAt(i);
    const next = src.charAt(i + 1);
    if (ch === '"') return i + 1;
    if (ch === "\\" && '$`"\\\n'.includes(next) && next !== "") {
      if (next !== "\n") append(next);
      i += 2;
      continue;
    }
    if (ch === "$" && next === "(") {
      const close = findParenClose(src, i + 2);
      nested(src.slice(i + 2, close));
      append(src.slice(i, close + 1));
      i = close + 1;
      continue;
    }
    if (ch === "`") {
      const close = findBacktickClose(src, i + 1);
      nested(src.slice(i + 1, close));
      i = close + 1;
      continue;
    }
    append(ch);
    i += 1;
  }
  return src.length;
}

/** Index of the `)` closing a `$(`/`(` whose body starts at `start`. */
function findParenClose(src: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < src.length) {
    const ch = src.charAt(i);
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "'") {
      const close = src.indexOf("'", i + 1);
      i = close === -1 ? src.length : close + 1;
      continue;
    }
    if (ch === '"') {
      i = scanDoubleQuoted(
        src,
        i + 1,
        () => {},
        () => {},
      );
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return src.length;
}

function findBacktickClose(src: string, start: number): number {
  let i = start;
  while (i < src.length) {
    const ch = src.charAt(i);
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") return i;
    i += 1;
  }
  return src.length;
}

function readHeredoc(
  src: string,
  start: number,
  delimiter: string,
  stripTabs: boolean,
): { body: string; resume: number } {
  const lines: string[] = [];
  let i = start;
  while (i < src.length) {
    const nl = src.indexOf("\n", i);
    const end = nl === -1 ? src.length : nl;
    const line = src.slice(i, end);
    i = end + 1;
    if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
    lines.push(line);
  }
  return { body: lines.join("\n"), resume: Math.min(i, src.length) };
}

// ── Command unwrapping ─────────────────────────────────────

const SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "ksh", "dash", "ash", "fish"]);

/** Commands that run their operands as a command (possibly after options). */
const EXEC_WRAPPERS: ReadonlySet<string> = new Set([
  "sudo",
  "doas",
  "env",
  "nohup",
  "timeout",
  "gtimeout",
  "nice",
  "ionice",
  "exec",
  "command",
  "builtin",
  "time",
  "stdbuf",
  "setsid",
  "xargs",
  "chronic",
  "caffeinate",
  "unbuffer",
  "flock",
  "watch",
]);

/** Words that do not run their operands; stop looking for a wrapped child. */
const NON_EXEC_COMMANDS: ReadonlySet<string> = new Set([
  "echo",
  "printf",
  "cat",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "sed",
  "awk",
  "head",
  "tail",
  "less",
  "more",
  "man",
  "which",
  "type",
  "tee",
  "wc",
]);

const SHELL_KEYWORDS: ReadonlySet<string> = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "case",
  "esac",
  "!",
  "{",
  "}",
  "function",
]);

/** Basename of a command word, `.exe` stripped (`/usr/bin/git`, `git.exe`). */
export function commandName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? word).replace(/\.exe$/i, "");
}

/**
 * Expand the home and working-directory forms a model writes in paths:
 * `~`, `$HOME`/`${HOME}` (any case, which also covers PowerShell `$home`),
 * `$env:USERPROFILE`/`$env:HOME`, cmd `%USERPROFILE%`, and `$PWD`/`${PWD}`. Other variables stay
 * literal, so they resolve to a harmless relative path.
 */
export function expandShellPath(p: string, cwd: string): string {
  return p
    .replace(
      /^(?:~|\$\{?home\}?|\$env:(?:userprofile|home)|%userprofile%)(?=[\\/]|$)/i,
      os.homedir(),
    )
    .replace(/^\$\{?PWD\}?(?=[\\/]|$)/, cwd);
}

/** One simple command found in a shell string, after unwrapping. */
export interface ShellInvocation {
  /** {@link commandName} of the command word. */
  name: string;
  args: readonly string[];
  /** Directory it would run in after any earlier `cd` in the same script. */
  cwd: string;
  /** Run by `xargs`, which appends operands read from stdin. */
  viaXargs: boolean;
}

interface ScanContext {
  cwd: string;
  depth: number;
  viaXargs: boolean;
  wanted: (name: string) => boolean;
  out: ShellInvocation[];
}

function isPowerShell(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "powershell" || lower === "pwsh";
}

function walkScript(script: string, ctx: ScanContext): void {
  const commands: string[][] = [];
  scanShell(script, ctx.depth, commands);
  // `cd` persists for later commands in the same script (approximation: a
  // subshell's cd leaks too, which only ever widens what gets checked).
  const local: ScanContext = { ...ctx };
  for (const words of commands) walkWords(words, local);
}

function walkWords(input: string[], ctx: ScanContext): void {
  let words = input;
  while (
    words.length > 0 &&
    (SHELL_KEYWORDS.has(words[0] ?? "") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? ""))
  ) {
    words = words.slice(1);
  }
  const head = words[0];
  if (head === undefined) return;
  const name = commandName(head);
  const args = words.slice(1);

  if (name === "cd" || name === "pushd") {
    const target = args.find((a) => !a.startsWith("-"));
    // `cd -` goes somewhere we cannot know; keep the current guess.
    if (target === undefined && !args.includes("-")) ctx.cwd = os.homedir();
    else if (target !== undefined)
      ctx.cwd = path.resolve(ctx.cwd, expandShellPath(target, ctx.cwd));
    return;
  }
  if (ctx.wanted(name)) {
    ctx.out.push({ name, args, cwd: ctx.cwd, viaXargs: ctx.viaXargs });
    return;
  }
  if (ctx.depth >= MAX_DEPTH) return;
  const deeper: ScanContext = { ...ctx, depth: ctx.depth + 1 };
  if (SHELLS.has(name)) {
    // `bash -c 'script'`, also clustered (`-lc`, `-ec`).
    const flagIndex = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
    const script = flagIndex === -1 ? undefined : args[flagIndex + 1];
    if (script !== undefined) walkScript(script, deeper);
    return;
  }
  if (isPowerShell(name)) {
    // `pwsh -c '…'` / `powershell -Command "…"` (any unambiguous prefix).
    const flagIndex = args.findIndex((a) => /^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i.test(a));
    const script = flagIndex === -1 ? undefined : args.slice(flagIndex + 1).join(" ");
    if (script) walkScript(script, deeper);
    return;
  }
  if (name === "eval") {
    walkScript(args.join(" "), deeper);
    return;
  }
  if (EXEC_WRAPPERS.has(name)) {
    // Wrapper options vary (`timeout 5`, `sudo -u bob`, `env X=1`, `nice -n 5`);
    // rather than model each, take the first word that is itself something we
    // analyse, stopping at a command that merely displays its operands.
    for (let index = 0; index < args.length; index += 1) {
      const candidate = commandName(args[index] ?? "");
      if (
        ctx.wanted(candidate) ||
        candidate === "cd" ||
        candidate === "eval" ||
        SHELLS.has(candidate) ||
        isPowerShell(candidate) ||
        EXEC_WRAPPERS.has(candidate)
      ) {
        walkWords(args.slice(index), { ...deeper, viaXargs: ctx.viaXargs || name === "xargs" });
        return;
      }
      if (NON_EXEC_COMMANDS.has(candidate)) return;
    }
  }
}

/**
 * Every simple command in `command` whose name satisfies `wanted`, in source
 * order, after splitting on `&&`/`;`/`||`/pipes, entering subshells,
 * substitutions and `if`/`for`/`while` bodies, unwrapping `bash -c`/`eval`/
 * `pwsh -c` scripts and exec wrappers (`sudo`, `env`, `timeout`, `xargs`, …),
 * and following `cd`. Pure: nothing is executed.
 */
export function walkShell(
  command: string,
  cwd: string,
  wanted: (name: string) => boolean,
): ShellInvocation[] {
  const out: ShellInvocation[] = [];
  walkScript(command, { cwd, depth: 0, viaXargs: false, wanted, out });
  return out;
}

// ── git classification ─────────────────────────────────────

/** True for a short-option cluster (`-fdx`) containing `letter`. */
export function hasShort(tokens: readonly string[], letter: string): boolean {
  return tokens.some((t) => /^-[A-Za-z]+$/.test(t) && t.slice(1).includes(letter));
}

/** Exact long option, or an unambiguous abbreviation of at least `minLength`. */
export function hasLong(
  tokens: readonly string[],
  option: string,
  minLength = option.length,
): boolean {
  return tokens.some((t) => {
    const name = t.split("=", 1)[0] ?? t;
    return name.startsWith("--") && name.length >= minLength && option.startsWith(name);
  });
}

export function splitAtDoubleDash(tokens: readonly string[]): {
  before: string[];
  after: string[] | null;
} {
  const index = tokens.indexOf("--");
  return index === -1
    ? { before: [...tokens], after: null }
    : { before: tokens.slice(0, index), after: tokens.slice(index + 1) };
}

/** Non-option operands, skipping the values of options in `withValue`. */
export function operands(tokens: readonly string[], withValue: ReadonlySet<string>): string[] {
  const result: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    if (token.startsWith("-")) {
      if (withValue.has(token)) i += 1;
      continue;
    }
    result.push(token);
  }
  return result;
}

export function isPathspecShaped(operand: string): boolean {
  return (
    operand === "." ||
    operand === ".." ||
    /^\.\.?[\\/]/.test(operand) ||
    /^(?:[\\/]|[A-Za-z]:[\\/])/.test(operand) ||
    operand.endsWith("/") ||
    operand.startsWith(":") ||
    /[*?[]/.test(operand)
  );
}

const CHECKOUT_VALUE_OPTS: ReadonlySet<string> = new Set(["--conflict", "-U", "--unified"]);
const RESTORE_VALUE_OPTS: ReadonlySet<string> = new Set([
  "-s",
  "--source",
  "--conflict",
  "-U",
  "--unified",
  "--inter-hunk-context",
]);
const CLEAN_VALUE_OPTS: ReadonlySet<string> = new Set(["-e", "--exclude"]);
const BRANCH_VALUE_OPTS: ReadonlySet<string> = new Set([
  "-t",
  "--track",
  "-u",
  "--set-upstream-to",
]);
const PUSH_VALUE_OPTS: ReadonlySet<string> = new Set([
  "-o",
  "--push-option",
  "--repo",
  "--receive-pack",
  "--exec",
]);

/** A git invocation split into its global options and its subcommand. */
export interface GitInvocation {
  /** Directory git would run in (after `-C`). */
  dir: string;
  /** `--git-dir=`/`--work-tree=` globals, resolved, to forward to inspection commands. */
  gitArgs: string[];
  subcommand: string | undefined;
  /** Everything after the subcommand. */
  rest: readonly string[];
}

/** Parse git's global options (`-C`, `--git-dir`, `-c k=v`, …) off the front of `args`. */
export function parseGitInvocation(args: readonly string[], cwd: string): GitInvocation {
  let dir = cwd;
  const gitArgs: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i] ?? "";
    if (arg === "-C") {
      dir = path.resolve(dir, expandShellPath(args[i + 1] ?? ".", dir));
      i += 2;
      continue;
    }
    if (arg === "--git-dir" || arg === "--work-tree") {
      gitArgs.push(`${arg}=${path.resolve(dir, expandShellPath(args[i + 1] ?? ".", dir))}`);
      i += 2;
      continue;
    }
    const assigned = /^(--git-dir|--work-tree)=(.*)$/.exec(arg);
    if (assigned) {
      gitArgs.push(`${assigned[1]}=${path.resolve(dir, expandShellPath(assigned[2] ?? ".", dir))}`);
      i += 1;
      continue;
    }
    if (
      arg === "-c" ||
      arg === "--namespace" ||
      arg === "--config-env" ||
      arg === "--super-prefix"
    ) {
      i += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      i += 1;
      continue;
    }
    break;
  }
  return { dir, gitArgs, subcommand: args[i], rest: args.slice(i + 1) };
}

function analyzeGit(args: readonly string[], cwd: string): DestructiveGitMatch | null {
  const { dir, gitArgs, subcommand, rest } = parseGitInvocation(args, cwd);
  if (subcommand === undefined) return null;
  const base = {
    display: truncate(["git", subcommand, ...rest].join(" ")),
    dir,
    gitArgs,
    pathspecs: [] as string[],
    refs: [] as string[],
  };

  switch (subcommand) {
    case "reset":
      // Git rejects paths with --hard, so it is always the whole tree.
      return hasLong(rest, "--hard", 4) ? { ...base, kind: "reset-hard" } : null;

    case "checkout": {
      const { before, after } = splitAtDoubleDash(rest);
      if (before.some((t) => t === "-b" || t === "-B" || t === "--orphan")) return null;
      if (hasLong(before, "--force") || hasShort(before, "f")) {
        return { ...base, kind: "checkout-paths", pathspecs: after ?? [] };
      }
      if (hasLong(before, "--pathspec-from-file", 12)) return { ...base, kind: "checkout-paths" };
      if (after !== null) {
        return after.length > 0 ? { ...base, kind: "checkout-paths", pathspecs: after } : null;
      }
      const positional = operands(before, CHECKOUT_VALUE_OPTS);
      if (positional.length >= 2) {
        return { ...base, kind: "checkout-paths", pathspecs: positional.slice(1) };
      }
      const operand = positional[0];
      if (operand === undefined || hasShort(before, "d") || hasLong(before, "--detach", 5)) {
        return null;
      }
      if (isPathspecShaped(operand)) {
        return { ...base, kind: "checkout-paths", pathspecs: [operand] };
      }
      if (existsSync(path.resolve(dir, operand))) {
        return { ...base, kind: "checkout-paths", pathspecs: [operand], maybeRef: operand };
      }
      return null;
    }

    case "restore": {
      const { before, after } = splitAtDoubleDash(rest);
      if (before.some((t) => t === "-h" || t === "--help")) return null;
      const staged = before.includes("--staged") || hasShort(before, "S");
      const worktree = before.includes("--worktree") || hasShort(before, "W");
      if (staged && !worktree) return null;
      const pathspecs = [...operands(before, RESTORE_VALUE_OPTS), ...(after ?? [])];
      const fromFile = hasLong(before, "--pathspec-from-file", 12);
      if (pathspecs.length === 0 && !fromFile) return null;
      return { ...base, kind: "restore-worktree", pathspecs: fromFile ? [] : pathspecs };
    }

    case "clean": {
      const { before, after } = splitAtDoubleDash(rest);
      if (hasShort(before, "n") || hasLong(before, "--dry-run", 5)) return null;
      if (!hasShort(before, "f") && !hasLong(before, "--force")) return null;
      const ignored = hasShort(before, "x") ? "also" : hasShort(before, "X") ? "only" : undefined;
      return {
        ...base,
        kind: "clean",
        pathspecs: [...operands(before, CLEAN_VALUE_OPTS), ...(after ?? [])],
        ignored,
        directories: hasShort(before, "d"),
      };
    }

    case "stash": {
      const [action, target] = operands(rest, new Set());
      if (action === "drop") return { ...base, kind: "stash-drop", refs: [target ?? "stash@{0}"] };
      if (action === "clear") return { ...base, kind: "stash-clear" };
      return null;
    }

    case "branch": {
      if (hasShort(rest, "r") || hasLong(rest, "--remotes", 5)) return null;
      const forceDelete =
        hasShort(rest, "D") ||
        ((hasShort(rest, "d") || hasLong(rest, "--delete", 5)) &&
          (hasShort(rest, "f") || hasLong(rest, "--force")));
      if (!forceDelete) return null;
      const refs = operands(rest, BRANCH_VALUE_OPTS);
      return refs.length > 0 ? { ...base, kind: "branch-force-delete", refs } : null;
    }

    case "push": {
      // --force-with-lease / --force-if-includes are the safe forms: exact
      // `--force` and `-f` only. A `+refspec` is a per-ref force.
      const forced =
        rest.includes("--force") ||
        hasShort(rest, "f") ||
        operands(rest, PUSH_VALUE_OPTS).some((ref) => ref.startsWith("+"));
      return forced ? { ...base, kind: "force-push" } : null;
    }

    default:
      return null;
  }
}

function truncate(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Parse `command` and return every git invocation in it that can destroy
 * work, with the directory each would run in. Pure apart from `existsSync`
 * for ambiguous `git checkout <name>`.
 */
export function findDestructiveGitCommands(command: string, cwd: string): DestructiveGitMatch[] {
  const out: DestructiveGitMatch[] = [];
  for (const call of walkShell(command, cwd, (name) => name === "git")) {
    // xargs appends operands read from stdin; stand in "." (whole tree)
    // so `… | xargs git checkout --` is checked rather than parsed as empty.
    const match = analyzeGit(call.viaXargs ? [...call.args, "."] : call.args, call.cwd);
    if (!match) continue;
    // A pathspec still holding a variable (`for f in …; do git checkout -- $f`)
    // could name anything once expanded: check the whole tree instead of a
    // literal `$f` that matches no file.
    if (match.pathspecs.some((spec) => spec.includes("$"))) match.pathspecs = [];
    out.push(match);
  }
  return out;
}

// ── Context check ──────────────────────────────────────────

interface GitResult {
  code: number;
  stdout: string;
}

class GuardError extends Error {}

/**
 * Run an inspection git command against the target repo with repo-config
 * execution sinks (fsmonitor, hooks, filters, …) disabled — see
 * runBackgroundGit. `gitArgs` are the command's own `--git-dir`/`--work-tree`.
 */
async function runGit(
  dir: string,
  gitArgs: readonly string[],
  args: readonly string[],
): Promise<GitResult> {
  try {
    const { stdout } = await runBackgroundGit(args, {
      cwd: dir,
      globalArgs: gitArgs,
      timeoutMs: GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: { LC_ALL: "C" },
    });
    return { code: 0, stdout };
  } catch (error) {
    // A numeric code is git's exit status; a string (ENOENT) or a kill
    // (timeout) means the guard itself could not inspect the repo.
    if (error instanceof BackgroundGitError && typeof error.code === "number" && !error.killed) {
      return { code: error.code, stdout: error.stdout };
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new GuardError(`git ${args.join(" ")} failed: ${message}`);
  }
}

interface StatusEntry {
  code: string;
  file: string;
}

/** `git status --porcelain=v1 -z`, parsed. Null when `dir` is not a repo. */
async function gitStatus(
  match: DestructiveGitMatch,
  extra: readonly string[],
): Promise<StatusEntry[] | null> {
  const result = await runGit(match.dir, match.gitArgs, [
    "status",
    "--porcelain=v1",
    "-z",
    ...extra,
    "--",
    ...match.pathspecs,
  ]);
  if (result.code !== 0) return null;
  const parts = result.stdout.split("\0");
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? "";
    if (part.length < 4) continue;
    const code = part.slice(0, 2);
    entries.push({ code, file: part.slice(3) });
    if (code.startsWith("R") || code.startsWith("C")) i += 1; // rename source path
  }
  return entries;
}

function listFiles(entries: readonly StatusEntry[]): string {
  const names = entries.slice(0, MAX_LISTED_FILES).map((e) => e.file);
  const more = entries.length - names.length;
  return names.join(", ") + (more > 0 ? `, and ${more} more` : "");
}

function describeTracked(entries: readonly StatusEntry[]): string {
  const counts = new Map<string, number>();
  for (const { code } of entries) {
    const label = code.includes("D")
      ? "deleted"
      : code.includes("A")
        ? "added"
        : code.includes("U")
          ? "conflicted"
          : code.startsWith("R")
            ? "renamed"
            : "modified";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const breakdown = [...counts].map(([label, n]) => `${n} ${label}`).join(", ");
  const noun = entries.length === 1 ? "file" : "files";
  return `${entries.length} changed ${noun} (${breakdown}): ${listFiles(entries)}`;
}

const NO_UNDO = "Checkpoints do not capture shell commands, so this could not be undone.";

function stashAdvice(label: string, untracked: "-u" | "-a" = "-u"): string {
  return (
    `Safe alternative: first save the work with \`git stash push ${untracked} -m "gg: before ${label}"\` ` +
    "(that alone also leaves a clean tree; recover with `git stash pop`), or use ask_user to " +
    "confirm the user really wants these changes discarded."
  );
}

async function evaluate(match: DestructiveGitMatch): Promise<string | null> {
  const where = match.pathspecs.length > 0 ? ` (${match.pathspecs.join(" ")})` : "";
  switch (match.kind) {
    case "force-push":
      return (
        `Blocked \`${match.display}\`: a plain force-push overwrites remote commits that are ` +
        "not in your local branch, and nothing here can restore them. Use " +
        "`git push --force-with-lease` (add `--force-if-includes` for extra safety) instead. " +
        "If the user explicitly wants a plain force-push, ask them to run it themselves."
      );

    case "reset-hard":
    case "checkout-paths":
    case "restore-worktree": {
      if (match.maybeRef !== undefined) {
        const ref = await runGit(match.dir, match.gitArgs, [
          "rev-parse",
          "--verify",
          "--quiet",
          `${match.maybeRef}^{commit}`,
        ]);
        if (ref.code === 0) return null; // a branch switch, which git refuses if it would clobber
      }
      const status = await gitStatus(match, ["--untracked-files=no"]);
      const tracked = (status ?? []).filter(
        (e) => !e.code.startsWith("?") && !e.code.startsWith("!"),
      );
      if (tracked.length === 0) return null;
      return (
        `Blocked \`${match.display}\`: it would permanently discard uncommitted changes in ` +
        `${match.dir}${where} — ${describeTracked(tracked)}. ${NO_UNDO} ` +
        stashAdvice(match.kind === "reset-hard" ? "reset" : "discarding changes")
      );
    }

    case "clean": {
      const extra = ["--untracked-files=normal", ...(match.ignored ? ["--ignored"] : [])];
      const status = await gitStatus(match, extra);
      const removable = (status ?? []).filter((e) => {
        const untracked = e.code === "??";
        const ignored = e.code === "!!";
        if (!untracked && !ignored) return false;
        if (untracked && match.ignored === "only") return false;
        if (ignored && match.ignored === undefined) return false;
        // Without -d (and no explicit pathspec), untracked directories stay.
        if (e.file.endsWith("/") && !match.directories && match.pathspecs.length === 0)
          return false;
        return true;
      });
      if (removable.length === 0) return null;
      const noun = removable.length === 1 ? "file" : "files";
      return (
        `Blocked \`${match.display}\`: it would permanently delete ${removable.length} untracked ` +
        `${noun} in ${match.dir}${where}: ${listFiles(removable)}. ${NO_UNDO} ` +
        "Preview with `git clean -n` (same flags). " +
        stashAdvice("clean", match.ignored ? "-a" : "-u")
      );
    }

    case "stash-drop":
    case "stash-clear": {
      const list = await runGit(match.dir, match.gitArgs, ["stash", "list"]);
      const entries = list.code === 0 ? list.stdout.split("\n").filter((l) => l.length > 0) : [];
      if (entries.length === 0) return null;
      const target =
        match.kind === "stash-clear"
          ? `all ${entries.length} stash ${entries.length === 1 ? "entry" : "entries"}`
          : (entries.find((l) => l.startsWith(`${match.refs[0] ?? ""}:`)) ?? match.refs[0] ?? "");
      return (
        `Blocked \`${match.display}\`: it would permanently delete ${target}. ` +
        "Inspect with `git stash list` / `git stash show -p <entry>`, or keep it as a branch with " +
        "`git stash branch <name> <entry>`. If the user explicitly wants it gone, ask them " +
        "(ask_user) and have them run it themselves."
      );
    }

    case "branch-force-delete": {
      const losses: string[] = [];
      for (const branch of match.refs) {
        const ref = `refs/heads/${branch}`;
        const result = await runGit(match.dir, match.gitArgs, [
          "rev-list",
          "--count",
          ref,
          "--not",
          `--exclude=${ref}`,
          "--all",
        ]);
        // Nonzero: no such branch — git branch -D will just fail.
        const count = result.code === 0 ? Number.parseInt(result.stdout.trim(), 10) : 0;
        if (count > 0) losses.push(`${branch} (${count} commit${count === 1 ? "" : "s"})`);
      }
      if (losses.length === 0) return null;
      return (
        `Blocked \`${match.display}\`: these branches have commits that exist on no other branch, ` +
        `tag or remote, so deleting them loses that work: ${losses.join(", ")}. ` +
        "Use `git branch -d` (refuses unmerged branches), push or merge the branch first, or — if " +
        "the user explicitly asked to delete it — keep a backup ref first " +
        "(`git tag backup/<branch> <branch>`) and then delete."
      );
    }
  }
}

export interface DestructiveGitCheckOptions {
  /** The tool's working directory. */
  cwd: string;
  /**
   * The shell's real current directory when it can differ from `cwd`
   * (persistent session shell after a `cd`). Only called when the command
   * contains a destructive git invocation.
   */
  resolveCwd?: () => Promise<string | null>;
}

/**
 * Returns a block message for the model when `command` would destroy
 * uncommitted work (or force-push), or null to let it run.
 */
export async function checkDestructiveGit(
  command: string,
  options: DestructiveGitCheckOptions,
): Promise<string | null> {
  try {
    if (!/\bgit\b/.test(command)) return null;
    let matches = findDestructiveGitCommands(command, options.cwd);
    if (matches.length === 0) return null;
    if (options.resolveCwd) {
      const real = await options.resolveCwd();
      if (real && path.isAbsolute(real) && real !== options.cwd)
        matches = findDestructiveGitCommands(command, real);
    }
    const reasons: string[] = [];
    for (const match of matches) {
      // A directory the command creates first cannot hold uncommitted work yet.
      if (match.kind !== "force-push" && !existsSync(match.dir)) continue;
      const reason = await evaluate(match);
      if (reason) reasons.push(reason);
    }
    return reasons.length > 0 ? reasons.join("\n") : null;
  } catch (error) {
    log("WARN", "git-guard", `Destructive-git guard failed open: ${(error as Error).message}`);
    return null;
  }
}
