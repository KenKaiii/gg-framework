import { describe, it, expect } from "vitest";
import os from "node:os";
import {
  buildKenDigest,
  buildKenAutopilotContext,
  buildKenAutopilotPlanContext,
  AUTOPILOT_REVIEW_INSTRUCTION,
  AUTOPILOT_PLAN_REVIEW_INSTRUCTION,
  KEN_RECENT_MESSAGE_LIMIT,
  INJECTED_PROMPT_LABEL,
} from "./ken-context.js";
import { USER_INSTRUCTIONS_HEADER } from "./autopilot-gate.js";
import { PROMPT_COMMANDS } from "./prompt-commands.js";
import { createTools } from "../tools/index.js";
import type { Message } from "@kenkaiiii/gg-ai";

// Mirror the sidecar's Ken allow-list so the filter test tracks the real set.
const KEN_ALLOWED_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "source_path",
  "web_fetch",
  "web_search",
  "screenshot",
  "steroids",
];

// Mirror of AgentSession.isToolAllowed (which is private): Ken whitelists no
// MCP server, so a tool passes only when its name is in the allow-list.
function isToolAllowed(name: string): boolean {
  return KEN_ALLOWED_TOOLS.includes(name);
}

describe("Ken allowedTools filter", () => {
  it("excludes every mutating tool from the Ken set", async () => {
    const { tools, processManager, lspManager } = await createTools(os.tmpdir(), {
      lspDiagnostics: false,
      steroidsBin: "/nonexistent/steroids",
    });
    try {
      const kenTools = tools.filter((t) => isToolAllowed(t.name)).map((t) => t.name);

      // The mutating / orchestration tools must NOT survive the filter.
      for (const banned of ["write", "edit", "bash", "tasks", "subagent", "generate_image"]) {
        expect(kenTools).not.toContain(banned);
      }
      // The read-only research/vision tools must survive.
      for (const allowed of ["read", "grep", "find", "ls", "screenshot", "steroids"]) {
        expect(kenTools).toContain(allowed);
      }
    } finally {
      processManager.shutdownAll();
      lspManager?.shutdownAll();
    }
  });

  it("allows the native steroids tool but blocks every MCP tool", () => {
    // steroids is Ken's research corpus: a native tool, no MCP server needed.
    expect(isToolAllowed("steroids")).toBe(true);
    // Any MCP server (e.g. a user-configured one) is blocked, even if it
    // exposes an innocuous-looking name.
    expect(isToolAllowed("mcp__some-other-server__searchCode")).toBe(false);
    expect(isToolAllowed("mcp__filesystem__write_file")).toBe(false);
  });
});

