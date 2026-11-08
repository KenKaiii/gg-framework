/**
 * Action guards (gg-safe A1, A2, P6): prompt injection can't be detected
 * reliably, so block the harmful ACTIONS an injected instruction would try.
 *
 * - A1 exfil: uploads to known collection hosts, credential-shaped literals
 *   sent to a host that isn't that credential's provider, DNS-label exfil
 *   (CVE-2025-55284).
 * - A2 auto-run switches: writes that turn on auto-approve / permission bypass
 *   in another tool's config, fetch-and-exec lines in shell startup files or
 *   git hooks, writes to GG's own auth file, settings that switch GG guards off.
 * - P6: launching another AI CLI with its safety disabled (Nx s1ngularity).
 *
 * Pure, local, synchronous regex/token checks — no I/O, no network.
 */
import type { ShellThreat } from "./shell-threats.js";

/**
 * Appended to every safety block the agent receives. The user may be away and
 * the step line is gone when the run ends, so the agent's reply is the lasting
 * record: it carries on without the blocked step and says so in plain words.
 */
const SAFETY_BLOCK_RESULT =
  /^(?:Error: )?Blocked (?:install|by (?:shell|action) safety check) \(([a-z-]+)\)/;

/** The rule of a guard's block when `result` is one (tool results start with it), else null. */
export function parseSafetyBlock(result: string): string | null {
  return SAFETY_BLOCK_RESULT.exec(result)?.[1] ?? null;
}

export const SAFETY_BLOCK_NOTE =
  "Kleio Coder blocked this for the user's safety. Carry on without it, and tell the user in one plain sentence in your final reply what was blocked and what you did instead.";

// ─── Shell helpers ──────────────────────────────────────────────────────────

