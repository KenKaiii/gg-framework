import type http from "node:http";
import { readCappedBody } from "../utils/http-body.js";
import { environmentSecrets, redactValue } from "@kenkaiiii/gg-ai";

// ── Daemon-level HTTP helpers (shared by the session-management routes) ─────
// The per-session route table has its own local copies; these serve the
// daemon's own POST /session / DELETE /session routes.
export function daemonReadBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<string | null> {
  return readCappedBody(req, res);
}

export function daemonJson(res: http.ServerResponse, status: number, body: unknown): void {
  // No CORS headers: only the Rust proxy (no Origin) should call this daemon.
  // Granting origins would let any web page read responses from loopback.
  res.writeHead(status, {
    "content-type": "application/json",
  });
  res.end(JSON.stringify(body));
}

export function readBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  maxBytes?: number,
): Promise<string | null> {
  return readCappedBody(req, res, maxBytes);
}

export function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(redactValue(body, { secrets: environmentSecrets(process.env) }));
  res.writeHead(status, {
    "content-type": "application/json",
  });
  res.end(payload);
}
