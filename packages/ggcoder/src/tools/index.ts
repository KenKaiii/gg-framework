import type { AgentTool } from "@kenkaiiii/gg-agent";
import { ProcessManager } from "../core/process-manager.js";
import { LspManager } from "../core/lsp/manager.js";
import { createReadTool } from "./read.js";
import { getVideoByteLimit } from "../core/model-registry.js";
import { createWriteTool } from "./write.js";
import { createEditTool } from "./edit.js";
import { createBashTool } from "./bash.js";
import { createFindTool } from "./find.js";
import { createGrepTool } from "./grep.js";
import { createLsTool } from "./ls.js";
import { createSubAgentTool } from "./subagent.js";
import { createWebFetchTool } from "./web-fetch.js";
import { createWebSearchTool } from "./web-search.js";
import { createSourcePathTool } from "./source-path.js";
import { createTaskOutputTool } from "./task-output.js";
import { createTaskStopTool } from "./task-stop.js";
import { createTaskSendTool } from "./task-send.js";
import { createTasksTool } from "./tasks.js";
import { createSkillTool } from "./skill.js";
import { createScreenshotTool } from "./screenshot.js";
import { createEnterPlanTool } from "./enter-plan.js";
import { createExitPlanTool } from "./exit-plan.js";
import { localOperations, type ToolOperations } from "./operations.js";
import type { ReadTracker } from "./read-tracker.js";
import type { AgentDefinition } from "../core/agents.js";
import type { Skill } from "../core/skills.js";

export interface CreateToolsOptions {
  agents?: AgentDefinition[];
  skills?: Skill[];
  provider?: string;
  model?: string;
  /** Custom I/O operations for remote execution (SSH, Docker, etc.). Defaults to local filesystem. */
  operations?: ToolOperations;
  /** Ref for checking plan mode inside tool execute functions. */
  planModeRef?: { current: boolean };
  /** Callback when the LLM enters plan mode. */
  onEnterPlan?: (reason?: string) => void | Promise<void>;
  /** Callback when the LLM submits a plan for review. */
  onExitPlan?: (planPath: string) => Promise<string>;
  /** Callback after read tool successfully reads a text file. */
  onFileRead?: (filePath: string) => void | Promise<void>;
  /** Callback after write/edit tools successfully mutate a file. */
  onFileMutated?: (filePath: string) => void | Promise<void>;
  /**
   * Callback fired by write/edit BEFORE the on-disk write, so a checkpoint store
   * can snapshot the file's prior content for /rewind. Receives the resolved
   * absolute path.
   */
  onPreFileMutation?: (filePath: string) => void | Promise<void>;
  /**
   * Getter for parent's prompt-cache routing key, evaluated lazily at
   * sub-agent spawn time. Returning a stable key from this getter lets every
   * sub-agent spawned by one parent share the same prompt_cache_key prefix —
   * without it, each child generates a fresh sessionId-derived key and pays a
   * cold-cache cost on every turn. Lazy because the parent's sessionId is
   * only assigned after `createTools()` runs during session init.
   */
  getCacheKey?: () => string | undefined;
  /**
   * Append LSP diagnostics to edit/write results (default true). Servers are
   * resolved from the project/PATH only and spawn lazily on the first edit of
   * a matching file — disabling this is a pure opt-out, not a capability loss.
   */
  lspDiagnostics?: boolean;
}

export interface CreateToolsResult {
  tools: AgentTool[];
  processManager: ProcessManager;
  /**
   * Rebuild the `read` tool for a different model, reusing the SAME read
   * tracker so read-before-edit history survives. The read tool's video
   * capability (description + native-video execute path) is baked in at
   * creation from the model's `maxVideoBytes`, so switching to/from a
   * video-capable model mid-session requires a fresh tool object. Returns the
   * new tool; the caller swaps it into the live tool set and rebuilds the
   * system prompt.
   */
  rebuildReadTool: (model: string) => AgentTool;
  /**
   * Language-server pool backing edit/write diagnostics. Present only when
   * enabled and running against the local filesystem; callers wire
   * `shutdownAll()` into their exit/cleanup paths alongside processManager.
   */
  lspManager?: LspManager;
}

