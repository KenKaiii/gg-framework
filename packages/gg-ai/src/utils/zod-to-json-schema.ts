import { z } from "zod";
import type { Tool } from "../types.js";

/**
 * Converts a Zod schema to a JSON Schema object suitable for provider tool
 * parameter definitions.
 *
 * Anthropic's `input_schema` validator is strict in two ways:
 *
 *   1. The root must be `type: "object"`. Returns 400 with
 *      `tools.N.custom.input_schema.type: Field required` otherwise.
 *
 *   2. The root must NOT contain `oneOf`, `anyOf`, or `allOf`. Returns 400 with
 *      `input_schema does not support oneOf, allOf, or anyOf at the top level`.
 *
 * Both rules trip whenever a tool's parameters are defined via
 * `z.discriminatedUnion(...)` or `z.union(...)` — Zod 4's
 * `z.toJSONSchema` emits `{oneOf: [...]}` at the root with no `type`.
 *
 * The fix is to collapse the union into a single flat object schema:
 *
 *   - properties = union of all branch properties (later branches win on
 *     conflict; that's fine because the model only uses these for hints —
 *     Zod's actual `tool.parameters.parse(args)` is the real validator)
 *   - required = intersection of branch `required` arrays (a field is only
 *     required if EVERY branch requires it)
 *   - if the union has a discriminator field (every branch has the same
 *     property as a `const`), we replace the discriminator's per-branch
 *     `const` with an `enum` listing every literal — the model gets a clear
 *     hint of the valid action values without needing oneOf
 *
 * The flattening is lossy for *schema-level* constraints (e.g. "if action=X,
 * then field Y is required") — Zod still enforces those at parse time. For
 * the model's purposes this is identical to a single object with optional
 * fields and a discriminator enum, which is exactly how Anthropic-supported
 * tools are typically authored anyway.
 */

type JsonSchema = Record<string, unknown>;

/**
 * Memoize the Zod → JSON Schema conversion. Tool schemas are immutable within
 * a session, but `toAnthropicTools` / `toOpenAITools` call this on every turn.
 * For ~15-20 tools with complex nested schemas, `z.toJSONSchema` can take
 * 5-20ms total per turn — pure wasted CPU on an unchanged schema.
 * Keyed by the Zod schema object identity (WeakMap so schemas can GC).
 */
const schemaCache = new WeakMap<z.ZodType, JsonSchema>();

export function zodToJsonSchema(schema: z.ZodType): JsonSchema {
  const cached = schemaCache.get(schema);
  if (cached) return cached;
  const jsonSchema = z.toJSONSchema(schema) as JsonSchema;
  const { $schema: _schema, ...rest } = jsonSchema;
  const normalized = normalizeRootForAnthropic(rest);
  schemaCache.set(schema, normalized);
  return normalized;
}

/**
 * Resolve a tool's JSON Schema for provider tool definitions: prefer the
 * tool's pre-built `rawInputSchema`, otherwise convert its Zod `parameters`.
 */
export function resolveToolSchema(tool: Tool): JsonSchema {
  return tool.rawInputSchema ?? zodToJsonSchema(tool.parameters);
}

/**
 * Recursively flatten a root discriminated/plain union into a single object
 * schema. Only operates at the ROOT — nested unions inside properties are
 * left intact (Anthropic accepts those just fine; only the top-level
 * input_schema is restricted).
 */
function normalizeRootForAnthropic(schema: JsonSchema): JsonSchema {
  const branches = (schema.oneOf ?? schema.anyOf) as JsonSchema[] | undefined;
  if (!branches || branches.length === 0) {
    // Already an object root or a primitive — Anthropic only sees object
    // params, so primitive roots will fail elsewhere; that's not our bug.
    return schema;
  }

  // All branches must be object schemas to flatten. If any isn't, fall
  // back to wrapping with type:"object" — better than failing outright.
  const allObjects = branches.every((b) => b.type === "object");
  if (!allObjects) {
    return { type: "object", ...schema };
  }

  const mergedProps: Record<string, JsonSchema> = {};
  const requiredCounts: Record<string, number> = {};
  const enumCandidate: Record<string, Set<string | number | boolean>> = {};
  const everyBranchHas: Record<string, number> = {};

  for (const branch of branches) {
    const props = (branch.properties ?? {}) as Record<string, JsonSchema>;
    const required = (branch.required ?? []) as string[];

    for (const [key, prop] of Object.entries(props)) {
      everyBranchHas[key] = (everyBranchHas[key] ?? 0) + 1;
      // Last-wins merge — fine, since these are model hints only.
      mergedProps[key] = { ...mergedProps[key], ...prop };

      // Track const candidates for discriminator collapse.
      if (prop && typeof prop === "object" && "const" in prop) {
        const v = prop.const as string | number | boolean;
        enumCandidate[key] = enumCandidate[key] ?? new Set();
        enumCandidate[key].add(v);
      }
    }
    for (const r of required) {
      requiredCounts[r] = (requiredCounts[r] ?? 0) + 1;
    }
  }

  // For any property where every branch had a `const` of the same primitive
  // type, replace that property's `const` with an `enum` listing all
  // observed literals. This is the discriminator collapse.
  for (const [key, values] of Object.entries(enumCandidate)) {
    if (everyBranchHas[key] === branches.length && values.size > 1) {
      const list = [...values];
      // Drop `const` (mutually exclusive with enum), keep type from one branch.
      const { const: _const, ...rest } = mergedProps[key];
      mergedProps[key] = { ...rest, enum: list };
    }
  }

  // A field is required only if EVERY branch lists it as required.
  const required = Object.entries(requiredCounts)
    .filter(([, count]) => count === branches.length)
    .map(([key]) => key);

  // Pull through any non-conflicting metadata from the union root
  // (description, title, etc.) — drop oneOf/anyOf/allOf themselves.
  const {
    oneOf: _o,
    anyOf: _a,
    allOf: _all,
    type: _t,
    properties: _p,
    required: _r,
    ...meta
  } = schema;

  const out: JsonSchema = {
    ...meta,
    type: "object",
    properties: mergedProps,
  };
  if (required.length > 0) out.required = required;
  return out;
}
