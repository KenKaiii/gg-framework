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
