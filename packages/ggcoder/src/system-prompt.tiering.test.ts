import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildSystemPrompt } from "./system-prompt.js";
import { createTools } from "./tools/index.js";
import {
  AUTO_LOADED_TOOL_NAMES,
  CORE_TOOL_NAMES,
  DEFERRED_TOOL_NAMES,
  partitionToolsByTier,
} from "./tools/tool-tiers.js";

const tempDirs: string[] = [];

async function makeProject(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ggcoder-tiering-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** Exactly what a provider transform serializes for one tool definition. */
function serializeTool(tool: { name: string; description: string; parameters: unknown }): string {
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    input_schema: z.toJSONSchema(tool.parameters as z.ZodType),
  });
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

describe("tool tiering in the system prompt", () => {
  it("indexes every deferred tool exactly once", async () => {
    const cwd = await makeProject();
    const prompt = await buildSystemPrompt(
      cwd,
      undefined,
      false,
      undefined,
      ["read", "edit", "bash", "grep", "tool_search"],
      undefined,
      "anthropic",
      undefined,
      DEFERRED_TOOL_NAMES,
    );

    for (const name of DEFERRED_TOOL_NAMES) {
      // Auto-loaded follow-ups (task_*, child control, exit_plan) load with
      // their trigger, so the index skips them.
      const expected = AUTO_LOADED_TOOL_NAMES.has(name) ? 0 : 1;
      expect(countOccurrences(prompt, `- **${name}**:`), `index line for ${name}`).toBe(expected);
    }
    expect(prompt).toContain("On demand (call by name;");
  });

  it("keeps cross-tool steering without repeating live tool descriptions", async () => {
    const cwd = await makeProject();
    const prompt = await buildSystemPrompt(cwd, [], false, undefined, ["edit", "write"]);
    expect(prompt).toContain("Prefer `edit` over `write` for changes to existing files.");
    expect(prompt).not.toContain("**edit**");
    expect(prompt).not.toContain("**write**");

    const restricted = await buildSystemPrompt(cwd, [], false, undefined, ["edit"]);
    expect(restricted).not.toContain("Prefer `edit` over `write`");
  });

  it("never double-lists a tool that is already live", async () => {
    const cwd = await makeProject();
    const prompt = await buildSystemPrompt(
      cwd,
      undefined,
      false,
      undefined,
      ["read", "source_path", "tool_search"],
      undefined,
      "anthropic",
      undefined,
      ["source_path", "screenshot"],
    );

    // Live tools already carry their descriptions in schemas, not the deferred index.
    expect(countOccurrences(prompt, "- **source_path**:")).toBe(0);
    expect(countOccurrences(prompt, "- **screenshot**:")).toBe(1);
  });

  it("does not advertise deferred tools without a loader", async () => {
    const cwd = await makeProject();
    const prompt = await buildSystemPrompt(
      cwd,
      undefined,
      false,
      undefined,
      ["read"],
      undefined,
      "anthropic",
      undefined,
      ["screenshot", "source_path"],
    );
    expect(prompt).not.toContain("Available on demand");
    expect(prompt).not.toContain("tool_search");
    expect(prompt).not.toContain("**screenshot**");
    expect(prompt).not.toContain("**source_path**");
  });

  it("keeps deferred parameter schemas out of the serialized tool payload", async () => {
    const cwd = await makeProject();
    const { tools, processManager, lspManager } = await createTools(cwd, {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      lspDiagnostics: false,
    });
    const { core, deferred } = partitionToolsByTier(tools);
    expect(deferred.length).toBeGreaterThan(0);

    const payload = core.map(serializeTool).join("\n");
    for (const tool of deferred) {
      expect(payload).not.toContain(`"name":"${tool.name}"`);
      // A deferred tool's own schema body must not leak in through another tool.
      expect(payload).not.toContain(serializeTool(tool));
    }

    processManager.shutdownAll();
    await lspManager?.shutdownAll?.();
  });

  it("produces a stable, append-only core tool order across builds", async () => {
    const cwd = await makeProject();
    const build = async (): Promise<string[]> => {
      const { tools, processManager, lspManager } = await createTools(cwd, {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        lspDiagnostics: false,
      });
      const { core } = partitionToolsByTier(tools);
      processManager.shutdownAll();
      await lspManager?.shutdownAll?.();
      return core.map((t) => t.name);
    };

    const first = await build();
    const second = await build();
    // Reordering the tool array invalidates the whole cached prefix, so the
    // order is a contract, not an implementation detail.
    expect(second).toEqual(first);
    for (const name of first) expect(CORE_TOOL_NAMES).toContain(name);
  });

  it("holds the tiered prompt inside its character budget", async () => {
    const cwd = await makeProject();
    const prompt = await buildSystemPrompt(
      cwd,
      undefined,
      false,
      undefined,
      CORE_TOOL_NAMES,
      undefined,
      "anthropic",
      undefined,
      DEFERRED_TOOL_NAMES,
    );
    // The whole point of tiering is that the index is cheap: the on-demand
    // block must stay a rounding error next to a schema per tool. Raised from
    // 1,200 for the `debug` line (~65 chars, against a ~2.5k-char schema it
    // keeps out of every request), then to 1,500 for the `web_search` line
    // (~120 chars, against a ~1.2k-char schema). Then to 1,700 for the
    // `steroids` and `subagent` lines (~170 chars, against ~5.4k chars of
    // schemas moved out of every request).
    const indexBlockStart = prompt.indexOf("Available on demand");
    const indexBlock = prompt.slice(indexBlockStart, prompt.indexOf("\n\n", indexBlockStart));
    expect(indexBlock.length).toBeLessThan(1_700);
    // Raised with the "How to Talk" reply-shape rules, then again for the
    // always-on security defaults in Code Quality, then again for the Code
    // Quality minimization ladder (benchmarked: same correctness, 50–76% less
    // generated code); the index block cap above is the one that guards
    // tiering itself, and it is unchanged. Raised again with the 2026-08
    // guardrail additions (git safety, anti-fake-green, reproduce-first,
    // circuit-breaker, question-vs-fix, no-variants, test guidance). Raised
    // again for the alignment guardrails (facts-vs-decisions, batched
    // questions) — see the size-budget test in system-prompt.test.ts. Raised
    // once more when `steroids` joined the core tier (its hint + the Research
    // staple sentence), and again when steroids became the proactive source
    // of truth (corpus-gap and not-installed fallbacks); the index block cap
    // is still the tiering guard.
    expect(prompt.length).toBeLessThan(13_100);
  });
});
