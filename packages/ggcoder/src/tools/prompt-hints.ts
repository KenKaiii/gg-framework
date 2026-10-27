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
  /** Render only when changes go through one POSIX `bash` command (true) or not (false). */
  oneCommandChanges?: boolean;
  text: string;
}> = [
  {
    // Arena 2026-10-25 (Haiku 5.5, 8 tasks × 10 reps): with this replacing the
    // edit-preference line and the Work section's script rule, GG ran the suite
    // 21% faster and 19% cheaper, in fewer turns; on a one-line fix in a 700-line
    // file it still never rewrote the file. `python3` is named because Haiku
    // otherwise reaches for GNU `sed -i`, which fails on macOS.
    needs: ["bash"],
    oneCommandChanges: true,
    text: "Make each change in one `bash` command that writes only what's new: `cat > file <<'EOF'` for a small file that mostly changes, a `python3` replace asserting exactly one match for a few lines of a bigger file, `cat >>` for added tests; end it with the test command.",
  },
  {
    needs: ["edit", "write"],
    oneCommandChanges: false,
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

/**
 * Changes go through one shell command when `bash` is available and runs a
 * POSIX shell (not the cmd.exe fallback on bash-less Windows).
 */
export function usesOneCommandChanges(
  activeTools: readonly string[],
  posixShell: boolean,
): boolean {
  return posixShell && activeTools.includes("bash");
}

/** Build the steering line from whichever clauses apply to the active tools. */
export function buildToolSteering(activeTools: readonly string[], posixShell = true): string {
  const active = new Set(activeTools);
  const oneCommand = usesOneCommandChanges(activeTools, posixShell);
  return TOOL_STEERING_CLAUSES.filter(
    (c) =>
      c.needs.every((n) => active.has(n)) &&
      (c.oneCommandChanges === undefined || c.oneCommandChanges === oneCommand),
  )
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
