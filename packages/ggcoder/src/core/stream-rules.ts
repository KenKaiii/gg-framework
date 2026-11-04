/**
 * Loads stream rules (regex guards matched against the model's streaming
 * output — see gg-agent `stream-rules.ts`) from markdown files:
 *
 *   ~/.gg/rules/*.md          user rules (trusted)
 *   <cwd>/.gg/rules/*.md      project rules (untrusted; override user rules by name)
 *
 * No rules ship built in. Example `.gg/rules/no-console-log.md`:
 *
 *   ---
 *   name: no-console-log
 *   trigger: console\.log\(
 *   scope: tool            # text | tool | both (default both)
 *   tools: [edit, write]   # optional; restricts tool-scope matching
 *   ---
 *   Do not add console.log calls. Use the project logger (`log()` from
 *   core/logger.ts) instead.
 *
 * `trigger` is a JavaScript regex source; `/source/flags` form is accepted
 * with flags from `imsu`. The body is the reminder shown to the model when the
 * rule fires (trimmed, capped at 1,000 chars). Project triggers longer than
 * 300 chars or with nested quantifiers (catastrophic-backtracking risk) are
 * skipped. Invalid files are skipped with a WARN log; loading never throws.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StreamRule, StreamRuleScope } from "@kleio/agent";
import { parseFrontmatter } from "./frontmatter.js";
import { log } from "./logger.js";

export const MAX_STREAM_RULES = 50;
export const MAX_STREAM_RULE_REMINDER_CHARS = 1000;
export const MAX_PROJECT_TRIGGER_CHARS = 300;

/** Heuristic for nested quantifiers like `(a+)+`, `(\w*)*`, `(x+){2,}`. */
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)[+*{]/;
const REGEX_LITERAL = /^\/(.+)\/([imsu]*)$/s;

type RuleOrigin = "user" | "project";

async function listRuleFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

function parseTools(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const tools = raw
    .replace(/^\[|\]$/g, "")
    .split(/[\s,]+/)
    .map((t) =>
      t
        .replace(/^-+$/, "")
        .replace(/^["']|["']$/g, "")
        .trim(),
    )
    .filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

function parseScope(raw: string | undefined): StreamRuleScope | null {
  if (raw === undefined || raw.trim() === "") return "both";
  const scope = raw.trim().toLowerCase();
  return scope === "text" || scope === "tool" || scope === "both" ? scope : null;
}

function compileTrigger(trigger: string, origin: RuleOrigin): RegExp | string {
  if (origin === "project") {
    if (trigger.length > MAX_PROJECT_TRIGGER_CHARS) {
      return `trigger exceeds ${MAX_PROJECT_TRIGGER_CHARS} chars`;
    }
    if (NESTED_QUANTIFIER.test(trigger)) return "trigger has nested quantifiers";
  }
  const literal = REGEX_LITERAL.exec(trigger);
  try {
    return literal ? new RegExp(literal[1], literal[2]) : new RegExp(trigger);
  } catch (err) {
    return `invalid regex: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function readRule(file: string, origin: RuleOrigin): Promise<StreamRule | null> {
  const skip = (reason: string): null => {
    log("WARN", "stream-rules", `Skipping stream rule ${file}: ${reason}`);
    return null;
  };
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    return skip(`unreadable (${err instanceof Error ? err.message : String(err)})`);
  }
  const { fields, body, hasFrontmatter } = parseFrontmatter(raw);
  if (!hasFrontmatter) return skip("missing frontmatter");
  const name = fields.name?.trim();
  if (!name) return skip("missing name");
  const trigger = fields.trigger?.trim();
  if (!trigger) return skip("missing trigger");
  const scope = parseScope(fields.scope);
  if (!scope) return skip(`invalid scope "${fields.scope ?? ""}"`);
  const pattern = compileTrigger(trigger, origin);
  if (typeof pattern === "string") return skip(pattern);
  const reminder = body.trim().slice(0, MAX_STREAM_RULE_REMINDER_CHARS);
  if (!reminder) return skip("empty reminder body");
  const tools = parseTools(fields.tools);
  return { name, pattern, scope, reminder, ...(tools ? { tools } : {}) };
}

async function loadDir(dir: string, origin: RuleOrigin): Promise<StreamRule[]> {
  const rules: StreamRule[] = [];
  for (const file of await listRuleFiles(dir)) {
    const rule = await readRule(file, origin);
    if (rule) rules.push(rule);
  }
  return rules;
}

/** Load user + project stream rules. Project rules override user rules with the same name. */
export async function loadStreamRules(
  cwd: string,
  home: string = os.homedir(),
): Promise<StreamRule[]> {
  try {
    const byName = new Map<string, StreamRule>();
    for (const rule of await loadDir(path.join(home, ".gg", "rules"), "user")) {
      byName.set(rule.name, rule);
    }
    const projectDir = path.join(cwd, ".gg", "rules");
    // cwd === home would load the same dir twice and apply untrusted limits to user rules.
    if (path.resolve(projectDir) !== path.resolve(home, ".gg", "rules")) {
      for (const rule of await loadDir(projectDir, "project")) {
        byName.delete(rule.name);
        byName.set(rule.name, rule);
      }
    }
    const rules = [...byName.values()];
    if (rules.length > MAX_STREAM_RULES) {
      log(
        "WARN",
        "stream-rules",
        `Only the first ${MAX_STREAM_RULES} of ${rules.length} stream rules are used`,
      );
    }
    return rules.slice(0, MAX_STREAM_RULES);
  } catch (err) {
    log(
      "WARN",
      "stream-rules",
      `Failed to load stream rules: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}
