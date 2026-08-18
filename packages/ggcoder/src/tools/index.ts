import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { SubAgentManager, type SubAgentSnapshot } from "../core/subagent-manager.js";
import { ProcessManager } from "../core/process-manager.js";
import { LspManager } from "../core/lsp/manager.js";
import { createReadTool } from "./read.js";
import { getVideoByteLimit } from "../core/model-registry.js";
import { createWriteTool } from "./write.js";
import { createEditTool } from "./edit.js";
import { createBashTool, type CommandRewriter } from "./bash.js";
import { createFindTool } from "./find.js";
import { createGrepTool } from "./grep.js";
import { createSearchCodeTool } from "./search-code.js";
import { createCodeNavTool } from "./code-nav.js";
import { createLsTool } from "./ls.js";
import { createSubAgentTool } from "./subagent.js";
import { createSubAgentControlTools } from "./subagent-control.js";
import { createWebFetchTool } from "./web-fetch.js";
import { createWebSearchTool } from "./web-search.js";
import { createSourcePathTool } from "./source-path.js";
import { createTaskOutputTool } from "./task-output.js";
import { createTaskStopTool } from "./task-stop.js";
import { createTaskSendTool } from "./task-send.js";
import { createTasksTool } from "./tasks.js";

import { createSkillTool } from "./skill.js";
import { createScreenshotTool } from "./screenshot.js";
import { createGenerateImageTool, type GenerateImageAuth } from "./generate-image.js";
import { createEnterPlanTool } from "./enter-plan.js";
import { createExitPlanTool } from "./exit-plan.js";
import { localOperations, type ToolOperations } from "./operations.js";
import type { ReadTracker } from "./read-tracker.js";
import type { WriteGuardSettings } from "../core/workspace-guard.js";
import type { GetNetworkPolicy } from "../core/network-guard.js";
import type { SandboxPolicy } from "../core/sandbox.js";
import type { AgentDefinition } from "../core/agents.js";
import type { Skill } from "../core/skills.js";
import type { AgentNotificationQueue } from "../core/agent-notifications.js";

// Canonical registry of built-in tool names. Defined in prompt-hints (a leaf
// module) so `core/agents.ts` can validate `tools:` frontmatter without
// importing this module's heavy tool graph.
export { BUILTIN_TOOL_NAMES } from "./prompt-hints.js";

export interface CreateToolsOptions {
  agents?: AgentDefinition[];
  skills?: Skill[];
  provider?: Provider;
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
  /** Current parent provider/model, evaluated lazily when spawning a sub-agent. */
  getProvider?: () => Provider;
  getModel?: () => string;
  getThinkingLevel?: () => ThinkingLevel | undefined;
  getBaseUrl?: () => string | undefined;
  /** Optional per-model subagent concurrency cap (subagentMaxPerModel). */
  getMaxPerModel?: () => number | undefined;
  onSubAgentState?: (snapshot: SubAgentSnapshot) => void;
  /** Persistent child workers omit every subagent tool to enforce one-level fan-out. */
  disableSubagents?: boolean;
  /**
   * Append LSP diagnostics to edit/write results (default true). Servers are
   * resolved from the project/PATH only and spawn lazily on the first edit of
   * a matching file — disabling this is a pure opt-out, not a capability loss.
   */
  lspDiagnostics?: boolean;
  /**
   * Auth storage for conditional tool registration. When provided AND the user
   * has OpenAI connected, the `generate_image` tool is registered — letting the
   * agent generate/edit images via OpenAI's Image API regardless of the active
   * chat provider. Omitted by callers that don't want image generation.
   */
  authStorage?: GenerateImageAuth & { hasProviderAuth(provider: string): Promise<boolean> };
  /**
   * Lazily read the workspace write-guard settings (allowOutsideWorkspaceWrites).
   * When omitted, writes are allowed under cwd, the OS tmpdir, and ~/.gg only.
   */
  getWriteGuardSettings?: () => WriteGuardSettings | undefined;
  /**
   * Lazily read the network egress policy (networkMode / networkAllow).
   * When omitted, no network restriction is applied.
   */
  getNetworkPolicy?: GetNetworkPolicy;
  /** Lazily read the OS command-sandbox mode and allowed network domains. */
  getSandboxPolicy?: () => SandboxPolicy;
  /**
   * Optional rewrite hook for the bash tool's plain foreground spawn path
   * (git status, ps aux, find, ...). Every safety guard still runs against
   * the original command first — see `CommandRewriter` in `./bash.js` for
   * the exact scope and contract. Omitted by default: commands run unchanged.
   */
  rewriteCommand?: CommandRewriter;
  /**
   * Lazily read whether `grep` may use the external `rg` scanner when present
   * (grepUseRipgrep). Defaults to enabled when omitted.
   */
  getUseExternalGrep?: () => boolean;
  /**
   * Push queue for out-of-band notifications (child completions, background
   * process progress). When provided, producers enqueue here and the session
   * drains it into steering, so the agent learns about them without spending a
   * turn polling.
   */
  notifications?: AgentNotificationQueue;
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
  subAgentManager?: SubAgentManager;
}

