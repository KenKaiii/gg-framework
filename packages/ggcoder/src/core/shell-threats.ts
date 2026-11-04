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
import { extractCommandHosts, hostFromUrl } from "./network-guard.js";

export interface ShellThreat {
  rule: string;
  severity: "block" | "warn";
  detail: string;
}

const SHELLS =
  "(?:sudo\\s+)?(?:[\\w./-]*/)?(?:sh|bash|zsh|dash|ksh|python[\\d.]*|node|perl|ruby)\\b";
const FETCHERS = "\\b(?:curl|wget)\\b";

const PIPE_TO_SHELL: readonly RegExp[] = [
  // curl … | sh  (any number of intermediate pipeline stages)
  // An interpreter given an inline script (-c/-e/-m/-p) or a script file reads
  // stdin as data (`curl … | python -m json.tool`), so that is not flagged.
  new RegExp(
    `${FETCHERS}[^;&\\n]*\\|\\s*${SHELLS}(?!\\s+(?:-[cmepE]\\b|--eval\\b|--print\\b|[^-\\s|;&]))`,
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
];

const REVERSE_SHELL: readonly RegExp[] = [
  /\/dev\/(?:tcp|udp)\//i,
  // Case-sensitive: nc flags are case-significant (`-C` is CRLF, not `-c`).
  /\b(?:nc|ncat|netcat)\b[^|;&\n]*\s(?:-[a-zA-Z]*[ec]\b|--exec\b|--sh-exec\b|-e\S|-c\S)/,
  /\bsocat\b[^\n]*\b(?:exec|system):/i,
  /\bbash\s+-i\s*>&/i,
];

/** python -c / perl -e one-liners that open a socket and connect/spawn. */
function isScriptReverseShell(command: string): boolean {
  if (!/\b(?:python[\d.]*\s+-c|perl\s+-e)\b/i.test(command)) return false;
  return /\bsocket\b/i.test(command) && /\b(?:connect|subprocess|exec)\b/i.test(command);
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

const NETWORK_SINKS: readonly RegExp[] = [
  // Case-sensitive: `-f`/`-t`/`-D` are not upload flags. A short cluster such
  // as `-sd` counts only when the data flag is last (it takes the value).
  /\bcurl\b[^\n]*\s(?:-[a-zA-Z]*[dFT]|--data(?:-\w+)?|--form(?:-string)?|--upload-file)(?=[\s=@'"]|$)/,
  /\bcurl\b[^\n]*\s@\S/i,
  /\bwget\b[^\n]*--post-(?:data|file)\b/i,
  /\b(?:nc|ncat|netcat)\s/i,
  /\b(?:scp|rsync)\b[^\n]*\s[\w.@-]+:/i,
  /\bxargs\b[^\n]*\b(?:curl|wget)\b/i,
  /\bfind\b[^\n]*-exec\s+(?:curl|wget)\b/i,
];

// eslint-disable-next-line no-control-regex -- matching ESC is the point
const TERMINAL_TRICK = /[\u001b\u202a-\u202e\u2066-\u2069\u200b-\u200d\u2060\ufeff]/u;

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
  for (const m of command.matchAll(/[a-z][a-z0-9+.-]*:\/\/(?:[^@\s/'"]*@)?([^\s/:'"?#]+)/giu)) {
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

export function checkShellThreats(command: string): ShellThreat[] {
  const threats: ShellThreat[] = [];

  const trick = TERMINAL_TRICK.exec(command);
  if (trick) {
    threats.push({
      rule: "terminal-tricks",
      severity: "block",
      detail: `command contains invisible/control character ${codepoint(trick[0])} (ANSI escape, bidi override or zero-width) that can hide what actually runs`,
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

  if (REVERSE_SHELL.some((re) => re.test(command)) || isScriptReverseShell(command)) {
    threats.push({
      rule: "reverse-shell",
      severity: "block",
      detail: "command matches a reverse-shell pattern (remote shell access over a socket)",
    });
  }

  if (
    SECRET_SOURCES.some((re) => re.test(command)) &&
    NETWORK_SINKS.some((re) => re.test(command))
  ) {
    threats.push({
      rule: "secret-exfil",
      severity: "block",
      detail:
        "command reads secret material (keys, credentials, .env, environment) and sends data over the network",
    });
  }

  threats.push(...lookalikeThreats(command));
  return threats;
}

/** First blocking threat as a refusal message, or null when the command may run. */
export function shellThreatBlockMessage(command: string): string | null {
  const threat = checkShellThreats(command).find((t) => t.severity === "block");
  return threat ? `Blocked by shell safety check (${threat.rule}): ${threat.detail}` : null;
}
