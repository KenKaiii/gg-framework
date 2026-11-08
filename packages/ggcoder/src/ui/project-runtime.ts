import type { AgentTool } from "@kleio/agent";
import { CheckpointStore } from "../core/checkpoint-store.js";
import type { LspManager } from "../core/lsp/manager.js";
import { MCPClientManager } from "../core/mcp/client.js";
import type { MCPServerConfig } from "../core/mcp/types.js";
import { discoverAgents } from "../core/agents.js";
import { createTools, type CreateToolsOptions } from "../tools/index.js";
import type { ProcessManager } from "../core/process-manager.js";
import { discoverSkills, type Skill } from "../core/skills.js";
import type { SubAgentManager } from "../core/subagent-manager.js";
import type { DebugManager } from "../tools/debug.js";

/** Resources that must move together when a retained Pixel fix changes project. */
export interface ProjectRuntime {
  cwd: string;
  tools: AgentTool[];
  skills?: Skill[];
  rebuildReadTool?: (model: string) => AgentTool;
  clearReadTracker?: () => void;
  processManager?: ProcessManager;
  subAgentManager?: SubAgentManager;
  lspManager?: LspManager;
  debugManager?: DebugManager;
  mcpManager?: MCPClientManager;
  checkpointStore?: CheckpointStore;
}

export interface ProjectRuntimePreparation {
  current: { current: ProjectRuntime };
  pending?: { current: ProjectRuntime | undefined };
  cwd: string;
  sessionId: string;
  globalSkillsDir: string;
  globalAgentsDir: string;
  checkpointBaseDir?: string;
  toolOptions: CreateToolsOptions;
  getMcpServers: () => Promise<MCPServerConfig[]>;
  waitForStartup?: () => Promise<unknown>;
}

export interface PreparedProjectRuntime {
  runtime: ProjectRuntime;
  /** Commit only after the caller has prepared its session and system prompt. */
  commit: () => Promise<void>;
  /** Dispose an uncommitted candidate on any preparation failure. */
  dispose: () => Promise<void>;
}

/** Attempt every teardown even when one resource fails to close. */
export async function disposeProjectRuntime(runtime: ProjectRuntime): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => runtime.subAgentManager?.shutdownAll()),
    Promise.resolve().then(() => runtime.processManager?.shutdownAll()),
    Promise.resolve().then(() => runtime.lspManager?.shutdownAll()),
    Promise.resolve().then(() => runtime.debugManager?.shutdown()),
    Promise.resolve().then(() => runtime.mcpManager?.dispose()),
  ]);
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

const preparing = new WeakSet<object>();

/** Prepare without publishing; callers can discard a failed prompt/session transition. */
export async function prepareProjectRuntime(
  options: ProjectRuntimePreparation,
): Promise<PreparedProjectRuntime> {
  if (preparing.has(options.current) || options.pending?.current) {
    throw new Error("A project runtime is already being prepared.");
  }
  preparing.add(options.current);
  try {
    const previous = options.current.current;
    const skills = await discoverSkills({
      globalSkillsDir: options.globalSkillsDir,
      projectDir: options.cwd,
    });
    const agents = await discoverAgents({
      globalAgentsDir: options.globalAgentsDir,
      projectDir: options.cwd,
    });
    const checkpointStore = new CheckpointStore({
      sessionId: options.sessionId,
      cwd: options.cwd,
      baseDir: options.checkpointBaseDir,
    });
    const rebuilt = await createTools(options.cwd, {
      ...options.toolOptions,
      agents,
      skills,
      onPreFileMutation: (filePath) => checkpointStore.recordPreMutation(filePath),
    });
    const mcpManager = new MCPClientManager();
    const next: ProjectRuntime = {
      ...rebuilt,
      cwd: options.cwd,
      skills,
      checkpointStore,
      mcpManager,
    };
    if (options.pending) options.pending.current = next;
    const clearPending = () => {
      if (options.pending?.current === next) options.pending.current = undefined;
      preparing.delete(options.current);
    };
    try {
      await rebuilt.subAgentManager?.hydrate(options.sessionId);
      next.tools = [
        ...rebuilt.tools,
        ...(await mcpManager.connectAll(await options.getMcpServers())),
      ];
    } catch (error) {
      try {
        await disposeProjectRuntime(next);
      } finally {
        clearPending();
      }
      throw error;
    }
    let committed = false;
    let disposed = false;
    return {
      runtime: next,
      commit: async () => {
        if (disposed || committed || options.current.current !== previous) {
          throw new Error("The project runtime changed while preparing the Pixel fix.");
        }
        await options.waitForStartup?.();
        await disposeProjectRuntime(previous);
        options.current.current = next;
        committed = true;
        clearPending();
      },
      dispose: async () => {
        if (committed || disposed) return;
        disposed = true;
        try {
          await disposeProjectRuntime(next);
        } finally {
          clearPending();
        }
      },
    };
  } catch (error) {
    preparing.delete(options.current);
    throw error;
  }
}
