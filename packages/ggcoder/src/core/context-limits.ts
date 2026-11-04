/**
 * Byte budgets for every untrusted input injected into the system prompt or
 * tool definitions (fx-pattern). Skills, MCP tool descriptions and promoted
 * MCP schemas are attacker-controllable content a hostile skill file or MCP
 * server can bloat without limit; these caps bound both per-request token cost
 * and the prompt-injection surface. All values are user-tunable via the
 * `contextLimits` setting.
 */
export interface ContextLimits {
  /** One skill's `description` as listed in the prompt / skill tool. */
  skillDescriptionBytes: number;
  /** Whole rendered skills list (prompt section + skill tool description). */
  skillCatalogBytes: number;
  /** One MCP tool's `description` while it sits in the deferred catalog. */
  mcpToolDescriptionBytes: number;
  /** A promoted MCP tool's serialized input schema. Oversized = refused. */
  mcpToolSchemaBytes: number;
  /** Combined project instruction files (AGENTS.md etc.) — Codex default. */
  projectContextBytes: number;
  /** Emergency ceiling on the fully assembled system prompt. */
  systemPromptCeilingBytes: number;
}

export const CONTEXT_LIMITS: ContextLimits = {
  skillDescriptionBytes: 240,
  skillCatalogBytes: 16 * 1024,
  mcpToolDescriptionBytes: 1024,
  mcpToolSchemaBytes: 64 * 1024,
  projectContextBytes: 32 * 1024,
  systemPromptCeilingBytes: 1024 * 1024,
};

export function resolveContextLimits(overrides?: Partial<ContextLimits>): ContextLimits {
  return { ...CONTEXT_LIMITS, ...overrides };
}

/**
 * A session's limits: global defaults, then the mode's own defaults (e.g.
 * Motion's larger bundled skill catalog), then the user's `contextLimits`
 * setting, which always wins.
 */
export function resolveSessionContextLimits(
  modeDefaults?: Partial<ContextLimits>,
  userSettings?: Partial<ContextLimits>,
): ContextLimits {
  return resolveContextLimits({ ...modeDefaults, ...userSettings });
}

export interface ClampedText {
  text: string;
  truncated: boolean;
  originalBytes: number;
}

const ELLIPSIS = "\u2026";

/**
 * Cut `text` to at most `maxBytes` of UTF-8 on a codepoint boundary (never
 * splits a surrogate pair), appending an ellipsis when truncation happened.
 */
export function clampToBytes(text: string, maxBytes: number): ClampedText {
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= maxBytes) return { text, truncated: false, originalBytes };
  const ellipsisBytes = Buffer.byteLength(ELLIPSIS, "utf8");
  if (maxBytes <= ellipsisBytes) return { text: "", truncated: true, originalBytes };
  const buf = Buffer.from(text, "utf8");
  let cut = maxBytes - ellipsisBytes;
  // Walk back onto a codepoint start so the kept prefix is complete codepoints.
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return {
    text: `${buf.subarray(0, cut).toString("utf8")}${ELLIPSIS}`,
    truncated: true,
    originalBytes,
  };
}
