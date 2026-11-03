// Stored as the key of a local endpoint added without one. It only means "no
// key" and is never sent: gateways treat any bearer token as a key to check.
export const LOCAL_NO_API_KEY = "local";

/** The key to send to a local endpoint, or undefined when it has none. */
export function localBearerKey(apiKey: string | undefined): string | undefined {
  return apiKey && apiKey !== LOCAL_NO_API_KEY ? apiKey : undefined;
}
