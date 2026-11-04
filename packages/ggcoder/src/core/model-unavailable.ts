import { ProviderError } from "@kleio/ai";

/**
 * Whether a failure message means the selected model cannot be used at all —
 * it does not exist, was retired, or the account has no access. Only these
 * failures are worth retrying on a different model; usage limits, auth and
 * process errors would fail the same way again.
 */
export function isModelUnavailableError(message: string): boolean {
  return /does not recognize the requested model|requested model[^\n]*(?:not available|no access)|model[^\n]*(?:does not exist|not found|not available)/i.test(
    message,
  );
}

/**
 * {@link isModelUnavailableError} for a thrown provider failure. Raw provider
 * errors often carry only a terse body ("model: claude-x", type
 * `not_found_error`), so an HTTP 404 or an explicit `model_not_found` code
 * counts too.
 */
export function isModelUnavailableFailure(err: unknown): boolean {
  if (err instanceof ProviderError && err.statusCode === 404) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /model_not_found/i.test(message) || isModelUnavailableError(message);
}
