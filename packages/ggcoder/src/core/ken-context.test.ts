import { describe, it, expect } from "vitest";
import os from "node:os";
import {
  buildKenDigest,
  buildKenAutopilotContext,
  buildKenAutopilotPlanContext,
  buildKenAutopilotAskContext,
  latestHumanRequest,
  AUTOPILOT_ASK_INSTRUCTION,
  AUTOPILOT_REVIEW_INSTRUCTION,
  AUTOPILOT_PLAN_REVIEW_INSTRUCTION,
  KEN_RECENT_MESSAGE_LIMIT,
  INJECTED_PROMPT_LABEL,
} from "./ken-context.js";
import { USER_INSTRUCTIONS_HEADER } from "./autopilot-gate.js";
import { frameAutopilotInjection } from "./autopilot-cycle.js";
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
  "browser",
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
      for (const allowed of ["read", "grep", "find", "ls", "browser", "steroids"]) {
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
    // Older user requests survive separately; recent activity stays bounded.
    const recent = digest.split("## Recent activity (GG Coder and user)")[1];
    expect(recent).not.toContain("msg-0");
    expect(recent).not.toContain("msg-5");
    expect(digest).toContain("**User:** msg-0");
    expect(digest).toContain("**User:** msg-5");
    // The newest message is kept.
    expect(digest).toContain(`msg-${KEN_RECENT_MESSAGE_LIMIT + 9}`);
  });

  it("retains early constraints and later corrections for manual and autopilot reviews", () => {
    const messages: Message[] = [
      { role: "user", content: "CSV only, no new dependencies." },
      { role: "assistant", content: "SUGGESTED: rewrite in Excel." },
      {
        role: "user",
        content: [{ type: "text", text: "Correction: preserve the current filters too." }],
      },
      ...Array.from({ length: 25 }, (): Message => ({
        role: "assistant",
        content: "Still working.",
      })),
    ];
    for (const digest of [
      buildKenDigest({ ...base, messages }),
      buildKenAutopilotContext({ ...base, messages }),
    ]) {
      expect(digest).toContain("CSV only, no new dependencies.");
      expect(digest).toContain("Correction: preserve the current filters too.");
      expect(digest.indexOf("CSV only")).toBeLessThan(digest.indexOf("Correction:"));
      expect(digest).not.toContain("SUGGESTED:");
      expect(digest).not.toContain("Context incomplete");
    }
  });

  it("does not retain injected prompts as user decisions after restart", () => {
    const messages: Message[] = [
      { role: "user", content: frameAutopilotInjection("Add analytics.") },
      { role: "user", content: "Old unframed injection." },
      { role: "user", content: "Keep it dependency-free." },
      ...Array.from({ length: 25 }, (): Message => ({ role: "assistant", content: "Working." })),
    ];
    const digest = buildKenDigest({
      ...base,
      messages,
      injectedPrompts: ["Old unframed injection."],
    });
    expect(digest).toContain("Keep it dependency-free.");
    expect(digest).not.toContain("Add analytics.");
    expect(digest).not.toContain("Old unframed injection.");
    const recent = buildKenDigest({ ...base, messages: [messages[0]] });
    expect(recent).toContain(INJECTED_PROMPT_LABEL);
    expect(recent).not.toContain("**User:**");
  });

  it("bounds retained decisions and explicitly discloses omitted or truncated context", () => {
    const messages: Message[] = [
      ...Array.from({ length: 100 }, (_, i): Message => ({
        role: "user",
        content: `Decision ${i}: ${"x".repeat(500)}`,
      })),
      ...Array.from({ length: 25 }, (): Message => ({ role: "assistant", content: "Working." })),
    ];
    const digest = buildKenDigest({ ...base, messages });
    expect(digest).toContain("Context incomplete: some earlier user messages");
    expect(digest).toContain("Decision 99:");
    expect(digest.length).toBeLessThan(11000);
    expect(buildKenDigest({ ...base, messages: [], originalRequest: "x".repeat(5000) })).toContain(
      "Context incomplete: original request was truncated",
    );
    expect(
      buildKenDigest({
        ...base,
        messages: [{ role: "user", content: "[Previous conversation summary]" + "x".repeat(5000) }],
      }),
    ).toContain("Context incomplete: conversation summary was truncated");
  });

  it("retains only human decisions and labels recent automation in both modes", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: "CSV only.",
        provenance: { source: "human", kind: "prompt", visibility: "transcript" },
      },
      { role: "user", content: "Legacy human constraint: no dependencies." },
      {
        role: "user",
        content: "Old verification reminder.",
        provenance: { source: "runtime", kind: "completion_gate", visibility: "hidden" },
      },
      {
        role: "user",
        content: "Old agent continuation.",
        provenance: { source: "agent", kind: "automation", visibility: "hidden" },
      },
      ...Array.from({ length: 25 }, (): Message => ({ role: "assistant", content: "Progress." })),
      {
        role: "user",
        content: "Latest verification reminder.",
        provenance: { source: "runtime", kind: "completion_gate", visibility: "hidden" },
      },
      {
        role: "user",
        content: "Latest agent continuation.",
        provenance: { source: "agent", kind: "automation", visibility: "hidden" },
      },
      {
        role: "user",
        content: "Correction: preserve filters.",
        provenance: { source: "human", kind: "steering", visibility: "transcript" },
      },
    ];
    for (const digest of [
      buildKenDigest({ ...base, messages }),
      buildKenAutopilotContext({ ...base, messages }),
    ]) {
      expect(digest).toContain("**User:** CSV only.");
      expect(digest).toContain("**User:** Legacy human constraint: no dependencies.");
      expect(digest).toContain("**User:** Correction: preserve filters.");
      expect(digest).not.toContain("Old verification reminder.");
      expect(digest).not.toContain("Old agent continuation.");
      expect(digest).toContain("**Runtime (not a user request):** Latest verification reminder.");
      expect(digest).toContain(
        "**Agent automation (not a user request):** Latest agent continuation.",
      );
      expect(digest).not.toContain("**User:** Latest");
    }
  });

  it("runtime reminders cannot consume the retained user-decision budget", () => {
    const messages: Message[] = [
      { role: "user", content: "Keep this genuine requirement." },
      ...Array.from({ length: 40 }, (): Message => ({
        role: "user",
        content: "Internal reminder. ".repeat(300),
        provenance: { source: "runtime", kind: "notification", visibility: "hidden" },
      })),
      ...Array.from({ length: 25 }, (): Message => ({ role: "assistant", content: "Progress." })),
    ];
    const digest = buildKenDigest({ ...base, messages });
    expect(digest).toContain("Keep this genuine requirement.");
    expect(digest).not.toContain("Internal reminder.");
    expect(digest).not.toContain("Context incomplete");
  });

  it("preserves provenance-tagged compaction summaries", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: "[Previous conversation summary] User chose CSV and rejected Excel.",
        provenance: { source: "runtime", kind: "compaction_summary", visibility: "summary" },
      },
    ];
    const digest = buildKenDigest({ ...base, messages });
    expect(digest).toContain("## Story so far");
    expect(digest).toContain("User chose CSV and rejected Excel.");
    expect(digest).not.toContain("**User:**");
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

  it("frames autopilot digests as a machine review, never as a user's question", () => {
    const messages: Message[] = [{ role: "user", content: "add a login form" }];
    const input = { cwd: base.cwd, gitBranch: base.gitBranch, platform: base.platform, messages };
    for (const digest of [
      buildKenAutopilotContext(input),
      buildKenAutopilotPlanContext({ ...input, planContent: "# Plan" }),
    ]) {
      expect(digest).toContain("No user is in this conversation");
      expect(digest).toContain("## Your task");
      expect(digest).not.toContain("mentoring the user");
      expect(digest).not.toContain("They just asked you");
    }
    // Chat Ken keeps his user-facing framing.
    const chat = buildKenDigest({ ...base, messages });
    expect(chat).toContain("mentoring the user");
    expect(chat).toContain("## They just asked you");
  });

  describe("autopilot changed-files section", () => {
    const edit = (id: string, filePath: string): Message => ({
      role: "assistant",
      content: [{ type: "tool_call", id, name: "edit", args: { file_path: filePath } }],
    });
    const result = (id: string, isError = false): Message => ({
      role: "tool",
      content: [{ type: "tool_result", toolCallId: id, content: "ok", isError }],
    });
    const section = (digest: string): string =>
      digest.split("## Files changed by the work under review")[1]?.split("\n\n## ")[0] ?? "";

    it("lists successful edit/write paths from this turn only, sorted", () => {
      const messages: Message[] = [
        { role: "user", content: "older ask" },
        edit("old", "src/old.ts"),
        result("old"),
        { role: "user", content: "add a login form" },
        edit("z", "src/z.ts"),
        result("z"),
        {
          role: "assistant",
          content: [{ type: "tool_call", id: "w", name: "write", args: { file_path: "src/a.ts" } }],
        },
        result("w"),
        edit("bad", "src/failed.ts"),
        result("bad", true),
        {
          role: "assistant",
          content: [{ type: "tool_call", id: "r", name: "read", args: { file_path: "src/r.ts" } }],
        },
        result("r"),
      ];
      const listed = section(
        buildKenAutopilotContext({
          cwd: base.cwd,
          gitBranch: base.gitBranch,
          platform: base.platform,
          messages,
          originalRequest: "add a login form",
        }),
      );
      expect(listed).toContain("since the original request");
      expect(listed.indexOf("- src/a.ts")).toBeLessThan(listed.indexOf("- src/z.ts"));
      expect(listed).not.toContain("src/old.ts");
      expect(listed).not.toContain("src/failed.ts");
      expect(listed).not.toContain("src/r.ts");
    });

    it("does not restart the turn at Ken's injected prompt that quotes the request", () => {
      const messages: Message[] = [
        { role: "user", content: "add a login form" },
        edit("first", "src/form.ts"),
        result("first"),
        { role: "user", content: frameAutopilotInjection("Finish: add a login form. Add a test.") },
        edit("second", "src/form.test.ts"),
        result("second"),
      ];
      const listed = section(
        buildKenAutopilotContext({
          cwd: base.cwd,
          gitBranch: base.gitBranch,
          platform: base.platform,
          messages,
          originalRequest: "add a login form",
        }),
      );
      expect(listed).toContain("- src/form.ts");
      expect(listed).toContain("- src/form.test.ts");
    });

    it("keeps files whose edits scrolled out of the recent-activity window", () => {
      const messages: Message[] = [{ role: "user", content: "refactor auth" }];
      for (let i = 0; i < KEN_RECENT_MESSAGE_LIMIT; i++) {
        messages.push(edit(`e${i}`, `src/file-${String(i).padStart(2, "0")}.ts`), result(`e${i}`));
      }
      const digest = buildKenAutopilotContext({
        cwd: base.cwd,
        gitBranch: base.gitBranch,
        platform: base.platform,
        messages,
        originalRequest: "refactor auth",
      });
      expect(digest.split("## Recent activity")[1]).not.toContain("refactor auth");
      expect(section(digest)).toContain("- src/file-00.ts");
    });

    it("says when the original request message is gone instead of guessing a boundary", () => {
      const digest = buildKenAutopilotContext({
        cwd: base.cwd,
        gitBranch: base.gitBranch,
        platform: base.platform,
        messages: [edit("e", "src/plan-step.ts"), result("e")],
        originalRequest: "implement the approved plan",
      });
      expect(section(digest)).toContain("original request message was compacted or reset away");
      expect(section(digest)).toContain("- src/plan-step.ts");
    });

    it("caps a huge file list and reports the overflow", () => {
      const messages: Message[] = [{ role: "user", content: "rename everywhere" }];
      for (let i = 0; i < 45; i++) {
        messages.push(edit(`e${i}`, `src/f${String(i).padStart(2, "0")}.ts`), result(`e${i}`));
      }
      const listed = section(
        buildKenAutopilotContext({
          cwd: base.cwd,
          gitBranch: base.gitBranch,
          platform: base.platform,
          messages,
          originalRequest: "rename everywhere",
        }),
      );
      expect(listed).toContain("- src/f39.ts");
      expect(listed).not.toContain("- src/f40.ts");
      expect(listed).toContain("[…5 more files]");
    });

    it("is omitted when no edit/write calls succeeded, so shell-only work never reads as 'no changes'", () => {
      const digest = buildKenAutopilotContext({
        cwd: base.cwd,
        gitBranch: base.gitBranch,
        platform: base.platform,
        messages: [
          { role: "user", content: "regenerate the client" },
          edit("bad", "src/failed.ts"),
          result("bad", true),
        ],
        originalRequest: "regenerate the client",
      });
      expect(digest).not.toContain("## Files changed by the work under review");
      expect(digest).not.toContain("(none)");
    });

    it("is absent from chat digests", () => {
      const digest = buildKenDigest({
        ...base,
        messages: [{ role: "user", content: "hi" }, edit("e", "src/x.ts"), result("e")],
        originalRequest: "hi",
      });
      expect(digest).not.toContain("## Files changed by the work under review");
    });
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
      .split("## Your task")[0];
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
    expect(digest.indexOf("## Plan under review")).toBeLessThan(digest.indexOf("## Your task"));
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
    expect(section).toContain("Context incomplete: plan was truncated");
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
  const expand = PROMPT_COMMANDS.find((c) => c.name === "expand")!;

  it("renders an expanded template as a short command note, not a user ask", () => {
    // AgentSession.prompt() stores the EXPANDED template as a plain user
    // message; the digest must not present 400 template lines as **User:**.
    const messages: Message[] = [
      { role: "user", content: expand.prompt },
      { role: "assistant", content: "Compared against 12 repos, found 6 features." },
    ];
    const digest = buildKenDigest({ ...base, messages, workflowCommands: PROMPT_COMMANDS });
    expect(digest).toContain("**User:** [ran workflow command /expand]");
    // The template body itself never leaks into the digest.
    expect(digest).not.toContain("Find the most exciting new features this project should add");
  });

  it("keeps the user's own args from an expanded command", () => {
    const messages: Message[] = [
      { role: "user", content: `${expand.prompt}${USER_INSTRUCTIONS_HEADER}only src/auth.ts` },
    ];
    const digest = buildKenDigest({ ...base, messages, workflowCommands: PROMPT_COMMANDS });
    expect(digest).toContain("[ran workflow command /expand]");
    expect(digest).toContain("only src/auth.ts");
  });

  it("leaves ordinary user text untouched when specs are provided", () => {
    const messages: Message[] = [{ role: "user", content: "please compare my two branches" }];
    const digest = buildKenDigest({ ...base, messages, workflowCommands: PROMPT_COMMANDS });
    expect(digest).toContain("**User:** please compare my two branches");
  });
});

