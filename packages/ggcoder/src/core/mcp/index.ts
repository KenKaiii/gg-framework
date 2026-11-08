export { MCPClientManager } from "./client.js";
export type {
  MCPConnectResult,
  MCPElicitation,
  MCPElicitHandler,
  MCPLoginResult,
} from "./client.js";
export { createElicitationBridge, MCP_ELICIT_TIMEOUT_MS } from "./elicitation-bridge.js";
export type { ElicitationBridge, ElicitationPrompt } from "./elicitation-bridge.js";
export { McpOAuthStore } from "./oauth-store.js";
export {
  McpOAuthProvider,
  mcpOAuthRedirectUrl,
  MCP_OAUTH_CALLBACK_PORT,
} from "./oauth-provider.js";
export { DEFAULT_MCP_SERVERS, getMCPServers, getAllMcpServers } from "./defaults.js";
export { isShareableServer, SharedMcpPool, sharedMcpPool } from "./shared-pool.js";
export type { SharedConnector, SharedServerHandle } from "./shared-pool.js";
export type { MCPServerConfig } from "./types.js";
export {
  loadServers,
  addServer,
  removeServer,
  getServer,
  globalMcpPath,
  projectMcpPath,
} from "./store.js";
export type { MCPScope, ScopedServer } from "./store.js";
export { parseMcpAddCommand } from "./parse-add-command.js";
export type { ParsedAddCommand } from "./parse-add-command.js";
export { McpToolGuard, hiddenToolMessage } from "./tool-guard.js";
export type { HiddenMcpTool } from "./tool-guard.js";
