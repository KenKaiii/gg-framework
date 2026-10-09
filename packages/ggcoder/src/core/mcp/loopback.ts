/**
 * Localhost detection + loopback retry helpers for HTTP MCP connections.
 *
 * Extracted so the retry-decision logic is unit-testable on every platform, not
 * only on the Windows CI leg. Windows 11 resolves `localhost` → ::1 (IPv6) first,
 * but many MCP servers (Playwright MCP `--port`, Node's default HTTP listen)
 * bind to 127.0.0.1 (IPv4-only). The client's first `fetch` then hits a dead
 * socket (ECONNREFUSED). These helpers decide whether a connect is local and,
 * on failure, which alternate hostname to retry with.
 */

/** Whether a URL points at the local machine (no OAuth, retry-eligible). */
export function isLocalhost(url: URL): boolean {
  const h = normalizeHost(url.hostname);
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0";
}

/**
 * The alternate loopback hostname to try when a localhost connect fails, or
 * `undefined` if the hostname isn't a known loopback (so a retry would be
 * pointless). Maps between the IPv4 / IPv6 / name representations.
 */
export function alternateLoopback(hostname: string): string | undefined {
  const h = normalizeHost(hostname);
  if (h === "localhost") return "127.0.0.1";
  if (h === "127.0.0.1") return "localhost";
  if (h === "::1") return "127.0.0.1";
  if (h === "0.0.0.0") return "127.0.0.1";
  return undefined;
}

/**
 * Lowercase + strip the surrounding brackets Node's URL API keeps on IPv6
 * hostnames (e.g. `[::1]` → `::1`) so comparisons are uniform.
 */
function normalizeHost(hostname: string): string {
  let h = hostname.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h;
}

/**
 * Whether an error is a low-level network failure (worth a loopback retry) vs.
 * a protocol/auth error (not — retrying won't help). Node's `fetch` surfaces
 * these as `TypeError: fetch failed` wrapping a `cause` with a code like
 * `ECONNREFUSED`; the SSE transport surfaces `SseError`. We check the message,
 * the cause message, and the cause code.
 */
export function isNetworkError(err: unknown): boolean {
  if (err == null) return false;
  const msg = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const text = `${msg} ${cause?.message ?? ""} ${cause?.code ?? ""}`.toLowerCase();
  return (
    text.includes("econnrefused") ||
    text.includes("econnreset") ||
    text.includes("enotfound") ||
    text.includes("eai_again") ||
    text.includes("fetch failed") ||
    text.includes("failed to fetch") ||
    text.includes("connection refused") ||
    text.includes("network request failed") ||
    text.includes("sse error")
  );
}
