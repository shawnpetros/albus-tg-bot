import { describe, expect, test } from "bun:test";
import { TurnQueue } from "../lib/queue.ts";

// A controllable deferred promise: resolve it from the outside to let a
// processor "finish". Lets multiple items pile up as pending while one is
// in-flight.
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Yield to the microtask/macrotask queue so any synchronously-kicked
// draining has a chance to advance.
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("TurnQueue", () => {
  test("1. FIFO order: A,B,C processed in order", async () => {
    const seen: string[] = [];
    const q = new TurnQueue<string>(async (item) => {
      seen.push(item);
    });
    q.enqueue("A");
    q.enqueue("B");
    q.enqueue("C");
    await q.idle();
    expect(seen).toEqual(["A", "B", "C"]);
  });

  test("2. single-flight: process is never invoked concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    let everConcurrent = false;
    const gates: Array<ReturnType<typeof deferred<void>>> = [];

    const q = new TurnQueue<number>(async () => {
      if (active > 0) everConcurrent = true;
      active++;
      maxActive = Math.max(maxActive, active);
      const g = deferred();
      gates.push(g);
      await g.promise; // hold the item in-flight until released
      active--;
    });

    q.enqueue(1);
    q.enqueue(2);
    q.enqueue(3);

    // Let the first item enter the processor.
    await tick();
    expect(active).toBe(1); // only one in-flight despite three enqueued
    expect(q.size).toBe(2); // the other two are pending

    // Release each in turn, confirming the next only starts after release.
    while (gates.length) {
      const g = gates.shift()!;
      g.resolve(undefined);
      await tick();
    }
    await q.idle();

    expect(everConcurrent).toBe(false);
    expect(maxActive).toBe(1);
  });

  test("3. enqueueFront jumps ahead of pending but not the in-flight item", async () => {
    const seen: string[] = [];
    const firstGate = deferred();
    let started = false;

    const q = new TurnQueue<string>(async (item) => {
      seen.push(item);
      if (!started) {
        started = true;
        await firstGate.promise; // hold A in-flight
      }
    });

    q.enqueue("A"); // becomes in-flight
    await tick();
    expect(seen).toEqual(["A"]); // A running, not yet done

    q.enqueue("B"); // tail
    q.enqueueFront("C"); // ahead of pending B, behind running A
    expect(q.size).toBe(2);

    firstGate.resolve(undefined); // let A finish
    await q.idle();

    expect(seen).toEqual(["A", "C", "B"]);
  });

  test("4. enqueue from inside a processor keeps draining without re-entrancy", async () => {
    const seen: string[] = [];
    let active = 0;
    let everConcurrent = false;

    const q = new TurnQueue<string>(async (item) => {
      if (active > 0) everConcurrent = true;
      active++;
      seen.push(item);
      if (item === "A") {
        // Enqueue while draining: must not double-process or stall.
        q.enqueue("B");
      }
      active--;
    });

    q.enqueue("A");
    await q.idle();

    expect(seen).toEqual(["A", "B"]);
    expect(everConcurrent).toBe(false);
    expect(q.busy).toBe(false);
    expect(q.size).toBe(0);
  });

  test("5. error isolation: a throwing item fires onError and the queue continues", async () => {
    const seen: string[] = [];
    const errors: Array<{ err: unknown; item: string }> = [];

    const q = new TurnQueue<string>(
      async (item) => {
        seen.push(item);
        if (item === "B") throw new Error("boom");
      },
      { onError: (err, item) => errors.push({ err, item }) }
    );

    q.enqueue("A");
    q.enqueue("B");
    q.enqueue("C");
    await q.idle();

    expect(seen).toEqual(["A", "B", "C"]); // C still processed after B failed
    expect(errors).toHaveLength(1);
    expect(errors[0]!.item).toBe("B");
    expect((errors[0]!.err as Error).message).toBe("boom");
    expect(q.busy).toBe(false); // not wedged
    expect(q.size).toBe(0);
  });

  test("5b. a throwing item without onError still does not wedge the queue", async () => {
    const seen: string[] = [];
    const q = new TurnQueue<string>(async (item) => {
      seen.push(item);
      if (item === "A") throw new Error("nope");
    });
    q.enqueue("A");
    q.enqueue("B");
    await q.idle();
    expect(seen).toEqual(["A", "B"]);
    expect(q.busy).toBe(false);
  });

  test("6. idle/empty then re-enqueue restarts processing", async () => {
    const seen: string[] = [];
    const q = new TurnQueue<string>(async (item) => {
      seen.push(item);
    });

    q.enqueue("A");
    await q.idle();
    expect(q.busy).toBe(false);
    expect(q.size).toBe(0);
    expect(seen).toEqual(["A"]);

    // idle() on an already-idle queue resolves immediately.
    await q.idle();

    q.enqueue("B");
    expect(q.busy).toBe(true); // started synchronously on enqueue
    await q.idle();
    expect(seen).toEqual(["A", "B"]);
    expect(q.busy).toBe(false);
    expect(q.size).toBe(0);
  });
});
