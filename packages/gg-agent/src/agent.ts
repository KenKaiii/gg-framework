import { EventStream, type Message } from "@kenkaiiii/gg-ai";
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

  constructor(options: AgentOptions) {
    this.options = options;
    if (options.system) {
      this.messages.push({ role: "system", content: options.system });
    }
  }

  get running(): boolean {
    return this._running;
  }

  prompt(content: string): AgentStream {
    if (this._running) {
      throw new Error("Agent is already running");
    }
    this._running = true;

    this.messages.push({ role: "user", content });

    const generator = agentLoop(this.messages, this.options);
    return new AgentStream(generator, () => {
      this._running = false;
    });
  }
}
