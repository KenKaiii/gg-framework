import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  collectProjectContext,
  PROJECT_CONTEXT_MAX_BYTES,
} from "./system-prompt.js";
import type { LanguageId } from "./core/language-detector.js";

const tempDirs: string[] = [];

async function makeProject(files: Record<string, string> = {}): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ggcoder-system-prompt-"));
  tempDirs.push(cwd);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(cwd, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
  }
  return cwd;
}

function sectionIndex(prompt: string, heading: string): number {
  const index = prompt.indexOf(heading);
  expect(index, `${heading} should exist`).toBeGreaterThanOrEqual(0);
  return index;
}

function toolsSection(prompt: string): string {
  const start = sectionIndex(prompt, "## Tools");
  const rest = prompt.slice(start);
  const next = rest.indexOf("\n\n## ", "## Tools".length);
  return next === -1 ? rest : rest.slice(0, next);
}

function promptSize(prompt: string): { characters: number; lines: number; sections: number } {
  return {
    characters: prompt.length,
    lines: prompt.split("\n").length,
    sections: prompt.match(/^## /gm)?.length ?? 0,
  };
}

function promptAudit(prompt: string): { size: ReturnType<typeof promptSize>; flags: string[] } {
  const flags: string[] = [];
  const obsoleteOrContradictory = [
    "what observable artifact would prove the requested outcome worked end-to-end",
    "the simplest reliable local/free proof path",
    "generic tests, scripts, screenshots, benchmarks, or simulations; use them by default",
    "After meaningful edits, run the relevant verification commands below",
    "Run relevant checks after edits",
  ];

  for (const phrase of obsoleteOrContradictory) {
    if (prompt.includes(phrase)) flags.push(`obsolete/contradictory guidance: ${phrase}`);
  }

  const repeatedSentences = new Map<string, number>();
  for (const sentence of prompt
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 80)) {
    repeatedSentences.set(sentence, (repeatedSentences.get(sentence) ?? 0) + 1);
  }
  for (const [sentence, count] of repeatedSentences) {
    if (count > 1) flags.push(`duplicate sentence x${count}: ${sentence}`);
  }

  return { size: promptSize(prompt), flags };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("buildSystemPrompt", () => {
  it("renders deterministic section order and keeps only the volatile date after the marker", async () => {
    const cwd = await makeProject({
      "CLAUDE.md": "Project rules win.",
      "package.json": JSON.stringify({ scripts: { check: "tsc --noEmit" } }),
      "tsconfig.json": "{}",
    });

    const prompt = await buildSystemPrompt(
      cwd,
      [{ name: "find-skills", description: "Find skills.", content: "", source: "test" }],
      false,
      undefined,
      ["read", "edit", "web_search", "skill"],
      new Set<LanguageId>(["typescript"]),
    );

    expect(prompt.startsWith("You are GG Coder by Ken Kai")).toBe(true);
    expect(sectionIndex(prompt, "## How to Talk")).toBeLessThan(
      sectionIndex(prompt, "## How to Work"),
    );
    expect(sectionIndex(prompt, "## How to Work")).toBeLessThan(
      sectionIndex(prompt, "## Research & Verification"),
    );
    expect(sectionIndex(prompt, "## Research & Verification")).toBeLessThan(
      sectionIndex(prompt, "## Code Quality"),
    );
    expect(prompt).toContain("Woops I just farted!");
    expect(prompt).toContain("don't force it or repeat one line");
    expect(prompt).not.toContain(
      "Do not default to generic tests, scripts, screenshots, benchmarks, or simulations",
    );
    expect(sectionIndex(prompt, "## Code Quality")).toBeLessThan(sectionIndex(prompt, "## Tools"));
    expect(sectionIndex(prompt, "## Tools")).toBeLessThan(
      sectionIndex(prompt, "## Project Context"),
    );
    expect(sectionIndex(prompt, "## Project Context")).toBeLessThan(
      sectionIndex(prompt, "## Language Style Packs"),
    );
    expect(sectionIndex(prompt, "## Language Style Packs")).toBeLessThan(
      sectionIndex(prompt, "## Verification"),
    );
    expect(sectionIndex(prompt, "## Verification")).toBeLessThan(sectionIndex(prompt, "## Skills"));
    expect(sectionIndex(prompt, "## Skills")).toBeLessThan(sectionIndex(prompt, "## Environment"));

    const marker = "<!-- uncached -->";
    expect(prompt.match(new RegExp(marker, "g"))).toHaveLength(1);
    const afterMarker = prompt.slice(prompt.indexOf(marker) + marker.length).trim();
    expect(afterMarker).toMatch(/^Today's date: \d{1,2} [A-Za-z]+ \d{4}$/);
  });

  it("lists exactly available known tools", async () => {
    const cwd = await makeProject();

    const prompt = await buildSystemPrompt(cwd, undefined, false, undefined, [
      "read",
      "write",
      "edit",
      "web_search",
      "not_a_tool",
    ]);
    const renderedTools = toolsSection(prompt);
    // Core file tools (read/write/edit) no longer carry a per-tool hint — they
    // rely on their schema description plus the cross-tool steering line (which
    // renders here because edit + write are both active). Tools with non-obvious
    // usage (web_search) still render a hint. Unknown tools never do.
    expect(renderedTools).toContain("Prefer `edit` over `write`");
    expect(renderedTools).toContain("**web_search**");
    expect(renderedTools).not.toContain("not_a_tool");
    expect(renderedTools).not.toContain("**read**");
    expect(renderedTools).not.toContain("**edit**");
  });

  it("states rule precedence exactly once and keeps project context before style packs", async () => {
    const cwd = await makeProject({
      "AGENTS.md": "Use tabs for this fixture.",
      "tsconfig.json": "{}",
    });

    const prompt = await buildSystemPrompt(
      cwd,
      undefined,
      false,
      undefined,
      ["read"],
      new Set<LanguageId>(["typescript"]),
    );

    // Precedence lives in How to Work only — not restated in Project Context or Style Packs.
    expect(prompt).toContain("Rule precedence: project context files");
    expect(prompt.match(/Rule precedence/g)).toHaveLength(1);
    expect(prompt).not.toContain("**Highest precedence**");
    expect(prompt).not.toContain("override default guidance");
    expect(prompt).not.toContain("override these defaults");
    expect(sectionIndex(prompt, "## Project Context")).toBeLessThan(
      sectionIndex(prompt, "## Language Style Packs"),
    );
  });

  it("renders normal mode as direct coding mode", async () => {
    const cwd = await makeProject();
    const prompt = await buildSystemPrompt(cwd, undefined, false, undefined, [
      "read",
      "edit",
      "write",
      "bash",
      "subagent",
    ]);

    expect(prompt).toContain("works directly in the user's codebase");
    expect(prompt).toContain("completing tasks end-to-end");
  });

  it("preserves critical operating rules concisely", async () => {
    const cwd = await makeProject({ "AGENTS.md": "Project rules win." });
    const prompt = await buildSystemPrompt(cwd, undefined, true, undefined, [
      "read",
      "edit",
      "write",
      "bash",
      "web_search",
      "web_fetch",
      "source_path",
      "mcp__kencode-search__referenceSources",
      "mcp__kencode-search__discoverRepos",
      "mcp__kencode-search__searchCode",
    ]);

    for (const required of [
      "works directly in the user's codebase",
      "completing tasks end-to-end",
      "Final replies: 1–2 sentences, hard cap 5",
      "Read before `edit`/`write`",
      "re-read after formatters",
      "Compute in bash; write with `edit`/`write`",
      "Match neighbors",
      "When none exist, infer from the task and project",
      "ask only when a missing product or taste decision would materially change the result",
      "Keep edits small",
      "Do routine follow-up yourself",
      "Ask first for destructive actions",
      "Preserve user work",
      "Rule precedence: project context files",
      "file/module patterns → applicable skill instructions",
      "Your training data has a cutoff",
      "treat it as a stale hint to verify, never as ground truth",
      "Do not rely on memory for APIs",
      "Use `source_path`",
      "web_search` then `web_fetch",
      "ReferenceSources",
      "DiscoverRepos",
      "SearchCode literal text/RE2 (not semantic)",
      "Choose targeted verification appropriate to the change",
    ]) {
      expect(prompt).toContain(required);
    }
  });

  it("keeps kencode guidance concise while separating repo discovery from exact search", async () => {
    const cwd = await makeProject();
    const prompt = await buildSystemPrompt(cwd, undefined, false, undefined, [
      "mcp__kencode-search__referenceSources",
      "mcp__kencode-search__discoverRepos",
      "mcp__kencode-search__searchCode",
    ]);
    const tools = toolsSection(prompt);

    expect(tools).toContain("curated, categorized reference repos");
    expect(tools).toContain("Search GitHub repos live");
    expect(tools).toContain("returns metadata, not snippets");
    expect(tools).toContain("literal text or RE2 regex");
    expect(tools).toContain("NOT semantic");
    expect(tools).toContain("path` is a literal file-path substring");
    expect(tools).not.toContain("zero hits, every time");
    expect(tools.length).toBeLessThan(950);
  });

  it("routes public-code research guidance through tool_search when MCP tools are deferred", async () => {
    const cwd = await makeProject();
    // Deferred MCP loading: kencode tools live in the catalog, tool_search is active.
    const deferred = await buildSystemPrompt(cwd, undefined, false, undefined, [
      "read",
      "bash",
      "tool_search",
    ]);
    // Research section must not name tools the model can't call yet…
    expect(deferred).not.toContain("SearchCode literal text/RE2");
    expect(deferred).not.toContain("ReferenceSources");
    // …and must point discovery at tool_search instead (research + tools hint).
    expect(deferred).toContain("call `tool_search` first");
    expect(deferred).toContain("Check the catalog BEFORE concluding");

    // Neither kencode nor tool_search active: the public-code sentence is omitted.
    const bare = await buildSystemPrompt(cwd, undefined, false, undefined, ["read", "bash"]);
    expect(bare).not.toContain("SearchCode literal text/RE2");
    expect(bare).not.toContain("tool_search");
  });

  it("measures representative system prompt sizes", async () => {
    const normalCwd = await makeProject();
    const normalToolNames = [
      "read",
      "grep",
      "find",
      "ls",
      "web_search",
      "web_fetch",
      "source_path",
      "mcp__kencode-search__referenceSources",
      "mcp__kencode-search__discoverRepos",
      "mcp__kencode-search__searchCode",
    ];
    const normalPrompt = await buildSystemPrompt(
      normalCwd,
      undefined,
      false,
      undefined,
      normalToolNames,
    );

    const planModePrompt = await buildSystemPrompt(
      normalCwd,
      undefined,
      true,
      undefined,
      normalToolNames,
    );

    const typescriptCwd = await makeProject({
      "AGENTS.md": "Prefer strict TypeScript. Run the focused test before reporting completion.",
      "package.json": JSON.stringify({
        scripts: {
          test: "vitest",
          typecheck: "tsc --noEmit",
        },
        devDependencies: {
          typescript: "^5.0.0",
          vitest: "^3.0.0",
        },
      }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
    });
    const typescriptPrompt = await buildSystemPrompt(
      typescriptCwd,
      [
        {
          name: "find-skills",
          description: "Find and install agent skills from the open ecosystem.",
          content: "Use this when the user asks whether a skill exists for a task.",
          source: "test-fixture",
        },
      ],
      false,
      undefined,
      [
        "read",
        "edit",
        "bash",
        "grep",
        "find",
        "ls",
        "web_search",
        "web_fetch",
        "source_path",
        "skill",
        "mcp__kencode-search__referenceSources",
        "mcp__kencode-search__discoverRepos",
        "mcp__kencode-search__searchCode",
      ],
      new Set<LanguageId>(["typescript"]),
    );

    const measurements = {
      normal: promptSize(normalPrompt),
      planMode: promptSize(planModePrompt),
      typescriptProjectContextToolsSkills: promptSize(typescriptPrompt),
    };

    console.info(`system prompt size measurements: ${JSON.stringify(measurements)}`);

    expect(measurements.normal.characters).toBeLessThan(5_100);
    expect(measurements.planMode.characters).toBeLessThan(6_300);
    expect(measurements.typescriptProjectContextToolsSkills.characters).toBeLessThan(9_800);
    expect(measurements.planMode.characters).toBeGreaterThan(measurements.normal.characters);
    expect(measurements.typescriptProjectContextToolsSkills.characters).toBeGreaterThan(
      measurements.normal.characters,
    );
  });

  it("audits representative prompts for obsolete, duplicate, or contradictory guidance", async () => {
    const cwd = await makeProject({
      "AGENTS.md": "Prefer project-specific rules.",
      "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
      "tsconfig.json": "{}",
    });
    const prompt = await buildSystemPrompt(
      cwd,
      [{ name: "find-skills", description: "Find skills.", content: "", source: "test" }],
      false,
      undefined,
      [
        "read",
        "edit",
        "write",
        "bash",
        "web_search",
        "web_fetch",
        "source_path",
        "skill",
        "mcp__kencode-search__referenceSources",
        "mcp__kencode-search__discoverRepos",
        "mcp__kencode-search__searchCode",
      ],
      new Set<LanguageId>(["typescript"]),
    );

    const audit = promptAudit(prompt);
    console.info(`system prompt audit: ${JSON.stringify(audit)}`);

    expect(audit.flags).toEqual([]);
    expect(audit.size.characters).toBeLessThan(9_500);
    expect(audit.size.sections).toBeGreaterThanOrEqual(8);
  });

  it("only references web_search in Research when it is an active tool", async () => {
    const cwd = await makeProject();

    // Anthropic-shaped tool set: no client-side web_search tool.
    const withoutSearch = await buildSystemPrompt(cwd, undefined, false, undefined, [
      "read",
      "bash",
      "web_fetch",
    ]);
    expect(withoutSearch).not.toContain("web_search");
    expect(withoutSearch).toContain(
      "use `web_fetch` for authoritative docs (native web search is available)",
    );

    const withSearch = await buildSystemPrompt(cwd, undefined, false, undefined, [
      "read",
      "bash",
      "web_search",
      "web_fetch",
    ]);
    expect(withSearch).toContain("use `web_search` then `web_fetch` for authoritative docs");
  });

  it("reports the resolved shell in the Environment section", async () => {
    const cwd = await makeProject();
    const prompt = await buildSystemPrompt(cwd, undefined, false, undefined, ["read"]);

    // Non-Windows hosts (and Windows with Git Bash) run POSIX bash.
    expect(prompt).toContain("- Shell: bash (POSIX)");
  });

  it("states the nearest-wins precedence rule in the project context section", async () => {
    const cwd = await makeProject({ "AGENTS.md": "Project rules." });
    const prompt = await buildSystemPrompt(cwd, undefined, false, undefined, ["read"]);

    expect(prompt).toContain("Files are ordered broadest → nearest.");
    expect(prompt).toContain("the nearest file wins");
  });

  it("uses the Claude Code identity for Anthropic and GG Coder for other providers", async () => {
    const cwd = await makeProject();
    const anthropic = await buildSystemPrompt(
      cwd,
      undefined,
      false,
      undefined,
      ["read"],
      undefined,
      "anthropic",
    );
    const openai = await buildSystemPrompt(
      cwd,
      undefined,
      false,
      undefined,
      ["read"],
      undefined,
      "openai",
    );

    expect(anthropic.startsWith("You are Claude Code")).toBe(true);
    expect(anthropic).not.toContain("GG Coder by Ken Kai");
    expect(openai.startsWith("You are GG Coder by Ken Kai")).toBe(true);
    expect(openai).not.toContain("You are Claude Code");
  });
});

describe("collectProjectContext", () => {
  it("picks one file per directory — AGENTS.md shadows CLAUDE.md and the rest", async () => {
    const cwd = await makeProject({
      "AGENTS.md": "agents rules",
      "CLAUDE.md": "claude rules",
      ".cursorrules": "cursor rules",
    });

    const parts = await collectProjectContext(cwd);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toContain("AGENTS.md");
    expect(parts[0]).toContain("agents rules");
    expect(parts.join("\n")).not.toContain("claude rules");
    expect(parts.join("\n")).not.toContain("cursor rules");
  });

  it("AGENTS.override.md beats AGENTS.md in the same directory", async () => {
    const cwd = await makeProject({
      "AGENTS.override.md": "local override rules",
      "AGENTS.md": "checked-in rules",
    });

    const parts = await collectProjectContext(cwd);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toContain("AGENTS.override.md");
    expect(parts[0]).toContain("local override rules");
    expect(parts.join("\n")).not.toContain("checked-in rules");
  });

  it("renders broad → narrow: the nearest file comes last", async () => {
    const root = await makeProject({
      "AGENTS.md": "root-level rules",
      "nested/CLAUDE.md": "nested rules",
    });
    const cwd = path.join(root, "nested");

    const parts = await collectProjectContext(cwd);

    const rendered = parts.join("\n\n");
    expect(rendered.indexOf("root-level rules")).toBeGreaterThanOrEqual(0);
    expect(rendered.indexOf("root-level rules")).toBeLessThan(rendered.indexOf("nested rules"));
    expect(parts[parts.length - 1]).toContain("CLAUDE.md");
  });

  it("skips empty or whitespace-only files", async () => {
    const cwd = await makeProject({ "AGENTS.md": "  \n\t\n" });

    expect(await collectProjectContext(cwd)).toHaveLength(0);
  });

  it("strips a BOM so the content renders clean", async () => {
    const cwd = await makeProject({ "AGENTS.md": "\uFEFFbom rules" });

    const parts = await collectProjectContext(cwd);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toContain("bom rules");
    expect(parts[0]).not.toContain("\uFEFF");
  });

  it("budgets nearest-first at 32 KiB and reports skipped files", async () => {
    const bigParent = "x".repeat(PROJECT_CONTEXT_MAX_BYTES + 1_000);
    const root = await makeProject({
      "AGENTS.md": bigParent,
      "nested/CLAUDE.md": "nearest rules survive",
    });
    const cwd = path.join(root, "nested");

    const parts = await collectProjectContext(cwd);

    const rendered = parts.join("\n\n");
    expect(rendered).toContain("nearest rules survive");
    expect(rendered).not.toContain(bigParent);
    expect(rendered).toContain("Skipped (context budget)");
    expect(rendered).toMatch(/Skipped \(context budget\): .*AGENTS\.md \(\d+KB\)/);
  });

  it("keeps the nearest file when the budget cannot fit both", async () => {
    const nearBig = "n".repeat(PROJECT_CONTEXT_MAX_BYTES - 100);
    const parentRules = `parent rules ${"p".repeat(200)}`; // larger than the 100B leftover
    const root = await makeProject({
      "AGENTS.md": parentRules,
      "nested/AGENTS.md": nearBig,
    });
    const cwd = path.join(root, "nested");

    const parts = await collectProjectContext(cwd);
    const rendered = parts.join("\n\n");

    // The nearest (big) file consumed the budget; the parent was dropped.
    expect(rendered).toContain(nearBig);
    expect(rendered).not.toContain(parentRules);
    expect(rendered).toContain("Skipped (context budget)");
  });
});
