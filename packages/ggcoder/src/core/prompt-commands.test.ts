import { describe, expect, it } from "vitest";
import { PROMPT_COMMANDS } from "./prompt-commands.js";

function getGoalPrompt(): string {
  const goal = PROMPT_COMMANDS.find((command) => command.name === "goal");
  expect(goal).toBeDefined();
  return goal?.prompt ?? "";
}

function expectOrdered(text: string, snippets: string[]): void {
  let previousIndex = -1;

  for (const snippet of snippets) {
    const index = text.indexOf(snippet);
    expect(index, `Missing ordered snippet: ${snippet}`).toBeGreaterThan(previousIndex);
    previousIndex = index;
  }
}

describe("prompt commands", () => {
  it("defines /goal as a durable loop with proportional sensory proof", () => {
    const goal = PROMPT_COMMANDS.find((command) => command.name === "goal");
    const prompt = getGoalPrompt();

    expect(goal?.description).toContain("programmatic goal loop");
    expect(prompt).toContain("Core mindset: goal-specific sensory proof");
    expect(prompt).toContain(
      "Do not default to ordinary tests, generic scripts, or broad simulations",
    );
    expect(prompt).toContain("Required senses/signals");
    expect(prompt).toContain("Proportional instruments");
    expect(prompt).toContain("Any examples you consider are inspiration, not a checklist");
    expect(prompt).toContain("Persist the run with the goals tool");
    expect(prompt).toContain("evidence_plan items");
    expect(prompt).toContain(
      "Non-negotiable boundary: /goal creates a run, it does not do the work",
    );
    expect(prompt).toContain("Create or update the durable run and Goal tasks, then stop");
    expect(prompt).toContain(
      "Do not implement, fix, refactor, edit, or generate project artifacts",
    );
    expect(prompt).toContain("Do not call subagent, the normal tasks tool, goals resume");
    expect(prompt).toContain('Do not run the verifier or "just start" any task');
    expect(prompt).toContain(
      "Worker agents do implementation after the user explicitly starts the Goal",
    );
    expect(prompt).toContain("Plan first; do not build during initial Goal creation");
    expect(prompt).toContain("You MUST run every cheap local prerequisite check");
    expect(prompt).toContain("Do not leave a locally checkable prerequisite as unknown");
    expect(prompt).toContain("do not mark any prerequisite met unless you have checked it");
    expect(prompt).toContain(
      "the goals tool will also run each provided `check_command` before persisting",
    );
    expect(prompt).toContain("worker agents should build instruments");
    expect(prompt).toContain("after the user starts the Goal");
    expect(prompt).toContain("capture it as a Goal task instead of doing it yourself");
    expect(prompt).toContain("Only ask the user for true external blockers");
    expect(prompt).toContain('named "User prerequisites" in the pane');
    expect(prompt).toContain("The user may provide the missing value or instructions in chat");
    expect(prompt).toContain("verify it locally without revealing secrets");
    expect(prompt).toContain(
      "do not simulate, script, screenshot, benchmark, or red-team anything unless that signal is relevant",
    );
    expect(prompt).toContain("Do not use the normal tasks tool for this workflow");
    expect(prompt).toContain("Each Goal task prompt must be standalone");
    expect(prompt).toContain('Avoid pure "investigate and report" tasks');
    expect(prompt).toContain('goals({ action: "evidence"');
    expect(prompt).toContain("creating or updating the next implementation task");
    expect(prompt).toContain("persist the run/tasks/evidence plan → stop");
    expect(prompt).toContain("briefly say what you are doing as the coordinator");
    expect(prompt).not.toContain("main orchestrator");
    expect(prompt).not.toContain("what the orchestrator is doing");
    expect(prompt).toContain(
      "take the next durable control-loop action rather than merely narrating",
    );
    expect(prompt).toContain("do not switch into hands-on implementation");
    expect(prompt).toContain("only complete after verification passes");
    expect(prompt).toContain("Then stop. Do not continue into implementation");
    expect(prompt).toContain("worker startup, verifier execution, or Goal resume");
    expect(prompt).toContain("Goal pane keybind is (r) to run it");
    expect(prompt).toContain("give the user a specific final summary in chat");
    expect(prompt).toContain("Do not collapse the outcome into one generic row");
    expect(prompt).toContain("one row per substantive Goal task");
    expect(prompt).toContain("problem, how it was proven real or wrong, what fixed it");
    expect(prompt).toContain("creation/improvement/non-problem goals");
    expect(prompt).toContain("Include small snippets when useful");
    expect(prompt).toContain("file:line references, command names and exit codes");
    expect(prompt).toContain('concrete proof snippets instead of a generic "verified" claim');
  });

  it("keeps the /goal sensory-proof mindset complete and ordered", () => {
    const prompt = getGoalPrompt();

    expectOrdered(prompt, [
      "1. Intended experience",
      "2. Failure imagination",
      "3. Required senses/signals",
      "4. Proportional instruments",
      "5. Completion rule",
    ]);
    expect(prompt).toContain("First model what must be experienced");
    expect(prompt).toContain("Think in capabilities, not fixed tools");
    expect(prompt).toContain("as small as possible while still removing the important assumptions");
    expect(prompt).toContain("what remains unproven or blocked");
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

  it("defines /source as a plan-research-adjust-verify command", () => {
    const source = PROMPT_COMMANDS.find((command) => command.name === "source");

    expect(source).toBeDefined();
    expect(source?.aliases).toEqual(["depcheck", "depsource"]);
    expect(source?.description).toContain("Plan, source-check, adjust, and verify");
    expect(source?.prompt).toContain("# Source: Plan → Research → Adjust → Verify");
    expect(source?.prompt).toContain("Do a short, private plan");
    expect(source?.prompt).toContain("call `source_path` before making claims");
    expect(source?.prompt).toContain("Spawn the research sub-agents in parallel");
    expect(source?.prompt).toContain("fix all confirmed issues directly");
    expect(source?.prompt).toContain("Run the relevant project checks");
    expect(source?.prompt).not.toContain("Do not start implementing until the user chooses");
    expect(source?.prompt).not.toContain("Report only");
  });

  it("defines /expand as a fresh, repo-validated comparison command", () => {
    const expand = PROMPT_COMMANDS.find((command) => command.name === "expand");

    expect(expand).toBeDefined();
    expect(expand?.prompt).toContain("Spawn exactly 5 sub-agents in parallel");
    expect(expand?.prompt).toContain("updated within the last 6 months");
    expect(expand?.prompt).toContain("validate it yourself before reporting");
    expect(expand?.prompt).toContain("The table must have exactly 3 columns");
    expect(expand?.prompt).toContain("Do not start implementing until the user chooses");
    expect(expand?.prompt).toContain("Do not create planning tasks");
    expect(expand?.prompt).not.toContain("Create an implementation plan first");
    expect(expand?.prompt).not.toContain("create one planning task");
    expect(expand?.prompt).not.toContain("plan mode");
  });

  it("keeps /init focused on project-specific CLAUDE.md content", () => {
    const init = PROMPT_COMMANDS.find((command) => command.name === "init");

    expect(init).toBeDefined();
    expect(init?.prompt).toContain("project-specific context only");
    expect(init?.prompt).toContain("Do NOT add generic agent behavior");
    expect(init?.prompt).toContain("Remove generic guidance");
    expect(init?.prompt).toContain(
      "Do not duplicate language style packs or generic verification rules",
    );
    expect(init?.prompt).toContain("Do NOT embed generated symbol maps");
    expect(init?.prompt).toContain("generated repo maps");
    expect(init?.prompt).toContain("CLAUDE.md must remain durable, agent-focused project context");
    expect(init?.prompt).not.toContain("human-authored");
    expect(init?.prompt).not.toContain("one file per component");
    expect(init?.prompt).not.toContain("single responsibility");
    expect(init?.prompt).not.toContain("zero-tolerance code quality checks");
  });
});
