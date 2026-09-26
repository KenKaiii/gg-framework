const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";
const CIRCULAR = "[CIRCULAR]";

const SENSITIVE_NAME =
  /(?:^|[_-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|key|auth(?:orization)?|bearer|cookie|credential|private[_-]?key|password|passwd|secret)(?:$|[_-])/i;
/**
 * Generic `name = value` detection is deliberately narrow. Tool output is mostly
 * source code, where `const token = await getToken()` or `key === "name"` are
 * ordinary code — rewriting them corrupts what the model reads and breaks
 * `edit` matching. So only two credential-shaped forms are matched:
 *
 * 1. ENV-style ALL-CAPS names ending in a secret word (`OPENAI_API_KEY=…`,
 *    `DB_PASSWORD: …`), with any spacing, case-sensitive, whose value contains
 *    a digit. Names that merely contain the word (`TOKEN_URL`, `AUTH_PROVIDERS`)
 *    and digit-free values (`STORAGE_KEY = "app:zoom"`, `= savedValue`) are
 *    code, not credentials. References (`$X`, `process.env.X`) name a secret
 *    rather than contain one, so they are left alone.
 * 2. Compact `name=value` with no surrounding whitespace, as in `.env` files,
 *    query strings and logs (`token=…&`). Formatted code puts spaces around
 *    `=`, so it never reaches this form.
 *
 * Values shorter than 8 characters are skipped: they are counts, flags and
 * placeholders, not credentials. High-confidence formats (PEM, JWT, provider
 * prefixes, auth headers) and exact environment values (the real secrets, in
 * any form) are handled separately.
 */
const ENV_SECRET_ASSIGNMENT =
  /\b((?:[A-Z0-9]+_)*(?:API_?KEY|ACCESS_TOKEN|REFRESH_TOKEN|TOKEN|KEY|AUTH|AUTHORIZATION|BEARER|CREDENTIALS?|PASSWORD|PASSWD|SECRET))\b(\s*[=:]\s*)(["']?)(?!\$|process\.env|os\.environ|import\.meta|env\.)(?=[^\s,"';}]*\d)([^\s,"';}=$][^\s,"';}]{7,})\3/g;
const COMPACT_SECRET_ASSIGNMENT =
  /\b((?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|auth|authorization|credentials?|password|passwd|secret)|(?:[a-z0-9]+[_-])+key)=(["']?)(?!\$)([^\s,"'&;}=][^\s,"'&;}]{7,})\2/gi;

export interface RedactionOptions {
  /** Exact secret values to remove in addition to high-confidence formats. */
  secrets?: Iterable<string>;
  /** Maximum recursive object depth before a stable truncation marker is emitted. */
  maxDepth?: number;
  /** Maximum total array/object entries cloned before truncation markers are emitted. */
  maxEntries?: number;
  /** Maximum retained string length after sanitization. */
  maxStringLength?: number;
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedSecrets(secrets: Iterable<string> | undefined): string[] {
  if (!secrets) return [];
  return [...new Set([...secrets].filter((value) => value.length >= 8 && value !== REDACTED))].sort(
    (a, b) => b.length - a.length,
  );
}

/** Collect sufficiently distinctive secrets from security-sensitive environment variables. */
export function environmentSecrets(env: Record<string, string | undefined>): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8 || value === REDACTED || !SENSITIVE_NAME.test(name)) continue;
    values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/** Redact credentials from arbitrary text without mutating its source. */
export function redactText(text: string, options: RedactionOptions = {}): string {
  let result = text;

  // PEM private keys, including multiline payloads.
  result = result.replace(
    /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    REDACTED,
  );
  // Credentials embedded in URLs.
  result = result.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`);
  // Authorization headers and inline auth values.
  result = result.replace(
    /\b(authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s,;]+/gi,
    `$1${REDACTED}`,
  );
  // A short plain word after "bearer"/"basic" is prose ("bearer authentication",
  // "basic functionality"). Credentials are either mixed (digits, symbols,
  // inner capitals) or, when purely alphabetic, long: 16+ letters is rare in prose.
  result = result.replace(
    /\b(bearer|basic)\s+(?![A-Za-z][a-z]{0,14}\b)[A-Za-z0-9+/_.=-]{8,}/gi,
    `$1 ${REDACTED}`,
  );
  // Cookie headers are security-sensitive as a whole; avoid trying to infer safe
  // cookie names. Header values start with `name=`, which separates them from
  // code such as `cookie: req.headers.cookie`.
  result = result.replace(/\b(cookie|set-cookie)(\s*:\s*)[^\s=;:]+=[^\r\n]*/gi, `$1$2${REDACTED}`);
  // JWTs and well-known provider/repository token prefixes.
  result = result.replace(
    /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
    REDACTED,
  );
  result = result.replace(
    /\b(?:sk-(?:ant-|proj-)?|xox[baprs]-|gh[pousr]_|github_pat_|AIza)[A-Za-z0-9_-]{12,}\b/g,
    REDACTED,
  );
  result = result.replace(
    ENV_SECRET_ASSIGNMENT,
    (_match, name: string, separator: string, quote: string) =>
      `${name}${separator}${quote}${REDACTED}${quote}`,
  );
  result = result.replace(
    COMPACT_SECRET_ASSIGNMENT,
    (_match, name: string, quote: string) => `${name}=${quote}${REDACTED}${quote}`,
  );

  for (const secret of normalizedSecrets(options.secrets)) {
    result = result.replace(new RegExp(escaped(secret), "g"), REDACTED);
  }

  const maxStringLength = options.maxStringLength ?? 1_000_000;
  if (result.length > maxStringLength) {
    result = `${result.slice(0, maxStringLength)}${TRUNCATED}`;
  }
  return result;
}

function isBinary(value: object): boolean {
  return (
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    (typeof Blob !== "undefined" && value instanceof Blob)
  );
}

function isMediaObject(value: Record<string, unknown>): boolean {
  return (
    (value.type === "image" || value.type === "video") &&
    (typeof value.data === "string" || typeof value.url === "string")
  );
}

/**
 * Recursively clone and sanitize transport/persistence payloads.
 * Cycles, excessive depth, and excessive collection sizes become stable markers.
 */
export function redactValue<T>(value: T, options: RedactionOptions = {}): T {
  const maxDepth = options.maxDepth ?? 20;
  const maxEntries = options.maxEntries ?? 10_000;
  const ancestors = new WeakSet<object>();
  let entries = 0;

  const visit = (current: unknown, depth: number, sensitive = false): unknown => {
    if (typeof current === "string") {
      if (sensitive && current.length > 0 && current !== REDACTED) return REDACTED;
      return redactText(current, options);
    }
    if (
      current === null ||
      current === undefined ||
      typeof current === "number" ||
      typeof current === "boolean" ||
      typeof current === "bigint"
    ) {
      return current;
    }
    if (typeof current !== "object") return current;
    if (isBinary(current)) return current;
    if (current instanceof Date) return new Date(current.getTime());
    if (depth >= maxDepth) return TRUNCATED;
    // Only an ancestor makes a cycle. An object reached twice through siblings
    // (e.g. one shared options array) is ordinary data and must clone both
    // times; `maxEntries` still bounds the work.
    if (ancestors.has(current)) return CIRCULAR;
    ancestors.add(current);
    try {
      return cloneObject(current, depth);
    } finally {
      ancestors.delete(current);
    }
  };

  const cloneObject = (current: object, depth: number): unknown => {
    if (current instanceof Error) {
      const error: Record<string, unknown> = {
        name: current.name,
        message: visit(current.message, depth + 1),
        stack: visit(current.stack, depth + 1),
      };
      for (const [key, child] of Object.entries(current)) {
        error[key] = visit(child, depth + 1, SENSITIVE_NAME.test(key));
      }
      return error;
    }

    if (Array.isArray(current)) {
      const clone: unknown[] = [];
      for (const child of current) {
        if (++entries > maxEntries) {
          clone.push(TRUNCATED);
          break;
        }
        clone.push(visit(child, depth + 1));
      }
      return clone;
    }

    const record = current as Record<string, unknown>;
    if (isMediaObject(record)) return { ...record };
    const clone: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      if (++entries > maxEntries) {
        clone[TRUNCATED] = true;
        break;
      }
      clone[key] = visit(child, depth + 1, SENSITIVE_NAME.test(key));
    }
    return clone;
  };

  return visit(value, 0) as T;
}

export { REDACTED as REDACTION_MARKER };
