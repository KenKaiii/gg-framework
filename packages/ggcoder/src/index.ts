// Tools
export {
  createTools,
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createSourcePathTool,
} from "./tools/index.js";

// System prompt
export { buildSystemPrompt } from "./system-prompt.js";

// Session (legacy — still usable)
export {
  createSession,
  loadSession,
  listSessions,
  getMostRecentSession,
  persistMessage,
} from "./session.js";

// Core
export {
  EventBus,
  AgentSession,
  SessionManager,
  SettingsManager,
  AuthStorage,
  SlashCommandRegistry,
  ExtensionLoader,
  MODELS,
  getModel,
  getModelsForProvider,
  getDefaultModel,
  getContextWindow,
  usesOpenAICodexTransport,
  getMaxThinkingLevel,
  getDefaultThinkingLevel,
  getNextThinkingLevel,
  getSupportedThinkingLevels,
  isThinkingLevelSupported,
  shouldCompact,
  compact,
  discoverSkills,
  estimateTokens,
  estimateConversationTokens,
} from "./core/index.js";

// Modes
export { runPrintMode } from "./modes/index.js";

// UI entry
export { renderApp } from "./ui/render.js";

// Config
export { APP_NAME, VERSION, getAppPaths, ensureAppDirs } from "./config.js";

// Project discovery (shared with gg-boss + gg-app sidecar)
export {
  discoverProjects,
  listRecentSessions,
  type DiscoveredProject,
  type ProjectSource,
  type RecentSession,
} from "./core/project-discovery.js";

// Types
export type {
  CliConfig,
  SessionHeader as LegacySessionHeader,
  SessionMessageEntry,
  SessionEntry as LegacySessionEntry,
  SessionInfo as LegacySessionInfo,
} from "./types.js";

export type {
  AgentSessionOptions,
  AgentSessionState,
  BusEventMap,
  ContextWindowOptions,
  ModelInfo,
  Settings,
  SlashCommand,
  SlashCommandContext,
  Skill,
  Extension,
  ExtensionContext,
  CompactionResult,
  SessionEntry,
  SessionInfo,
  SessionHeader,
} from "./core/index.js";
