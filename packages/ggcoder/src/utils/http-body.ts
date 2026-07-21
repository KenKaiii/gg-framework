import type http from "node:http";

/**
 * Hard cap on inbound HTTP request bodies for the app sidecar (baseline #8).
 * The sidecar is localhost-only, but an unbounded body balloons RSS ~5.5x its
 * size (a 100 MB POST measured at ~550 MB RSS). 10 MB is far above any
 * legitimate prompt / settings / session payload.
 */
export const MAX_HTTP_BODY_BYTES = 10 * 1024 * 1024;

/**
 * Read a request body into a string, aborting if it exceeds `maxBytes`.
 *
 * On overflow the socket is destroyed, a single `413` JSON response is sent
 * (unless headers were already flushed), and the promise resolves `null` so the
 * caller can short-circuit without double-responding. Socket errors also resolve
 * `null` — call sites use `.then()` without `.catch()`, so rejecting would
 * surface as an unhandled rejection.
 */
export function readCappedBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  maxBytes: number = MAX_HTTP_BODY_BYTES,
): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on("data", (c) => {
      if (aborted) return;
      const buf = c as Buffer;
      total += buf.length;
      if (total > maxBytes) {
        aborted = true;
        chunks.length = 0; // drop what we buffered so it can be GC'd
        try {
          if (!res.headersSent) {
            res.writeHead(413, {
              "content-type": "application/json",
              "access-control-allow-origin": "*",
            });
            res.end(JSON.stringify({ error: "request body too large" }));
          }
        } catch {
          /* response already gone */
        }
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      if (!aborted) resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", () => {
      if (!aborted) resolve(null);
    });
  });
}
