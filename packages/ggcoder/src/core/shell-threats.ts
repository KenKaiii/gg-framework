/**
 * Local, deterministic shell-threat rules. Run against every command the
 * agent is about to execute (bash tool, task_send input) and refuse the
 * clearly-dangerous shapes: pipe-to-shell installers, reverse shells, secret
 * exfiltration, lookalike (IDN/punycode) hosts and terminal-escape tricks.
 *
 * These are regexes over the full command text, not a shell parser. Known
 * trade-off: quoted text inside `echo`/`printf` (e.g. `echo "curl x | sh"`)
 * may be flagged too. That false positive is acceptable — the agent can write
 * such text to a file with the write tool instead.
 */
import {
  checkActionThreats,
  commandPrograms,
  lineRule,
  SAFETY_BLOCK_NOTE,
  sendsOnlyToTrustedHosts,
  stripInertHeredocs,
} from "./action-threats.js";
import { extractCommandHosts, hostFromUrl } from "./network-guard.js";

export interface ShellThreat {
  rule: string;
  severity: "block" | "warn";
  detail: string;
  /** Flagged `name@version (IDs)` items, when the threat lists packages. */
  packages?: string[];
  /** The packages this threat blocks, for the project's "don't install" list. */
  blocked?: BlockedPackage[];
}

/** One package a guard refused, as recorded in the project's instruction file. */
export interface BlockedPackage {
  ecosystem: "npm" | "PyPI";
  name: string;
  /** Exact version when the block is version-specific. */
  version?: string;
  /** Plain reason, e.g. "known malware (MAL-2025-46969)". */
  reason: string;
}

const SHELLS =
  "(?:sudo\\s+)?(?:(?<![\\w./-])[\\w./-]*/)?(?:sh|bash|zsh|dash|ksh|python[\\d.]*|node|perl|ruby)\\b";
const FETCHERS = "\\b(?:curl|wget)\\b";

