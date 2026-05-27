import { formatError } from "@kenkaiiii/gg-ai";
import { log } from "../core/logger.js";
import type { ErrorItem } from "./app-items.js";

/** Where ggcoder bugs should be reported. Surfaced in the guidance line. */
const GGCODER_BUG_REPORT_URL = "github.com/kenkaiiii/gg-framework/issues";

/**
 * Build an ErrorItem from any thrown value. Centralises headline / message /
 * guidance extraction so every error answers the same question for the user:
 * "Should I retry, or is this a ggcoder bug to report?"
 */
export function toErrorItem(err: unknown, id: string, contextPrefix?: string): ErrorItem {
  const f = formatError(err);
  const headline = contextPrefix ? `${contextPrefix} — ${f.headline}` : f.headline;
  const guidance =
    f.source === "ggcoder"
      ? `This looks like a ggcoder bug — please send it to the dev at ${GGCODER_BUG_REPORT_URL}.`
      : f.guidance;

  log("ERROR", "ui-error", headline, {
    source: f.source,
    message: f.message,
    ...(f.provider ? { provider: f.provider } : {}),
    ...(f.statusCode != null ? { statusCode: String(f.statusCode) } : {}),
    ...(f.requestId ? { requestId: f.requestId } : {}),
    ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
  });

  return {
    kind: "error",
    headline,
    message: f.message,
    guidance,
    id,
  };
}
