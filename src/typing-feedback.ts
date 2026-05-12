import { createTypingCallbacks } from "openclaw/plugin-sdk/channel-reply-pipeline";
import { formatQqTarget, type QQTarget } from "./targets.js";
import type { ResolvedQQAccount } from "./types.js";

export const STATUS_PREFIX = "[Agent] ";

type StatusSink = (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;

export interface StatusContext {
  account: ResolvedQQAccount;
  target: QQTarget;
  sendQueue: ReturnType<typeof import("./message-queue.js").createSendQueue>;
  statusSink?: StatusSink;
}

/** Send a status message through the Phase 1 send pipeline (same queue + bridge). */
export async function sendStatus(ctx: StatusContext, text: string): Promise<void> {
  const { account, target, sendQueue, statusSink } = ctx;
  const targetKey = formatQqTarget(target);
  return new Promise<void>((resolve) => {
    sendQueue.enqueue(targetKey, async () => {
      try {
        const { sendQqMessage } = await import("./native-ob11-bridge.js");
        await sendQqMessage({
          account,
          target,
          text: `${STATUS_PREFIX}${text}`,
        });
        statusSink?.({ lastOutboundAt: Date.now() });
      } finally {
        resolve();
      }
    });
  });
}

/** Extract a tool name from payload text produced by the agent model.
 *  Handles two common formats:
 *  1. Emoji-prefixed: "🔍 web_search: query" → "web_search"
 *  2. Bracket-prefixed: "[Tool: read_file] ..." → "read_file" */
export function extractToolNameFromText(text?: string): string | null {
  if (!text) return null;
  // Emoji + tool name pattern (non-colon, non-whitespace word)
  const emojiMatch = text.match(/^[\p{Emoji}]\s*([^:\s]+)/u);
  if (emojiMatch) return emojiMatch[1];
  // Bracket fallback (capture word characters including _ and -)
  const bracketMatch = text.match(/^\[Tool:\s*([^\]\s]+)/);
  if (bracketMatch) return bracketMatch[1];
  return null;
}

/** Create DM-only typing callbacks for a dispatch context.
 *  Returns `undefined` for group chats (no status noise in groups per RESEARCH.md Pitfall 4). */
export function createDmTypingCallbacks(params: {
  isDm: boolean;
  statusCtx: StatusContext;
  responseState: ToolProgressState;
  runtime: { error?: (msg: string) => void };
}): ReturnType<typeof createTypingCallbacks> | undefined {
  if (!params.isDm) return undefined;

  return createTypingCallbacks({
    start: async () => {
      await sendStatus(params.statusCtx, "处理中...");
    },
    stop: async () => {
      // Send completion indicator only for tool-only responses
      // (when no block/final text was ever delivered to the user).
      // When the agent sends text, the text itself signals "done."
      if (!params.responseState.hasTextResponse) {
        await sendStatus(params.statusCtx, "已完成");
      }
    },
    onStartError: (err) => {
      params.runtime.error?.(`qq typing start failed: ${String(err)}`);
    },
    onStopError: (err) => {
      params.runtime.error?.(`qq typing stop failed: ${String(err)}`);
    },
    // No keepalive — OB11 has no native typing action and re-sending inline
    // messages would flood the chat with duplicate "[Agent] 处理中..." text.
    keepaliveIntervalMs: 0,
    // 2-minute safety TTL (QQ agent responses may involve long tool chains).
    maxDurationMs: 2 * 60_000,
  });
}

export interface ToolProgressState {
  /** Whether any block or final text has been delivered for this response. */
  hasTextResponse: boolean;
  /** The most recently seen tool name, or null if none parsed. */
  currentToolName: string | null;
  /** Timestamp when the current tool started (ms since epoch). */
  toolStartTime: number | null;
}

export interface ToolProgressTracker {
  /** Record a tool delivery event. Resets timer on each call. */
  recordTool: (toolText?: string) => void;
  /** Schedule a progress update. No-ops if text already delivered or timer already pending. */
  scheduleProgress: () => void;
  /** Reset the progress timer (called when text arrives). Sets hasTextResponse=true. */
  resetProgress: () => void;
  /** Access current state for external inspection (used by typing stop callback). */
  getState: () => Readonly<ToolProgressState>;
  /** Cancel pending timer and clean up. */
  cleanup: () => void;
}

export function createToolProgressTracker(params: {
  statusCtx: StatusContext;
  intervalMs?: number;
}): ToolProgressTracker {
  const intervalMs = params.intervalMs ?? 15_000;
  const statusCtx = params.statusCtx;

  const state: ToolProgressState = {
    hasTextResponse: false,
    currentToolName: null,
    toolStartTime: null,
  };

  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const recordTool = (toolText?: string): void => {
    // Reset timer on every tool event to prevent stale progress messages
    // when tools execute in rapid succession (per RESEARCH.md Pitfall 3).
    clearTimer();
    state.toolStartTime = Date.now();
    state.currentToolName = extractToolNameFromText(toolText) ?? state.currentToolName;
  };

  const scheduleProgress = (): void => {
    if (state.hasTextResponse || timer) return;

    timer = setTimeout(async () => {
      if (state.hasTextResponse) return;

      const elapsed = state.toolStartTime
        ? Math.round((Date.now() - state.toolStartTime) / 1000)
        : 0;
      const label = state.currentToolName
        ? `运行: ${state.currentToolName} (${elapsed}s)`
        : `工作中... (${elapsed}s)`;

      await sendStatus(statusCtx, label);
      timer = null;

      // Re-schedule if still waiting (for very long tool executions)
      scheduleProgress();
    }, intervalMs);
  };

  const resetProgress = (): void => {
    clearTimer();
    state.hasTextResponse = true;
  };

  return {
    recordTool,
    scheduleProgress,
    resetProgress,
    getState: () => state,
    cleanup: clearTimer,
  };
}
