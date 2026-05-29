import { describe, expect, it } from "vitest";
import { PROMPT_COMMANDS } from "./prompt-commands.js";

function getGoalPrompt(): string {
  const goal = PROMPT_COMMANDS.find((command) => command.name === "goal");
  expect(goal).toBeDefined();
  return goal?.prompt ?? "";
}

describe("prompt commands", () => {
  it("defines /goal as a short Goal setup wrapper", () => {
    const goal = PROMPT_COMMANDS.find((command) => command.name === "goal");
    const prompt = getGoalPrompt();

    expect(goal?.description).toContain("programmatic goal loop");
    expect(prompt).toContain("Create a Goal run for the following objective");
    expect(prompt).toContain("First plan/research only if needed");
    expect(prompt).toContain("Goal setup will consume that plan");
    expect(prompt.length).toBeLessThan(240);
    expect(prompt).not.toContain("Core mindset: goal-specific sensory proof");
    expect(prompt).not.toContain("Non-negotiable boundary: /goal creates a run");
    expect(prompt).not.toContain("Do not implement, fix, refactor, edit");
  });

  it("keeps deep Goal setup policy out of the slash command body", () => {
    const prompt = getGoalPrompt();

    for (const snippet of [
      "1. Intended experience",
      "2. Failure imagination",
      "3. Required senses/signals",
      "4. Proportional instruments",
      "5. Completion rule",
    ]) {
      expect(prompt).not.toContain(snippet);
    }
    expect(prompt).not.toContain("Do not default to ordinary tests, generic scripts");
    expect(prompt).not.toContain("worker agents should build instruments");
  });

  it("guards /goal against the old generic proof-path bias", () => {
    const prompt = getGoalPrompt();
    const forbiddenPhrases = [
      "the simplest proof paths",
      "Build a capability/evidence plan before implementation",
      "choose the simplest reliable proof",
      "Do not require a script for every task",
      "what artifact would prove the requested outcome worked end-to-end",
      "scripts, tests, fixtures, seeded data, app/dev servers, browser automation, screenshots, logs",
      "ffmpeg, expo, adb, xcrun, playwright",
    ];

    for (const phrase of forbiddenPhrases) {
      expect(prompt).not.toContain(phrase);
    }
  });

  it("removes retired prompt-template commands", () => {
    const removedCommandNames = [
      "scan",
      "verify",
      "source",
      "simplify",
      "batch",
      "research",
      "setup-lint",
      `setup-${"tests"}`,
      "setup-update",
    ];
    const removedAliases = ["depcheck", "depsource"];

    for (const name of removedCommandNames) {
      expect(PROMPT_COMMANDS.find((command) => command.name === name)).toBeUndefined();
    }
    for (const alias of removedAliases) {
      expect(PROMPT_COMMANDS.find((command) => command.aliases.includes(alias))).toBeUndefined();
    }
  });

  it("defines /expand as a fresh, repo-validated, feature-first plan-mode command", () => {
    const expand = PROMPT_COMMANDS.find((command) => command.name === "expand");

    expect(expand).toBeDefined();
    expect(expand?.prompt).toContain("Spawn exactly 5 sub-agents in parallel");
    expect(expand?.prompt).toContain("updated within the last 6 months");
    expect(expand?.prompt).toContain("validate it yourself before reporting");
    expect(expand?.prompt).toContain("The table must have exactly 3 columns");
    expect(expand?.prompt).toContain("Do not start implementing until the user chooses");
    expect(expand?.prompt).toContain("A) Build all of these features in plan mode");
    expect(expand?.prompt).toContain("B) Build only the top priority ones in plan mode");
    expect(expand?.prompt).toContain("C) Other");
    expect(expand?.prompt).toContain("call the enter_plan tool");
    expect(expand?.prompt).toContain("call exit_plan with the plan path");
    expect(expand?.prompt).not.toContain("Create a Goal");
    expect(expand?.prompt).not.toContain("planning-only Goal tasks");
  });

  it("keeps /init focused on project-specific CLAUDE.md content", () => {
    const init = PROMPT_COMMANDS.find((command) => command.name === "init");

    expect(init).toBeDefined();
    expect(init?.prompt).toContain("project-specific context only");
    expect(init?.prompt).toContain("Do NOT add generic agent behavior");
    expect(init?.prompt).toContain("Remove generic guidance");
    expect(init?.prompt).toContain("Never add guidance that requires running checks");
    expect(init?.prompt).toContain("mandatory after-every-edit requirements");
    expect(init?.prompt).toContain("After editing ANY file");
    expect(init?.prompt).toContain(
      "Do not duplicate language style packs, generic verification rules",
    );
    expect(init?.prompt).toContain("Do NOT embed generated symbol maps");
    expect(init?.prompt).toContain("auto-generated project inventories");
    expect(init?.prompt).toContain("CLAUDE.md must remain durable, agent-focused project context");
    expect(init?.prompt).not.toContain("human-authored");
    expect(init?.prompt).not.toContain("one file per component");
    expect(init?.prompt).not.toContain("single responsibility");
    expect(init?.prompt).not.toContain("zero-tolerance code quality checks");
    expect(init?.prompt).not.toContain("run full quality suite after every edit");
  });
});
