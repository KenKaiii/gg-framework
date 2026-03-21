import type { AgentTool } from "@kenkaiiii/gg-agent";
import { ProcessManager } from "../core/process-manager.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";
import { createEditTool } from "./edit.js";
import { createBashTool } from "./bash.js";
import { createFindTool } from "./find.js";
import { createGrepTool } from "./grep.js";
import { createLsTool } from "./ls.js";
import { createSubAgentTool } from "./subagent.js";
import { createWebFetchTool } from "./web-fetch.js";
import { createTaskOutputTool } from "./task-output.js";
import { createTaskStopTool } from "./task-stop.js";
import { createTasksTool } from "./tasks.js";
import { localOperations, type ToolOperations } from "./operations.js";
import type { AgentDefinition } from "../core/agents.js";
import { getModel } from "../core/model-registry.js";

export interface CreateToolsOptions {
  agents?: AgentDefinition[];
  provider?: string;
  model?: string;
  /** Custom I/O operations for remote execution (SSH, Docker, etc.). Defaults to local filesystem. */
  operations?: ToolOperations;
}

export interface CreateToolsResult {
  tools: AgentTool[];
  processManager: ProcessManager;
}

export function createTools(cwd: string, opts?: CreateToolsOptions): CreateToolsResult {
  const readFiles = new Set<string>();
  const processManager = new ProcessManager();
  const ops = opts?.operations ?? localOperations;

  const modelInfo = opts?.model ? getModel(opts.model) : undefined;

  const tools: AgentTool[] = [
    createReadTool(cwd, readFiles, ops, { supportsImages: modelInfo?.supportsImages }),
    createWriteTool(cwd, readFiles, ops),
    createEditTool(cwd, readFiles, ops),
    createBashTool(cwd, processManager, ops),
    createFindTool(cwd),
    createGrepTool(cwd, ops),
    createLsTool(cwd, ops),
    createWebFetchTool(),
    createTaskOutputTool(processManager),
    createTaskStopTool(processManager),
    createTasksTool(cwd),
  ];

  if (opts?.agents && opts.agents.length > 0 && opts.provider && opts.model) {
    tools.push(createSubAgentTool(cwd, opts.agents, opts.provider, opts.model));
  }

  return { tools, processManager };
}

export { createReadTool } from "./read.js";
export { createWriteTool } from "./write.js";
export { createEditTool } from "./edit.js";
export { createBashTool } from "./bash.js";
export { createFindTool } from "./find.js";
export { createGrepTool } from "./grep.js";
export { createLsTool } from "./ls.js";
export { createWebFetchTool } from "./web-fetch.js";
export { createTaskOutputTool } from "./task-output.js";
export { createTaskStopTool } from "./task-stop.js";
export { createTasksTool } from "./tasks.js";
export { ProcessManager } from "../core/process-manager.js";
export { localOperations, type ToolOperations } from "./operations.js";
