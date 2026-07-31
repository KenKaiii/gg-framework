import { randomUUID } from "node:crypto";
import { canonicalProjectKey } from "@kenkaiiii/gg-core/project-notes";

export type RoadmapReconciliationKind =
  | "phase-start"
  | "status-update"
  | "implementation-checkpoint"
  | "completion-review";

export interface RoadmapReconciliationOwner {
  projectKey: string;
  operationId: string;
  kind: RoadmapReconciliationKind;
}

export interface RoadmapReconciliationLease extends RoadmapReconciliationOwner {
  release(): void;
}

/** Daemon-shared fail-fast lease for launch, status, and completion intent on one project. */
export class AppSidecarRoadmapReconciliationCoordinator {
  private readonly owners = new Map<string, RoadmapReconciliationOwner>();

  constructor(private readonly createId: () => string = randomUUID) {}

  owner(cwd: string): RoadmapReconciliationOwner | undefined {
    const owner = this.owners.get(canonicalProjectKey(cwd));
    return owner ? { ...owner } : undefined;
  }

  tryAcquire(cwd: string, kind: RoadmapReconciliationKind): RoadmapReconciliationLease | null {
    const projectKey = canonicalProjectKey(cwd);
    if (this.owners.has(projectKey)) return null;
    const owner: RoadmapReconciliationOwner = {
      projectKey,
      operationId: this.createId(),
      kind,
    };
    this.owners.set(projectKey, owner);
    let released = false;
    return {
      ...owner,
      release: () => {
        if (released) return;
        released = true;
        if (this.owners.get(projectKey)?.operationId === owner.operationId) {
          this.owners.delete(projectKey);
        }
      },
    };
  }
}