const PIPE_TO_SHELL = [
  // curl … | sh  (any number of intermediate pipeline stages)
  // An interpreter given an inline script (-c/-e/-m/-p) or a script file reads
  // stdin as data (`curl … | python -m json.tool`), so that is not flagged.
  new RegExp(
    `${FETCHERS}[^;&\\n]*\\|\\s*${SHELLS}(?![ \\t]+(?:-[cmepE]\\b|--eval\\b|--print\\b|[^-\\s|;&]))`,
    "i",
  ),
  // bash <(curl …)
  new RegExp(`${SHELLS}\\s+<\\(\\s*(?:curl|wget)\\b`, "i"),
  // sh -c "$(curl …)"  /  $(wget …) / `curl …` executed
  new RegExp(`${SHELLS}\\s+(?:-\\w+\\s+)*["']?\\$\\(\\s*(?:curl|wget)\\b`, "i"),
  new RegExp(`${SHELLS}\\s+(?:-\\w+\\s+)*["']?\`\\s*(?:curl|wget)\\b`, "i"),
  // eval "$(curl …)"
  /\beval\s+["']?\$\(\s*(?:curl|wget)\b/i,
  // PowerShell: iex (iwr …) / irm … | iex / Invoke-Expression
  /\b(?:iex|invoke-expression)\b[\s(]*(?:\(?\s*)(?:iwr|irm|invoke-webrequest|invoke-restmethod|\(?new-object\s+net\.webclient)/i,
  /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n]*\|\s*(?:iex|invoke-expression)\b/i,
  /\binvoke-expression\b/i,
].map(lineRule);

const REVERSE_SHELL = [
  /\/dev\/(?:tcp|udp)\//i,
  /\bsocat\b[^\n]*\b(?:exec|system):/i,
  /\bbash\s+-i\s*>&/i,
].map(lineRule);

/**
 * nc/ncat/netcat run as a program with an exec flag. Token-based, so the text
 * `nc -e` inside a grep pattern or a string is not mistaken for a command.
 * Case-sensitive: nc flags are case-significant (`-C` is CRLF, not `-c`).
 */
/** nc/ncat/netcat run as a program (not the letters inside a grep pattern). */
function runsNetcat(command: string): boolean {
  return (
    /\b(?:nc|ncat|netcat)\b/i.test(command) &&
    commandPrograms(command).some(({ program }) => /^(?:nc|ncat|netcat)$/.test(program))
  );
}

function isNetcatExec(command: string): boolean {
  if (!/\b(?:nc|ncat|netcat)\b/.test(command)) return false;
  return commandPrograms(command).some(
    ({ program, args }) =>
      /^(?:nc|ncat|netcat)$/.test(program) &&
      args.some((a) => /^(?:-[a-zA-Z]*[ec]|--exec|--sh-exec|-e\S+|-c\S+)$/.test(a)),
  );
}

/**
 * python -c / perl -e one-liners that open a network socket and connect/spawn.
 * `socket.socketpair()` (local IPC) and a `sandbox-exec` wrapper are not that.
 */
function isScriptReverseShell(command: string): boolean {
  if (!/\b(?:python[\d.]*\s+-c|perl\s+-e)\b/i.test(command)) return false;
  return (
    /\bsocket\.(?:socket|create_connection)\b|\bsocket\s*\(|IO::Socket/i.test(command) &&
    /\b(?:connect|subprocess|pty|dup2)\b|(?<![\w-])exec\w*\s*\(/i.test(command)
  );
}

const SECRET_SOURCES: readonly RegExp[] = [
  /~\/\.ssh\//,
  /\.ssh\//,
  /\bid_(?:rsa|ed25519|ecdsa|dsa)\b/,
  /\.aws\/credentials\b/,
  /\.gg\/auth\.json\b/,
  /\.netrc\b/,
  /\.npmrc\b/,
  // `.env` / `.env.local` as a path component, but not `.env.example`/`.env.sample`.
  /(?:^|[\s/'"=@<])\.env(?!\.(?:example|sample|template|dist)\b)(?:\.[\w-]+)?(?=$|[\s'"|;&)>])/,
  /\bsecurity\s+find-(?:generic|internet)-password\b/,
  /(?:^|[;&|(]\s*)(?:printenv|env)\s*(?:\||$)/m,
];

const NETWORK_SINKS = [
  // Case-sensitive: `-f`/`-t`/`-D` are not upload flags. A short cluster such
  // as `-sd` counts only when the data flag is last (it takes the value).
  // The flag must belong to the same simple command as curl: `cut -d=` or
  // `psql -d db` after `curl …/health &&` is not an upload.
  /\bcurl\b[^;&|\n]*\s(?:-[a-zA-Z]*[dFT]|--data(?:-\w+)?|--form(?:-string)?|--upload-file)(?=[\s=@'"]|$)/,
  /\bcurl\b[^;&|\n]*\s@\S/i,
  /\bwget\b[^;&|\n]*--post-(?:data|file)\b/i,
  /\b(?:scp|rsync)\b[^;&|\n]*\s[\w.@-]+:/i,
  /\bxargs\b[^;&|\n]*\b(?:curl|wget)\b/i,
  /\bfind\b[^;&|\n]*-exec\s+(?:curl|wget)\b/i,
].map(lineRule);

// eslint-disable-next-line no-control-regex -- matching ESC is the point
const TERMINAL_TRICK = /[\u001b\u202a-\u202e\u2066-\u2069\u200b-\u200d\u2060\ufeff]/gu;

/**
 * First hiding character, skipping a zero-width (non-)joiner between two
 * non-ASCII characters (emoji ZWJ sequences, Persian/Indic text shaping):
 * those can't disguise ASCII shell code.
 */
function terminalTrick(command: string): string | null {
  TERMINAL_TRICK.lastIndex = 0;
  for (let m = TERMINAL_TRICK.exec(command); m; m = TERMINAL_TRICK.exec(command)) {
    const ch = m[0];
    if (ch === "\u200c" || ch === "\u200d") {
      const prev = command.charCodeAt(m.index - 1);
      const next = command.charCodeAt(m.index + 1);
      if (prev > 0x7f && next > 0x7f && next !== 0x200c && next !== 0x200d) continue;
    }
    return ch;
  }
  return null;
}

function codepoint(ch: string): string {
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Programs whose bare dotted operands are hostnames (`ping аpple.com`). */
const NETWORK_PROGRAMS = new Set([
  "curl",
  "wget",
  "ping",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "git",
  "nc",
  "ncat",
  "netcat",
  "telnet",
  "ftp",
  "dig",
  "nslookup",
  "host",
  "http",
  "https",
]);

/**
 * Candidate hostnames: URL authorities anywhere, plus bare dotted operands of
 * network programs only — so non-ASCII file names (`cat résumé.pdf`) pass.
 */
function candidateHosts(command: string): string[] {
  const out = new Set<string>();
  for (const m of command.matchAll(
    /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/(?:[^@\s/'"]*@)?([^\s/:'"?#]+)/giu,
  )) {
    if (m[1]) out.add(m[1].toLowerCase());
  }
  for (const segment of command.split(/(?:&&|\|\||[;|\n])/)) {
    const tokens = segment.split(/[\s'"()<>]+/).filter((t) => t.length > 0);
    if (tokens[0] === "sudo") tokens.shift();
    const program = (tokens[0] ?? "").split("/").pop() ?? "";
    if (!NETWORK_PROGRAMS.has(program)) continue;
    for (const token of tokens.slice(1)) {
      const bare = token.replace(/^[\w.-]*@/, "").split(/[/:?#]/)[0] ?? "";
      if (/^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u.test(bare) && /\p{L}/u.test(bare)) {
        out.add(bare.toLowerCase());
      }
    }
  }
  for (const host of extractCommandHosts(command)) out.add(host);
  return [...out];
}

function lookalikeThreats(command: string): ShellThreat[] {
  const threats: ShellThreat[] = [];
  const seen = new Set<string>();
  for (const host of candidateHosts(command)) {
    const nonAscii = /[^\p{ASCII}]/u.test(host);
    const punycodeLabel = host.split(".").some((label) => label.startsWith("xn--"));
    if (!nonAscii && !punycodeLabel) continue;
    const ascii = nonAscii ? (hostFromUrl(`http://${host}`) ?? host) : host;
    if (seen.has(ascii)) continue;
    seen.add(ascii);
    threats.push({
      rule: "lookalike-host",
      severity: "block",
      detail: nonAscii
        ? `host "${host}" contains non-ASCII characters (resolves as ${ascii}) — likely a lookalike of a real domain`
        : `host "${host}" uses a punycode (xn--) label — likely a lookalike of a real domain`,
    });
  }
  return threats;
}

export function checkShellThreats(raw: string): ShellThreat[] {
  const threats: ShellThreat[] = [];
  // Heredoc bodies that can't run (data for `cat > notes.md`, a python edit
  // script with no process/network calls) are not commands.
  const command = stripInertHeredocs(raw);

  const trick = terminalTrick(command);
  if (trick) {
    threats.push({
      rule: "terminal-tricks",
      severity: "block",
      detail: `command contains invisible/control character ${codepoint(trick)} (ANSI escape, bidi override or zero-width) that can hide what actually runs`,
    });
  }

  if (PIPE_TO_SHELL.some((re) => re.test(command))) {
    threats.push({
      rule: "pipe-to-shell",
      severity: "block",
      detail:
        "remote content is executed directly by a shell/interpreter. Download it to a file first " +
        "(e.g. `curl -fsSL -o install.sh <url>`), read it, then run it.",
    });
  }

  if (
    REVERSE_SHELL.some((re) => re.test(command)) ||
    isNetcatExec(command) ||
    isScriptReverseShell(command)
  ) {
    threats.push({
      rule: "reverse-shell",
      severity: "block",
      detail: "command matches a reverse-shell pattern (remote shell access over a socket)",
    });
  }

  if (
    SECRET_SOURCES.some((re) => re.test(command)) &&
    (NETWORK_SINKS.some((re) => re.test(command)) || runsNetcat(command)) &&
    // A key from .env sent to its own provider API or a local dev server.
    !sendsOnlyToTrustedHosts(command)
  ) {
    threats.push({
      rule: "secret-exfil",
      severity: "block",
      detail:
        "command reads secret material (keys, credentials, .env, environment) and sends data over the network",
    });
  }

  threats.push(...lookalikeThreats(command));
  threats.push(...checkActionThreats(command));
  return threats;
}

/** First blocking threat as a refusal message, or null when the command may run. */
export function shellThreatBlockMessage(command: string): string | null {
  const threat = checkShellThreats(command).find((t) => t.severity === "block");
  return threat
    ? `Blocked by shell safety check (${threat.rule}): ${threat.detail} ${SAFETY_BLOCK_NOTE}`
    : null;
}
