import type { StreamEvent, StreamResponse } from "../types.js";

/**
 * Push-based async iterable. Producers push events, consumers
 * iterate with `for await`. Also supports thenable so you can
 * `await stream(...)` directly to get the final response.
 */
export class EventStream<T = StreamEvent> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolve: (() => void) | null = null;
  private done = false;
  private error: Error | null = null;

  push(event: T): void {
    // Safety valve: if queue grows beyond 10k unconsumed events, drop oldest
    // to prevent OOM when consumer is blocked/slow
    if (this.queue.length > 10_000) {
      this.queue.splice(0, this.queue.length - 5_000);
    }
    this.queue.push(event);
    this.resolve?.();
    this.resolve = null;
  }

  close(): void {
    this.done = true;
    this.resolve?.();
    this.resolve = null;
  }

  abort(error: Error): void {
    this.error = error;
    this.done = true;
    this.resolve?.();
    this.resolve = null;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let index = 0;
    while (true) {
      while (index < this.queue.length) {
        yield this.queue[index++]!;
      }
      // Reset to avoid holding references to already-yielded events
      this.queue.splice(0, index);
      index = 0;
      if (this.error) throw this.error;
      if (this.done) return;
      await new Promise<void>((r) => {
        this.resolve = r;
      });
    }
  }
}

/**
 * Wraps EventStream and adds a `.response` promise that resolves
 * to the final StreamResponse. Also implements thenable so:
 *
 *   const msg = await stream({...})          // awaits response
 *   for await (const e of stream({...})) {}  // iterates events
 */
export class StreamResult implements AsyncIterable<StreamEvent> {
  readonly events: EventStream<StreamEvent>;
  readonly response: Promise<StreamResponse>;
  private resolveResponse!: (r: StreamResponse) => void;
  private rejectResponse!: (e: Error) => void;
  private hasConsumer = false;

  constructor() {
    this.events = new EventStream<StreamEvent>();
    this.response = new Promise<StreamResponse>((resolve, reject) => {
      this.resolveResponse = resolve;
      this.rejectResponse = reject;
    });
  }

  push(event: StreamEvent): void {
    this.events.push(event);
  }

  complete(response: StreamResponse): void {
    this.events.close();
    this.resolveResponse(response);
  }

  abort(error: Error): void {
    this.events.abort(error);
    this.rejectResponse(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    this.hasConsumer = true;
    return this.events[Symbol.asyncIterator]();
  }

  then<TResult1 = StreamResponse, TResult2 = never>(
    onfulfilled?: ((value: StreamResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    // Drain events so the stream completes
    this.drainEvents().catch(() => {});
    return this.response.then(onfulfilled, onrejected);
  }

  private async drainEvents(): Promise<void> {
    if (this.hasConsumer) return;
    this.hasConsumer = true;
    for await (const _ of this.events) {
      // consume silently
    }
  }
}
