/**
 * Conservative read-only command classifier for plan mode.
 *
 * Deny-by-default: false negatives are safe (a read-only command merely stays
 * blocked), false positives are not (a mutating command would slip through).
 * Plan mode gates bash on `isReadOnlyCommand`; anything this function cannot
 * prove is read-only falls back to the existing plan-mode block.
 *
 * A command-name allowlist alone is not proof: several allowlisted utilities
 * mutate through flags (`git branch -D`, `find -delete`, `date -s`,
 * `sort -o file`), take create-shaped operands (`git tag v1`), or execute
 * repo-configured code (`git diff --ext-diff`). Each carries a per-flag
 * policy below.
 */

/** Read-only utilities allowed as the leading command word of every segment. */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "find",
  "fd",
  "tree",
  "stat",
  "file",
  "du",
  "df",
  "pwd",
  "echo",
  "printf",
  "which",
  "type",
  "date",
  "whoami",
  "hostname",
  "uname",
  "printenv",
  "sort",
  "uniq",
  "cut",
  "tr",
  "column",
  "nl",
  "comm",
  "diff",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "jq",
  "yq",
  // No awk: its `system()` built-in is arbitrary shell execution and cannot
  // be screened by flags. Deny-by-default costs a blocked read-only call at
  // worst; allowing it costs plan mode running `rm`.
]);

/** Read-only git subcommands. Everything else (commit, push, …) is rejected. */
const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "remote",
  "tag",
  "describe",
  "blame",
  "ls-files",
  "rev-parse",
  "shortlog",
  "cat-file",
  "config",
  "for-each-ref",
  "reflog",
]);

/**
 * Shell tokens that can hide writes or execute arbitrary commands. If any
 * segment contains one of these, the whole command is rejected.
 */
const DANGEROUS_TOKENS: readonly string[] = [
  ">", // output redirection (covers >>, >|, &>, <> via substring)
  "<>",
  "$(", // command substitution
  "`", // backtick command substitution
  "<(", // process substitution
  ">(",
];

