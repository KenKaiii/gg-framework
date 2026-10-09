import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildSystemPrompt } from "./system-prompt.js";
import { createTools } from "./tools/index.js";
import { CORE_TOOL_NAMES, DEFERRED_TOOL_NAMES, partitionToolsByTier } from "./tools/tool-tiers.js";

/**
 * Golden snapshot of the CACHED PROMPT PREFIX — the system prompt plus the tool
 * block, exactly the span providers reuse between turns.
 *
 * Why this exists: measured over 90 days of history, the prefix text changed 62
 * times (4.8×/week) and 80% of those commits never mentioned the prompt in their
 * subject (bench/baseline/19-prefix-drift.mjs). Two consequences, and the second
 * is the one that matters:
 *
 *  1. Money: a changed prefix cannot be reused, so sessions whose warm window
 *     straddles the upgrade re-pay full input price for ~9.3k tokens.
 *  2. Review: the prefix IS the agent's instructions. An undeclared change to it
 *     is a behaviour change shipped without anyone reading it.
 *
 * So the diff has to be forced in front of a human. Any edit to prompt prose, a
 * tool description, or a tool's parameter schema fails this test until the
 * golden is regenerated on purpose:
 *
 *     UPDATE_GOLDEN=1 pnpm --filter @kenkaiiii/ggcoder test -- system-prompt.golden
 *
 * Regenerating is one command and always legitimate — the point is that it is a
 * DELIBERATE act that shows up in the diff of the commit that caused it.
 */

const GOLDEN_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__golden__",
  "system-prompt-prefix.md",
);

const UPDATE = process.env.UPDATE_GOLDEN === "1";

const tempDirs: string[] = [];
let previousGgBash: string | undefined;

beforeEach(() => {
  // The bash tool's description branches on whether a POSIX shell exists, so on
  // a bash-less Windows host it would differ from every other platform. Pinning
  // GG_BASH forces the POSIX branch everywhere, keeping ONE golden valid on
  // Linux, macOS and the blocking Windows CI leg.
  previousGgBash = process.env.GG_BASH;
  process.env.GG_BASH = "/bin/bash";
});

