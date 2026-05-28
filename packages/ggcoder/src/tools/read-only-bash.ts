/**
 * Conservative read-only command classifier for plan mode.
 *
 * Deny-by-default: false negatives are safe (a read-only command merely stays
 * blocked), false positives are not (a mutating command would slip through).
 * Plan mode gates bash on `isReadOnlyCommand`; anything this function cannot
 * prove is read-only falls back to the existing plan-mode block.
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
  "awk",
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
function splitSegments(command: string): string[] {
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

function isReadOnlyGit(segment: string): boolean {
  const parts = tokens(segment);
  // parts[0] === "git"; find the first non-flag token as the subcommand.
  let subcommand = "";
  for (let i = 1; i < parts.length; i += 1) {
    const part = parts[i];
    if (part.startsWith("-")) continue;
    subcommand = part;
    break;
  }
  if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return false;
  // `git config` is read-only only with --get (or --list / --get-all).
  if (subcommand === "config") {
    const hasReadFlag = parts.some(
      (part) => part === "--get" || part === "--get-all" || part === "--list" || part === "-l",
    );
    return hasReadFlag;
  }
  return true;
}

function isReadOnlySed(segment: string): boolean {
  // sed is read-only only when it does not edit in place.
  const parts = tokens(segment);
  return !parts.some(
    (part) => part === "-i" || part === "--in-place" || part.startsWith("--in-place="),
  );
}

function isReadOnlySegment(segment: string): boolean {
  // Reject any segment containing write/redirection or substitution tokens.
  for (const token of DANGEROUS_TOKENS) {
    if (segment.includes(token)) return false;
  }
  // Reject trailing background operator.
  if (/&\s*$/.test(segment)) return false;

  const command = leadingWord(segment);
  if (command === "git") return isReadOnlyGit(segment);
  if (command === "sed") return isReadOnlySed(segment);
  return READ_ONLY_COMMANDS.has(command);
}

/**
 * Returns true only when every segment of the command is provably read-only.
 */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  const segments = splitSegments(trimmed);
  if (segments.length === 0) return false;
  return segments.every(isReadOnlySegment);
}