export async function createTools(
  cwd: string,
  opts?: CreateToolsOptions,
): Promise<CreateToolsResult> {
  const readFiles: ReadTracker = new Map();
  const processManager = new ProcessManager({ notifications: opts?.notifications });
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
      opts?.getWriteGuardSettings,
    ),
    createEditTool(
      cwd,
      readFiles,
      ops,
      planModeRef,
      opts?.onFileMutated,
      opts?.onPreFileMutation,
      getDiagnostics,
      opts?.getWriteGuardSettings,
    ),
    createBashTool(
      cwd,
      processManager,
      ops,
      planModeRef,
      undefined,
      opts?.getNetworkPolicy,
      ops === localOperations ? opts?.getSandboxPolicy : undefined,
      opts?.rewriteCommand,
    ),
    createFindTool(cwd),
    createGrepTool(cwd, ops, { useExternalScanner: opts?.getUseExternalGrep }),
    createSearchCodeTool(cwd, ops),
    createCodeNavTool(cwd, lspManager, ops),
    createLsTool(cwd, ops),
    createSourcePathTool(cwd),
    createWebFetchTool(opts?.getNetworkPolicy),
    createTaskOutputTool(processManager),
    createTaskSendTool(processManager),
    createTaskStopTool(processManager),
    createTasksTool(cwd),
    createScreenshotTool(cwd),
  ];

  // Add web search tool for providers without reliable native web search
  if (opts?.provider && opts.provider !== "anthropic") {
    tools.push(createWebSearchTool(opts?.getNetworkPolicy));
  }

  let subAgentManager: SubAgentManager | undefined;
  if (
    !opts?.disableSubagents &&
    opts?.agents &&
    opts.agents.length > 0 &&
    opts.provider &&
    opts.model
  ) {
    tools.push(
      createSubAgentTool(
        cwd,
        opts.agents,
        () => opts.getProvider?.() ?? opts.provider!,
        () => opts.getModel?.() ?? opts.model!,
        opts.getCacheKey,
        planModeRef,
      ),
    );
    subAgentManager = new SubAgentManager({
      cwd,
      agents: opts.agents,
      getProvider: () => opts.getProvider?.() ?? opts.provider!,
      getModel: () => opts.getModel?.() ?? opts.model!,
      getThinkingLevel: () => opts.getThinkingLevel?.(),
      getCacheKey: opts.getCacheKey,
      getBaseUrl: opts.getBaseUrl,
      getMaxPerModel: () => opts.getMaxPerModel?.(),
      onState: opts.onSubAgentState,
      notifications: opts.notifications,
    });
    tools.push(...createSubAgentControlTools(subAgentManager, planModeRef));
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

  // Conditionally register the image generation tool — only when OpenAI auth
  // is connected. The tool always uses OpenAI's Image API regardless of the
  // active chat provider, so it's purely gated on OpenAI being logged in.
  if (opts?.authStorage) {
    try {
      if (await opts.authStorage.hasProviderAuth("openai")) {
        tools.push(createGenerateImageTool(cwd, opts.authStorage));
      }
    } catch {
      // Auth not loaded yet or check failed — skip the tool silently.
    }
  }

  const rebuildReadTool = (model: string): AgentTool =>
    createReadTool(cwd, readFiles, ops, opts?.onFileRead, getVideoByteLimit(model));

  return { tools, processManager, rebuildReadTool, lspManager, subAgentManager };
}

export { createReadTool } from "./read.js";
export { createWriteTool } from "./write.js";
export { createEditTool } from "./edit.js";
export { createBashTool } from "./bash.js";
export { createFindTool } from "./find.js";
export { createGrepTool } from "./grep.js";
export { createSearchCodeTool } from "./search-code.js";
export { createCodeNavTool } from "./code-nav.js";
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
export { createGenerateImageTool, type GenerateImageAuth } from "./generate-image.js";
export { createEnterPlanTool } from "./enter-plan.js";
export { createExitPlanTool } from "./exit-plan.js";
export { ProcessManager } from "../core/process-manager.js";
export { LspManager } from "../core/lsp/manager.js";
export { localOperations, type ToolOperations } from "./operations.js";