/** Split a command on shell control operators into individual segments. */
export function splitShellCommandSegments(command: string): string[] {
  // Split on ; && || | and newlines. The pipe split also covers |& since the
  // trailing & becomes its own (empty/garbage) segment that fails the allowlist.
  return command
    .split(/(?:&&|\|\||[;|\n])/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** Extract the leading command word from a segment (ignores nothing special). */
function leadingWord(segment: string): string {
  const match = segment.match(/^(\S+)/);
  return match ? match[1] : "";
}

/** Tokenize a segment on whitespace for flag inspection. */
function tokens(segment: string): string[] {
  return segment.split(/\s+/).filter((token) => token.length > 0);
}

/** True if any token equals `flag` or is `flag=value`. */
function hasFlag(parts: string[], ...flags: string[]): boolean {
  return parts.some((part) => flags.some((flag) => part === flag || part.startsWith(`${flag}=`)));
}

/** Non-flag tokens of `parts`. */
function positionals(parts: string[]): string[] {
  return parts.filter((part) => !part.startsWith("-"));
}

/**
 * True if any token is a cluster of short flags containing one of `letters`
 * (`-df` = `-d -f`; GNU getopt and git parse-options both accept clusters, so
 * exact-token flag checks alone can be bypassed with `sort -ro`, `date -su`,
 * `git branch -df`). Long flags (`--…`) never match: two leading dashes fail
 * the letter run.
 */
function hasClusteredShortFlag(parts: string[], letters: ReadonlySet<string>): boolean {
  return parts.some((part) => {
    const match = /^-([a-zA-Z]+)\d*$/.exec(part);
    return match !== null && [...match[1]!].some((ch) => letters.has(ch));
  });
}

// --- git subcommand flag policies -------------------------------------------

/** Listing flags that make `git branch`/`git tag` operands filters rather
 *  than create/delete targets. Without one, a positional operand creates. */
const GIT_LIST_FLAGS = ["--list", "-l"];
/** Short-flag letters that make `git branch` mutate or execute (d/D delete, m/M
 *  move, c/C copy, f force, u upstream). `a`/`v` listing letters excluded. */
const GIT_BRANCH_DANGEROUS_LETTERS = new Set(["d", "D", "m", "M", "c", "C", "f", "u"]);
/** Same for `git tag` (d/D delete, f force, a annotate, s sign, u local-user,
 *  m message, e edit). `n`/`l` listing letters excluded. */
const GIT_TAG_DANGEROUS_LETTERS = new Set(["d", "D", "f", "a", "s", "u", "m", "e"]);

function isReadOnlyGitBranch(rest: string[]): boolean {
  if (
    hasFlag(
      rest,
      "-d",
      "-D",
      "--delete",
      "-m",
      "-M",
      "--move",
      "-c",
      "-C",
      "--copy",
      "-f",
      "--force",
      "-u",
      "--set-upstream-to",
      "--unset-upstream",
      "--edit-description",
    ) ||
    hasClusteredShortFlag(rest, GIT_BRANCH_DANGEROUS_LETTERS)
  ) {
    return false;
  }
  return positionals(rest).length === 0 || hasFlag(rest, ...GIT_LIST_FLAGS);
}

function isReadOnlyGitTag(rest: string[]): boolean {
  if (
    hasFlag(
      rest,
      "-d",
      "--delete",
      "-f",
      "--force",
      "-a",
      "--annotate",
      "-s",
      "--sign",
      "-u",
      "--local-user",
      "-m",
      "--message",
      "-e",
      "--edit",
    ) ||
    hasClusteredShortFlag(rest, GIT_TAG_DANGEROUS_LETTERS)
  ) {
    return false;
  }
  return positionals(rest).length === 0 || hasFlag(rest, ...GIT_LIST_FLAGS);
}

function isReadOnlyGitRemote(rest: string[]): boolean {
  const operands = positionals(rest);
  if (operands.length === 0) return true; // bare `git remote [-v]` lists
  const sub = operands[0];
  if (sub === "get-url") return true;
  // `git remote show` contacts the remote (network, askpass helpers);
  // read-only only with --no-query.
  if (sub === "show") return hasFlag(rest, "-n", "--no-query");
  return false; // add, rename, remove, set-url, set-head, prune, update …
}

function isReadOnlyGitReflog(rest: string[]): boolean {
  // `expire` and `delete` rewrite reflog history.
  const sub = positionals(rest)[0];
  return sub !== "expire" && sub !== "delete";
}

function isReadOnlyGit(segment: string): boolean {
  const parts = tokens(segment);
  // parts[0] === "git"; find the first non-flag token as the subcommand. A
  // global flag with a value (`git -C /tmp branch`) puts the value here and
  // denies — fail-closed, and `-C` escapes the workspace anyway.
  let subcommand = "";
  for (let i = 1; i < parts.length; i += 1) {
    const part = parts[i];
    if (part.startsWith("-")) continue;
    subcommand = part;
    break;
  }
  if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return false;
  const rest = parts.slice(parts.indexOf(subcommand) + 1);
  if (subcommand === "config") {
    // `git config` is read-only only with --get (or --list / --get-all).
    return hasFlag(rest, "--get", "--get-all", "--list", "-l");
  }
  // log/show/diff can execute repo-configured external diff/textconv
  // drivers. The --no- forms (which disable them) stay allowed: exact match.
  if (subcommand === "log" || subcommand === "show" || subcommand === "diff") {
    if (rest.includes("--ext-diff") || rest.includes("--textconv")) return false;
  }
  if (subcommand === "branch") return isReadOnlyGitBranch(rest);
  if (subcommand === "tag") return isReadOnlyGitTag(rest);
  if (subcommand === "remote") return isReadOnlyGitRemote(rest);
  if (subcommand === "reflog") return isReadOnlyGitReflog(rest);
  return true;
}

/**
 * sed script text that could execute a command or write a file: GNU's `e`
 * command (`e cmd`, `1e`, `/re/e`, `{ e ...`), the `s///...e` exec flag, or
 * the `w`/`W` write commands. Applied to ALL candidate script text - every
 * non-flag token joined plus long-flag `=values` - so quoting or splitting a
 * script across whitespace cannot hide the command from it. False positives
 * (a filename shaped like `1e`) merely block a read-only call.
 */
function sedScriptUnsafe(text: string): boolean {
  // `e`/`w`/`W` at a command position: script start, after `;` `{` `}`/`)`, or
  // directly after an address (`1e`, `$e`, `/re/e`, `2w out`).
  if (/(^|[\s;{}()])([0-9,$~/\\][^\s;{}]*)?[ewW](\s|$|\\)/.test(text)) return true;
  // Exec flag on a substitution, any delimiter: `s/x/y/e`, `s#x#y#ge`.
  if (/s(.).*\1[0-9A-Za-z]*e/.test(text)) return true;
  return false;
}

function isReadOnlySed(segment: string): boolean {
  const rest = tokens(segment).slice(1);
  // In-place edit (`-i`, `-i.bak`, `--in-place`) or a script read from a file
  // (`-f`, `--file`) - the file's contents cannot be inspected here.
  if (
    rest.some(
      (part) =>
        part.startsWith("-i") ||
        part.startsWith("--in-place") ||
        part.startsWith("-f") ||
        part.startsWith("--file"),
    )
  ) {
    return false;
  }
  // A short-flag cluster longer than two characters carries an attached value
  // that cannot be attributed (`-es/a/b/`, `-i.bak`, even the pure `-nE`);
  // only single-letter flags pass. Long `--flags` are words, not clusters.
  if (rest.some((part) => /^-[a-zA-Z]./.test(part))) return false;
  // Fail closed on compound scripts: `;`/`{`/`}` chain commands across token
  // boundaries (`sed 's/a/b/; e x' f`), so compound scripts are never provably
  // read-only here.
  const scriptText = rest
    .filter((part) => !part.startsWith("-"))
    .map((part) => part.replace(/^['"]|['"]$/g, ""))
    .join(" ");
  const flagValues = rest
    .filter((part) => part.startsWith("--") && part.includes("="))
    .map((part) => part.slice(part.indexOf("=") + 1).replace(/^['"]|['"]$/g, ""))
    .join(" ");
  const all = `${scriptText} ${flagValues}`;
  if (/;|\{|\}/.test(all)) return false;
  return !sedScriptUnsafe(all);
}

// --- plain-utility flag policies --------------------------------------------

function isReadOnlyUtility(command: string, parts: string[]): boolean {
  const rest = parts.slice(1);
  switch (command) {
    case "date":
      // `-s`/`--set` sets the system clock, also when clustered (`-su`).
      return !hasFlag(rest, "-s", "--set") && !hasClusteredShortFlag(rest, new Set(["s"]));
    case "find":
      // -exec/-ok (and their -dir variants) run arbitrary commands; the rest
      // write files.
      return !rest.some(
        (part) =>
          part === "-delete" ||
          part.startsWith("-exec") ||
          part.startsWith("-ok") ||
          part.startsWith("-fprint") ||
          part === "-fls",
      );
    case "rg":
      // `--pre` runs a command on every file searched (`--pre-glob` only scopes it).
      return !hasFlag(rest, "--pre");
    case "sort":
      // `-o` writes a file, also when clustered (`-ro`).
      return !hasFlag(rest, "-o", "--output") && !hasClusteredShortFlag(rest, new Set(["o"]));
    case "tree":
      return !hasFlag(rest, "-o", "--output-file") && !hasClusteredShortFlag(rest, new Set(["o"]));
    case "yq":
      // -i edits in place; --split-exp/-s write one file per document.
      return !hasFlag(rest, "-i", "--in-place", "-s", "--split-exp");
    default:
      return true;
  }
}

export function hasUnsafeShellSyntax(segment: string): boolean {
  return DANGEROUS_TOKENS.some((token) => segment.includes(token)) || /&\s*$/.test(segment);
}

function isReadOnlySegment(segment: string): boolean {
  // Keep shell-syntax policy shared with semantic verification classification.
  if (hasUnsafeShellSyntax(segment)) return false;

  const parts = tokens(segment);
  const command = leadingWord(segment);
  if (command === "git") return isReadOnlyGit(segment);
  if (command === "sed") return isReadOnlySed(segment);
  return READ_ONLY_COMMANDS.has(command) && isReadOnlyUtility(command, parts);
}

/**
 * Returns true only when every segment of the command is provably read-only.
 */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  const segments = splitShellCommandSegments(trimmed);
  if (segments.length === 0) return false;
  return segments.every(isReadOnlySegment);
}

const SLEEP_UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/**
 * Total seconds a command sleeps when it does nothing else (`sleep 5`,
 * `sleep 2; sleep 3`), or null when it does any real work.
 *
 * Used to catch a guessed wait on a background process, which now has a real
 * answer in `task_output`'s `wait_ms`. Callers care about the duration because
 * a brief settle before poking a dev server is legitimate, while a long nap is
 * always a guess at a finish time.
 */
export function sleepOnlySeconds(command: string): number | null {
  const segments = splitShellCommandSegments(command.trim());
  if (segments.length === 0) return null;
  let total = 0;
  for (const segment of segments) {
    const match = /^sleep\s+(\d+(?:\.\d+)?)([smhd])?$/.exec(segment.trim());
    if (!match) return null;
    total += Number(match[1]) * (match[2] ? SLEEP_UNIT_SECONDS[match[2]] : 1);
  }
  return total;
}
