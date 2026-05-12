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
 *  Handles multiple known formats across models:
 *  1. Emoji-prefixed: "🔍 web_search: query" → "web_search"
 *  2. Bracket-prefixed: "[Tool: read_file] ..." → "read_file"
 *  3. Emoji-isolated: "🔍 read_file" → "read_file"
 *  4. Tool result prefix: "Tool web_search returned:" → "web_search"
 *  5. Bold tool name: "**web_search**" → "web_search" */
export function extractToolNameFromText(text?: string): string | null {
  if (!text) return null;
  // Format 1: Emoji + tool name (with optional colon)
  const emojiMatch = text.match(/^[\p{Emoji_Presentation}\p{Emoji}\u{2696}\u{1F3F9}]\s*([a-zA-Z_][a-zA-Z0-9_-]*)/u);
  if (emojiMatch) return emojiMatch[1];
  // Format 2: Bracket
  const bracketMatch = text.match(/^\[Tool:\s*([^\]\s]+)/);
  if (bracketMatch) return bracketMatch[1];
  // Format 4: Tool return text
  const returnMatch = text.match(/^Tool\s+([a-zA-Z_][a-zA-Z0-9_-]*)\s+returned/i);
  if (returnMatch) return returnMatch[1];
  // Format 5: Bold
  const boldMatch = text.match(/^\*\*([a-zA-Z_][a-zA-Z0-9_-]*)\*\*/);
  if (boldMatch) return boldMatch[1];
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

  let startSent = false;
  let elapsedTimer: ReturnType<typeof setInterval> | null = null;
  let elapsedSeconds = 0;

  return createTypingCallbacks({
    start: async () => {
      if (startSent) return;
      startSent = true;
      await sendStatus(params.statusCtx, "⏳ 处理中...");
      // Fallback periodic status — tool events don't reach our deliver callback,
      // so we show elapsed time to maintain user connection.
      elapsedTimer = setInterval(async () => {
        elapsedSeconds += 5;
        if (params.responseState.hasTextResponse) {
          if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
          return;
        }
        if (params.responseState.toolCount > 0) {
          return; // tool progress tracker handles this case
        }
        await sendStatus(params.statusCtx, `⏳ 处理中... ${elapsedSeconds}s`);
      }, 5000);
    },
    stop: async () => {
      if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
      if (params.responseState.hasTextResponse) return;
      const count = params.responseState.toolCount;
      const msg = count > 0 ? `✅ 完成 (${count} tools)` : "✅ 完成";
      await sendStatus(params.statusCtx, msg);
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
  /** Timestamp when the first tool started (ms since epoch). */
  toolStartTime: number | null;
  /** Number of tool deliveries recorded. */
  toolCount: number;
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
    toolCount: 0,
  };

  let lastSentText = "";

  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const recordTool = (toolText?: string): void => {
    clearTimer();
    const parsed = extractToolNameFromText(toolText);
    if (parsed) state.currentToolName = parsed;
    if (!state.toolStartTime) state.toolStartTime = Date.now();
    state.toolCount++;
  };

  const buildProgressText = (): string => {
    const elapsed = state.toolStartTime
      ? Math.round((Date.now() - state.toolStartTime) / 1000)
      : 0;
    if (state.currentToolName && state.toolCount > 0) {
      const extra = state.toolCount > 1 ? ` +${state.toolCount - 1} tools` : "";
      return `🔧 ${state.currentToolName}${extra} (${elapsed}s)`;
    }
    if (state.toolCount > 0) return `🔧 执行工具... (${elapsed}s)`;
    return `⏳ 处理中...`;
  };

  const scheduleProgress = (): void => {
    if (state.hasTextResponse || timer) return;

    timer = setTimeout(async () => {
      if (state.hasTextResponse) return;
      const label = buildProgressText();
      if (label === lastSentText) { timer = null; scheduleProgress(); return; }
      lastSentText = label;
      await sendStatus(statusCtx, label);
      timer = null;
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
