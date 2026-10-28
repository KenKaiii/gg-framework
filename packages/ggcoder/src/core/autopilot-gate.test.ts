import { describe, it, expect } from "vitest";
import {
  isWorkflowCommandText,
  matchExpandedCommand,
  countAssistantMessages,
  shouldStartAutopilotCycle,
  isMechanicalOnlyTurn,
  extractTurnToolCalls,
  USER_INSTRUCTIONS_HEADER,
  type WorkflowCommandSpec,
  type TurnToolCall,
} from "./autopilot-gate.js";
import { PROMPT_COMMANDS } from "./prompt-commands.js";
import { expandPromptCommand } from "./prompt-command-expansion.js";

// Synthetic: no shipped prompt command has an alias, so alias matching needs a
// fixture to exercise it. Real commands are covered by the PROMPT_COMMANDS
// loops below.
const COMMANDS: WorkflowCommandSpec[] = [
  { name: "compare", aliases: [], prompt: "Compare the code you just created…" },
  { name: "audit-fixture", aliases: ["af"], prompt: "Audit the project…" },
];

describe("isWorkflowCommandText", () => {
  it("matches a bare command", () => {
    expect(isWorkflowCommandText("/compare", COMMANDS)).toBe(true);
  });

  it("matches a command with trailing args", () => {
    expect(isWorkflowCommandText("/compare src/foo.ts please", COMMANDS)).toBe(true);
  });

  it("matches aliases and is case-insensitive", () => {
    expect(isWorkflowCommandText("/af", COMMANDS)).toBe(true);
    expect(isWorkflowCommandText("/COMPARE", COMMANDS)).toBe(true);
    expect(isWorkflowCommandText("/Audit-Fixture", COMMANDS)).toBe(true);
  });

  it("tolerates leading whitespace (matches trim semantics of the prompt path)", () => {
    expect(isWorkflowCommandText("  /compare", COMMANDS)).toBe(true);
  });

  it("rejects unknown commands, non-slash text, and prefix collisions", () => {
    expect(isWorkflowCommandText("/help", COMMANDS)).toBe(false);
    expect(isWorkflowCommandText("/comparex", COMMANDS)).toBe(false);
    expect(isWorkflowCommandText("compare the files", COMMANDS)).toBe(false);
    expect(isWorkflowCommandText("run /compare for me", COMMANDS)).toBe(false);
    expect(isWorkflowCommandText("/", COMMANDS)).toBe(false);
    expect(isWorkflowCommandText("", COMMANDS)).toBe(false);
  });

  it("recognizes EVERY built-in workflow command (the real leak set)", () => {
    // The reported bug: /compare fired an autopilot review of a report-only
    // command. Prove the gate recognizes every shipped PROMPT_COMMAND (and its
    // aliases) so none of them can leak into a review.
    for (const cmd of PROMPT_COMMANDS) {
      expect(isWorkflowCommandText(`/${cmd.name}`, PROMPT_COMMANDS)).toBe(true);
      expect(isWorkflowCommandText(`/${cmd.name} with args`, PROMPT_COMMANDS)).toBe(true);
      for (const alias of cmd.aliases) {
        expect(isWorkflowCommandText(`/${alias}`, PROMPT_COMMANDS)).toBe(true);
      }
    }
  });
});

describe("matchExpandedCommand", () => {
  it("recognizes the current expansion without treating guidance as user arguments", () => {
    const command = { name: "custom", prompt: "Review [$ARGUMENTS]." };
    const text = expandPromptCommand(command.prompt, "login only");
    expect(matchExpandedCommand(text, [command])).toEqual({ command, args: "login only" });
  });
  it("matches an exact template body", () => {
    const m = matchExpandedCommand("Compare the code you just created…", COMMANDS);
    expect(m?.command.name).toBe("compare");
    expect(m?.args).toBeNull();
  });

  it("matches template + user-instructions suffix and extracts the args", () => {
    const text = `Audit the project…${USER_INSTRUCTIONS_HEADER}only the auth module`;
    const m = matchExpandedCommand(text, COMMANDS);
    expect(m?.command.name).toBe("audit-fixture");
    expect(m?.args).toBe("only the auth module");
  });

  it("retains the legacy separator for older saved sessions", () => {
    // Old sessions must remain recognizable after the prompt format changes.
    expect(USER_INSTRUCTIONS_HEADER).toBe("\n\n## User Instructions\n\n");
  });

  it("returns null for ordinary user text and near-misses", () => {
    expect(matchExpandedCommand("compare my code to the repo", COMMANDS)).toBeNull();
    // Template body with arbitrary extra text but no separator is NOT an expansion.
    expect(
      matchExpandedCommand("Compare the code you just created… and also do X", COMMANDS),
    ).toBeNull();
    expect(matchExpandedCommand("", COMMANDS)).toBeNull();
  });

  it("matches every real built-in template round-tripped through expansion", () => {
    for (const cmd of PROMPT_COMMANDS) {
      // Mirrors AgentSession.prompt(): bare command → template verbatim.
      expect(matchExpandedCommand(cmd.prompt, PROMPT_COMMANDS)?.command.name).toBe(cmd.name);
      // Command with args → template + header + args.
      const withArgs = `${cmd.prompt}${USER_INSTRUCTIONS_HEADER}focus on src/`;
      const m = matchExpandedCommand(withArgs, PROMPT_COMMANDS);
      expect(m?.command.name).toBe(cmd.name);
      expect(m?.args).toBe("focus on src/");
    }
  });
});