describe("buildKenDigest", () => {
  const base = {
    question: "what next?",
    cwd: "/tmp/proj",
    gitBranch: "main" as string | null,
    platform: "darwin",
  };

  it("uses host results instead of re-rejecting a completed background launch", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "bg",
            name: "bash",
            args: { command: "pnpm test", run_in_background: true },
          },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "bg", content: "ID: task-1", isError: false }],
      },
    ];
    const digest = buildKenDigest({
      ...base,
      messages,
      verificationProblem: null,
      verificationEvidence: [
        { command: "pnpm test", status: "passed", reason: "Host exit code 0" },
      ],
    });
    expect(digest).toContain("PASSED: `pnpm test`");
    expect(digest).toContain("Current host gate: satisfied");
    expect(digest).not.toContain("REJECTED: `pnpm test`");
    expect(digest).not.toContain("background or persistent commands are not bounded evidence");
  });

  it("does not fall back to old transcript failures when restored host evidence has no command names", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "old", name: "bash", args: { command: "pnpm test" } }],
      },
      {
        role: "tool",
        content: [
          { type: "tool_result", toolCallId: "old", content: "Exit code: 1", isError: true },
        ],
      },
    ];
    const digest = buildKenDigest({
      ...base,
      messages,
      verificationEvidence: [],
      verificationProblem: null,
    });
    expect(digest).toContain("Current host gate: satisfied");
    expect(digest).not.toContain("FAILED: `pnpm test`");
    const unresolved = buildKenDigest({
      ...base,
      messages,
      verificationEvidence: [],
      verificationProblem: "Unverified: a check failed",
    });
    expect(unresolved).toContain("Current host gate: Unverified: a check failed");
  });

  it("includes the env and the question", () => {
    const digest = buildKenDigest({ ...base, messages: [] });
    expect(digest).toContain("/tmp/proj");
    expect(digest).toContain("main");
    expect(digest).toContain("what next?");
    expect(digest).toContain("(no conversation yet)");
  });

  it("caps recent activity at the last-N messages", () => {
    const messages: Message[] = [];
    for (let i = 0; i < KEN_RECENT_MESSAGE_LIMIT + 10; i++) {
      messages.push({ role: "user", content: `msg-${i}` });
    }
    const digest = buildKenDigest({ ...base, messages });
    // The earliest messages fall outside the cap.
    expect(digest).not.toContain("msg-0");
    expect(digest).not.toContain("msg-5");
    // The newest message is kept.
    expect(digest).toContain(`msg-${KEN_RECENT_MESSAGE_LIMIT + 9}`);
  });

  it("strips image blocks from user messages", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", mediaType: "image/png", data: "AAAABBBBCCCC" },
        ],
      },
    ];
    const digest = buildKenDigest({ ...base, messages });
    expect(digest).toContain("look at this");
    expect(digest).not.toContain("AAAABBBBCCCC");
  });

  it("buildKenAutopilotContext injects the fixed review instruction as the question", () => {
    const messages: Message[] = [
      { role: "user", content: "add a login form" },
      { role: "assistant", content: "Added the form." },
    ];
    const digest = buildKenAutopilotContext({
      cwd: base.cwd,
      gitBranch: base.gitBranch,
      platform: base.platform,
      messages,
    });
    // The transcript is still inlined (Ken reviews it) ...
    expect(digest).toContain("add a login form");
    expect(digest).toContain("Added the form.");
    // ... and the trailing question is the fixed autopilot instruction, not a
    // user-typed one.
    expect(digest).toContain(AUTOPILOT_REVIEW_INSTRUCTION);
    expect(digest).toContain("PROMPT");
    expect(digest).toContain("ALL_CLEAR");
    expect(digest).toContain("HUMAN");
  });

  it("feeds only harness-classified command outcomes into verification evidence", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "pass", name: "bash", args: { command: "tsc --noEmit" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "pass", content: "Exit code: 0\n" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "watch",
            name: "bash",
            args: { command: "vitest --watch" },
          },
          { type: "tool_call", id: "status", name: "bash", args: { command: "git status" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool_result", toolCallId: "watch", content: "Exit code: 0\n" },
          { type: "tool_result", toolCallId: "status", content: "Exit code: 0\n" },
        ],
      },
    ];

    const digest = buildKenAutopilotContext({ ...base, messages });
    const evidence = digest
      .split("## Harness-classified verification evidence")[1]
      .split("## They just asked you")[0];
    expect(evidence).toContain("PASSED: `tsc --noEmit`");
    expect(evidence).toContain("REJECTED: `vitest --watch`");
    expect(evidence).not.toContain("git status");
  });

  it("autopilot review instruction separates true human decisions from safe implied follow-ups", () => {
    // GG Coder ending with a question/options is HUMAN only when it needs a
    // real user-level decision. Permission to continue safe work implied by the
    // original ask should become a PROMPT, not a blocker. Ken must also be told
    // injected lines are his own — these are leak regressions.
    expect(AUTOPILOT_REVIEW_INSTRUCTION).toContain("asking the user a question");
    expect(AUTOPILOT_REVIEW_INSTRUCTION).toContain("HUMAN only when");
    expect(AUTOPILOT_REVIEW_INSTRUCTION).toContain("actual user-level decision");
    expect(AUTOPILOT_REVIEW_INSTRUCTION).toContain(
      "mechanically implied by the user's original ask",
    );
    expect(AUTOPILOT_REVIEW_INSTRUCTION).toContain(
      "safe for GG Coder to do without new information",
    );
    expect(AUTOPILOT_REVIEW_INSTRUCTION).toContain("use PROMPT with the next concrete follow-up");
    expect(AUTOPILOT_REVIEW_INSTRUCTION).toContain("Original user request");
    expect(AUTOPILOT_REVIEW_INSTRUCTION).toContain("Ken autopilot (injected)");
  });

  it("buildKenAutopilotPlanContext inlines the plan section + plan instruction", () => {
    const messages: Message[] = [
      { role: "user", content: "add OAuth login" },
      { role: "assistant", content: "Plan drafted." },
    ];
    const digest = buildKenAutopilotPlanContext({
      cwd: base.cwd,
      gitBranch: base.gitBranch,
      platform: base.platform,
      messages,
      originalRequest: "add OAuth login",
      planContent: "# OAuth plan\n\n1. Add provider config\n2. Wire callback route",
    });
    // The plan itself is inlined under its own section …
    expect(digest).toContain("## Plan under review");
    expect(digest).toContain("Wire callback route");
    // … before the trailing question, which is the PLAN instruction (not the
    // work-review one).
    expect(digest.indexOf("## Plan under review")).toBeLessThan(
      digest.indexOf("## They just asked you"),
    );
    expect(digest).toContain(AUTOPILOT_PLAN_REVIEW_INSTRUCTION);
    expect(digest).not.toContain(AUTOPILOT_REVIEW_INSTRUCTION);
  });

  it("buildKenAutopilotPlanContext caps a pathological plan", () => {
    const digest = buildKenAutopilotPlanContext({
      cwd: base.cwd,
      gitBranch: base.gitBranch,
      platform: base.platform,
      messages: [],
      planContent: "x".repeat(10_000),
    });
    const section = digest.slice(digest.indexOf("## Plan under review"));
    expect(section).toContain("more chars]");
    expect(section.length).toBeLessThan(9000);
  });

  it("plan review instruction names the three allowed verdicts and forbids IGNORE", () => {
    expect(AUTOPILOT_PLAN_REVIEW_INSTRUCTION).toContain("ALL_CLEAR");
    expect(AUTOPILOT_PLAN_REVIEW_INSTRUCTION).toContain("PROMPT");
    expect(AUTOPILOT_PLAN_REVIEW_INSTRUCTION).toContain("HUMAN");
    expect(AUTOPILOT_PLAN_REVIEW_INSTRUCTION).toContain("Never IGNORE a plan");
    expect(AUTOPILOT_PLAN_REVIEW_INSTRUCTION).toContain("Plan under review");
  });

  it("uses the latest compaction summary as the story-so-far base", () => {
    const messages: Message[] = [
      { role: "user", content: "old turn that should be summarized away" },
      { role: "user", content: "[Previous conversation summary]\n\nWe scaffolded the app." },
      { role: "assistant", content: "Added the header." },
    ];
    const digest = buildKenDigest({ ...base, messages });
    expect(digest).toContain("Story so far");
    expect(digest).toContain("We scaffolded the app.");
    // Pre-summary messages are not echoed into recent activity.
    expect(digest).not.toContain("old turn that should be summarized away");
    // Post-summary activity is kept.
    expect(digest).toContain("Added the header.");
  });
});

