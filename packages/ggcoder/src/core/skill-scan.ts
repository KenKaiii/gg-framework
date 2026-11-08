import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Load-time malware scan for skills (gg-safe S1).
 *
 * Few, narrow, high-confidence rules tied to real incidents (ClawHavoc fake
 * "prerequisite" installers, Snyk ToxicSkills droppers and webhook exfil,
 * tag-character smuggling). A hit means the skill is not loaded; there is no
 * prompt. Rules distinguish *instructing* from *describing*: in markdown a
 * line that sits in warning/analysis prose ("never", "attack", "e.g.") is not
 * a hit unless it is under an imperative setup/prerequisite heading. Script
 * files get no such allowance — code runs.
 *
 * Results are cached by content hash in memory and (via `loadSkillScanCacheFile`
 * / `saveSkillScanCacheFile`) on disk, so an unchanged skill costs a file read
 * and a hash, even on a fresh app start.
 */

export type SkillScanRule =
  | "decode-to-shell"
  | "download-to-shell"
  | "quarantine-strip"
  | "reverse-shell"
  | "fake-prerequisite"
  | "credential-exfil"
  | "secret-in-url"
  | "hide-from-user"
  | "invisible-text"
  | "symlink-escape";

export interface SkillScanFinding {
  rule: SkillScanRule;
  /** Path relative to the skill folder. */
  file: string;
  /** 1-based line, 0 when not line-specific. */
  line: number;
  reason: string;
}

/**
 * `hash` (blocked content scans only) is the content hash of everything that
 * was scanned, so a caller can tell "the same blocked skill again" from "a new
 * version of it".
 */
export type SkillScanResult =
  { ok: true } | { ok: false; finding: SkillScanFinding; hash?: string };

export type SkillFileKind = "markdown" | "script";

// ── Shared vocabulary ───────────────────────────────────────────────────────

const INTERPRETER = String.raw`(?:sudo\s+(?:-\S+\s+)*)?(?:(?:\/usr)?\/bin\/)?(?:ba|z|da|k|fi)?sh|python[0-9.]*|perl|ruby|node|php|osascript|iex|Invoke-Expression|eval`;
const DOWNLOADER = String.raw`\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b`;
const URL_RE = /\bhttps?:\/\/[^\s'"`<>)|\\]+/gi;

/** Exfil sinks: request catchers, paste sites, tunnels, file drops. */
const EXFIL_HOSTS = [
  "webhook.site",
  "pipedream.net",
  "requestbin.com",
  "requestbin.net",
  "requestcatcher.com",
  "hookbin.com",
  "beeceptor.com",
  "mockbin.org",
  "ngrok.io",
  "ngrok.app",
  "ngrok-free.app",
  "ngrok.dev",
  "trycloudflare.com",
  "loca.lt",
  "localtunnel.me",
  "serveo.net",
  "pastebin.com",
  "paste.ee",
  "hastebin.com",
  "ghostbin.com",
  "glot.io",
  "transfer.sh",
  "temp.sh",
  "file.io",
  "0x0.st",
  "interact.sh",
  "oast.pro",
  "oast.live",
  "oast.site",
  "oast.online",
  "oast.fun",
  "oast.me",
  "burpcollaborator.net",
];
const SHORTENER_HOSTS = ["bit.ly", "tinyurl.com", "is.gd", "t.co", "rb.gy", "cutt.ly"];

function hostMatches(host: string, list: readonly string[]): boolean {
  return list.some((h) => host === h || host.endsWith(`.${h}`));
}

function isPublicIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 192 && b === 168) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 169 && b === 254) return false;
  return true;
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** A host data should never be sent to: request catcher, paste, tunnel, raw public IP. */
export function isExfilUrl(raw: string): boolean {
  const url = parseUrl(raw);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  if (hostMatches(host, EXFIL_HOSTS) || isPublicIpv4(host)) return true;
  return /(^|\.)discord(?:app)?\.com$/.test(host) && url.pathname.startsWith("/api/webhooks");
}

/** A host nothing should be piped from into a shell. */
function isSuspiciousInstallUrl(raw: string): boolean {
  if (isExfilUrl(raw)) return true;
  const url = parseUrl(raw);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  if (hostMatches(host, SHORTENER_HOSTS)) return true;
  const local = host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host);
  return url.protocol === "http:" && !local;
}

// ── Rules ─────────────────────────────────────────────────────────────────────

