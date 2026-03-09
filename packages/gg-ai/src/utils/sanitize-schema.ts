/**
 * Recursively fix object schemas missing "properties" and strip fields
 * that OpenAI's API rejects.
 *
 * Anthropic tolerates schemas like `{ type: "object" }` without properties,
 * but OpenAI returns a 400 error. MCP servers (e.g. grep.app) sometimes
 * return such schemas, which are technically valid JSON Schema but violate
 * OpenAI's stricter validation.
 *
 * Also strips `$schema`, `$id`, and `$comment` at every level, and recurses
 * into `definitions`/`$defs` sub-schemas so they get sanitized too.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function sanitizeJsonSchema(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  const copy = { ...schema };

  // Strip unsupported top-level JSON Schema fields that OpenAI rejects
  delete copy.$schema;
  delete copy.$id;
  delete copy.$comment;

  // Handle type: ["object", "null"] array syntax
  const isObjectType =
    copy.type === "object" ||
    (Array.isArray(copy.type) && (copy.type as string[]).includes("object"));

  if (isObjectType && !copy.properties) {
    copy.properties = {};
  }
  if (copy.properties && typeof copy.properties === "object") {
    const props = { ...copy.properties };
    for (const key of Object.keys(props)) {
      props[key] = sanitizeJsonSchema(props[key]);
    }
    copy.properties = props;
  }
  if (copy.items) copy.items = sanitizeJsonSchema(copy.items);
  if (Array.isArray(copy.anyOf)) copy.anyOf = copy.anyOf.map(sanitizeJsonSchema);
  if (Array.isArray(copy.oneOf)) copy.oneOf = copy.oneOf.map(sanitizeJsonSchema);
  if (Array.isArray(copy.allOf)) copy.allOf = copy.allOf.map(sanitizeJsonSchema);
  if (copy.additionalProperties && typeof copy.additionalProperties === "object") {
    copy.additionalProperties = sanitizeJsonSchema(copy.additionalProperties);
  }

  // Recurse into definitions / $defs sub-schemas
  if (copy.definitions && typeof copy.definitions === "object") {
    const defs = { ...copy.definitions };
    for (const key of Object.keys(defs)) {
      defs[key] = sanitizeJsonSchema(defs[key]);
    }
    copy.definitions = defs;
  }
  if (copy.$defs && typeof copy.$defs === "object") {
    const defs = { ...copy.$defs };
    for (const key of Object.keys(defs)) {
      defs[key] = sanitizeJsonSchema(defs[key]);
    }
    copy.$defs = defs;
  }

  return copy;
}
