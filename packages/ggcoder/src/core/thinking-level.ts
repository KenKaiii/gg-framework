// Moved to @kenkaiiii/gg-core. This shim re-exports it so existing relative
// imports (`./thinking-level.js`) keep resolving unchanged.
export {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  isThinkingLevelSupported,
  getNextThinkingLevel,
  resolveInitialThinkingLevel,
} from "@kenkaiiii/gg-core";