/** Quote-aware split of one shell segment into words (quotes removed). */
function shellWords(segment: string): string[] {
  const words: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  let escaped = false;
  for (const ch of segment) {
    if (escaped) {
      cur += ch;
      has = true;
      escaped = false;
    } else if (ch === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (has) words.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) words.push(cur);
  return words;
}

/**
 * Split a command into top-level simple commands on `; & | && || newline`,
 * keeping `$(…)`, backticks and quoted text intact.
 */
function shellSegments(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let quote: string | null = null;
  let backtick = false;
  let escaped = false;
  for (const ch of command) {
    if (escaped) {
      escaped = false;
      cur += ch;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      cur += ch;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "`") {
      backtick = !backtick;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")" && depth > 0) {
      depth--;
    } else if (
      depth === 0 &&
      !backtick &&
      (ch === ";" || ch === "&" || ch === "|" || ch === "\n")
    ) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const WRAPPERS = new Set(["sudo", "env", "command", "exec", "nohup", "time", "doas"]);
/** Shell keywords that precede the real program (`for …; do curl …`). */
const KEYWORDS = new Set(["do", "then", "else", "elif", "!", "{", "("]);
const RUNNERS = new Set(["npx", "bunx", "pnpx"]);
const PACKAGE_BINARIES: Record<string, string> = {
  "@anthropic-ai/claude-code": "claude",
  "@google/gemini-cli": "gemini",
  "@openai/codex": "codex",
};

/** The program a segment runs, and its arguments (wrappers/env stripped). */
function programOf(words: readonly string[]): { program: string; args: string[] } {
  let i = 0;
  for (;;) {
    const w = words[i];
    if (w === undefined) return { program: "", args: [] };
    if (
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(w) ||
      WRAPPERS.has(w) ||
      KEYWORDS.has(w) ||
      /^[\w-]+\(\)$/.test(w)
    ) {
      i++;
      continue;
    }
    if (
      RUNNERS.has(w) ||
      ((w === "pnpm" || w === "yarn" || w === "bun") && /^(?:dlx|exec|x)$/.test(words[i + 1] ?? ""))
    ) {
      i += RUNNERS.has(w) ? 1 : 2;
      while ((words[i] ?? "").startsWith("-")) i++;
      continue;
    }
    break;
  }
  const raw = words[i] ?? "";
  const pkg = raw.replace(/(?!^)@[^/]*$/, "");
  const base =
    PACKAGE_BINARIES[pkg] ?? (raw.split(/[\\/]/).pop() ?? "").replace(/\.(?:exe|cmd)$/i, "");
  return { program: base.toLowerCase(), args: words.slice(i + 1) };
}

/** Every simple command in `command`, including scripts passed to `sh -c`. */
function simpleCommands(command: string, depth = 0): { program: string; args: string[] }[] {
  const out: { program: string; args: string[] }[] = [];
  for (const segment of shellSegments(command)) {
    const parsed = programOf(shellWords(segment));
    out.push(parsed);
    if (depth < 2 && /^(?:sh|bash|zsh|dash|ksh|fish|pwsh|powershell)$/.test(parsed.program)) {
      const c = parsed.args.findIndex((a) => /^-\w*c$/.test(a) || /^-command$/i.test(a));
      const script = c >= 0 ? parsed.args[c + 1] : undefined;
      if (script) out.push(...simpleCommands(script, depth + 1));
    }
  }
  return out;
}

/** Every simple command (program + args) in `command`; exported for shell-threats. */
export function commandPrograms(command: string): { program: string; args: string[] }[] {
  return simpleCommands(command);
}

// ─── Heredoc bodies that never run ─────────────────────────────────────────

/** Code that can run commands or reach the network from a script body. */
const EXEC_CAPABLE =
  /\b(?:os\.(?:system|popen|exec\w*|spawn\w*|fork)|subprocess|import\s+pty|from\s+pty|pty\.spawn|commands\.getoutput|child_process|(?<![.\w])exec(?:Sync|File\w*)?\s*\(|\.exec(?:Sync|File\w*)\s*\(|spawn(?:Sync)?\s*\(|eval\s*\(|Function\s*\(|system\s*\(|Bun\.(?:spawn|\$)|Deno\.(?:run|Command)|socket|urllib|requests\.|httpx|aiohttp|http\.client|fetch\s*\(|https?\.(?:request|get)\s*\(|XMLHttpRequest|net\.connect|import\s*\(|require\s*\(\s*["'](?:node:)?(?:net|http|https|dgram|tls))/;

/** Interpreters whose stdin script is checked for exec capability. Shells/perl/ruby always scan. */
const SCRIPT_INTERPRETERS = /^(?:python[\d.]*|node|tsx|ts-node|deno|bun)$/;
const DATA_WRITERS = /^(?:cat|tee)$/;
const SHELL_SCRIPT_EXT = /(?:\.(?:sh|bash|zsh|ksh|command|ps1|bat|cmd|pl|rb)|\/[^./]*)$/i;

const HEREDOC = /<<(-?)[ \t]*(?:(['"])([A-Za-z_][\w-]*)\2|\\?([A-Za-z_][\w-]*))/g;

/**
 * `command` with the bodies of heredocs that can't run anything replaced by
 * blank lines: data written by `cat`/`tee` to a file that is not run later,
 * and scripts fed to python/node/… that have no way to spawn a process or use
 * the network (the shell text inside them is string data). Bodies fed to a
 * shell, piped onward, executed afterwards, or (unquoted delimiter) holding
 * `$(…)`/backticks are kept, so nothing that runs escapes the checks.
 */
export function stripInertHeredocs(command: string): string {
  if (!command.includes("<<")) return command;
  let out = "";
  let pos = 0;
  let lastUse: Map<string, number> | undefined;
  HEREDOC.lastIndex = 0;
  for (let m = HEREDOC.exec(command); m; m = HEREDOC.exec(command)) {
    if (m.index < pos) continue;
    const delim = m[3] ?? m[4] ?? "";
    const quoted = m[3] !== undefined || command[m.index + 2 + m[1]!.length] === "\\";
    const lineEnd = command.indexOf("\n", m.index);
    if (lineEnd < 0) break;
    const tabs = m[1] === "-";
    // Find the terminating line (one linear regex scan, no per-line slicing).
    const term = new RegExp(`^${tabs ? "\\t*" : ""}${delim}$`, "gm");
    term.lastIndex = lineEnd + 1;
    const t = term.exec(command);
    const bodyEnd = t ? t.index : -1;
    const after = t ? t.index + t[0].length : -1;
    if (bodyEnd < 0) break;
    const body = command.slice(lineEnd + 1, bodyEnd);
    const lineStart = command.lastIndexOf("\n", m.index) + 1;
    const head = command.slice(lineStart, m.index);
    const tail = command.slice(m.index + m[0].length, lineEnd);
    const usedLater = (needle: string) =>
      ((lastUse ??= wordLastUse(command)).get(needle) ?? -1) > after;
    const fnBody = (name: string): string | null => {
      // `name() { … }` defined earlier in the command (the `mk(){ cat > "$1"; }` idiom).
      const at = name ? command.lastIndexOf(`${name}()`, lineStart) : -1;
      if (at < 0) return null;
      const open = command.indexOf("{", at);
      const close = open < 0 ? -1 : command.indexOf("}", open);
      return close < 0 || close > lineStart ? null : command.slice(open + 1, close);
    };
    if (heredocIsInert(head, tail, body, quoted, usedLater, fnBody)) {
      out += command.slice(pos, lineEnd + 1) + body.replace(/[^\n]/g, "");
      pos = bodyEnd;
    }
    HEREDOC.lastIndex = Math.max(after, m.index + 1);
  }
  return pos === 0 ? command : out + command.slice(pos);
}

/** Last offset of each word (split on shell punctuation and path slashes); one pass. */
function wordLastUse(command: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of command.matchAll(/[^\s"'`;&|()<>=\\/]+/g)) out.set(m[0], m.index);
  return out;
}

function heredocIsInert(
  head: string,
  tail: string,
  body: string,
  quoted: boolean,
  usedLater: (needle: string) => boolean,
  fnBody: (name: string) => string | null,
): boolean {
  if (!quoted && /\$\(|`/.test(body)) return false;
  // Piped or chained onward on the same line (`cat <<EOF | sh`, `<<EOF && bash`).
  if (/[|&;]|<</.test(tail.replace(/>{1,2}\s*\S+/g, ""))) return false;
  const segs = shellSegments(head);
  const seg = segs[segs.length - 1] ?? "";
  const { program, args } = programOf(shellWords(seg));
  const fn = DATA_WRITERS.test(program) || !/^[\w-]+$/.test(program) ? null : fnBody(program);
  const writer =
    DATA_WRITERS.test(program) ||
    (fn !== null &&
      simpleCommands(fn).every((c) =>
        /^(?:cat|tee|mkdir|dirname|echo|printf|:|)$/.test(c.program),
      ));
  if (writer) {
    const target =
      /(?:^|\s)>{1,2}\s*["']?([^\s"';|&<>]+)/.exec(`${seg} ${tail}`)?.[1] ??
      (program === "tee" ? args.find((a) => !a.startsWith("-")) : undefined);
    const base = target?.split(/[\\/]/).pop();
    if (!target || !base) return !EXEC_CAPABLE.test(body);
    if (!usedLater(base)) return true;
    // The written file is used later: treat it as the script it is.
    return !SHELL_SCRIPT_EXT.test(target) && !/^\.?[^.]*$/.test(base) && !EXEC_CAPABLE.test(body);
  }
  if (SCRIPT_INTERPRETERS.test(program)) return !EXEC_CAPABLE.test(body);
  return false;
}

// ─── Destinations that are the user's own or a provider API ────────────────

/** LLM/API provider hosts that take a key in a header (the key's own service). */
const PROVIDER_API_HOSTS = [
  "openrouter.ai",
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "api.mistral.ai",
  "api.groq.com",
  "api.together.xyz",
  "api.deepseek.com",
  "api.x.ai",
  "api.z.ai",
  "open.bigmodel.cn",
  "api.moonshot.ai",
  "api.moonshot.cn",
  "api.fireworks.ai",
  "api.cohere.com",
  "api.perplexity.ai",
  "api.minimax.io",
  "api.cerebras.ai",
  "api.elevenlabs.io",
  "api.replicate.com",
  "api-inference.huggingface.co",
];

function urlHost(u: string): string | undefined {
  try {
    return new URL(u).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

function isLocalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "::1" ||
    h === "0.0.0.0" ||
    h === "host.docker.internal" ||
    (IPV4.test(h) && isPrivateIpv4(h))
  );
}

/**
 * True when every program in `command` that sends data (curl/wget with a body
 * or upload, xh/http) targets only the local machine / private network or a
 * known provider API, and nothing ships data any other way (scp/rsync/nc…).
 * Used to let `.env`-keyed calls to the key's own API or a local dev server
 * through. `$VAR` URLs resolve through `VAR=…` assignments in the command;
 * an unresolved destination is never trusted.
 */
export function sendsOnlyToTrustedHosts(command: string): boolean {
  const vars = new Map<string, string[]>();
  const addVar = (name: string, value: string) =>
    vars.set(name, [...(vars.get(name) ?? []), value]);
  for (const m of command.matchAll(
    /(?:^|[\s;&(])([A-Za-z_]\w*)=(["']?)(https?:\/\/[^\s"';&|)]+)\2/g,
  ))
    if (m[1] && m[3]) addVar(m[1], m[3]);
  for (const m of command.matchAll(/\bfor\s+([A-Za-z_]\w*)\s+in\s+([^;\n]*)/g))
    for (const v of (m[2] ?? "").split(/\s+/))
      if (/^["']?https?:\/\//.test(v) && m[1]) addVar(m[1], v.replace(/^["']|["']$/g, ""));
  let fetchers = 0;
  for (const { program, args } of commandPrograms(command)) {
    if (/^(?:scp|rsync|sftp|nc|ncat|netcat|socat|telnet|ftp)$/.test(program)) return false;
    if (!/^(?:curl|wget|xh|http|https)$/.test(program)) continue;
    fetchers++;
    const urls = args
      .filter((a) => !a.startsWith("-"))
      .flatMap((a) => {
        const v = /^\$\{?([A-Za-z_]\w*)\}?/.exec(a);
        if (!v) return [a];
        const values = vars.get(v[1] ?? "");
        // A bare `"$body"` is data (after -d); `$BASE/path` is a destination.
        if (!values && v[0].length === a.length) return [];
        // An unresolved $VAR destination is unknown, so never trusted.
        return values ? values.map((x) => x + a.slice(v[0].length)) : ["unresolved://"];
      })
      .filter((a) => /^[a-z]+:\/\//i.test(a) || /^[\w.-]+\.[a-z]{2,}(?::\d+)?\//i.test(a));
    if (urls.length === 0) return false;
    for (const u of urls) {
      const host = urlHost(/^https?:/i.test(u) ? u : /:\/\//.test(u) ? "" : `http://${u}`);
      if (!host) return false;
      if (!isLocalHost(host) && !PROVIDER_API_HOSTS.some((d) => host === d)) return false;
    }
  }
  return fetchers > 0;
}

function block(rule: string, detail: string): ShellThreat {
  return { rule, severity: "block", detail };
}

// ─── Linear-time "HEAD …gap… TAIL" rules ────────────────────────────────────

/** A compiled rule: `test` like RegExp, `count` = non-overlapping matches. */
export interface LineRule {
  test(text: string): boolean;
  count(text: string): number;
}

const GAP = /\[\^([^\]]*\\n)\]\*\??/;

/**
 * Compile `HEAD[^…\n]*TAIL` so it runs in linear time. As one regex it tries
 * every HEAD occurrence and scans to the line end from each (100 KB of
 * `curl curl …` took 2.5 s). The first HEAD on a line covers every later one,
 * so only that one is tried: same verdict and same match count. Regexes
 * without such a gap are used as-is.
 */
export function lineRule(re: RegExp): LineRule {
  const flags = re.flags.replace(/[gy]/g, "");
  const gap = GAP.exec(re.source);
  if (!gap || gap.index === 0) {
    const g = new RegExp(re.source, `${flags}g`);
    return {
      test: (t) => {
        g.lastIndex = 0;
        return g.test(t);
      },
      count: (t) => {
        g.lastIndex = 0;
        return t.match(g)?.length ?? 0;
      },
    };
  }
  const head = new RegExp(re.source.slice(0, gap.index), `${flags}g`);
  const rest = new RegExp(re.source.slice(gap.index), `${flags}y`);
  const stop = new RegExp(`[${(gap[1] ?? "").replace(/^\^?/, "")}]`, "g");
  const count = (text: string, max: number): number => {
    let n = 0;
    head.lastIndex = 0;
    for (let m = head.exec(text); m && n < max; m = head.exec(text)) {
      const end = m.index + m[0].length;
      rest.lastIndex = end;
      if (rest.test(text)) {
        n++;
        head.lastIndex = Math.max(rest.lastIndex, end + (m[0].length === 0 ? 1 : 0));
        continue;
      }
      stop.lastIndex = end;
      const s = stop.exec(text);
      if (!s) break;
      head.lastIndex = s.index + 1;
    }
    return n;
  };
  return { test: (t) => count(t, 1) > 0, count: (t) => count(t, Number.MAX_SAFE_INTEGER) };
}

// ─── A1: exfil hosts ────────────────────────────────────────────────────────

/** Request-collection / tunnel / paste services used as exfil drops. */
const EXFIL_DOMAINS = [
  "webhook.site",
  "pipedream.net",
  "requestbin.com",
  "requestbin.net",
  "requestcatcher.com",
  "hookbin.com",
  "beeceptor.com",
  "ngrok.io",
  "ngrok.app",
  "ngrok-free.app",
  "ngrok-free.dev",
  "interact.sh",
  "interactsh.com",
  "oast.pro",
  "oast.live",
  "oast.site",
  "oast.online",
  "oast.fun",
  "oast.me",
  "oastify.com",
  "burpcollaborator.net",
  "canarytokens.com",
  "transfer.sh",
];

/** Exfil sinks identified by host + path (the host itself is legitimate). */
const EXFIL_PATHS: readonly { host: RegExp; path: RegExp; label: string }[] = [
  { host: /^(?:www\.)?pastebin\.com$/, path: /^\/api\b/i, label: "pastebin.com API" },
  {
    host: /^(?:[\w-]+\.)?discord(?:app)?\.com$/,
    path: /^\/api\/(?:v\d+\/)?webhooks\b/i,
    label: "Discord webhook",
  },
];

function matchesDomain(host: string, domains: readonly string[]): string | undefined {
  return domains.find((d) => host === d || host.endsWith(`.${d}`));
}

function isPrivateIpv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  const [a = 0, b = 0] = p;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** Bare `name.ext` operands that are files, not hosts. */
const FILE_EXTENSIONS = new Set(
  "json txt js mjs cjs ts tsx md yml yaml xml csv log tar gz tgz zip html htm py rb go rs toml lock env pem key crt bin out tmp png jpg jpeg gif svg pdf".split(
    " ",
  ),
);

interface Target {
  host: string;
  path: string;
}

/** URL-ish targets in a command: scheme URLs anywhere + bare host/path args of fetchers. */
function commandTargets(command: string): Target[] {
  const out: Target[] = [];
  for (const m of command.matchAll(
    /(?<![\w+.-])[a-z][a-z0-9+.-]*:\/\/(?:[^@\s/'"]*@)?([^\s/:'"?#]+)(?::\d+)?([^\s'"]*)/gi,
  )) {
    if (m[1]) out.push({ host: m[1].toLowerCase(), path: m[2] ?? "" });
  }
  for (const { program, args } of simpleCommands(command)) {
    if (!/^(?:curl|wget|http|https|xh|nc|ncat|netcat|telnet)$/.test(program)) continue;
    for (const a of args) {
      if (a.startsWith("-") || a.startsWith("@") || a.includes("://")) continue;
      const m = /^(?:[\w.-]+@)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?(\/\S*)?$/i.exec(a);
      const host = m?.[1]?.toLowerCase();
      if (!host) continue;
      const tld = host.split(".").pop() ?? "";
      if (IPV4.test(host) || (/^[a-z]{2,}$/.test(tld) && !FILE_EXTENSIONS.has(tld))) {
        out.push({ host, path: m?.[2] ?? "" });
      }
    }
  }
  return out;
}

/** Why `target` is an exfil drop, or null. */
function exfilSink(t: Target): string | null {
  const domain = matchesDomain(t.host, EXFIL_DOMAINS);
  if (domain) return domain;
  for (const p of EXFIL_PATHS) if (p.host.test(t.host) && p.path.test(t.path)) return p.label;
  if (IPV4.test(t.host) && !isPrivateIpv4(t.host)) return `raw IP ${t.host}`;
  return null;
}

/** Data leaves with the request: body/upload flags, or substitution/$VAR in the command. */
const DATA_SEND: readonly RegExp[] = [
  /\s(?:-[a-zA-Z]*[dFT]|--data(?:-\w+)?|--form(?:-string)?|--upload-file|--json)(?=[\s=@'"]|$)/,
  /\s@[^\s]/,
  /--(?:post|body)-(?:data|file)\b/i,
  /\s-X\s*(?:POST|PUT|PATCH)\b/i,
  /\$\(|`|\$\{?[A-Za-z_]/,
];

function exfilHostThreats(command: string): ShellThreat[] {
  if (
    !/\b(?:curl|wget|http|https|xh|nc|ncat|netcat|telnet|iwr|irm|invoke-webrequest|invoke-restmethod)\b/i.test(
      command,
    )
  )
    return [];
  if (!DATA_SEND.some((re) => re.test(command))) return [];
  for (const t of commandTargets(command)) {
    const sink = exfilSink(t);
    if (sink) {
      return [
        block(
          "exfil-host",
          `command sends data to ${sink}, a request-collection/tunnel/paste service used to steal data. Don't upload there; if the user needs to share output, write it to a local file for them.`,
        ),
      ];
    }
  }
  return [];
}

// ─── A1: credential literals ────────────────────────────────────────────────

const CREDENTIALS: readonly { name: string; re: RegExp; hosts: readonly string[] }[] = [
  {
    name: "Anthropic API key",
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}/,
    hosts: ["anthropic.com", "claude.ai"],
  },
  { name: "OpenAI API key", re: /\bsk-proj-[A-Za-z0-9_-]{20,}/, hosts: ["openai.com"] },
  {
    name: "GitHub token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/,
    hosts: ["github.com", "githubusercontent.com", "ghcr.io"],
  },
  { name: "GitLab token", re: /\bglpat-[A-Za-z0-9_-]{20,}/, hosts: ["gitlab.com", "gitlab"] },
  { name: "Slack token", re: /\bxox[bpoas]-[A-Za-z0-9-]{10,}/, hosts: ["slack.com"] },
  {
    name: "AWS access key",
    re: /\bAKIA[0-9A-Z]{16}\b/,
    hosts: ["amazonaws.com", "aws.amazon.com"],
  },
  {
    name: "Google API key",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/,
    hosts: ["googleapis.com", "google.com"],
  },
  { name: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/, hosts: ["npmjs.org", "npmjs.com"] },
];

function isProviderHost(host: string, hosts: readonly string[]): boolean {
  if (host === "localhost" || (IPV4.test(host) && isPrivateIpv4(host))) return true;
  // "gitlab" = any self-hosted GitLab (gitlab.example.com).
  return hosts.some((d) =>
    d.includes(".") ? host === d || host.endsWith(`.${d}`) : host.split(".").includes(d),
  );
}

function foreignCredentialHost(text: string, targets: readonly Target[]): string | null {
  for (const cred of CREDENTIALS) {
    if (!cred.re.test(text)) continue;
    const foreign = targets.find((t) => !isProviderHost(t.host, cred.hosts));
    if (foreign)
      return `a literal ${cred.name} is sent to ${foreign.host}, which is not that key's provider`;
  }
  return null;
}

function credentialThreats(command: string): ShellThreat[] {
  if (!CREDENTIALS.some((c) => c.re.test(command))) return [];
  const why = foreignCredentialHost(command, commandTargets(command));
  return why
    ? [
        block(
          "secret-literal-exfil",
          `${why}. Never send credentials to other hosts; reference the key by its env var and only call the provider's own API.`,
        ),
      ]
    : [];
}

// ─── A1: DNS exfil ──────────────────────────────────────────────────────────

const DNS_TOOLS =
  /^(?:ping6?|dig|nslookup|host|drill|getent|traceroute6?|tracepath|tracert|mtr|resolve-dnsname)$/;

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

/** A DNS label that looks like it carries encoded data. */
function suspiciousLabel(label: string): boolean {
  const l = label.toLowerCase();
  if (l.length >= 30 && !/^[a-z]+(?:-[a-z]+)*$/.test(l)) return true;
  if (l.length >= 40) return true;
  if (/^[0-9a-f]{16,}$/.test(l) && /\d/.test(l) && /[a-f]/.test(l)) return true;
  return l.length >= 20 && /\d/.test(l) && /[a-z]/.test(l) && entropy(l) >= 3.6;
}

function dnsThreats(command: string): ShellThreat[] {
  for (const segment of shellSegments(command)) {
    const words = shellWords(segment);
    const { program, args } = programOf(words);
    if (!DNS_TOOLS.test(program)) continue;
    const argText = args.join(" ");
    const sub = /\$\(|`/.test(argText);
    const varInName = /\$\{?\w+\}?\.[A-Za-z0-9]|[A-Za-z0-9-]\.\$\{?\w/.test(argText);
    const encoded = args.some(
      (a) =>
        !a.startsWith("-") &&
        !a.startsWith("+") &&
        a.includes(".") &&
        a.replace(/^@/, "").split(".").some(suspiciousLabel),
    );
    if (sub || varInName || encoded) {
      return [
        block(
          "dns-exfil",
          `${program} is given a hostname built from ${sub ? "command output" : varInName ? "a variable" : "an encoded-looking label"}; DNS lookups can smuggle data out to the attacker's nameserver. Use a plain, known hostname.`,
        ),
      ];
    }
  }
  return [];
}

// ─── P6: AI CLIs with safety disabled ───────────────────────────────────────

const AI_CLI_BYPASS: Record<string, (args: readonly string[]) => string | null> = {
  claude: (a) =>
    a.includes("--dangerously-skip-permissions")
      ? "--dangerously-skip-permissions"
      : permissionModeBypass(a)
        ? "--permission-mode bypassPermissions"
        : null,
  agy: (a) =>
    a.includes("--dangerously-skip-permissions") ? "--dangerously-skip-permissions" : null,
  gemini: (a) =>
    a.find((x) => x === "--yolo" || x === "-y") ??
    (a.some(
      (x, i) => x === "--approval-mode=yolo" || (x === "--approval-mode" && a[i + 1] === "yolo"),
    )
      ? "--approval-mode yolo"
      : null),
  q: (a) => (a.includes("--trust-all-tools") ? "--trust-all-tools" : null),
  qchat: (a) => (a.includes("--trust-all-tools") ? "--trust-all-tools" : null),
  codex: (a) =>
    a.find((x) => x === "--dangerously-bypass-approvals-and-sandbox" || x === "--yolo") ?? null,
  "cursor-agent": (a) => a.find((x) => x === "--force" || x === "-f" || x === "--yolo") ?? null,
  agent: (a) => a.find((x) => x === "--force" || x === "--yolo") ?? null,
};

function permissionModeBypass(a: readonly string[]): boolean {
  return a.some(
    (x, i) =>
      /^--permission-mode=bypasspermissions$/i.test(x) ||
      (x === "--permission-mode" && /^bypasspermissions$/i.test(a[i + 1] ?? "")),
  );
}

function aiCliThreats(command: string): ShellThreat[] {
  for (const { program, args } of simpleCommands(command)) {
    const flag = AI_CLI_BYPASS[program]?.(args);
    if (flag) {
      return [
        block(
          "ai-cli-bypass",
          `launching ${program} with ${flag} runs another AI agent with its safety checks off. Do the work yourself, or run ${program} without that flag.`,
        ),
      ];
    }
  }
  return [];
}

// ─── A2: auto-run / guard-off config writes ─────────────────────────────────

export type ConfigKind =
  | "gg-auth"
  | "gg-settings"
  | "vscode-settings"
  | "vscode-tasks"
  | "claude-settings"
  | "cursor-config"
  | "shell-startup"
  | "git-hook";

const SHELL_STARTUP = new Set([
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zlogin",
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".profile",
  ".kshrc",
  "microsoft.powershell_profile.ps1",
  "profile.ps1",
]);

/** Which protected config file `filePath` is (case-insensitive, Windows paths too). */
export function classifyConfigPath(filePath: string): ConfigKind | null {
  const p = filePath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const base = p.split("/").pop() ?? "";
  if (/(?:^|\/)\.gg\/auth\.json$/.test(p)) return "gg-auth";
  if (/(?:^|\/)\.gg\/settings\.json$/.test(p)) return "gg-settings";
  if (/(?:^|\/)\.claude\/settings(?:\.[\w-]+)?\.json$/.test(p)) return "claude-settings";
  if (/(?:^|\/)\.vscode\/tasks\.json$/.test(p)) return "vscode-tasks";
  if (/(?:^|\/)\.cursor\/[^/]+\.json$/.test(p) || /\/cursor\/user\/settings\.json$/.test(p))
    return "cursor-config";
  if (
    /(?:^|\/)\.vscode\/settings\.json$/.test(p) ||
    /\/(?:code|code - insiders|vscodium|windsurf)\/user\/settings\.json$/.test(p) ||
    base.endsWith(".code-workspace")
  )
    return "vscode-settings";
  if (SHELL_STARTUP.has(base) || /(?:^|\/)fish\/(?:config\.fish|conf\.d\/[^/]+\.fish)$/.test(p))
    return "shell-startup";
  if (/(?:^|\/)\.git\/hooks\/[^/]+$/.test(p) && !base.endsWith(".sample")) return "git-hook";
  return null;
}

/** Separators between a JSON key and value, also when shell-escaped (`\"`). */
const S = String.raw`[\\"'\s]*`;
const ON = String.raw`(?:true|"?on"?|"?always"?)`;

/**
 * Any `key: on` pair; the key is filtered by YOLO_NAME in code. One regex with
 * `[\w.]*yolo[\w.]*` backtracks cubically on long dotted runs (100 KB of
 * `yolo.` took seconds); a single anchored `[\w.]+` stays linear.
 */
const YOLO_KEY = new RegExp(String.raw`(?<![\w.])([\w.]+)${S}:${S}${ON}`, "gi");
const YOLO_NAME = /yolo|auto-?run/i;

const FETCH_EXEC_RES: readonly RegExp[] = [
  /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n]*\|\s*(?:sudo\s+)?(?:[\w./-]*\/)?(?:sh|bash|zsh|dash|ksh|fish|python[\d.]*|node|perl|ruby|iex|invoke-expression)\b/i,
  /\bbase64\s+(?:-d|--decode|-D)\b[^\n]*\|\s*(?:sudo\s+)?(?:[\w./-]*\/)?(?:sh|bash|zsh|dash|python[\d.]*|node|perl|ruby)\b/i,
  /\b(?:sh|bash|zsh|eval|source|\.)\s+[^\n]*?(?:<\(|\$\(|`)\s*(?:curl|wget)\b/i,
  /\bwget\b[^\n]*-O\s*-[^\n]*\|/i,
];

const FETCH_EXEC: readonly LineRule[] = FETCH_EXEC_RES.map((re) =>
  lineRule(new RegExp(re.source, "i")),
);

const CONFIG_RULES: Record<
  Exclude<ConfigKind, "gg-auth">,
  readonly { re: RegExp | LineRule; key?: RegExp; what: string }[]
> = {
  "vscode-settings": [
    {
      re: new RegExp(String.raw`chat\.tools\.(?:global\.)?auto-?approve${S}:${S}true`, "gi"),
      what: "chat.tools.autoApprove (agent runs tools without review)",
    },
    {
      re: new RegExp(String.raw`task\.allowautomatictasks${S}:${S}${ON}`, "gi"),
      what: "task.allowAutomaticTasks (tasks auto-run on folder open)",
    },
    {
      re: new RegExp(String.raw`security\.workspace\.trust\.enabled${S}:${S}false`, "gi"),
      what: "security.workspace.trust.enabled: false",
    },
    {
      re: YOLO_KEY,
      key: YOLO_NAME,
      what: "an auto-run/YOLO setting",
    },
  ],
  "vscode-tasks": [
    {
      re: new RegExp(String.raw`runon${S}:${S}folderopen`, "gi"),
      what: `"runOn": "folderOpen" (task runs when the folder opens)`,
    },
  ],
  "claude-settings": [
    {
      re: new RegExp(String.raw`defaultmode${S}:${S}bypasspermissions`, "gi"),
      what: "defaultMode: bypassPermissions",
    },
    {
      re: new RegExp(String.raw`skipdangerousmodepermissionprompt${S}:${S}true`, "gi"),
      what: "skipDangerousModePermissionPrompt",
    },
    {
      re: new RegExp(String.raw`[\\"']hooks${S}:\s*\{`, "gi"),
      what: "hooks (commands Claude Code runs automatically)",
    },
  ],
  "cursor-config": [
    {
      re: YOLO_KEY,
      key: YOLO_NAME,
      what: "an auto-run/YOLO setting",
    },
    { re: /shell\(\s*\*\s*\)/gi, what: "Shell(*) allow rule (every command auto-approved)" },
  ],
  "shell-startup": FETCH_EXEC.map((re) => ({
    re,
    what: "a download-and-execute line",
  })),
  "git-hook": FETCH_EXEC.map((re) => ({
    re,
    what: "a download-and-execute line",
  })),
  "gg-settings": [
    {
      re: new RegExp(String.raw`packagecooldowndays${S}:${S}0(?![\d.])`, "gi"),
      what: "packageCooldownDays: 0 (package age check off)",
    },
    {
      re: new RegExp(String.raw`networkmode${S}:${S}off`, "gi"),
      what: `networkMode: "off" (network allowlist off)`,
    },
    {
      re: new RegExp(String.raw`sandboxmode${S}:${S}off`, "gi"),
      what: `sandboxMode: "off" (sandbox off)`,
    },
  ],
};

function count(re: RegExp | LineRule, text: string, key?: RegExp): number {
  if (!(re instanceof RegExp)) return re.count(text);
  re.lastIndex = 0;
  if (!key) return text.match(re)?.length ?? 0;
  let n = 0;
  for (const m of text.matchAll(re)) if (key.test(m[1] ?? "")) n++;
  return n;
}

function describe(kind: ConfigKind): string {
  switch (kind) {
    case "gg-auth":
      return "Kleio Coder's credential store";
    case "gg-settings":
      return "Kleio Coder's own safety settings";
    case "shell-startup":
      return "a shell startup file (runs in every new terminal)";
    case "git-hook":
      return "a git hook (runs on every git command)";
    default:
      return "another tool's config";
  }
}

/**
 * Block message when writing `next` to `filePath` (previously `previous`, or
 * undefined for a new file) would switch on auto-execution or switch a guard
 * off. Only NEW occurrences count, so editing a file that already has such a
 * setting (a theme change next to an existing hook) still passes.
 */
export function configWriteBlockMessage(
  filePath: string,
  next: string,
  previous = "",
): string | null {
  const kind = classifyConfigPath(filePath);
  if (!kind) return null;
  if (kind === "gg-auth") {
    return `Blocked by action safety check (gg-auth-write): agents may not write ${filePath}, ${describe(kind)}. Leave it alone; the user signs in through the app. ${SAFETY_BLOCK_NOTE}`;
  }
  for (const { re, key, what } of CONFIG_RULES[kind]) {
    if (count(re, next, key) > count(re, previous, key)) {
      return `Blocked by action safety check (auto-run-config): this write adds ${what} to ${filePath}, ${describe(kind)}, which would let code run without review. Make the rest of the change without it; the user can turn it on themselves. ${SAFETY_BLOCK_NOTE}`;
    }
  }
  return null;
}

/** Files a shell command writes to: `>`/`>>`, tee, sed -i, cp/mv/install destination. */
function shellWriteTargets(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/(?<![<>&\d])>>?\s*(["']?)([^\s"';|&<>]+)\1/g))
    if (m[2]) out.push(m[2]);
  for (const { program, args } of simpleCommands(command)) {
    const operands = args.filter((a) => !a.startsWith("-"));
    if (
      program === "tee" ||
      (program === "sed" && args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a)))
    ) {
      out.push(...operands);
    } else if (
      /^(?:cp|mv|install|ln|copy|copy-item|set-content|add-content|out-file)$/.test(program)
    ) {
      const last = operands[operands.length - 1];
      if (last) out.push(last);
    }
  }
  return out;
}

function configShellThreats(command: string): ShellThreat[] {
  for (const target of shellWriteTargets(command)) {
    const kind = classifyConfigPath(target);
    if (!kind) continue;
    const msg = configWriteBlockMessage(target, command);
    if (msg)
      return [
        block(
          kind === "gg-auth" ? "gg-auth-write" : "auto-run-config",
          msg.replace(/^Blocked by action safety check \([\w-]+\): /, ""),
        ),
      ];
  }
  return [];
}

// ─── Entry points ───────────────────────────────────────────────────────────

/** All action-level threats in a shell command (called from checkShellThreats). */
export function checkActionThreats(command: string): ShellThreat[] {
  return [
    ...exfilHostThreats(command),
    ...credentialThreats(command),
    ...dnsThreats(command),
    ...aiCliThreats(command),
    ...configShellThreats(command),
  ];
}

/** web_fetch: block message for a URL that is an exfil channel, else null. */
export function urlExfilBlockMessage(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const target = {
    host: parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ""),
    path: parsed.pathname,
  };
  const sink = exfilSink(target);
  const carriesData = parsed.search.length > 1 || parsed.pathname.length > 1;
  const rawIp = sink?.startsWith("raw IP");
  if (sink && (rawIp ? parsed.search.length > 1 : carriesData)) {
    return `Blocked by action safety check (exfil-host): ${url} is ${sink}, a request-collection/tunnel/paste endpoint where the URL itself carries data out. Don't fetch it; use the real documentation or API host instead. ${SAFETY_BLOCK_NOTE}`;
  }
  const why = foreignCredentialHost(decodeURIComponentSafe(url), [target]);
  return why
    ? `Blocked by action safety check (secret-literal-exfil): ${why}. Never put credentials in URLs to other hosts. ${SAFETY_BLOCK_NOTE}`
    : null;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
