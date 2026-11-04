import { resolveToolSchema } from "@kleio/ai";
import type { AgentTool } from "./types.js";

/**
 * Repair hints for a malformed tool call: a close-match name for an unknown
 * tool, and the expected argument shape for a call whose arguments failed
 * validation. A bare "Unknown tool: Bash" makes the model guess again; naming
 * `bash` (or the fields `edit` takes) gets the next call right first time.
 */

/** Lowercase and drop separators so `Read_File`, `readFile`, `read-file` collide. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Optimal-string-alignment distance: a swapped adjacent pair (`wirte`) costs one edit. */
function editDistance(a: string, b: string): number {
  let beforePrevious: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let distance = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        distance = Math.min(distance, (beforePrevious[j - 2] ?? 0) + 1);
      }
      current[j] = distance;
    }
    beforePrevious = previous;
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * Closest candidate to `name`, or undefined when nothing is plausibly what the
 * caller meant. Exact matches after normalization win; otherwise the smallest
 * edit distance within a third of the name's length (minimum 1, maximum 3).
 * Ties resolve alphabetically so the hint is deterministic.
 */
export function closestName(name: string, candidates: Iterable<string>): string | undefined {
  const target = normalizeName(name);
  if (!target) return undefined;
  const limit = Math.min(3, Math.max(1, Math.floor(target.length / 3)));
  let best: { name: string; distance: number } | undefined;
  for (const candidate of [...candidates].sort()) {
    if (candidate === name) continue;
    const distance = editDistance(target, normalizeName(candidate));
    if (distance > limit) continue;
    if (!best || distance < best.distance) best = { name: candidate, distance };
  }
  return best?.name;
}

/** Result text for a call naming a tool that is not registered. */
export function unknownToolMessage(name: string, available: readonly string[]): string {
  const suggestion = closestName(name, available);
  if (suggestion) return `Unknown tool: ${name}. Did you mean \`${suggestion}\`?`;
  const names = [...available].sort();
  const listed = names.length > 40 ? `${names.slice(0, 40).join(", ")}, …` : names.join(", ");
  const searchHint = available.includes("tool_search")
    ? " If the capability is not listed, call `tool_search` to load it."
    : "";
  return `Unknown tool: ${name}. Available tools: ${listed}.${searchHint}`;
}

type JsonSchemaNode = Record<string, unknown>;

function isRecord(value: unknown): value is JsonSchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Short type label for one JSON Schema property: `string`, `number[]`, `"a" | "b"`. */
function typeLabel(node: unknown): string {
  if (!isRecord(node)) return "any";
  if (Array.isArray(node.enum)) {
    return node.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  const variants = node.anyOf ?? node.oneOf;
  if (Array.isArray(variants)) {
    return [...new Set(variants.map(typeLabel))].filter((t) => t !== "null").join(" | ") || "any";
  }
  if (node.type === "array") return `${typeLabel(node.items)}[]`;
  if (Array.isArray(node.type)) {
    return node.type.filter((t) => t !== "null").join(" | ") || "any";
  }
  return typeof node.type === "string" ? node.type : "any";
}

/** Top-level property names and their required set, or undefined for non-object roots. */
function objectShape(
  tool: AgentTool,
): { properties: Record<string, unknown>; required: Set<string> } | undefined {
  let schema: unknown;
  try {
    schema = resolveToolSchema(tool);
  } catch {
    return undefined;
  }
  if (!isRecord(schema) || !isRecord(schema.properties)) return undefined;
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((r): r is string => typeof r === "string")
      : [],
  );
  return { properties: schema.properties, required };
}

/**
 * Repair hints appended to an invalid-arguments error: the expected shape
 * (`{ file_path: string, limit?: number }`) and, for each unrecognised key the
 * model sent, the field it most likely meant. Empty when the schema has no
 * object shape to describe.
 */
export function argumentHints(tool: AgentTool, args: unknown): string {
  const shape = objectShape(tool);
  if (!shape) return "";
  const names = Object.keys(shape.properties);
  if (names.length === 0) return `Expected arguments: none.`;
  const fields = names.map((name) => {
    const optional = shape.required.has(name) ? "" : "?";
    return `${name}${optional}: ${typeLabel(shape.properties[name])}`;
  });
  const lines = [`Expected arguments: { ${fields.join(", ")} }`];
  if (isRecord(args)) {
    for (const key of Object.keys(args).sort()) {
      if (key in shape.properties) continue;
      const suggestion = closestName(key, names);
      lines.push(
        suggestion
          ? `Unknown field \`${key}\` — did you mean \`${suggestion}\`?`
          : `Unknown field \`${key}\` is not a parameter of this tool.`,
      );
    }
  }
  return lines.join("\n");
}
