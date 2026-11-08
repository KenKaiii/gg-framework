/**
 * Upper bound for one OAuth/token HTTP request, body included. A token refresh
 * runs while holding the auth file lock, so a request that never answers (a
 * half-open socket, a captive portal) would otherwise block every later auth
 * read in the long-lived app daemon.
 */
const OAUTH_REQUEST_TIMEOUT_MS = 30_000;

export function oauthRequestSignal(): AbortSignal {
  return AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS);
}
