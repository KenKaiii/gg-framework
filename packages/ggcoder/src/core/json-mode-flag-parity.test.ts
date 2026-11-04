import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The desktop app has no sibling `cli.js` next to the bundled sidecar, so
 * subagent.ts's spawn falls back to re-running app-sidecar.mjs itself
 * (see the comment above `runJsonModeIfRequested` in app-sidecar.ts).
 * app-sidecar.ts therefore keeps its OWN `parseArgs` schema that mirrors
 * cli.ts's `values.json` branch, in `strict: true` mode.
 *
 * These two schemas drifted once already (the `tools` flag was added to
 * cli.ts + subagent.ts's spawn args but not to app-sidecar.ts), which broke
 * every subagent call for any named agent with a `tools:` allow-list in the
 * desktop app with "GG_APP_FATAL Unknown option '--tools'". `--thinking` then
 * drifted the same way while this test exempted it, failing every subagent
 * call in the desktop app. This test reads
 * both option lists back out of source and asserts every flag the JSON-mode
 * branch of cli.ts accepts is also accepted by app-sidecar.ts's JSON-mode
 * parser, so a future flag addition can't silently drift again.
 */
function extractJsonModeOptionKeys(source: string, anchor: string): string[] {
  const anchorIndex = source.indexOf(anchor);
  if (anchorIndex === -1) throw new Error(`Anchor not found: ${anchor}`);
  const braceOpen = source.indexOf("{", source.indexOf("options:", anchorIndex));
  // Walk brace depth from the options object's opening `{` to find its
  // matching close — a plain indexOf("},") stops at the FIRST nested
  // option's closing brace instead of the whole block's.
  let depth = 0;
  let optionsEnd = -1;
  for (let i = braceOpen; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        optionsEnd = i;
        break;
      }
    }
  }
  if (optionsEnd === -1) throw new Error("Unbalanced braces in options block");
  const block = source.slice(braceOpen, optionsEnd);
  const keys: string[] = [];
  for (const m of block.matchAll(/^\s*(?:"([\w-]+)"|(\w[\w-]*)):\s*{\s*type:/gm)) {
    keys.push(m[1] ?? m[2]);
  }
  return keys;
}

describe("cli.ts / app-sidecar.ts JSON-mode flag parity", () => {
  it("app-sidecar's runJsonModeIfRequested accepts every flag cli.ts's JSON mode does", () => {
    const cliSource = fs.readFileSync(path.join(__dirname, "../cli.ts"), "utf-8");
    const sidecarSource = fs.readFileSync(
      path.join(__dirname, "../app-sidecar/json-mode.ts"),
      "utf-8",
    );

    const cliKeys = extractJsonModeOptionKeys(
      cliSource,
      "const { values, positionals } = parseArgs({",
    );
    const sidecarKeys = extractJsonModeOptionKeys(
      sidecarSource,
      "const { values, positionals } = parseArgs({",
    );

    // Flags that are meaningless in JSON/sub-agent mode (interactive-only or
    // top-level CLI concerns) are intentionally absent from app-sidecar.ts's
    // narrower schema — exclude them rather than widening the sidecar.
    const notApplicableToJsonMode = new Set(["help", "version", "rpc", "resume"]);
    const requiredInSidecar = cliKeys.filter((k) => !notApplicableToJsonMode.has(k));

    const missing = requiredInSidecar.filter((k) => !sidecarKeys.includes(k));
    expect(missing).toEqual([]);
  });
});
