export interface SidecarErrorContext {
  level?: "debug" | "info" | "warning" | "error" | "fatal";
  culprit?: string;
  tags?: Record<string, string>;
  context?: Record<string, unknown>;
}

interface SidecarErrorReporter {
  captureError(error: unknown, context?: SidecarErrorContext): string;
  wrap<A extends unknown[], R>(
    fn: (...args: A) => R,
    context?: SidecarErrorContext,
  ): (...args: A) => R;
  flush(): Promise<void>;
}

const EXPECTED_TOOL_VALIDATION_FAILURES: Readonly<Partial<Record<string, readonly string[]>>> = {
  edit: [
    "file must be read first before editing",
    "file has been modified since it was read",
    "the file changed since you read it (anchor mismatch)",
    "old_text and new_text are identical",
    "invalid edit:",
    "span overlaps another span edit",
    "old_text found ",
    "old_text not found in ",
  ],
  write: [
    "file must be read first before editing",
    "existing files must be read first before overwriting",
    "file has been modified since it was read",
  ],
};

export function shouldCaptureUsagePollingError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) return true;
  return error.status !== 429 && error.status !== "429";
}

export function shouldCaptureToolFailure(toolName: string, result: string): boolean {
  const expectedFailures = EXPECTED_TOOL_VALIDATION_FAILURES[toolName];
  if (!expectedFailures) return true;
  const normalizedResult = result.toLowerCase();
  return !expectedFailures.some((fragment) => normalizedResult.includes(fragment));
}

function errorMomReporter(): SidecarErrorReporter | undefined {
  return (globalThis as typeof globalThis & { __GG_ERROR_MOM__?: SidecarErrorReporter })
    .__GG_ERROR_MOM__;
}

function sidecarProcessTag(): string {
  if (process.argv.includes("--subagent-worker")) return "subagent-worker";
  if (process.argv.includes("--json")) return "json-worker";
  return "app-sidecar";
}

export function captureSidecarError(
  error: unknown,
  culprit: string,
  tags: Record<string, string> = {},
  context?: Record<string, unknown>,
): void {
  errorMomReporter()?.captureError(error, {
    culprit,
    tags: { process: sidecarProcessTag(), ...tags },
    ...(context ? { context } : {}),
  });
}

export async function flushSidecarErrors(): Promise<void> {
  await errorMomReporter()?.flush();
}

export function wrapSidecarHandler<A extends unknown[], R>(
  fn: (...args: A) => R,
  culprit: string,
): (...args: A) => R {
  return (
    errorMomReporter()?.wrap(fn, {
      culprit,
      tags: { process: sidecarProcessTag() },
    }) ?? fn
  );
}
