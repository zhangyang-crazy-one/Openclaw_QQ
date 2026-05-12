import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createSendQueue, type SendQueue } from "./message-queue.js";

function makeQueue(interSendDelayMs = 50): SendQueue {
  return createSendQueue({ interSendDelayMs });
}

describe("createSendQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("executes single send per target immediately (no prior chain)", async () => {
    const queue = makeQueue();
    const sendFn = vi.fn().mockResolvedValue(undefined);

    queue.enqueue("target-a", sendFn);

    // Advance microtasks (the enqueued chain uses Promise resolution)
    await vi.runAllTimersAsync();
    // Also flush microtask queue
    await Promise.resolve();

    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it("executes 3 sends to same target sequentially with inter-send delay", async () => {
    const queue = makeQueue();
    const calls: string[] = [];
    const fn1 = vi.fn(async () => {
      calls.push("first");
    });
    const fn2 = vi.fn(async () => {
      calls.push("second");
    });
    const fn3 = vi.fn(async () => {
      calls.push("third");
    });

    queue.enqueue("target-a", fn1);
    queue.enqueue("target-a", fn2);
    queue.enqueue("target-a", fn3);

    // First send executes immediately
    await vi.advanceTimersByTimeAsync(0);
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(0);
    expect(fn3).toHaveBeenCalledTimes(0);

    // After inter-send delay, second executes
    await vi.advanceTimersByTimeAsync(50);
    expect(fn2).toHaveBeenCalledTimes(1);
    expect(fn3).toHaveBeenCalledTimes(0);

    // After another inter-send delay, third executes
    await vi.advanceTimersByTimeAsync(50);
    expect(fn3).toHaveBeenCalledTimes(1);

    expect(calls).toEqual(["first", "second", "third"]);
  });

  it("runs sends to different targets in parallel (isolated chains)", async () => {
    const queue = makeQueue();
    const fnA = vi.fn(async () => {
      /* noop */
    });
    const fnB = vi.fn(async () => {
      /* noop */
    });

    queue.enqueue("target-a", fnA);
    queue.enqueue("target-b", fnB);

    // Both execute immediately since they target different keys
    await vi.advanceTimersByTimeAsync(0);

    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).toHaveBeenCalledTimes(1);
  });

  it("keeps chain alive when send function throws", async () => {
    const queue = makeQueue();
    const order: string[] = [];

    queue.enqueue("target-a", async () => {
      order.push("fail");
      throw new Error("send failed");
    });
    queue.enqueue("target-a", async () => {
      order.push("recover");
    });

    // First send fails
    await vi.advanceTimersByTimeAsync(0);
    // After inter-send delay, second still executes
    await vi.advanceTimersByTimeAsync(50);

    expect(order).toEqual(["fail", "recover"]);
  });

  it("pendingCount returns 1 for active target, 0 for idle target", () => {
    const queue = makeQueue();

    expect(queue.pendingCount("target-a")).toBe(0);

    queue.enqueue("target-a", async () => {
      /* noop */
    });
    expect(queue.pendingCount("target-a")).toBe(1);

    expect(queue.pendingCount("target-b")).toBe(0);
  });
});