const DECODE_TO_SHELL: RegExp[] = [
  new RegExp(
    String.raw`\b(?:base64|openssl\s+(?:base64|enc))\b[^|\n]*?\s(?:-d|-D|--decode)\b[^|\n]*\|\s*(?:${INTERPRETER})\b`,
    "i",
  ),
  new RegExp(String.raw`\bxxd\b[^|\n]*\s-r[^|\n]*\|\s*(?:${INTERPRETER})\b`, "i"),
  /\b(?:eval|exec|(?:ba|z)?sh\s+-c)\s+["']?\$\([^)\n]*\bbase64\b[^)\n]*(?:-d|-D|--decode)\b/i,
  /\b(?:exec|eval)\s*\(\s*(?:base64\.b64decode|atob\s*\(|Buffer\.from\([^)\n]*base64|codecs\.decode|bytes\.fromhex|zlib\.decompress|marshal\.loads)/i,
  /\bFromBase64String\b[^\n]*\|\s*(?:iex|Invoke-Expression)\b|\b(?:iex|Invoke-Expression)\b[^\n]*FromBase64String/i,
  /\bpowershell(?:\.exe)?\b[^\n]*\s-e(?:nc|ncodedcommand)?\s+[A-Za-z0-9+/=]{40,}/i,
];

const REVERSE_SHELL: RegExp[] = [
  /\/dev\/(?:tcp|udp)\/[^\s/]+\/\d+/,
  /\b(?:nc|ncat|netcat)\b[^\n|;]*\s-[a-z]*[ec]\s+\S*(?:sh|bash|cmd(?:\.exe)?)\b/i,
  /\bmkfifo\b[^\n]*\b(?:nc|ncat|netcat)\b/,
  /\bsocat\b[^\n]*\bexec:[^\n]*\b(?:ba)?sh\b/i,
  /\bdup2\s*\(\s*\w+\.fileno\(\)/,
  /\b(?:ba)?sh\s+-i\s*[>&]+/,
];

const DOWNLOAD_PIPE = new RegExp(
  String.raw`${DOWNLOADER}[^\n|]*?(https?:\/\/[^\s'"\x60)|\\]+)[^\n|]*\|\s*(?:${INTERPRETER})\b`,
  "gi",
);
const SHELL_SUBST_DOWNLOAD =
  /\b(?:(?:ba|z)?sh|eval|source|\.)\s+(?:-c\s+)?["']?(?:<\(|\$\()\s*(?:curl|wget)\b[^\n)]*?(https?:\/\/[^\s'"`)|\\]+)/gi;

const QUARANTINE_STRIP: RegExp[] = [
  /\bxattr\b[^\n|;&]*\s-[a-z]*d[a-z]*\b[^\n|;&]*\bcom\.apple\.quarantine\b/i,
  /\bxattr\s+(?:-[a-z]+\s+)*-[a-z]*c[a-z]*(?:\s|$)/i,
  /\bspctl\s+--master-disable\b/i,
];

/** An executable or archive fetched from a sink host, or a password-protected archive. */
const PREREQ_BINARY =
  /\bhttps?:\/\/[^\s'"`)]+\.(?:zip|dmg|pkg|exe|msi|bin|appimage|sh|command|scr|tar\.gz|tgz|7z|rar)\b/i;
const ARCHIVE_PASSWORD =
  /\b(?:zip|archive|rar|7z)\b[^\n]{0,60}\bpassword\b\s*[:=]?\s*[`"']?\w{3,}|\bpassword\b[^\n]{0,20}\b(?:for|to\s+(?:open|extract|unzip))\b[^\n]{0,30}\b(?:zip|archive)\b/i;

const CREDENTIAL_SOURCE =
  /(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|\/Users\/[\w.-]+|\/home\/[\w.-]+)\/\.ssh\b|\bid_(?:rsa|ed25519|ecdsa|dsa)|\.aws\/credentials\b|~\/\.aws\b|\.gg\/auth\.json\b|\.clawdbot\/|\.config\/gh\/hosts|(?:~|\$HOME)\/\.(?:netrc|npmrc|pypirc)\b|\.docker\/config\.json\b|\bsecurity\s+find-(?:generic|internet)-password\b|(?:^|[\s'"`(/=@<])\.env(?:\.local|\.production)?(?![\w.-])|\$\{?[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)\b|process\.env\.[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET)\b|os\.environ(?:\.get\(|\[)\s*['"][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET)/;

const SECRET_IN_URL =
  /\b(?:append|add|attach|include|put)\b[^.\n]{0,80}?\$\{?[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET)\b[^.\n]{0,60}?\b(?:to|in|into|onto)\b[^.\n]{0,30}?\b(?:(?:every|each|all|any)\s+(?:\w+\s+)?(?:urls?|links?|requests?|quer(?:y|ies))|urls|links)\b/i;

/**
 * Wording that orders the agent to keep something from the user. Shared with
 * the MCP tool guard. Each form names the hidden object ("this step", "these
 * instructions") so ordinary advice like "don't tell the user it's done before
 * tests pass" stays clean.
 */
export const HIDE_FROM_USER: readonly RegExp[] = [
  /\b(?:do\s+not|don't|never|must\s+not|should\s+not)\s+(?:mention|disclose|reveal|tell|report|explain|show)\s+(?:this|these|that|it|them|any\s+of\s+(?:this|these|it)|(?:this|these|the)\s+(?:\w+\s+)?(?:step|steps|instruction|instructions|action|actions|request|requests|note|notes|command|commands|part))\s+(?:\w+\s+){0,3}?(?:to|with)\s+(?:the\s+)?user/i,
  /\b(?:do\s+not|don't|never|must\s+not)\s+(?:tell|inform|notify|alert|let)\s+the\s+user\s+(?:know\s+)?(?:about|of)\s+(?:this|these|that|it|the\s+(?:step|instruction|instructions|request|action|file|upload|command))\b/i,
  /\b(?:hide|conceal)\s+(?:this|these|it|them|that)\s+from\s+(?:the\s+)?user\b/i,
  /\bkeep\s+(?:this|these|it|them|that)\s+(?:secret|hidden)\s+from\s+(?:the\s+)?user\b/i,
  /\b(?:silently|quietly|secretly)\b[^.\n]{0,60}\bwithout\s+(?:telling|informing|notifying|alerting)\s+the\s+user\b/i,
  /\bthe\s+user\s+(?:must|should)\s+(?:not|never)\s+(?:know|find\s+out|notice|be\s+(?:told|informed|aware))\b/i,
  /\b(?:do\s+not|don't|never)\s+(?:mention|reveal|disclose)\s+(?:to\s+the\s+user\s+)?that\s+you\s+(?:read|accessed|sent|uploaded|ran|have|did)\b/i,
];

export function findHideFromUser(text: string): string | null {
  for (const re of HIDE_FROM_USER) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

/** Words that mark text as security analysis of an attack (strong signal). */
const ANALYSIS =
  /\b(?:attack(?:er|s)?|malicious|malware|exfiltrat\w*|payloads?|red\s+flags?|threats?|vulnerab\w*|poison\w*|injection|example\s+of|equivalent\s+to|documented)\b/i;
/** Weaker warning words: enough to mark a prose line as describing, not instructing. */
const DESCRIBING =
  /\b(?:never|avoid|dangerous|unsafe|insecure|such\s+as|e\.g\.|for\s+example|detect\w*|flag(?:s|ged)?|block(?:s|ed)?)\b/i;
/** Headings whose body is a set of things to run. */
const IMPERATIVE_HEADING =
  /\b(?:prerequisites?|requirements?|setup|set\s+up|install(?:ation|ing)?|before\s+(?:you|using|use)|getting\s+started|quick\s*start|first\s+steps?|dependencies)\b/i;

// ── Invisible text ──────────────────────────────────────────────────────────

const TAG_FLAG_SEQUENCE = /\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}/gu;
const TAG_CHAR = /[\u{E0000}-\u{E007F}]/u;
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/;
// eslint-disable-next-line no-control-regex -- matching ESC/CSI is the point
const ESCAPE_CHAR = /[\u001B\u009B]/;
const EMOJI_JOINER = /(\p{Extended_Pictographic}\uFE0F?)\u200D(?=\p{Extended_Pictographic})/gu;
const LETTER_JOINER = /([\p{L}\p{M}])[\u200C\u200D](?=[\p{L}\p{M}])/gu;
const ZERO_WIDTH = /[\u200B-\u200D\u2060-\u2064\u206A-\u206F\uFEFF]/gu;

const ANY_INVISIBLE =
  // eslint-disable-next-line no-control-regex -- matching ESC/CSI is the point
  /[\u001B\u009B\u200B-\u200D\u202A-\u202E\u2060-\u2069\u206A-\u206F\uFEFF\uDB40]/;

/**
 * Cheap gates: a line can only match a rule group if it contains that group's
 * mandatory words (case-insensitively), so ordinary prose skips the ~20 rule
 * regexes. Keep each gate a superset of its rules when editing them.
 */
const HAS_URL = /https?:\/\//i;
const HIDE_GATE = /user|mention|reveal|disclose/i;
const HIDE_VERB_GATE =
  /\b(?:not|don't|never|hide|conceal|keep|silently|quietly|secretly)\b|user\s+(?:must|should)/i;
const DECODE_GATE = /base64|openssl|xxd|\b(?:exec|eval)\s*\(|powershell/i;
const REVERSE_GATE = /\/dev\/|\bn(?:c|cat|etcat)\b|mkfifo|socat|dup2|sh\s+-i/i;
const QUARANTINE_GATE = /xattr|spctl/i;
const SECRET_GATE = /\$\{?[a-z][a-z0-9_]*(?:api_key|token|secret)/i;
const PASSWORD_GATE = /password/i;
/** Union of every gate above: one pass rules out most lines. */
const ANY_GATE = new RegExp(
  [HIDE_GATE, DECODE_GATE, REVERSE_GATE, QUARANTINE_GATE, SECRET_GATE, PASSWORD_GATE, HAS_URL]
    .map((re) => re.source)
    .join("|"),
  "i",
);

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Hidden characters in raw text: tag smuggling, bidi, ANSI, zero-width runs. */
export function findInvisibleText(raw: string): { reason: string; index: number } | null {
  // Fast path: none of the code units any rule below looks for (tag chars are
  // the surrogate pair \uDB40 \uDC00-\uDC7F). Almost every file exits here.
  if (!ANY_INVISIBLE.test(raw)) return null;
  const text = raw.charCodeAt(0) === 0xfeff ? ` ${raw.slice(1)}` : raw;
  const withoutFlags = text.replace(TAG_FLAG_SEQUENCE, (m) => " ".repeat(m.length));
  let m = TAG_CHAR.exec(withoutFlags);
  if (m)
    return { reason: "hidden Unicode tag characters (invisible instructions)", index: m.index };
  m = BIDI_CONTROL.exec(text);
  if (m)
    return { reason: "bidirectional control characters that reorder visible text", index: m.index };
  m = ESCAPE_CHAR.exec(text);
  if (m) return { reason: "terminal escape sequences that can hide text", index: m.index };
  const stripped = text.replace(EMOJI_JOINER, "$1 ").replace(LETTER_JOINER, "$1 ");
  const zw = [...stripped.matchAll(ZERO_WIDTH)];
  if (zw.length >= 2) {
    return { reason: `${zw.length} zero-width characters (hidden text)`, index: zw[0]?.index ?? 0 };
  }
  return null;
}

// ── Text scan ───────────────────────────────────────────────────────────────

interface LogicalLine {
  text: string;
  line: number;
  inCode: boolean;
  imperative: boolean;
  /** Paragraph/code-block id, for source+sink pairing. */
  region: number;
  /** Sits in attack-analysis context (this line or the prose just before). */
  analysis: boolean;
  /** Prose line that reads as a warning rather than an instruction. */
  describing: boolean;
}

function splitLines(text: string, kind: SkillFileKind): LogicalLine[] {
  const raw = text.split(/\r?\n/);
  const out: LogicalLine[] = [];
  let inCode = false;
  let imperative = false;
  let region = 0;
  let prevProse = "";
  let prevProseAnalysis = false;
  // Analysis/warning context introduced by a prose line covers the rest of
  // its paragraph, and the list or code block it introduces (line ends ":").
  let ctxAnalysis = false;
  let ctxDescribing = false;
  for (let i = 0; i < raw.length; i++) {
    let current = raw[i] ?? "";
    const start = i + 1;
    // Join shell line continuations so a chain split over lines still matches.
    while (current.includes("\\") && /\\\s*$/.test(current) && i + 1 < raw.length) {
      current = current.replace(/\\\s*$/, " ") + (raw[++i] ?? "");
    }
    if (kind === "script") {
      out.push({
        text: current,
        line: start,
        inCode: true,
        imperative: true,
        region: 0,
        analysis: false,
        describing: false,
      });
      continue;
    }
    const fence = /^\s*(?:```|~~~)/.test(current);
    if (fence) {
      inCode = !inCode;
      region++;
      continue;
    }
    if (!inCode) {
      const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(current);
      if (heading) {
        imperative = IMPERATIVE_HEADING.test(heading[1] ?? "");
        region++;
        prevProse = "";
        prevProseAnalysis = false;
        ctxAnalysis = false;
        ctxDescribing = false;
        continue;
      }
      if (current.trim() === "") {
        region++;
        if (!/:\s*$/.test(prevProse)) {
          ctxAnalysis = false;
          ctxDescribing = false;
        }
        continue;
      }
    }
    // Each regex runs once per line; the previous prose line's result is reused.
    const curAnalysis = ANALYSIS.test(current);
    const curDescribing = !inCode && DESCRIBING.test(current);
    if (!inCode) {
      if (curAnalysis) ctxAnalysis = true;
      if (curDescribing && /:\s*$/.test(current)) ctxDescribing = true;
    }
    const analysis = ctxAnalysis || curAnalysis || prevProseAnalysis;
    const describing = !inCode && (ctxDescribing || curDescribing);
    out.push({ text: current, line: start, inCode, imperative, region, analysis, describing });
    if (!inCode) {
      prevProse = current;
      prevProseAnalysis = curAnalysis;
    }
  }
  return out;
}

function urlsIn(text: string): string[] {
  return [...text.matchAll(URL_RE)].map((m) => m[0]);
}

/**
 * Scan one skill file's raw text. Returns the first finding, or null.
 * `kind: "script"` treats every line as code that runs.
 */
export function scanSkillText(
  raw: string,
  file: string,
  kind: SkillFileKind,
): SkillScanFinding | null {
  const hidden = findInvisibleText(raw);
  if (hidden) {
    return {
      rule: "invisible-text",
      file,
      line: lineOf(raw, hidden.index),
      reason: `contains ${hidden.reason}`,
    };
  }

  const lines = splitLines(raw, kind);
  const at = (rule: SkillScanRule, l: LogicalLine, reason: string): SkillScanFinding => ({
    rule,
    file,
    line: l.line,
    reason,
  });
  // A markdown line counts as an instruction unless it reads as warning or
  // analysis prose outside an imperative setup section.
  const instructs = (l: LogicalLine): boolean =>
    kind === "script" || l.imperative || !(l.analysis || l.describing);

  for (const l of lines) {
    const t = l.text;
    if (!ANY_GATE.test(t)) continue;
    // Hide-from-user wording opens with "never"/"do not", so only attack
    // analysis context (quoting the wording) excuses it.
    const hide =
      kind === "markdown" &&
      (l.imperative || !l.analysis) &&
      HIDE_GATE.test(t) &&
      HIDE_VERB_GATE.test(t)
        ? findHideFromUser(t)
        : null;
    if (hide) {
      return at("hide-from-user", l, `tells the agent to hide actions from the user ("${hide}")`);
    }
    if (!instructs(l)) continue;
    if (DECODE_GATE.test(t) && DECODE_TO_SHELL.some((re) => re.test(t))) {
      return at("decode-to-shell", l, "runs base64/hex-decoded text through a shell or eval");
    }
    if (REVERSE_GATE.test(t) && REVERSE_SHELL.some((re) => re.test(t))) {
      return at("reverse-shell", l, "opens a reverse shell");
    }
    if (QUARANTINE_GATE.test(t) && QUARANTINE_STRIP.some((re) => re.test(t))) {
      return at("quarantine-strip", l, "removes the macOS quarantine flag (Gatekeeper bypass)");
    }
    const hasUrl = HAS_URL.test(t);
    if (hasUrl) {
      for (const re of [DOWNLOAD_PIPE, SHELL_SUBST_DOWNLOAD]) {
        re.lastIndex = 0;
        for (const m of t.matchAll(re)) {
          const url = m[1] ?? "";
          if (isSuspiciousInstallUrl(url)) {
            return at("download-to-shell", l, `pipes a download from ${hostOf(url)} into a shell`);
          }
        }
      }
    }
    if (SECRET_GATE.test(t) && SECRET_IN_URL.test(t)) {
      return at("secret-in-url", l, "tells the agent to append secrets to URLs");
    }
    // Fake prerequisite: an executable/archive from a sink host or a
    // password-protected archive, under an install/setup instruction.
    const hasPassword = PASSWORD_GATE.test(t);
    if (
      kind === "markdown" &&
      (hasUrl || hasPassword) &&
      (l.imperative || /\b(?:download|install|run|open|execute)\b/i.test(t))
    ) {
      const bin = hasUrl ? PREREQ_BINARY.exec(t) : null;
      if (bin && isSuspiciousInstallUrl(bin[0])) {
        return at(
          "fake-prerequisite",
          l,
          `tells you to download and run a binary from ${hostOf(bin[0])}`,
        );
      }
      if (l.imperative && hasPassword && ARCHIVE_PASSWORD.test(t)) {
        return at(
          "fake-prerequisite",
          l,
          "tells you to install a password-protected archive (scanner evasion)",
        );
      }
    }
  }

  // Credential read + send to a sink, in the same script / code block / paragraph.
  // Sinks first: a region with no exfil URL can't pair, and URLs are rare,
  // so only the few regions holding one are searched for a credential read.
  const sinks = new Map<number, LogicalLine>();
  for (const l of lines) {
    if (sinks.has(l.region) || !HAS_URL.test(l.text)) continue;
    if (instructs(l) && urlsIn(l.text).some(isExfilUrl)) sinks.set(l.region, l);
  }
  for (const region of [...sinks.keys()].sort((x, y) => x - y)) {
    const source = lines.find(
      (l) => l.region === region && instructs(l) && CREDENTIAL_SOURCE.test(l.text),
    );
    const sink = sinks.get(region);
    if (source && sink) {
      const url = urlsIn(sink.text).find(isExfilUrl) ?? "";
      return at("credential-exfil", source, `reads credentials and sends them to ${hostOf(url)}`);
    }
  }
  return null;
}

function hostOf(raw: string): string {
  return parseUrl(raw)?.hostname ?? raw.slice(0, 60);
}

// ── Folder scan ─────────────────────────────────────────────────────────────

const SCRIPT_EXTS = new Set([
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".psm1",
  ".bat",
  ".cmd",
  ".command",
  ".py",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".rb",
  ".pl",
  ".php",
  ".applescript",
]);
const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv"]);
const MAX_ENTRIES = 400;
const MAX_DEPTH = 6;
const MAX_FILE_BYTES = 512 * 1024;
const CACHE_LIMIT = 512;

interface ScanInput {
  file: string;
  kind: SkillFileKind;
  content: string;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function realOrResolved(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    // Broken link: judge by where it points.
    const target = await fs.readlink(p);
    return path.resolve(path.dirname(p), target);
  }
}

/**
 * One stat fingerprint per scanned directory and file. A directory's mtime
 * changes when an entry is added, removed or renamed in it; a file's
 * size/mtime/ctime/inode change when it is written or replaced. ctime and
 * inode can't be reset by `touch`/`tar`, so a swapped file can't fake a match.
 */
type StatSig = readonly [rel: string, size: number, mtimeMs: number, ctimeMs: number, ino: number];

function sigOf(
  rel: string,
  st: { size: number; mtimeMs: number; ctimeMs: number; ino: number },
): StatSig {
  return [rel, st.size, st.mtimeMs, st.ctimeMs, st.ino];
}

/** Do all recorded stats still match? Any error or difference means "rescan". */
async function statsMatch(root: string, sigs: readonly StatSig[]): Promise<boolean> {
  try {
    const stats = await Promise.all(
      sigs.map(([rel]) => fs.lstat(rel === "" ? root : path.join(root, rel))),
    );
    return stats.every((st, i) => {
      const want = sigs[i];
      return (
        want !== undefined &&
        !st.isSymbolicLink() &&
        st.size === want[1] &&
        st.mtimeMs === want[2] &&
        st.ctimeMs === want[3] &&
        st.ino === want[4]
      );
    });
  } catch {
    return false;
  }
}

async function collect(
  root: string,
  realRoot: string,
): Promise<{
  inputs: ScanInput[];
  escape?: SkillScanFinding;
  /** Null when the folder can't be fingerprinted (symlinks, too many entries). */
  sigs: StatSig[] | null;
}> {
  const inputs: ScanInput[] = [];
  let sigs: StatSig[] | null = [];
  let seen = 0;
  const walk = async (dir: string, depth: number): Promise<SkillScanFinding | undefined> => {
    let entries;
    try {
      // Stat before listing: a change after this moment shows up next time.
      const dirStat = await fs.lstat(dir);
      sigs?.push(sigOf(path.relative(root, dir).split(path.sep).join("/"), dirStat));
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      sigs = null;
      return undefined;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++seen > MAX_ENTRIES) {
        sigs = null;
        return undefined;
      }
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (entry.isSymbolicLink()) {
        sigs = null; // a link's target can change without touching the folder
        let target: string;
        try {
          target = await realOrResolved(full);
        } catch {
          continue;
        }
        if (!isInside(realRoot, target)) {
          return {
            rule: "symlink-escape",
            file: rel,
            line: 0,
            reason: `symlink ${rel} points outside the skill folder`,
          };
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || depth >= MAX_DEPTH) continue;
        const hit = await walk(full, depth + 1);
        if (hit) return hit;
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      const isSkillMd = depth === 0 && entry.name === "SKILL.md";
      if (isSkillMd) continue; // supplied by the caller
      if (!SCRIPT_EXTS.has(ext) && ext !== "") continue;
      let content: string;
      try {
        const stat = await fs.lstat(full);
        sigs?.push(sigOf(rel, stat));
        if (stat.size > MAX_FILE_BYTES) continue;
        content = await fs.readFile(full, "utf-8");
      } catch {
        sigs = null;
        continue;
      }
      if (ext === "" && !content.startsWith("#!")) continue;
      inputs.push({ file: rel, kind: "script", content });
    }
    return undefined;
  };
  const escape = await walk(root, 0);
  return { inputs, escape, sigs };
}

function hashInputs(inputs: readonly ScanInput[]): string {
  const h = crypto.createHash("sha256");
  for (const input of inputs) {
    h.update(input.kind)
      .update("\0")
      .update(input.file)
      .update("\0")
      .update(input.content)
      .update("\0");
  }
  return h.digest("hex");
}

/**
 * Content-hash keyed verdict cache. An explicit object (not module state) so
 * tests can use a fresh one; `defaultSkillScanCache` is the process-wide one.
 */
export interface StatEntry {
  sigs: readonly StatSig[];
  verdict: SkillScanResult;
}

export class SkillScanCache {
  private readonly verdicts = new Map<string, SkillScanResult>();
  /** Path → stat fingerprint + verdict: the no-read, no-hash warm path. */
  private readonly byStats = new Map<string, StatEntry>();
  /** Disk files already merged in, so each session start doesn't re-read them. */
  readonly loadedFiles = new Set<string>();
  /** Bumped on every new verdict; lets a caller skip a no-op disk write. */
  changes = 0;

  get(key: string): SkillScanResult | undefined {
    return this.verdicts.get(key);
  }

  set(key: string, value: SkillScanResult): void {
    if (this.verdicts.has(key)) this.verdicts.delete(key);
    else if (this.verdicts.size >= CACHE_LIMIT) {
      const oldest = this.verdicts.keys().next().value;
      if (oldest !== undefined) this.verdicts.delete(oldest);
    }
    this.verdicts.set(key, value);
    this.changes++;
  }

  getStats(key: string): StatEntry | undefined {
    return this.byStats.get(key);
  }

  setStats(key: string, value: StatEntry): void {
    if (this.byStats.has(key)) this.byStats.delete(key);
    else if (this.byStats.size >= CACHE_LIMIT) {
      const oldest = this.byStats.keys().next().value;
      if (oldest !== undefined) this.byStats.delete(oldest);
    }
    this.byStats.set(key, value);
    this.changes++;
  }

  statEntries(): [string, StatEntry][] {
    return [...this.byStats.entries()];
  }

  entries(): [string, SkillScanResult][] {
    return [...this.verdicts.entries()];
  }

  get size(): number {
    return this.verdicts.size;
  }
}

/**
 * Bump whenever a rule changes what it catches: verdicts saved under another
 * version are ignored, so an old "ok" can never hide a newly caught skill.
 */
export const SKILL_SCAN_RULES_VERSION = 2;

interface SkillScanCacheFileData {
  version: number;
  verdicts: Record<string, SkillScanResult>;
  stats?: Record<string, StatEntry>;
}

function isStatSig(value: unknown): value is StatSig {
  return (
    Array.isArray(value) &&
    value.length === 5 &&
    typeof value[0] === "string" &&
    value.slice(1).every((n) => typeof n === "number")
  );
}

function isStatEntry(value: unknown): value is StatEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { sigs?: unknown; verdict?: unknown };
  return (
    Array.isArray(v.sigs) && v.sigs.length > 0 && v.sigs.every(isStatSig) && isVerdict(v.verdict)
  );
}

function isVerdict(value: unknown): value is SkillScanResult {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { ok?: unknown; finding?: unknown };
  if (v.ok === true) return true;
  if (v.ok !== false || typeof v.finding !== "object" || v.finding === null) return false;
  const f = v.finding as Record<string, unknown>;
  return (
    typeof f.rule === "string" &&
    typeof f.file === "string" &&
    typeof f.line === "number" &&
    typeof f.reason === "string"
  );
}

/**
 * Merge saved verdicts from `file` into `cache` (once per file per cache).
 * A missing, corrupt or other-version file is simply ignored: the skills are
 * then scanned as usual.
 */
export async function loadSkillScanCacheFile(cache: SkillScanCache, file: string): Promise<void> {
  if (cache.loadedFiles.has(file)) return;
  cache.loadedFiles.add(file);
  let data: unknown;
  try {
    data = JSON.parse(await fs.readFile(file, "utf-8"));
  } catch {
    return;
  }
  const parsed = data as Partial<SkillScanCacheFileData> | null;
  if (!parsed || parsed.version !== SKILL_SCAN_RULES_VERSION) return;
  if (typeof parsed.verdicts !== "object" || parsed.verdicts === null) return;
  const before = cache.changes;
  for (const [key, verdict] of Object.entries(parsed.verdicts)) {
    if (/^[0-9a-f]{64}$/.test(key) && isVerdict(verdict)) cache.set(key, verdict);
  }
  if (typeof parsed.stats === "object" && parsed.stats !== null) {
    for (const [key, entry] of Object.entries(parsed.stats)) {
      if (isStatEntry(entry)) cache.setStats(key, entry);
    }
  }
  // Loading what's already on disk is not a change worth writing back.
  cache.changes = before;
}

/** Write `cache` to `file` (temp file + rename). Best effort: it is only a cache. */
export async function saveSkillScanCacheFile(cache: SkillScanCache, file: string): Promise<void> {
  const data: SkillScanCacheFileData = {
    version: SKILL_SCAN_RULES_VERSION,
    verdicts: Object.fromEntries(cache.entries()),
    stats: Object.fromEntries(cache.statEntries()),
  };
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(data), "utf-8");
    await fs.rename(tmp, file);
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

export const defaultSkillScanCache = new SkillScanCache();

function scanInputs(inputs: readonly ScanInput[], cache: SkillScanCache): SkillScanResult {
  const key = hashInputs(inputs);
  const cached = cache.get(key);
  if (cached) return cached;
  let result: SkillScanResult = { ok: true };
  for (const input of inputs) {
    const finding = scanSkillText(input.content, input.file, input.kind);
    if (finding) {
      result = { ok: false, finding, hash: key };
      break;
    }
  }
  cache.set(key, result);
  return result;
}

/**
 * Scan a directory-layout skill: `<root>/SKILL.md` (passed raw as read by the
 * loader) plus every script in the folder, and every symlink in it.
 */
export async function scanSkillFolder(
  root: string,
  skillMd: string,
  cache: SkillScanCache = defaultSkillScanCache,
): Promise<SkillScanResult> {
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    realRoot = path.resolve(root);
  }
  const skillPath = path.join(root, "SKILL.md");
  const statKey = `dir:${path.resolve(root)}`;
  const known = cache.getStats(statKey);
  // Warm path: nothing changed since the last scan → no reads, no hashing.
  if (known && (await statsMatch(root, known.sigs))) return known.verdict;
  let skillSig: StatSig | null = null;
  try {
    const stat = await fs.lstat(skillPath);
    if (!stat.isSymbolicLink()) skillSig = sigOf("SKILL.md", stat);
    if (stat.isSymbolicLink() && !isInside(realRoot, await realOrResolved(skillPath))) {
      return {
        ok: false,
        finding: {
          rule: "symlink-escape",
          file: "SKILL.md",
          line: 0,
          reason: "SKILL.md is a symlink pointing outside the skill folder",
        },
      };
    }
  } catch {
    // Missing SKILL.md is the loader's concern.
  }
  const { inputs, escape, sigs } = await collect(root, realRoot);
  if (escape) return { ok: false, finding: escape };
  const verdict = scanInputs(
    [{ file: "SKILL.md", kind: "markdown", content: skillMd }, ...inputs],
    cache,
  );
  if (sigs && skillSig) cache.setStats(statKey, { sigs: [skillSig, ...sigs], verdict });
  return verdict;
}

/** Scan a flat-layout skill (`<dir>/<name>.md`), refusing a symlink that leaves `dir`. */
export async function scanSkillFile(
  filePath: string,
  content: string,
  cache: SkillScanCache = defaultSkillScanCache,
): Promise<SkillScanResult> {
  const file = path.basename(filePath);
  const statKey = `file:${path.resolve(filePath)}`;
  const known = cache.getStats(statKey);
  if (known && (await statsMatch(path.dirname(filePath), known.sigs))) return known.verdict;
  let fileSig: StatSig | null = null;
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isSymbolicLink()) fileSig = sigOf(file, stat);
    if (stat.isSymbolicLink()) {
      const dir = await fs.realpath(path.dirname(filePath));
      if (!isInside(dir, await realOrResolved(filePath))) {
        return {
          ok: false,
          finding: {
            rule: "symlink-escape",
            file,
            line: 0,
            reason: `${file} is a symlink pointing outside the skills folder`,
          },
        };
      }
    }
  } catch {
    // Unreadable metadata: content scan still applies.
  }
  const verdict = scanInputs([{ file, kind: "markdown", content }], cache);
  if (fileSig) cache.setStats(statKey, { sigs: [fileSig], verdict });
  return verdict;
}

/** One plain line for logs and the user: which skill, and why. */
export function skillBlockMessage(name: string, finding: SkillScanFinding): string {
  const where = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
  return `Skill "${name}" not loaded: ${finding.reason} (${where}).`;
}