describe("countAssistantMessages", () => {
  it("counts only assistant-role messages", () => {
    expect(
      countAssistantMessages([
        { role: "system" },
        { role: "user" },
        { role: "assistant" },
        { role: "tool" },
        { role: "assistant" },
      ]),
    ).toBe(2);
    expect(countAssistantMessages([])).toBe(0);
  });
});

describe("shouldStartAutopilotCycle", () => {
  const reviewable = {
    enabled: true,
    cancelled: false,
    planMode: false,
    workflowCommand: false,
    assistantMessagesAdded: 1,
  };

  it("starts a work review for a normal reviewable turn", () => {
    expect(shouldStartAutopilotCycle(reviewable)).toEqual({ start: true, kind: "work" });
  });

  it("starts a plan review when the turn submitted a plan (exit_plan)", () => {
    expect(shouldStartAutopilotCycle({ ...reviewable, planPending: true })).toEqual({
      start: true,
      kind: "plan",
    });
  });

  it("plan review beats workflow-command / mechanical-only / no-assistant-output", () => {
    // A plan-submission turn often looks skippable (mostly reads + exit_plan,
    // maybe zero assistant text added by the gate's count) — planPending must
    // override all the cheap-skip checks so the plan actually gets reviewed.
    expect(
      shouldStartAutopilotCycle({
        ...reviewable,
        planPending: true,
        workflowCommand: true,
        mechanicalOnly: true,
        assistantMessagesAdded: 0,
      }),
    ).toEqual({ start: true, kind: "plan" });
  });

  it("disabled / cancelled / plan-mode still beat a pending plan", () => {
    expect(shouldStartAutopilotCycle({ ...reviewable, planPending: true, enabled: false })).toEqual(
      { start: false, reason: "disabled" },
    );
    expect(
      shouldStartAutopilotCycle({ ...reviewable, planPending: true, cancelled: true }),
    ).toEqual({ start: false, reason: "cancelled" });
    // Still INSIDE plan mode (entered, never exited) → no submitted plan to
    // review; Ken must not touch a read-only session.
    expect(shouldStartAutopilotCycle({ ...reviewable, planPending: true, planMode: true })).toEqual(
      { start: false, reason: "plan-mode" },
    );
  });

  it("skips when autopilot is off", () => {
    expect(shouldStartAutopilotCycle({ ...reviewable, enabled: false })).toEqual({
      start: false,
      reason: "disabled",
    });
  });

  it("skips when the turn was cancelled", () => {
    expect(shouldStartAutopilotCycle({ ...reviewable, cancelled: true })).toEqual({
      start: false,
      reason: "cancelled",
    });
  });

  it("skips when the turn ended in plan mode (pending Accept/Reject modal)", () => {
    expect(shouldStartAutopilotCycle({ ...reviewable, planMode: true })).toEqual({
      start: false,
      reason: "plan-mode",
    });
  });

  it("skips workflow-command turns (/compare — the reported bug)", () => {
    expect(shouldStartAutopilotCycle({ ...reviewable, workflowCommand: true })).toEqual({
      start: false,
      reason: "workflow-command",
    });
  });

  it("skips turns that added no assistant output (/help, unknown /foo, failed runs)", () => {
    expect(shouldStartAutopilotCycle({ ...reviewable, assistantMessagesAdded: 0 })).toEqual({
      start: false,
      reason: "no-assistant-output",
    });
    // A run that somehow REMOVED messages (defensive) also never reviews.
    expect(shouldStartAutopilotCycle({ ...reviewable, assistantMessagesAdded: -1 })).toEqual({
      start: false,
      reason: "no-assistant-output",
    });
  });

  it("skips mechanical-only turns (dev server start, read-only lookup, git commit/push)", () => {
    expect(shouldStartAutopilotCycle({ ...reviewable, mechanicalOnly: true })).toEqual({
      start: false,
      reason: "mechanical-only",
    });
  });

  it("resolves multiple skip conditions in fixed priority order", () => {
    // disabled beats everything; plan-mode beats workflow-command beats no-output.
    expect(
      shouldStartAutopilotCycle({
        enabled: false,
        cancelled: true,
        planMode: true,
        workflowCommand: true,
        assistantMessagesAdded: 0,
      }),
    ).toEqual({ start: false, reason: "disabled" });
    expect(
      shouldStartAutopilotCycle({
        ...reviewable,
        planMode: true,
        workflowCommand: true,
        assistantMessagesAdded: 0,
      }),
    ).toEqual({ start: false, reason: "plan-mode" });
    expect(
      shouldStartAutopilotCycle({
        ...reviewable,
        workflowCommand: true,
        assistantMessagesAdded: 0,
      }),
    ).toEqual({ start: false, reason: "workflow-command" });
  });
});

