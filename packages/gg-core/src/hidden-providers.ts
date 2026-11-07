/**
 * Providers temporarily hidden from every user-facing surface: the login lists
 * (CLI + app), the model pickers, and startup provider resolution. Their models,
 * transports and stored credentials stay in place, so un-hiding is a one-line
 * change here (plus `HIDDEN_PROVIDERS` in gg-app/src-tauri/src/auth.rs).
 *
 * None are hidden today: Gemini came back with an AI Studio API key.
 *
 * Hiding works through `AuthStorage.hasProviderAuth()`, which reports a hidden
 * provider as not connected: every picker and the startup resolver filter on
 * it, so a user with old Gemini credentials falls back to another provider.
 */
export const HIDDEN_PROVIDERS: readonly string[] = [];

/** True when `provider` is hidden from login lists, pickers and startup. */
export function isHiddenProvider(provider: string): boolean {
  return HIDDEN_PROVIDERS.includes(provider);
}
