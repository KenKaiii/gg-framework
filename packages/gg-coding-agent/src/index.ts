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