afterEach(async () => {
  if (previousGgBash === undefined) delete process.env.GG_BASH;
  else process.env.GG_BASH = previousGgBash;
  while (tempDirs.length > 0) {
    await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** Exactly what a provider transform serializes for one tool definition. */
function serializeTool(tool: {
  name: string;
  description: string;
  parameters: unknown;
  rawInputSchema?: Record<string, unknown>;
}): string {
  return JSON.stringify(
    {
      name: tool.name,
      description: tool.description,
      // The transform sends a pre-built schema when a tool has one.
      input_schema: tool.rawInputSchema ?? z.toJSONSchema(tool.parameters as z.ZodType),
    },
    null,
    2,
  );
}

/**
 * Replace the parts that legitimately differ per host or per day. Everything
 * NOT replaced here is content a human should have to approve.
 */
function normalize(text: string, cwd: string): string {
  return (
    text
      .split(cwd)
      .join("<CWD>")
      // Windows backslash form of the same temp path.
      .split(cwd.replace(/\//g, "\\"))
      .join("<CWD>")
      .split(os.homedir())
      .join("<HOME>")
      .replace(/^- Platform: .+$/m, "- Platform: <PLATFORM>")
      .replace(/^- Shell: .+$/m, "- Shell: <SHELL>")
      // The date suffix is deliberately volatile and sits after the uncached
      // marker, outside the cached span (system-prompt.ts renders it last).
      .replace(/Today's date: .+$/m, "Today's date: <DATE>")
      .replace(/\r\n/g, "\n")
  );
}

/** Build the prefix a real Anthropic session would send on turn one. */
async function buildPrefix(): Promise<{
  text: string;
  cwd: string;
  coreNames: string[];
  deferredNames: string[];
}> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ggcoder-golden-"));
  tempDirs.push(cwd);

  const { tools, processManager } = await createTools(cwd, {
    provider: "anthropic",
    model: "claude-sonnet-5",
    // Machine-gated: present only where the Agent Steroids binary is installed.
    steroidsBin: null,
    // Pinned so a change to the bundled roster or skill catalog is a visible
    // diff in ITS own golden, not silent noise in this one.
    agents: [],
    skills: [],
    lspDiagnostics: false,
  });
  try {
    const { core, deferred } = partitionToolsByTier(tools);
    const prompt = await buildSystemPrompt(
      cwd,
      [],
      false,
      undefined,
      core.map((tool) => tool.name),
      undefined,
      "anthropic",
      undefined,
      deferred.map((tool) => tool.name),
    );
    const toolBlock = core.map(serializeTool).join("\n");
    return {
      cwd,
      coreNames: core.map((tool) => tool.name),
      deferredNames: deferred.map((tool) => tool.name),
      text: `${prompt}\n\n===== TOOL BLOCK =====\n\n${toolBlock}\n`,
    };
  } finally {
    processManager.shutdownAll();
  }
}

/** Which top-level `## ` sections gained, lost or changed content. */
function changedSections(before: string, after: string): string[] {
  const sectionsOf = (text: string): Map<string, string> => {
    const out = new Map<string, string>();
    let name = "<preamble>";
    let body: string[] = [];
    for (const line of text.split("\n")) {
      if (line.startsWith("## ") || line.startsWith("===== ")) {
        out.set(name, body.join("\n"));
        name = line
          .replace(/^#+\s*/, "")
          .replace(/=/g, "")
          .trim();
        body = [];
        continue;
      }
      body.push(line);
    }
    out.set(name, body.join("\n"));
    return out;
  };

  const a = sectionsOf(before);
  const b = sectionsOf(after);
  const names = new Set([...a.keys(), ...b.keys()]);
  const changed: string[] = [];
  for (const name of names) {
    if (!a.has(name)) changed.push(`+ ${name} (new section)`);
    else if (!b.has(name)) changed.push(`- ${name} (section removed)`);
    else if (a.get(name) !== b.get(name)) {
      const from = a.get(name)!.length;
      const to = b.get(name)!.length;
      changed.push(`~ ${name} (${from} → ${to} chars)`);
    }
  }
  return changed.sort();
}

describe("cached prompt prefix golden", () => {
  it("matches the approved snapshot, or names exactly what changed", async () => {
    const { text, cwd } = await buildPrefix();
    const actual = normalize(text, cwd);

    if (UPDATE) {
      await fs.mkdir(path.dirname(GOLDEN_PATH), { recursive: true });
      await fs.writeFile(GOLDEN_PATH, actual, "utf8");
      return;
    }

    const golden = await fs.readFile(GOLDEN_PATH, "utf8").catch(() => null);
    expect(
      golden,
      `No golden prefix on disk. Create it with:\n  UPDATE_GOLDEN=1 pnpm --filter @kenkaiiii/ggcoder test -- system-prompt.golden`,
    ).not.toBeNull();

    const expected = golden!.replace(/\r\n/g, "\n");
    if (actual !== expected) {
      const sections = changedSections(expected, actual);
      // Printed before the assertion so the failure output leads with WHERE the
      // prefix moved; vitest then renders the line-level diff underneath.
      console.error(
        [
          "",
          "The cached prompt prefix changed. Sections affected:",
          ...sections.map((line) => `  ${line}`),
          `  (${expected.length} → ${actual.length} chars)`,
          "",
          "If this change was intended, regenerate the golden so it lands in the",
          "same commit and gets reviewed:",
          "  UPDATE_GOLDEN=1 pnpm --filter @kenkaiiii/ggcoder test -- system-prompt.golden",
          "",
        ].join("\n"),
      );
    }
    expect(actual).toBe(expected);
  });

  it("keeps the volatile date and the working directory outside the cached span", async () => {
    const { text, cwd } = await buildPrefix();
    const normalized = normalize(text, cwd);
    const marker = normalized.indexOf("<!-- uncached -->");
    expect(marker, "uncached marker must be present").toBeGreaterThan(-1);
    // Nothing above the marker may carry today's date, or every turn after
    // midnight would miss the cache for the whole prefix.
    expect(normalized.slice(0, marker)).not.toContain("Today's date:");
    // Nor the working directory, or every checkout/worktree of the same project
    // would write its own copy of the cached system block.
    expect(normalized.slice(0, marker)).not.toContain("<CWD>");
  });

  it("covers every core tool, so a description edit cannot slip past the golden", async () => {
    const { text, cwd, coreNames, deferredNames } = await buildPrefix();
    const normalized = normalize(text, cwd);

    for (const name of coreNames) {
      expect(normalized, `core tool ${name} must appear in the golden prefix`).toContain(
        `"name": "${name}"`,
      );
    }
    // Deferred tools are one hint line each, not a full schema — that is the
    // whole point of tiering, so the golden asserts the shape stays that way.
    for (const name of deferredNames) {
      expect(normalized).not.toContain(`"name": "${name}"`);
    }

    // Adding or removing a core tool changes the cached prefix for every user,
    // so the exact set is pinned here rather than merely being present in the
    // golden text.
    //
    // SCOPE, stated honestly: this config builds only the unconditional tools.
    // Tools gated on options are absent by construction and are NOT covered by
    // this golden — web_search (provider-side, injected by the transport),
    // subagent/spawn_agent and the agent-control tools (need a roster), skill
    // (needs a catalog), enter_plan/exit_plan (need plan callbacks), tool_search
    // (needs a deferred catalog), generate_image.
    expect(coreNames).toEqual(["read", "write", "edit", "bash", "grep"]);
    // Every core name this config builds must be a declared core tool — a tool
    // silently promoted into the cached tier fails here.
    for (const name of coreNames) {
      expect(CORE_TOOL_NAMES, `${name} is served eagerly but not declared core`).toContain(name);
    }
    for (const name of deferredNames) {
      expect(DEFERRED_TOOL_NAMES, `${name} is deferred but not declared`).toContain(name);
    }
  });
});