describe("buildKenDigest — original request pinning", () => {
  const base = {
    question: "review it",
    cwd: "/tmp/proj",
    gitBranch: "main" as string | null,
    platform: "darwin",
  };

  it("pins the original request in its own section", () => {
    const digest = buildKenDigest({
      ...base,
      messages: [],
      originalRequest: "build a login form with validation",
    });
    expect(digest).toContain("## Original user request (the turn under review)");
    expect(digest).toContain("build a login form with validation");
  });

  it("keeps the original request even when it scrolled out of recent activity", () => {
    // The drift bug: multi-round cycles push the real ask out of the rolling
    // 20-message window. The pinned section must survive that.
    const messages: Message[] = [{ role: "user", content: "THE-REAL-ASK: add dark mode" }];
    for (let i = 0; i < KEN_RECENT_MESSAGE_LIMIT + 5; i++) {
      messages.push({ role: "assistant", content: `working… step ${i}` });
    }
    const digest = buildKenDigest({
      ...base,
      messages,
      originalRequest: "THE-REAL-ASK: add dark mode",
    });
    // Scrolled out of recent activity…
    expect(digest.split("## Original user request")[0]).not.toContain("THE-REAL-ASK");
    // …but pinned in its own section.
    expect(digest.split("## Original user request")[1]).toContain("THE-REAL-ASK: add dark mode");
  });

  it("gives the pinned request far more room than a recent-activity line", () => {
    // Recent-activity lines truncate at 1500 chars; the ask under review must
    // not be judged against a mid-sentence cut, so its cap is 4000.
    const longAsk = "requirement " + "x".repeat(3000);
    const digest = buildKenDigest({ ...base, messages: [], originalRequest: longAsk });
    const pinned = digest.split("## Original user request")[1];
    expect(pinned).toContain("x".repeat(3000));
  });

  it("omits the section when there is no original request (chat Ken)", () => {
    const digest = buildKenDigest({ ...base, messages: [] });
    expect(digest).not.toContain("## Original user request");
  });
});

