import { daemonReadBody, daemonJson } from "./http.js";
import {
  parseCompleteRequest,
  completeOnce,
  CompletionTimeoutError,
} from "../core/one-shot-complete.js";
import { requireStartModel, ModelUnavailableError } from "./start-model.js";
import { log } from "../core/logger.js";
import type { DaemonRouteContext } from "./route-context.js";
import type http from "node:http";

export function handleCompleteRoutes(
  daemon: DaemonRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  // One-shot completion (no tools, thinking off, not session-scoped):
  // { model, system?, prompt, maxTokens?, timeoutMs? } → { text, model }.
  // The model resolves exactly like POST /session's `model`, failing closed
  // (409). Logs model and duration only — never the prompt.
  if (method === "POST" && url === "/complete") {
    void daemonReadBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        daemonJson(res, 400, { error: "invalid JSON body" });
        return;
      }
      const input = parseCompleteRequest(body);
      if ("error" in input) {
        daemonJson(res, 400, { error: input.error });
        return;
      }
      // Stop paying for tokens nobody will read once the caller hangs up.
      const clientGone = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) clientGone.abort();
      });
      const started = Date.now();
      let model = input.model;
      try {
        const target = await requireStartModel(daemon.auth, input.model);
        model = target.id;
        const text = await completeOnce({
          auth: daemon.auth,
          provider: target.provider,
          model: target.id,
          system: input.system,
          prompt: input.prompt,
          maxTokens: input.maxTokens,
          timeoutMs: input.timeoutMs,
          signal: clientGone.signal,
        });
        log("INFO", "app-sidecar", "complete done", {
          model,
          ms: String(Date.now() - started),
        });
        daemonJson(res, 200, { text, model });
      } catch (err) {
        if (err instanceof ModelUnavailableError) {
          log("WARN", "app-sidecar", "complete refused: model unavailable", {
            model: err.modelId,
            reason: err.reason,
          });
          daemonJson(res, 409, { error: err.message });
          return;
        }
        const { status, statusCode } = (err ?? {}) as { status?: unknown; statusCode?: unknown };
        const httpStatus = status ?? statusCode;
        // Provider errors can echo request content, so log only the class.
        log("WARN", "app-sidecar", "complete failed", {
          model,
          ms: String(Date.now() - started),
          error: err instanceof Error ? err.name : "unknown",
          ...(typeof httpStatus === "number" ? { status: String(httpStatus) } : {}),
        });
        const message =
          err instanceof CompletionTimeoutError
            ? err.message
            : `completion failed: ${err instanceof Error ? err.message : String(err)}`;
        daemonJson(res, 502, { error: message });
      }
    });
    return true;
  }

  return false;
}