describe("buildKenAutopilotAskContext", () => {
  const questions = [
    {
      id: "store",
      question: "Where should sessions live?",
      kind: "choice" as const,
      options: [{ label: "SQLite", value: "sqlite" }],
    },
  ];

  it("puts the question section before the ask instruction", () => {
    const digest = buildKenAutopilotAskContext({
      cwd: "/tmp/proj",
      gitBranch: "main",
      platform: "darwin",
      messages: [{ role: "user", content: "add session storage" }],
      originalRequest: "add session storage",
      questions,
    });
    const section = digest.indexOf("## Question for you");
    const task = digest.lastIndexOf("## Your task");
    expect(section).toBeGreaterThan(-1);
    expect(task).toBeGreaterThan(section);
    expect(digest.slice(section, task)).toContain('"id": "store"');
    expect(digest.slice(task)).toContain(AUTOPILOT_ASK_INSTRUCTION);
    expect(digest).toContain("add session storage");
  });
});

describe("latestHumanRequest", () => {
  it("skips injected prompts, automation and summaries", () => {
    const fix = "Fix the failing test.";
    const messages: Message[] = [
      { role: "user", content: "build the login page" },
      { role: "assistant", content: "on it" },
      { role: "user", content: fix },
      {
        role: "user",
        content: "background task finished",
        provenance: { source: "runtime", kind: "automation", visibility: "hidden" },
      },
    ];
    expect(latestHumanRequest(messages, [fix])).toBe("build the login page");
    expect(latestHumanRequest(messages)).toBe(fix);
    expect(
      latestHumanRequest([{ role: "user", content: "[Previous conversation summary] x" }]),
    ).toBe(undefined);
  });
});
