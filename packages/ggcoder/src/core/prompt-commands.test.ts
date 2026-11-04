import { describe, expect, it, vi } from "vitest";
import { PROMPT_COMMANDS } from "./prompt-commands.js";

describe("prompt commands", () => {
  it("no longer defines the /goal command", () => {
    expect(PROMPT_COMMANDS.find((command) => command.name === "goal")).toBeUndefined();
    expect(PROMPT_COMMANDS.find((command) => command.aliases.includes("g"))).toBeUndefined();
  });

  it("strands no audit protocol or dated threat data in a command prompt", () => {
    // /bullet-proof became the bundled `bulletproof` skill (retirement asserted
    // below). Its protocol and incident data must not survive as a copy here,
    // where there is no snapshot date and no confidence marker to age it.
    for (const command of PROMPT_COMMANDS) {
      expect(command.prompt, command.name).not.toContain("CVE-2025-30066");
      expect(command.prompt, command.name).not.toContain("Subagents cannot see this prompt.");
      expect(command.prompt, command.name).not.toContain("surviving findings per skeptic");
    }
  });

  // The commit is where work gets verified; replies leave checks to it.
  it("builds /commit in for every project: checks with tests, review, commit, push", () => {
    const cmd = PROMPT_COMMANDS.find((command) => command.name === "commit");
    expect(cmd?.prompt).toContain("Verification in your instructions, plus the tests");
    expect(cmd?.prompt).toContain("Run each standalone, unpiped");
    expect(cmd?.prompt).toContain("Fix every failure");
    expect(cmd?.prompt).toContain("spawn ONE subagent with the full diff");
    expect(cmd?.prompt).toContain("never `git add -A`");
    expect(cmd?.prompt).toContain("never with `--no-verify`");
    expect(cmd?.prompt).toContain("stop before committing");
    // Never pushes somewhere unconfigured.
    expect(cmd?.prompt).toContain("if it has none, say so instead of pushing");
  });

  it("lets a project's own commit.md, which the built-in name shadows, take over", () => {
    const cmd = PROMPT_COMMANDS.find((command) => command.name === "commit");
    expect(cmd?.prompt).toContain(
      "If `.gg/commands/commit.md` exists, read it and follow it instead of these steps",
    );
    expect(cmd?.prompt).toContain("If it runs no tests while the project has some, run them too");
  });

  it("makes /setup-commit include the project's tests", () => {
    const cmd = PROMPT_COMMANDS.find((command) => command.name === "setup-commit");
    expect(cmd?.prompt).toContain("[PROJECT-SPECIFIC LINT/TYPECHECK/TEST COMMANDS]");
    expect(cmd?.prompt).toContain("tests included");
  });

  it("defines /steroids as profile, discover, ask, then index only what was chosen", () => {
    const cmd = PROMPT_COMMANDS.find((command) => command.name === "steroids");
    expect(cmd?.prompt).toContain("Profile the project");
    expect(cmd?.prompt).toContain("`discover` queries WITHOUT `add`");
    expect(cmd?.prompt).toContain("`ask_user` tool");
    expect(cmd?.prompt).toContain("Do not index anything until the user answers");
    expect(cmd?.prompt).toContain("`steroids` `add`");
  });

  it("routes real-code comparison through the native steroids tool", () => {
    for (const name of ["compare", "expand"]) {
      const cmd = PROMPT_COMMANDS.find((command) => command.name === name);
      expect(cmd?.prompt, name).toContain("`steroids`");
      expect(cmd?.prompt, name).not.toContain("kencode");
    }
  });

  it("points /init at the app's New Session instead of CLI keybinds when run under gg-app", async () => {
    const previous = process.env.GG_APP_PORT;
    process.env.GG_APP_PORT = "0";
    vi.resetModules();
    try {
      const { PROMPT_COMMANDS: appPromptCommands } = await import("./prompt-commands.js");
      const init = appPromptCommands.find((command) => command.name === "init");

      expect(init?.prompt).toContain("New Session");
      expect(init?.prompt).toContain('click "+ New"');
      expect(init?.prompt).not.toContain("restart ggcoder");
      expect(init?.prompt).not.toContain("/quit");
    } finally {
      if (previous === undefined) delete process.env.GG_APP_PORT;
      else process.env.GG_APP_PORT = previous;
      vi.resetModules();
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
      "setup",
      "setup-lint",
      `setup-${"tests"}`,
      "setup-update",
      // Retired into the bundled `bulletproof` skill, which also fires inline
      // during ordinary feature work rather than only when invoked.
      "bullet-proof",
    ];
    const removedAliases = ["depcheck", "depsource", "setup-project", "bp"];

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
    // The choice is offered through `ask_user` (clickable options in the app)
    // and ONLY there: restating the options as text gave the user the same
    // question twice, once clickable and once not. Prose is the fallback for
    // hosts that cannot render the card at all.
    expect(expand?.prompt).toContain("`ask_user` tool");
    expect(expand?.prompt).toContain("Build all of these features in plan mode");
    expect(expand?.prompt).toContain("Build only the top priority ones in plan mode");
    expect(expand?.prompt).toContain("The card is the ONLY ask");
    expect(expand?.prompt).toContain("Only if `ask_user` is unavailable");
    expect(expand?.prompt).toContain("call the enter_plan tool");
    expect(expand?.prompt).toContain("call exit_plan with the plan path");
    expect(expand?.prompt).not.toContain("Create a Goal");
    expect(expand?.prompt).not.toContain("planning-only Goal tasks");
  });

  it("keeps /init focused on project-specific context", () => {
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
    expect(init?.prompt).toContain(
      "context file must remain durable, agent-focused project context",
    );
    expect(init?.prompt).not.toContain("human-authored");
    expect(init?.prompt).not.toContain("one file per component");
    expect(init?.prompt).not.toContain("single responsibility");
    expect(init?.prompt).not.toContain("zero-tolerance code quality checks");
    expect(init?.prompt).not.toContain("run full quality suite after every edit");
  });

  it("states each redundancy rule exactly once so /init reads as one filter", () => {
    const init = PROMPT_COMMANDS.find((command) => command.name === "init");
    const count = (needle: string): number => init!.prompt.split(needle).length - 1;

    // The old prompt restated these across the preamble and 3 separate steps.
    // Repetition-as-emphasis is what you write when a rule isn't structurally
    // enforceable; the fence + budget now carry that load instead.
    expect(count("Do NOT add generic agent behavior")).toBe(1);
    expect(count("Do NOT embed generated symbol maps")).toBe(1);
    expect(count("Never add guidance that requires running checks")).toBe(1);
  });

  it("makes /init regeneration replace a fenced block instead of appending", () => {
    const init = PROMPT_COMMANDS.find((command) => command.name === "init");

    // /init is re-run over a project's lifetime. Without a marker separating
    // agent-generated from user-written content, "preserve custom sections"
    // preserves everything and the file grows monotonically.
    expect(init?.prompt).toContain("<!-- gg:init:start -->");
    expect(init?.prompt).toContain("<!-- gg:init:end -->");
    expect(init?.prompt).toContain("replace everything between the markers wholesale");
    expect(init?.prompt).toContain("Text outside the fence is user-owned");
  });

  it("makes /init write to the context file the loader actually reads", () => {
    const init = PROMPT_COMMANDS.find((command) => command.name === "init");

    // CONTEXT_FILES takes one file per directory, AGENTS.md outranks CLAUDE.md.
    // Writing a fresh CLAUDE.md next to an existing AGENTS.md creates a file
    // that is silently never loaded.
    expect(init?.prompt).toContain("one per directory, first match wins");
    expect(init?.prompt).toContain("AGENTS.override.md`");
    expect(init?.prompt).toContain("already has an `AGENTS.md`, update that file");
  });

  it("budgets /init output in bytes with a stated token cost, not a line cap", () => {
    const init = PROMPT_COMMANDS.find((command) => command.name === "init");

    // A line cap is unverifiable by the model and doesn't constrain tables or
    // code fences; the real constraint is PROJECT_CONTEXT_MAX_BYTES (32KB).
    expect(init?.prompt).toContain("cached prefix of every request");
    expect(init?.prompt).toContain("Target 6KB or less");
    expect(init?.prompt).toContain("`wc -c`");
    expect(init?.prompt).not.toContain("under 100 lines");
  });

  it("hunts non-derivable knowledge instead of mapping directories", () => {
    const init = PROMPT_COMMANDS.find((command) => command.name === "init");

    // Gotchas/invariants are the only content an agent can't recover by
    // reading the code, so they replace the directory-structure sweep whose
    // output the prompt then forbids embedding anyway.
    expect(init?.prompt).toContain("Gotchas & Invariants Agent");
    expect(init?.prompt).toContain("would a competent agent get this wrong without being told?");
    expect(init?.prompt).not.toContain("Directory Structure Agent");
  });

  it("defines /setup-ci as a dual-mode, stack-agnostic, hardened-by-construction command", () => {
    const setupCi = PROMPT_COMMANDS.find((command) => command.name === "setup-ci");

    expect(setupCi).toBeDefined();
    // Dual mode: generate from scratch OR audit + harden existing workflows.
    expect(setupCi?.prompt).toContain("Mode A: generate");
    expect(setupCi?.prompt).toContain("Mode B: audit + harden");
    // Stack-agnostic: manifests decide, and the detector spans more than Node.
    expect(setupCi?.prompt).toContain("never assume a stack");
    expect(setupCi?.prompt).toContain("Detect the stack (manifests only)");
    expect(setupCi?.prompt).toContain("pyproject.toml");
    expect(setupCi?.prompt).toContain("go.mod");
    expect(setupCi?.prompt).toContain("Cargo.toml");
    // Hardened by construction: every cost/safety rule present.
    expect(setupCi?.prompt).toContain("contents: read");
    expect(setupCi?.prompt).toContain("ubuntu-latest");
    expect(setupCi?.prompt).toContain("10x billing");
    expect(setupCi?.prompt).toContain("cancel-in-progress: true");
    expect(setupCi?.prompt).toContain("timeout-minutes: 15");
    // Publish workflows must never be cancelled mid-flight.
    expect(setupCi?.prompt).toContain("cancelling mid-publish is worse than waiting");
    // Never weakens existing checks; rulesets degrade gracefully; doesn't auto-commit.
    expect(setupCi?.prompt).toContain("NEVER weaken a check to make it pass");
    expect(setupCi?.prompt).toContain("not an error");
    expect(setupCi?.prompt).toContain("Do NOT commit anything");
  });
});
