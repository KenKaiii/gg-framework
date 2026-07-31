import path from "node:path";

function canonicalProjectKey(cwd: string): string {
  const resolved = path.resolve(cwd);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export type ProjectAutopilotListener = (enabled: boolean) => void;

/** Daemon-shared live Autopilot policy and session fan-out, isolated by canonical project. */
export class AppSidecarProjectAutopilotState {
  private readonly values = new Map<string, boolean>();
  private readonly loads = new Map<string, Promise<boolean>>();
  private readonly listeners = new Map<string, Set<ProjectAutopilotListener>>();

  async initialize(cwd: string, load: () => Promise<boolean>): Promise<boolean> {
    const projectKey = canonicalProjectKey(cwd);
    const current = this.values.get(projectKey);
    if (current !== undefined) return current;

    const activeLoad = this.loads.get(projectKey);
    if (activeLoad) return activeLoad;

    const pending = load()
      .then((enabled) => {
        // A completed POST may have supplied a newer live value while persistence
        // was loading. Never let the older read overwrite that user action.
        if (!this.values.has(projectKey)) this.values.set(projectKey, enabled);
        return this.values.get(projectKey)!;
      })
      .finally(() => {
        if (this.loads.get(projectKey) === pending) this.loads.delete(projectKey);
      });
    this.loads.set(projectKey, pending);
    return pending;
  }

  isEnabled(cwd: string): boolean {
    return this.values.get(canonicalProjectKey(cwd)) ?? false;
  }

  set(cwd: string, enabled: boolean): void {
    const projectKey = canonicalProjectKey(cwd);
    this.values.set(projectKey, enabled);
    for (const listener of this.listeners.get(projectKey) ?? []) listener(enabled);
  }

  subscribe(cwd: string, listener: ProjectAutopilotListener): () => void {
    const projectKey = canonicalProjectKey(cwd);
    const projectListeners = this.listeners.get(projectKey) ?? new Set<ProjectAutopilotListener>();
    projectListeners.add(listener);
    this.listeners.set(projectKey, projectListeners);
    return () => {
      projectListeners.delete(listener);
      if (projectListeners.size === 0) this.listeners.delete(projectKey);
    };
  }
}
