import type { PhaseStartResult } from "@kenkaiiii/gg-core/phase-start-protocol";

export interface PhaseStartRouteDependencies {
  method: string;
  url: string;
  host: string;
  respond(status: number, body: PhaseStartResult): void;
  start(phaseId: string): void;
}

/** Handles only POST /phases/:phaseId/start and leaves every other route untouched. */
export function handlePhaseStartRoute(dependencies: PhaseStartRouteDependencies): boolean {
  const pathname = new URL(dependencies.url, `http://${dependencies.host}`).pathname;
  const match = pathname.match(/^\/phases\/([^/]+)\/start$/);
  if (dependencies.method !== "POST" || !match) return false;

  let phaseId: string;
  try {
    phaseId = decodeURIComponent(match[1]!);
  } catch {
    dependencies.respond(400, {
      status: "failed",
      code: "invalid-phase-id",
      operationId: null,
      message: "The phase identifier is malformed.",
    } satisfies PhaseStartResult);
    return true;
  }

  dependencies.start(phaseId);
  return true;
}
