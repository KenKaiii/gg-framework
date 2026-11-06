/**
 * Public auth surface for downstream packages (gg-editor, etc).
 *
 * Re-exports the OAuth login flows, refresh functions, credential types,
 * and the shared AuthStorage. Downstream packages MUST import from here
 * rather than copy-pasting these files \u2014 every previous fork (gg-editor
 * 0.6.0\u20130.6.6) introduced regressions when small details drifted.
 */
export { loginOpenAI, refreshOpenAIToken } from "../oauth/openai.js";
export type { OAuthCredentials, OAuthLoginCallbacks } from "../oauth/types.js";
export { AuthStorage, NotLoggedInError } from "../auth-storage.js";