export function createTools(cwd: string, opts?: CreateToolsOptions): CreateToolsResult {
  const readFiles: ReadTracker = new Map();
  const processManager = new ProcessManager();
  const ops = opts?.operations ?? localOperations;
  const planModeRef = opts?.planModeRef;

  // LSP diagnostics only make sense against the local filesystem — remote
  // operations (SSH/Docker) would point local language servers at paths that
  // don't exist here. Lazy: no server spawns until the first matching edit.
  const lspEnabled = (opts?.lspDiagnostics ?? true) && ops === localOperations;
  const lspManager = lspEnabled ? new LspManager(cwd) : undefined;
  const getDiagnostics = lspManager
    ? (filePath: string, content: string): Promise<string> =>
        lspManager.diagnosticsAfterWrite(filePath, content)
    : undefined;

  // Enable native video returns from the read tool for any video-capable model
  // (Kimi/Moonshot, Gemini, MiniMax), each with its own per-model byte cap that
  // drives auto-compression. Non-video models get `undefined` — video falls back
  // to the plain binary-file notice, never offered to models that can't watch it.
  const videoByteLimit = opts?.model ? getVideoByteLimit(opts.model) : undefined;
  const tools: AgentTool[] = [
    createReadTool(cwd, readFiles, ops, opts?.onFileRead, videoByteLimit),
    createWriteTool(
      cwd,
      readFiles,
      ops,
      planModeRef,
      opts?.onFileMutated,
      opts?.onPreFileMutation,
      getDiagnostics,
    ),
    createEditTool(
      cwd,
      readFiles,
      ops,
      planModeRef,
      opts?.onFileMutated,
      opts?.onPreFileMutation,
      getDiagnostics,
    ),
    createBashTool(cwd, processManager, ops, planModeRef),
    createFindTool(cwd),
    createGrepTool(cwd, ops),
    createLsTool(cwd, ops),
    createSourcePathTool(cwd),
    createWebFetchTool(),
    createTaskOutputTool(processManager),
    createTaskSendTool(processManager),
    createTaskStopTool(processManager),
    createTasksTool(cwd),
    createScreenshotTool(cwd),
  ];

  // Add web search tool for providers without reliable native web search
  if (opts?.provider && opts.provider !== "anthropic") {
    tools.push(createWebSearchTool());
  }

  if (opts?.agents && opts.agents.length > 0 && opts.provider && opts.model) {
    tools.push(
      createSubAgentTool(
        cwd,
        opts.agents,
        opts.provider,
        opts.model,
        opts.getCacheKey,
        planModeRef,
      ),
    );
  }

  if (opts?.skills && opts.skills.length > 0) {
    tools.push(createSkillTool(opts.skills));
  }

  if (opts?.onEnterPlan) {
    tools.push(createEnterPlanTool(opts.onEnterPlan));
  }

  if (opts?.onExitPlan) {
    tools.push(createExitPlanTool(cwd, opts.onExitPlan));
  }

  const rebuildReadTool = (model: string): AgentTool =>
    createReadTool(cwd, readFiles, ops, opts?.onFileRead, getVideoByteLimit(model));

  return { tools, processManager, rebuildReadTool, lspManager };
}

export { createReadTool } from "./read.js";
export { createWriteTool } from "./write.js";
export { createEditTool } from "./edit.js";
export { createBashTool } from "./bash.js";
export { createFindTool } from "./find.js";
export { createGrepTool } from "./grep.js";
export { createLsTool } from "./ls.js";
export { createWebFetchTool } from "./web-fetch.js";
export { createWebSearchTool } from "./web-search.js";
export { createSourcePathTool } from "./source-path.js";
export { createTaskOutputTool } from "./task-output.js";
export { createTaskSendTool } from "./task-send.js";
export { createTaskStopTool } from "./task-stop.js";
export { createTasksTool } from "./tasks.js";
export { createSkillTool } from "./skill.js";
export { createScreenshotTool } from "./screenshot.js";
export { createEnterPlanTool } from "./enter-plan.js";
export { createExitPlanTool } from "./exit-plan.js";
export { ProcessManager } from "../core/process-manager.js";
export { LspManager } from "../core/lsp/manager.js";
export { localOperations, type ToolOperations } from "./operations.js";
