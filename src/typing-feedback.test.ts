import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock native-ob11-bridge — intercepts both static and dynamic imports
vi.mock("./native-ob11-bridge.js", () => ({
  sendQqMessage: vi.fn(),
}));

// Mock message-queue — provide controllable mock
const mockEnqueueFn = vi.fn();
vi.mock("./message-queue.js", () => ({
  createSendQueue: vi.fn(() => ({
    enqueue: mockEnqueueFn,
    pendingCount: vi.fn(() => 0),
  })),
}));

import { sendQqMessage } from "./native-ob11-bridge.js";
import {
  sendStatus,
  extractToolNameFromText,
  createDmTypingCallbacks,
  createToolProgressTracker,
  STATUS_PREFIX,
} from "./typing-feedback.js";

const mockSendQqMessage = vi.mocked(sendQqMessage);

function makeStatusContext(overrides: Partial<{
  account: Parameters<typeof sendStatus>[0]["account"];
  target: Parameters<typeof sendStatus>[0]["target"];
  sendQueue: Parameters<typeof sendStatus>[0]["sendQueue"];
  statusSink: Parameters<typeof sendStatus>[0]["statusSink"];
}> = {}) {
  return {
    account: overrides.account ?? {
      accountId: "test-account",
      enabled: true,
      config: {},
    } as Parameters<typeof sendStatus>[0]["account"],
    target: overrides.target ?? { kind: "private" as const, id: "10001" },
    sendQueue: overrides.sendQueue ?? {
      enqueue: vi.fn(async (_key: string, fn: () => Promise<void>) => {
        await fn();
      }),
      pendingCount: vi.fn(() => 0),
    },
    statusSink: overrides.statusSink,
  };
}

describe("STATUS_PREFIX", () => {
  it("is '[Agent] '", () => {
    expect(STATUS_PREFIX).toBe("[Agent] ");
  });
});

describe("sendStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendQqMessage.mockResolvedValue({ messageId: "1", chatId: "test" });
  });

  it("enqueues into the given queue and calls sendQqMessage with [Agent] prefix", async () => {
    const sendQueue = {
      enqueue: vi.fn(async (_key: string, fn: () => Promise<void>) => {
        await fn();
      }),
      pendingCount: vi.fn(() => 0),
    };
    const ctx = makeStatusContext({ sendQueue });

    await sendStatus(ctx, "⏳ 处理中...");

    // Verify enqueue was called with the target key
    expect(sendQueue.enqueue).toHaveBeenCalledTimes(1);
    // Verify sendQqMessage was called with "[Agent] " prefix
    expect(mockSendQqMessage).toHaveBeenCalledTimes(1);
    expect(mockSendQqMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "[Agent] ⏳ 处理中..." }),
    );
  });

  it("does NOT pass replyToId (status messages are standalone)", async () => {
    const sendQueue = {
      enqueue: vi.fn(async (_key: string, fn: () => Promise<void>) => {
        await fn();
      }),
      pendingCount: vi.fn(() => 0),
    };
    const ctx = makeStatusContext({ sendQueue });

    await sendStatus(ctx, "test");

    const callArgs = mockSendQqMessage.mock.calls[0][0];
    expect(callArgs).not.toHaveProperty("replyToId");
  });

  it("routes through sendQueue.enqueue with formatQqTarget(target) as targetKey", async () => {
    const sendQueue = {
      enqueue: vi.fn(async (_key: string, fn: () => Promise<void>) => {
        await fn();
      }),
      pendingCount: vi.fn(() => 0),
    };
    const ctx = makeStatusContext({
      sendQueue,
      target: { kind: "private", id: "user-xyz" },
    });

    await sendStatus(ctx, "hello");

    expect(sendQueue.enqueue).toHaveBeenCalledWith("user-xyz", expect.any(Function));
  });

  it("routes group targets with 'group:' prefix as targetKey", async () => {
    const sendQueue = {
      enqueue: vi.fn(async (_key: string, fn: () => Promise<void>) => {
        await fn();
      }),
      pendingCount: vi.fn(() => 0),
    };
    const ctx = makeStatusContext({
      sendQueue,
      target: { kind: "group", id: "g123" },
    });

    await sendStatus(ctx, "hello");

    expect(sendQueue.enqueue).toHaveBeenCalledWith("group:g123", expect.any(Function));
  });

  it("calls statusSink with lastOutboundAt after sending", async () => {
    const statusSink = vi.fn();
    const sendQueue = {
      enqueue: vi.fn(async (_key: string, fn: () => Promise<void>) => {
        await fn();
      }),
      pendingCount: vi.fn(() => 0),
    };
    const ctx = makeStatusContext({ sendQueue, statusSink });

    await sendStatus(ctx, "done");

    expect(statusSink).toHaveBeenCalledTimes(1);
    expect(statusSink).toHaveBeenCalledWith({ lastOutboundAt: expect.any(Number) });
  });
});

