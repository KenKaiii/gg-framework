import chalk from "chalk";

/**
 * Convert raw errors into clean, user-friendly one-liners.
 */
export function formatUserError(err: unknown): string {
  if (err instanceof Error && err.name === "AbortError") {
    return chalk.red("Interrupted.");
  }

  const { message, provider, statusCode } = extractErrorInfo(err);
  const lowerMsg = message.toLowerCase();

  // Auth: not logged in
  if (
    lowerMsg.includes("not logged in") ||
    lowerMsg.includes("resolve authentication") ||
    lowerMsg.includes("api key") ||
    lowerMsg.includes("apikey") ||
    lowerMsg.includes("no auth")
  ) {
    return chalk.red('Not logged in. Run "ggcoder login" to authenticate.');
  }

  // Auth: invalid/expired token
  if (
    statusCode === 401 ||
    lowerMsg.includes("unauthorized") ||
    /invalid.*key/.test(lowerMsg) ||
    /invalid.*token/.test(lowerMsg)
  ) {
    return chalk.red('Session expired or invalid. Run "ggcoder login" to re-authenticate.');
  }

  // Billing/quota errors (GLM returns 429 for these)
  if (
    lowerMsg.includes("insufficient balance") ||
    lowerMsg.includes("no resource package") ||
    lowerMsg.includes("quota exceeded") ||
    lowerMsg.includes("recharge")
  ) {
    const name = displayProvider(provider);
    return chalk.red(
      `${name} reports a billing or quota issue. Check your account balance or resource package.`,
    );
  }

  // Rate limiting
  if (statusCode === 429 || lowerMsg.includes("rate limit")) {
    const name = displayProvider(provider);
    return chalk.red(`Rate limited by ${name}. Wait a moment and try again.`);
  }

  // Server errors (5xx)
  if (statusCode && statusCode >= 500 && statusCode < 600) {
    const name = displayProvider(provider);
    return chalk.red(`${name} server error (${statusCode}). Try again shortly.`);
  }

  // Network errors
  if (
    lowerMsg.includes("econnrefused") ||
    lowerMsg.includes("fetch failed") ||
    lowerMsg.includes("enotfound") ||
    lowerMsg.includes("etimedout") ||
    lowerMsg.includes("network")
  ) {
    const name = displayProvider(provider);
    return chalk.red(`Cannot reach ${name} API. Check your internet connection.`);
  }

  // Bad request (400)
  if (statusCode === 400) {
    const name = displayProvider(provider);
    const firstLine = message.split("\n")[0];
    return chalk.red(`Request error (${name}): ${firstLine}`);
  }

  // File not found
  if (lowerMsg.includes("enoent")) {
    const path = extractPath(message);
    return chalk.red(path ? `File not found: ${path}` : "File not found.");
  }

  // Permission denied
  if (lowerMsg.includes("eacces")) {
    const path = extractPath(message);
    return chalk.red(path ? `Permission denied: ${path}` : "Permission denied.");
  }

  // Generic Error — show first line only, no stack
  if (message) {
    const firstLine = message.split("\n")[0];
    return chalk.red(`Error: ${firstLine}`);
  }

  return chalk.red("An unexpected error occurred.");
}

// ── Helpers ──────────────────────────────────────────────────

interface ErrorInfo {
  message: string;
  provider: string | undefined;
  statusCode: number | undefined;
}

function extractErrorInfo(err: unknown): ErrorInfo {
  if (typeof err !== "object" || err === null) {
    return { message: String(err), provider: undefined, statusCode: undefined };
  }

  const e = err as Record<string, unknown>;
  const message = typeof e.message === "string" ? e.message : String(err);
  const provider = typeof e.provider === "string" ? e.provider : undefined;
  const statusCode =
    typeof e.statusCode === "number"
      ? e.statusCode
      : typeof e.status === "number"
        ? e.status
        : undefined;

  return { message, provider, statusCode };
}

function displayProvider(provider: string | undefined): string {
  switch (provider) {
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
    default:
      return "the provider";
  }
}

function extractPath(message: string): string | undefined {
  // Match common ENOENT/EACCES patterns: "... 'path'" or "... \"path\""
  const match = message.match(/['"]([^'"]+)['"]/);
  return match?.[1];
}