describe("isMechanicalOnlyTurn", () => {
  it("is TRUE for a turn with no tool calls (plain-text answer, nothing built)", () => {
    // Matches the autopilot contract's own IGNORE example: "a plain question
    // that got answered with no code touched".
    expect(isMechanicalOnlyTurn([])).toBe(true);
  });

  it("treats dedicated read-only tools as mechanical regardless of args", () => {
    const calls: TurnToolCall[] = [
      { name: "read", args: { file_path: "a.ts" } },
      { name: "grep", args: { pattern: "TODO" } },
      { name: "find", args: { pattern: "*.ts" } },
      { name: "ls", args: { path: "." } },
      { name: "web_fetch", args: { url: "https://example.com" } },
      { name: "web_search", args: { query: "x" } },
      { name: "source_path", args: { package: "zod" } },
      { name: "task_output", args: { id: "abc" } },
      { name: "screenshot", args: { url: "http://localhost:3000" } },
      { name: "skill", args: { skill: "example-skill" } },
    ];
    expect(isMechanicalOnlyTurn(calls)).toBe(true);
  });

  it("is NOT mechanical when a research turn also calls write/edit/subagent", () => {
    expect(
      isMechanicalOnlyTurn([
        { name: "read", args: {} },
        { name: "write", args: {} },
      ]),
    ).toBe(false);
    expect(
      isMechanicalOnlyTurn([
        { name: "grep", args: {} },
        { name: "subagent", args: {} },
      ]),
    ).toBe(false);
  });

  it("is NOT mechanical for tools that mutate task/process state or produce artifacts", () => {
    expect(isMechanicalOnlyTurn([{ name: "generate_image", args: {} }])).toBe(false);
    expect(isMechanicalOnlyTurn([{ name: "tasks", args: {} }])).toBe(false);
    expect(isMechanicalOnlyTurn([{ name: "task_send", args: {} }])).toBe(false);
    expect(isMechanicalOnlyTurn([{ name: "task_stop", args: {} }])).toBe(false);
  });

  it("treats a background bash start (dev server / watcher) as mechanical", () => {
    const calls: TurnToolCall[] = [
      { name: "bash", args: { command: "npm run dev", run_in_background: true } },
    ];
    expect(isMechanicalOnlyTurn(calls)).toBe(true);
  });

  it("treats a read-only bash command as mechanical", () => {
    const calls: TurnToolCall[] = [{ name: "bash", args: { command: "git status" } }];
    expect(isMechanicalOnlyTurn(calls)).toBe(true);
  });

  it("treats a plain git add/commit/push workflow as mechanical", () => {
    const calls: TurnToolCall[] = [
      { name: "bash", args: { command: 'git add -A && git commit -m "fix" && git push' } },
    ];
    expect(isMechanicalOnlyTurn(calls)).toBe(true);
  });

  it("is NOT mechanical when a git chain mixes in a non-git command", () => {
    const calls: TurnToolCall[] = [
      { name: "bash", args: { command: "git commit -m x && rm -rf dist" } },
    ];
    expect(isMechanicalOnlyTurn(calls)).toBe(false);
  });

  it("is NOT mechanical when any call is edit/write", () => {
    const calls: TurnToolCall[] = [
      { name: "bash", args: { command: "git status" } },
      { name: "edit", args: { file_path: "a.ts" } },
    ];
    expect(isMechanicalOnlyTurn(calls)).toBe(false);
  });

  it("is NOT mechanical for an ordinary mutating bash command", () => {
    const calls: TurnToolCall[] = [{ name: "bash", args: { command: "rm -rf node_modules" } }];
    expect(isMechanicalOnlyTurn(calls)).toBe(false);
  });

  it("is NOT mechanical when args are missing (defensive)", () => {
    expect(isMechanicalOnlyTurn([{ name: "bash" }])).toBe(false);
  });
});

describe("extractTurnToolCalls", () => {
  it("collects tool calls only from assistant messages at/after startIndex", () => {
    const messages = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "tool_call", name: "read", args: { file_path: "old.ts" } }],
      },
      { role: "tool", content: "ok" },
      {
        role: "assistant",
        content: [
          { type: "text" },
          { type: "tool_call", name: "bash", args: { command: "git status" } },
        ],
      },
    ];
    expect(extractTurnToolCalls(messages, 2)).toEqual([
      { name: "bash", args: { command: "git status" } },
    ]);
  });

  it("returns an empty array for a string-content assistant message (no tool calls)", () => {
    const messages = [{ role: "assistant", content: "just text, no tools" }];
    expect(extractTurnToolCalls(messages, 0)).toEqual([]);
  });

  it("returns an empty array when startIndex is at the end", () => {
    const messages = [{ role: "assistant", content: [{ type: "tool_call", name: "bash" }] }];
    expect(extractTurnToolCalls(messages, 1)).toEqual([]);
  });
});
