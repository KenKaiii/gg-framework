/**
 * One-line prompt hints for each tool, shown in the system prompt's Tools
 * section. Full parameter docs live on each tool's JSON schema description
 * (sent separately via the tool definition), so these hints stay short.
 *
 * Hints exist ONLY for tools whose correct usage is NOT obvious from their
 * schema description alone. The core file/nav/exec tools (read/write/edit/
 * bash/find/grep/ls) deliberately have NO hint: an ablation (experiments/
 * prompt-bench, Opus n=12) showed dropping their hints did not change tool
 * selection — the schema description already carries when/how to use them.
 * Cross-tool preferences for those tools live in TOOL_STEERING instead.
 */
export const TOOL_PROMPT_HINTS: Record<string, string> = {
  ui_registry: "Browse Bklit/Kokonut/shadcn components.",
  ui_adopt: "Adopt Bklit/Kokonut component source.",
  find: "Glob search.",
  ls: "List a dir.",
  code_nav: "Exact definitions/callers.",
  code_search: "Find code by meaning (“where is X”).",
  task_send: "Process stdin.",
  spawn_agent: "Parallel child agents.",
  source_path: "Dependency source.",
  web_search: "Web search.",
  web_fetch: "Fetch URLs/PDFs.",
  task_output: "Process output.",
  task_stop: "Stop a process.",
  screenshot: "Screenshot/click UI.",
  debug: "Node debugger.",
  send_message: "Steer a child.",
  followup_task: "Re-task a child.",
  wait_agent: "Await children.",
  list_agents: "List children.",
  interrupt_agent: "Interrupt a child.",
  checklist:
    "Read/record project checks with evidence and scope; re-record an item after fixing it. No unasked audits.",
  tasks: "Task list; only if asked.",
  ask_user: "Ask the user via clickable options; mark your pick `recommended`.",
  enter_plan: "Plan mode.",
  exit_plan: "Submit a plan.",
  subagent: "Blocking child agent.",
  skill: "Load a named skill's instructions.",
  tool_search: "Load on-demand and integration tools by capability.",
  generate_image: "Images; only if asked.",
  steroids: "Real-repo examples.",
};

/**
 * Cross-tool selection guidance that no single tool's own schema description
 * can state (it's relational). Each clause only renders when its tools are
 * actually active, so the line never references an unavailable tool. Proven
 * equivalent to the full per-tool hint list in the prompt-bench ablation
 * while costing ~95% fewer words.
 */
export const TOOL_STEERING_CLAUSES: ReadonlyArray<{
  needs: readonly string[];
  text: string;
}> = [
  {
    needs: ["edit", "write"],
    text: "Prefer `edit` over `write` for changes to existing files.",
  },
  {
    needs: ["bash", "grep"],
    // A head-to-head against the pi agent found the strict
    // "rather than bash" wording split exploration into one ls/find per turn
    // (~50s per suite); one combined read-only bash command does it in one.
    text: "To orient, combine `ls`/`find`/`rg`/`cat` in one `bash` call.",
  },
  {
    needs: ["read", "grep"],
    text: "Batch independent reads/searches in one turn; they run in parallel.",
  },
];

/** Build the steering line from whichever clauses apply to the active tools. */
export function buildToolSteering(activeTools: readonly string[]): string {
  const active = new Set(activeTools);
  return TOOL_STEERING_CLAUSES.filter((c) => c.needs.every((n) => active.has(n)))
    .map((c) => c.text)
    .join(" ");
}

/**
 * Every tool name `createTools()` can register, including the conditional ones
 * (web_search on non-Anthropic providers, generate_image with OpenAI auth,
 * plan tools, the subagent cluster) and `tool_search`, which MCP deferred
 * loading adds. Used to validate an agent definition's `tools:` frontmatter —
 * an unknown name is silently dropped by the session allow-list, so a typo
 * would otherwise cost the agent a capability with no signal at all.
 */
export const BUILTIN_TOOL_NAMES: readonly string[] = [
  "ask_user",
  "bash",
  "checklist",
  "code_nav",
  "code_search",
  "debug",
  "edit",
  "enter_plan",
  "exit_plan",
  "find",
  "followup_task",
  "generate_image",
  "grep",
  "interrupt_agent",
  "list_agents",
  "ls",
  "read",
  "screenshot",
  "send_message",
  "skill",
  "source_path",
  "spawn_agent",
  "steroids",
  "subagent",
  "task_output",
  "task_send",
  "task_stop",
  "tasks",
  "tool_search",
  "ui_registry",
  "ui_adopt",
  "wait_agent",
  "web_fetch",
  "web_search",
  "write",
];

/** Tools always rendered when no explicit tool list is provided. */
export const DEFAULT_TOOL_NAMES: readonly string[] = [
  "read",
  "write",
  "edit",
  "bash",
  "find",
  "grep",
  "code_nav",
  "code_search",
  "ls",
  "source_path",
  "web_fetch",
  "task_output",
  "task_stop",
  "enter_plan",
  "exit_plan",
  "subagent",
  "skill",
  "generate_image",
  "steroids",
];
