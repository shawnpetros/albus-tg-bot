// A generic single-consumer async FIFO.
//
// Used by poll.ts to serialize Telegram turns: only one `claude -p` runs at a
// time. Follow-up user messages fired while a turn is in-flight are buffered
// and processed in order (steer buffering). A system op (e.g. compaction) can
// be inserted ahead of pending user messages but never preempts the running
// turn, via enqueueFront.

export type QueueProcessor<T> = (item: T) => Promise<void>;

export interface TurnQueueOptions<T> {
  // Called when the processor throws/rejects for an item. The queue then
  // continues with the next item; one bad item never wedges the queue.
  onError?: (err: unknown, item: T) => void;
}

export class TurnQueue<T> {
  private readonly process: QueueProcessor<T>;
  private readonly onError?: (err: unknown, item: T) => void;
  private readonly pending: T[] = [];
  private running = false;
  // Resolvers for outstanding idle() promises, fired when the queue drains.
  private idleWaiters: Array<() => void> = [];

  constructor(process: QueueProcessor<T>, opts?: TurnQueueOptions<T>) {
    this.process = process;
    this.onError = opts?.onError;
  }

  // Append to the tail; start draining if idle.
  enqueue(item: T): void {
    this.pending.push(item);
    this.drain();
  }

  // Insert ahead of all PENDING items. Runs after the in-flight item (if any),
  // before anything already queued. Does NOT preempt the running item.
  enqueueFront(item: T): void {
    this.pending.unshift(item);
    this.drain();
  }

  // Number of pending (not-yet-started) items.
  get size(): number {
    return this.pending.length;
  }

  // True while an item is being processed.
  get busy(): boolean {
    return this.running;
  }

  // Resolves when the queue is drained (no in-flight item, nothing pending).
  // Resolves immediately if already idle.
  idle(): Promise<void> {
    if (!this.running && this.pending.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  // Kick the consumer loop. Guarded by `running` so it is never re-entrant:
  // calling drain() while an item is in-flight (e.g. from inside the
  // processor) is a no-op; the existing loop picks up the new item.
  private drain(): void {
    if (this.running) return;
    if (this.pending.length === 0) return;
    this.running = true;
    void this.loop();
  }

  private async loop(): Promise<void> {
    try {
      while (this.pending.length > 0) {
        const item = this.pending.shift() as T;
        try {
          await this.process(item);
        } catch (err) {
          if (this.onError) this.onError(err, item);
        }
      }
    } finally {
      this.running = false;
      // A processor may have enqueued more work between the loop's last
      // length check and now; if so, restart rather than signalling idle.
      if (this.pending.length > 0) {
        this.drain();
      } else {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }
}
