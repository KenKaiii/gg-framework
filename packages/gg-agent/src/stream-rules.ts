/**
 * Stream rules: regex guards matched against a response WHILE it streams.
 *
 * A rule costs zero prompt tokens until the model actually breaks it. On a
 * match the agent loop aborts the in-flight response, discards the partial
 * assistant message (nothing is persisted, no partial tool call runs), appends
 * the rule's reminder as a hidden runtime note, and retries the same step.
 *
 * Matching is incremental: each stream (assistant text, or one tool call's
 * argument JSON) keeps a bounded rolling window, so a delta is scanned together
 * with only the last `windowChars` characters before it — never the whole
 * output. A pattern whose match spans more than the window is not detected.
 *
 * Tool-call arguments arrive as JSON text; they are unescaped incrementally so
 * rules see `\n`, `"`, etc. as the model meant them, not as JSON escapes.
 */

import type { Message } from "@kleio/ai";

/** Which streamed output a rule watches. Thinking is never matched. */
export type StreamRuleScope = "text" | "tool" | "both";

export interface StreamRule {
  /** Stable identifier; also the once-per-run dedupe key. */
  name: string;
  /** Pattern tested against the rolling window. `g`/`y` flags are tolerated. */
  pattern: RegExp;
  scope: StreamRuleScope;
  /** Reminder appended to the context when the rule fires. */
  reminder: string;
  /** Restrict tool-scope matching to these tool names. Unset = every tool. */
  tools?: readonly string[];
}

export interface StreamRulesConfig {
  rules: readonly StreamRule[];
  /** Rule-triggered retries allowed per agent run (one user turn). Default 3. */
  maxRetries?: number;
  /** Characters of prior output kept per stream for cross-delta matches. Default 1024. */
  windowChars?: number;
}

export type StreamRuleSource = "text" | "tool";

export interface StreamRuleMatch {
  rules: StreamRule[];
  source: StreamRuleSource;
  toolName?: string;
}

export const DEFAULT_STREAM_RULE_MAX_RETRIES = 3;
export const DEFAULT_STREAM_RULE_WINDOW_CHARS = 1024;

const JSON_ESCAPES: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  '"': '"',
  "\\": "\\",
  "/": "/",
};

/** Incremental JSON string-escape decoder that tolerates escapes split across chunks. */
export class JsonEscapeDecoder {
  private pending = "";

  push(chunk: string): string {
    const input = this.pending + chunk;
    this.pending = "";
    if (!input.includes("\\")) return input;
    let out = "";
    let i = 0;
    while (i < input.length) {
      const ch = input.charAt(i);
      if (ch !== "\\") {
        out += ch;
        i++;
        continue;
      }
      if (i + 1 >= input.length) {
        this.pending = input.slice(i);
        break;
      }
      const next = input.charAt(i + 1);
      if (next === "u") {
        if (i + 6 > input.length) {
          this.pending = input.slice(i);
          break;
        }
        const hex = input.slice(i + 2, i + 6);
        out += /^[0-9a-fA-F]{4}$/.test(hex)
          ? String.fromCharCode(Number.parseInt(hex, 16))
          : input.slice(i, i + 6);
        i += 6;
        continue;
      }
      out += JSON_ESCAPES[next] ?? next;
      i += 2;
    }
    return out;
  }
}

interface ToolStreamState {
  window: string;
  decoder: JsonEscapeDecoder;
}

/**
 * Per-run rule state. Create one per `agentLoop` run; call `beginAttempt()`
 * before every provider attempt so windows never leak across attempts.
 */
export class StreamRuleMonitor {
  readonly maxRetries: number;
  private readonly rules: readonly StreamRule[];
  private readonly windowChars: number;
  private readonly fired = new Set<string>();
  private retries = 0;
  private textWindow = "";
  private readonly toolStreams = new Map<string, ToolStreamState>();

  constructor(config: StreamRulesConfig) {
    this.rules = config.rules;
    this.maxRetries = Math.max(0, config.maxRetries ?? DEFAULT_STREAM_RULE_MAX_RETRIES);
    this.windowChars = Math.max(64, config.windowChars ?? DEFAULT_STREAM_RULE_WINDOW_CHARS);
  }

  /** False once the retry cap is spent or every rule has fired — skip all matching. */
  get active(): boolean {
    return this.retries < this.maxRetries && this.fired.size < this.rules.length;
  }

  get retriesUsed(): number {
    return this.retries;
  }

  beginAttempt(): void {
    this.textWindow = "";
    this.toolStreams.clear();
  }

  checkText(delta: string): StreamRuleMatch | null {
    if (!this.active || !delta) return null;
    const scan = this.textWindow + delta;
    this.textWindow = scan.slice(-this.windowChars);
    const rules = this.match(scan, "text");
    return rules.length > 0 ? { rules, source: "text" } : null;
  }

  checkToolArgs(id: string, toolName: string, argsDelta: string): StreamRuleMatch | null {
    if (!this.active || !argsDelta) return null;
    let state = this.toolStreams.get(id);
    if (!state) {
      state = { window: "", decoder: new JsonEscapeDecoder() };
      this.toolStreams.set(id, state);
    }
    const scan = state.window + state.decoder.push(argsDelta);
    state.window = scan.slice(-this.windowChars);
    const rules = this.match(scan, "tool", toolName);
    return rules.length > 0 ? { rules, source: "tool", toolName } : null;
  }

  /** Consume one retry and mark the rules fired. Returns the retry ordinal (1-based). */
  recordTrigger(rules: readonly StreamRule[]): number {
    for (const rule of rules) this.fired.add(rule.name);
    this.retries++;
    return this.retries;
  }

  private match(scan: string, source: StreamRuleSource, toolName?: string): StreamRule[] {
    const hits: StreamRule[] = [];
    for (const rule of this.rules) {
      if (this.fired.has(rule.name)) continue;
      if (rule.scope !== "both" && rule.scope !== source) continue;
      if (source === "tool" && rule.tools && toolName !== undefined) {
        if (!rule.tools.includes(toolName)) continue;
      }
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(scan)) hits.push(rule);
    }
    return hits;
  }
}

/** The hidden runtime note appended before the retry. */
export function buildStreamRuleReminder(rules: readonly StreamRule[]): Message {
  const blocks = rules.map(
    (rule) =>
      `<system-reminder reason="stream_rule" rule="${rule.name.replace(/"/g, "'")}">\n` +
      "Your previous response was interrupted mid-stream because it violated this rule. " +
      "The interrupted output was discarded: the user never saw it and no tool call from it ran. " +
      "Regenerate the response from the start and follow the rule:\n\n" +
      `${rule.reminder.trim()}\n` +
      "</system-reminder>",
  );
  return {
    role: "user",
    content: blocks.join("\n\n"),
    provenance: { source: "runtime", kind: "notification", visibility: "hidden" },
  };
}
