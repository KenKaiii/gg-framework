/**
 * One-line prompt hints for each tool. These are shown in the system prompt's
 * Tools section to orient the model. Full parameter docs live on each tool's
 * JSON schema description (sent separately via the tool definition), so these
 * hints stay short and focus on non-obvious usage.
 */
export const TOOL_PROMPT_HINTS: Record<string, string> = {
  read: "Read file contents. Use offset/limit for large files.",
  write: "Create or overwrite files; read existing files first. Prefer edit for changes.",
  edit: "Apply surgical { old_text, new_text } edits from a prior read. Use exact text; retry only failed edits; replace_all for renames.",
  bash: "Run shell commands from project root; use for computation and long/background processes, not direct file rewrites.",
  find: "Find files/dirs by name pattern. Faster than bash find, respects .gitignore.",
  grep: "Regex search across files. Use for usages, definitions, imports.",
  source_path:
    "Resolve installed package/repo source via opensrc. Use before assuming dependency APIs; inspect returned absolute path with read/grep/find/ls.",
  web_search:
    "Search the web. Use before web_fetch to find pages; supports include/exclude_domains and a time_range recency filter.",
  web_fetch:
    "Fetch page content as Markdown (or text/html). Pass `urls` to fetch many at once; reads PDFs, follows safe redirects, and prefers a site's /llms.txt for docs.",
  task_output: "Read new output from a background process by id.",
  task_stop: "Stop a background process by id.",
  enter_plan:
    "Enter read-only plan mode for complex/risky tasks before implementation; draft a plan under .gg/plans/.",
  exit_plan: "Submit a .gg/plans/ markdown plan for user approval and leave plan mode.",
  subagent: "Delegate focused, isolated subtasks (research, parallel exploration).",
  skill: "Invoke a named skill for specialized instructions.",
  "mcp__kencode-search__referenceSources":
    "Get curated, categorized reference repos for examples, inspiration, architecture, UI, agents, SaaS, workflows, and domain patterns. Repo-only starting points; fetch docs/source, then verify code with searchCode.",
  "mcp__kencode-search__discoverRepos":
    "Search GitHub repos live by keyword/language/topic/stars/recency. Use for current/top repos or long-tail discovery; returns metadata, not snippets. Follow with docs/source and searchCode.",
  "mcp__kencode-search__searchCode":
    "Verify public GitHub code by literal text or RE2 regex; NOT semantic. Put code/import/API tokens in `query`; `path` is a literal file-path substring, not a concept. Start broad/peek, then narrow by repo/path. RE2 multi-line needs `(?s)`.",
};

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
  "mcp__kencode-search__referenceSources",
  "mcp__kencode-search__discoverRepos",
  "mcp__kencode-search__searchCode",
];