describe("buildKenDigest — injected-prompt labeling", () => {
  const base = {
    question: "review it",
    cwd: "/tmp/proj",
    gitBranch: null,
    platform: "darwin",
  };

  it("labels autopilot-injected prompts as Ken's, never **User:**", () => {
    const injected = "Fix the failing auth test and prove it by running it.";
    const messages: Message[] = [
      { role: "user", content: "add auth" },
      { role: "assistant", content: "Added auth." },
      { role: "user", content: injected },
      { role: "assistant", content: "Fixed the test." },
    ];
    const digest = buildKenDigest({ ...base, messages, injectedPrompts: [injected] });
    expect(digest).toContain(`${INJECTED_PROMPT_LABEL} ${injected}`);
    expect(digest).not.toContain(`**User:** ${injected}`);
    // Real user asks keep the normal label.
    expect(digest).toContain("**User:** add auth");
  });

  it("matches injected prompts through whitespace drift", () => {
    const injected = "Fix the failing test.";
    const messages: Message[] = [{ role: "user", content: `  ${injected}  ` }];
    const digest = buildKenDigest({ ...base, messages, injectedPrompts: [injected] });
    expect(digest).toContain(INJECTED_PROMPT_LABEL);
  });
});

describe("buildKenDigest — workflow-command labeling", () => {
  const base = {
    question: "review it",
    cwd: "/tmp/proj",
    gitBranch: null,
    platform: "darwin",
  };
  const compare = PROMPT_COMMANDS.find((c) => c.name === "compare")!;

  it("renders an expanded template as a short command note, not a user ask", () => {
    // AgentSession.prompt() stores the EXPANDED template as a plain user
    // message; the digest must not present 400 template lines as **User:**.
    const messages: Message[] = [
      { role: "user", content: compare.prompt },
      { role: "assistant", content: "Compared against 12 repos, all aligned." },
    ];
    const digest = buildKenDigest({ ...base, messages, workflowCommands: PROMPT_COMMANDS });
    expect(digest).toContain("**User:** [ran workflow command /compare]");
    // The template body itself never leaks into the digest.
    expect(digest).not.toContain("Compare the code you just created or modified");
  });

  it("keeps the user's own args from an expanded command", () => {
    const messages: Message[] = [
      { role: "user", content: `${compare.prompt}${USER_INSTRUCTIONS_HEADER}only src/auth.ts` },
    ];
    const digest = buildKenDigest({ ...base, messages, workflowCommands: PROMPT_COMMANDS });
    expect(digest).toContain("[ran workflow command /compare]");
    expect(digest).toContain("only src/auth.ts");
  });

  it("leaves ordinary user text untouched when specs are provided", () => {
    const messages: Message[] = [{ role: "user", content: "please compare my two branches" }];
    const digest = buildKenDigest({ ...base, messages, workflowCommands: PROMPT_COMMANDS });
    expect(digest).toContain("**User:** please compare my two branches");
  });
});
