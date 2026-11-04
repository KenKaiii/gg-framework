import { EventStream, type Message } from "@kleio/ai";
import { agentLoop } from "./agent-loop.js";
import type { AgentEvent, AgentOptions, AgentResult } from "./types.js";

// ── AgentStream ─────────────────────────────────────────────

/**
 * Dual-nature result: async iterable for streaming events,
 * thenable for awaiting the final AgentResult.
 *
 * ```ts
 * // Stream events
 * for await (const event of agent.prompt("hello")) { ... }
 *
 * // Or just await the result
 * const result = await agent.prompt("hello");
 * ```
 */
export class AgentStream implements AsyncIterable<AgentEvent> {
  private events: EventStream<AgentEvent>;
  private resultPromise: Promise<AgentResult>;
  private resolveResult!: (r: AgentResult) => void;
  private rejectResult!: (e: Error) => void;
  private hasConsumer = false;

  constructor(generator: AsyncGenerator<AgentEvent, AgentResult>, onDone: () => void) {
    this.events = new EventStream<AgentEvent>();
    this.resultPromise = new Promise<AgentResult>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    this.pump(generator, onDone);
  }

  private async pump(
    generator: AsyncGenerator<AgentEvent, AgentResult>,
    onDone: () => void,
  ): Promise<void> {
    try {
      let next = await generator.next();
      while (!next.done) {
        this.events.push(next.value);
        next = await generator.next();
      }
      this.events.close();
      this.resolveResult(next.value);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.events.abort(error);
      this.rejectResult(error);
    } finally {
      onDone();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    this.hasConsumer = true;
    return this.events[Symbol.asyncIterator]();
  }

  then<TResult1 = AgentResult, TResult2 = never>(
    onfulfilled?: ((value: AgentResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    this.drainEvents().catch(() => {});
    return this.resultPromise.then(onfulfilled, onrejected);
  }

  private async drainEvents(): Promise<void> {
    if (this.hasConsumer) return;
    this.hasConsumer = true;
    for await (const _ of this.events) {
      // consume silently
    }
  }
}

// ── Agent ───────────────────────────────────────────────────

export class Agent {
  private messages: Message[] = [];
  private _running = false;
  private options: AgentOptions;
  private steeringQueue: Message[] = [];
  private followUpQueue: Message[] = [];
  private steeringListeners = new Set<() => void>();

  constructor(options: AgentOptions) {
    this.options = options;
    if (options.system) {
      this.messages.push({ role: "system", content: options.system });
    }
    if (options.priorMessages && options.priorMessages.length > 0) {
      this.messages.push(...options.priorMessages);
    }
  }

  /** Snapshot of the current message history. Used for session persistence. */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * Swap the abort signal used for subsequent prompts. Call this after
   * `controller.abort()` so the next prompt() call gets a fresh, unaborted
   * signal — without losing message history.
   */
  setSignal(signal: AbortSignal | undefined): void {
    this.options = { ...this.options, signal };
  }

  get running(): boolean {
    return this._running;
  }

  /**
   * Queue a steering message. Instant interrupt: if tools are running, the
   * interruptible ones are preempted right away and the message is injected
   * before the next model call (the turn continues — unlike abort/Stop).
   */
  steer(msg: Message): void {
    this.steeringQueue.push(msg);
    for (const listener of [...this.steeringListeners]) listener();
  }

  /** Queue a follow-up message for injection when the agent would otherwise stop. */
  followUp(msg: Message): void {
    this.followUpQueue.push(msg);
  }

  prompt(content: string): AgentStream {
    if (this._running) {
      throw new Error("Agent is already running");
    }
    this._running = true;

    this.messages.push({ role: "user", content });

    const optionsWithQueues: AgentOptions = {
      ...this.options,
      getSteeringMessages: async () => {
        const callerResult = (await this.options.getSteeringMessages?.()) ?? [];
        const queued = this.steeringQueue.splice(0);
        const all = [...(callerResult ?? []), ...queued];
        return all.length > 0 ? all : null;
      },
      onSteeringAvailable: (listener) => {
        this.steeringListeners.add(listener);
        const unsubscribeCaller = this.options.onSteeringAvailable?.(listener);
        return () => {
          this.steeringListeners.delete(listener);
          unsubscribeCaller?.();
        };
      },
      getFollowUpMessages: async () => {
        const callerResult = (await this.options.getFollowUpMessages?.()) ?? [];
        const queued = this.followUpQueue.splice(0);
        const all = [...(callerResult ?? []), ...queued];
        return all.length > 0 ? all : null;
      },
    };

    const generator = agentLoop(this.messages, optionsWithQueues);
    return new AgentStream(generator, () => {
      this._running = false;
    });
  }
}
