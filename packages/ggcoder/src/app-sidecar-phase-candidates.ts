export interface DisposablePhaseCandidate {
  session: { dispose: () => void | Promise<void> };
}

/** Owns initialized phase candidates until promotion or terminal disposal. */
export class AppSidecarPhaseCandidateStore<TCandidate extends DisposablePhaseCandidate> {
  readonly #candidates = new Map<string, TCandidate>();
  #disposed = false;

  get(phaseId: string): TCandidate | undefined {
    return this.#candidates.get(phaseId);
  }

  has(phaseId: string): boolean {
    return this.#candidates.has(phaseId);
  }

  async add(phaseId: string, candidate: TCandidate): Promise<void> {
    if (this.#disposed || this.#candidates.has(phaseId)) {
      await Promise.allSettled([Promise.resolve().then(() => candidate.session.dispose())]);
      throw new Error(
        this.#disposed
          ? "Cannot retain a phase candidate after its logical session was disposed."
          : `A phase candidate is already retained for ${phaseId}.`,
      );
    }
    this.#candidates.set(phaseId, candidate);
  }

  /** Removes a promoted candidate without disposing the now-active session. */
  take(phaseId: string): TCandidate | undefined {
    const candidate = this.#candidates.get(phaseId);
    if (candidate) this.#candidates.delete(phaseId);
    return candidate;
  }

  async disposeCandidate(phaseId: string): Promise<boolean> {
    const candidate = this.take(phaseId);
    if (!candidate) return false;
    await Promise.allSettled([Promise.resolve().then(() => candidate.session.dispose())]);
    return true;
  }

  /** Clears stale retry candidates while keeping this logical owner reusable. */
  async clear(): Promise<void> {
    const candidates = [...this.#candidates.values()];
    this.#candidates.clear();
    await Promise.allSettled(
      candidates.map((candidate) => Promise.resolve().then(() => candidate.session.dispose())),
    );
  }

  /** Permanently closes the owner and disposes every candidate still retained. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.clear();
  }
}