describe("extractToolNameFromText", () => {
  it('returns "web_search" from text with emoji prefix', () => {
    expect(extractToolNameFromText("🔍 web_search: query")).toBe("web_search");
  });

  it("returns null for undefined input", () => {
    expect(extractToolNameFromText(undefined)).toBeNull();
  });

  it("returns null for empty string input", () => {
    expect(extractToolNameFromText("")).toBeNull();
  });

  it('handles fallback "[Tool: X]" pattern', () => {
    expect(extractToolNameFromText("[Tool: read_file] content")).toBe("read_file");
  });

  it("returns the first non-whitespace token after emoji", () => {
    expect(extractToolNameFromText("📁 read: path/to/file")).toBe("read");
  });

  it("returns null for text without recognizable tool pattern", () => {
    expect(extractToolNameFromText("Hello world")).toBeNull();
  });
});

describe("createDmTypingCallbacks", () => {
  const makeParams = (isDm: boolean, responseStateOverrides: Partial<{
    hasTextResponse: boolean;
    currentToolName: string | null;
    toolStartTime: number | null;
  }> = {}) => ({
    isDm,
    statusCtx: makeStatusContext(),
    responseState: {
      hasTextResponse: responseStateOverrides.hasTextResponse ?? false,
      currentToolName: responseStateOverrides.currentToolName ?? null,
      toolStartTime: responseStateOverrides.toolStartTime ?? null,
    },
    runtime: { error: vi.fn() },
  });

  it("returns undefined for group chats (isDm=false)", () => {
    const callbacks = createDmTypingCallbacks(makeParams(false));
    expect(callbacks).toBeUndefined();
  });

  it("returns callbacks for DM chats (isDm=true)", () => {
    const callbacks = createDmTypingCallbacks(makeParams(true));
    expect(callbacks).toBeDefined();
    expect(callbacks).toHaveProperty("onReplyStart");
    expect(typeof callbacks!.onReplyStart).toBe("function");
    expect(callbacks).toHaveProperty("onIdle");
    expect(typeof callbacks!.onIdle).toBe("function");
  });

  it("calls sendStatus with '处理中...' when onReplyStart fires", async () => {
    const callbacks = createDmTypingCallbacks(makeParams(true));
    expect(callbacks).toBeDefined();

    await callbacks!.onReplyStart();

    expect(mockSendQqMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "[Agent] ⏳ 处理中..." }),
    );
  });

  it("sends completion indicator when stop fires with hasTextResponse=false (tool-only response)", async () => {
    vi.useFakeTimers();
    const callbacks = createDmTypingCallbacks(
      makeParams(true, { hasTextResponse: false }),
    );
    expect(callbacks).toBeDefined();

    void callbacks!.onIdle!();

    // Flush microtasks so the fire-and-forget stop() completes
    await vi.runAllTimersAsync();

    expect(mockSendQqMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "[Agent] ✅ 完成" }),
    );
    vi.useRealTimers();
  });

  it("does NOT send completion when hasTextResponse=true (text was delivered)", async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    const callbacks = createDmTypingCallbacks(
      makeParams(true, { hasTextResponse: true }),
    );
    expect(callbacks).toBeDefined();

    void callbacks!.onIdle!();

    // Flush microtasks
    await vi.runAllTimersAsync();

    // Should not have sent completion since text was already delivered
    expect(mockSendQqMessage).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("createToolProgressTracker", () => {
  const makeTrackerParams = (overrides: Partial<{
    statusCtx: Parameters<typeof createToolProgressTracker>[0]["statusCtx"];
    intervalMs: number;
  }> = {}) => {
    const sendQueue = {
      enqueue: vi.fn(async (_key: string, fn: () => Promise<void>) => {
        await fn();
      }),
      pendingCount: vi.fn(() => 0),
    };
    return {
      statusCtx: overrides.statusCtx ?? makeStatusContext({ sendQueue }),
      intervalMs: overrides.intervalMs ?? 100, // short interval for fast tests
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendQqMessage.mockResolvedValue({ messageId: "1", chatId: "test" });
  });

  it("recordTool on first tool event sets start time and tool name", () => {
    const tracker = createToolProgressTracker(makeTrackerParams());

    tracker.recordTool("🔍 web_search: query");

    const state = tracker.getState();
    expect(state.currentToolName).toBe("web_search");
    expect(state.toolStartTime).toBeGreaterThan(0);
    expect(state.hasTextResponse).toBe(false);
  });

  it("fires status update after interval without text", async () => {
    vi.useFakeTimers();
    const params = makeTrackerParams({ intervalMs: 1000 });
    const tracker = createToolProgressTracker(params);

    tracker.recordTool("📁 read: file.ts");
    tracker.scheduleProgress();

    // Advance time past the interval
    await vi.advanceTimersByTimeAsync(1000);
    // Flush microtasks after setTimeout callback fires
    await Promise.resolve();

    expect(mockSendQqMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("🔧 read"),
      }),
    );
    vi.useRealTimers();
  });

  it("resetProgress on block delivery clears timer and sets hasTextResponse=true", () => {
    vi.useFakeTimers();
    const params = makeTrackerParams({ intervalMs: 1000 });
    const tracker = createToolProgressTracker(params);

    tracker.recordTool("some tool");
    tracker.scheduleProgress();

    // Before timer fires, reset progress (simulating text arrival)
    tracker.resetProgress();

    const state = tracker.getState();
    expect(state.hasTextResponse).toBe(true);

    // Advance time — status should NOT be sent because hasTextResponse is true
    vi.advanceTimersByTime(1100);
    expect(mockSendQqMessage).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("subsequent tool events reset timer to prevent stale status", async () => {
    vi.useFakeTimers();
    const params = makeTrackerParams({ intervalMs: 1000 });
    const tracker = createToolProgressTracker(params);

    tracker.recordTool("🔍 tool-a: first");
    tracker.scheduleProgress();

    // Advance 500ms, then record a new tool (should reset timer)
    vi.advanceTimersByTime(500);
    tracker.recordTool("🔍 tool-b: second");
    tracker.scheduleProgress();

    // Advance past the first timer's deadline (should NOT fire yet)
    vi.advanceTimersByTime(600);
    // Only 600ms passed since tool-b started, so no status yet
    // Let's check state reflects the new tool
    expect(tracker.getState().currentToolName).toBe("tool-b");
    expect(mockSendQqMessage).not.toHaveBeenCalled();

    // Advance past full interval from tool-b
    await vi.advanceTimersByTimeAsync(500);
    expect(mockSendQqMessage).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("does NOT fire status after text has been delivered (hasTextResponse blocks scheduling)", () => {
    const tracker = createToolProgressTracker(makeTrackerParams());
    tracker.resetProgress(); // Set hasTextResponse = true

    // After reset, schedule should be a no-op
    tracker.scheduleProgress(); // Should return early

    // No enqueue should have been called
    // The scheduleProgress no-ops early, so the sendQueue.enqueue is never reached
    // We can verify by checking sendQqMessage wasn't called
    expect(mockSendQqMessage).not.toHaveBeenCalled();
  });

  it("cleanup cancels pending timer and prevents status", () => {
    vi.useFakeTimers();
    const params = makeTrackerParams({ intervalMs: 1000 });
    const tracker = createToolProgressTracker(params);

    tracker.recordTool("tool-x");
    tracker.scheduleProgress();

    // Clean up before timer fires
    tracker.cleanup();

    // Advance past the interval — nothing should fire
    vi.advanceTimersByTime(1100);
    expect(mockSendQqMessage).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
