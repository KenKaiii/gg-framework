import { openRoyale, royaleStatus } from "./agent";
import { royaleConsentAccepted, ROYALE_CONSENT_VERSION } from "./RoyaleKey";

/**
 * Getting GG Royale on screen fast. Opening it costs a sign-in code from the
 * game server and a fresh connection to it before the game page even starts
 * loading. Both can happen early:
 * - `preconnectRoyale()` (Home on show) opens the connection to the game
 *   server in the background, so the page's first request skips that setup.
 * - `warmRoyale()` (pointing at or focusing the Royale button) also fetches
 *   the sign-in code, which `takeWarmRoyaleUrl()` hands to the game screen.
 *
 * Only for a computer that's already linked and has agreed to the current
 * link box: warming never creates an account or links anyone. A code is
 * one-time and lives 5 minutes on the server (with 30 an hour per device), so
 * a warm code is reused while it's under WARM_MAX_AGE_MS old and is used at
 * most once.
 */
export const WARM_MAX_AGE_MS = 3 * 60_000;

let warm: { url: Promise<string>; at: number } | null = null;
let connected: string | null = null;

async function ready(): Promise<string | null> {
  const status = await royaleStatus();
  if (!status.linked || royaleConsentAccepted() < ROYALE_CONSENT_VERSION) return null;
  return status.serverUrl;
}

function preconnect(serverUrl: string): void {
  let origin: string;
  try {
    origin = new URL(serverUrl).origin;
  } catch {
    return;
  }
  if (connected === origin || typeof document === "undefined") return;
  connected = origin;
  const link = document.createElement("link");
  link.rel = "preconnect";
  link.href = origin;
  document.head.append(link);
}

/** Open the connection to the game server ahead of time. Never throws. */
export function preconnectRoyale(): void {
  void ready()
    .then((server) => server && preconnect(server))
    .catch(() => {});
}

/** Connect and fetch a sign-in code ahead of a likely click. Never throws. */
export function warmRoyale(now = Date.now()): void {
  if (warm && now - warm.at < WARM_MAX_AGE_MS) return;
  warm = null;
  void ready()
    .then((server) => {
      if (!server || warm) return;
      preconnect(server);
      const url = openRoyale();
      // A failed warm-up is forgotten; the screen just asks again.
      url.catch(() => {
        if (warm?.url === url) warm = null;
      });
      warm = { url, at: Date.now() };
    })
    .catch(() => {});
}

/** The warmed sign-in URL if it's still fresh (used once), else null. */
export function takeWarmRoyaleUrl(now = Date.now()): Promise<string> | null {
  const w = warm;
  warm = null;
  return w && now - w.at < WARM_MAX_AGE_MS ? w.url : null;
}

/** Tests: forget any warm-up. */
export function resetRoyaleWarm(): void {
  warm = null;
  connected = null;
}
