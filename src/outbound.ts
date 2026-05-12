import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import type { ChannelOutboundContext } from "openclaw/plugin-sdk/twitch";
import { getActiveQqClient } from "./adapter.js";
import { resolveDefaultQqAccountId, resolveQqAccount } from "./config.js";
import { getActiveNativeClient } from "./qq-native.js";
import { getQqRuntime } from "./runtime.js";
import type { ChannelOutboundTargetMode } from "./sdk-compat.js";
import { DEFAULT_ACCOUNT_ID, type OutboundDeliveryResult } from "./sdk-compat.js";
import { formatQqTarget, normalizeAllowEntry, parseQqTarget, type QQTarget } from "./targets.js";
import { sendQqMessage } from "./native-ob11-bridge.js";

/**
 * Safely convert a value to a QQ ID (positive integer).
 * Throws if the value is not a valid positive number.
 */
function safeQqId(value: string | number, fieldName: string): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0 || !Number.isInteger(num)) {
    throw new Error(`Invalid QQ ID for ${fieldName}: ${JSON.stringify(value)}`);
  }
  return num;
}

function normalizeAllowList(allowFrom: Array<string | number> | undefined): {
  list: string[];
  hasWildcard: boolean;
} {
  const raw = (allowFrom ?? []).map((entry) => String(entry).trim()).filter(Boolean);
  const hasWildcard = raw.includes("*");
  const list = raw
    .filter((entry) => entry !== "*")
    .map(normalizeAllowEntry)
    .filter(Boolean);
  return { list, hasWildcard };
}

function resolveOutboundTarget(params: {
  to?: string;
  allowFrom?: Array<string | number>;
  mode?: ChannelOutboundTargetMode;
}): { ok: true; target: QQTarget } | { ok: false; error: Error } {
  const trimmed = params.to?.trim() ?? "";
  const { list, hasWildcard } = normalizeAllowList(params.allowFrom);

  if (trimmed) {
    const parsed = parseQqTarget(trimmed);
    if (!parsed) {
      return { ok: false, error: new Error("Invalid QQ target") };
    }
    if (
      (params.mode === "implicit" || params.mode === "heartbeat") &&
      list.length > 0 &&
      !hasWildcard
    ) {
      const formatted = formatQqTarget(parsed);
      if (!list.includes(formatted)) {
        const fallback = parseQqTarget(list[0] ?? "");
        if (fallback) {
          return { ok: true, target: fallback };
        }
      }
    }
    return { ok: true, target: parsed };
  }

  if (list.length > 0) {
    const fallback = parseQqTarget(list[0] ?? "");
    if (fallback) {
      return { ok: true, target: fallback };
    }
  }

  return {
    ok: false,
    error: new Error("QQ outbound target is missing; set --to or channels.qq.allowFrom"),
  };
}

async function sendMessage(params: {
  ctx: ChannelOutboundContext;
  mediaUrl?: string;
}): Promise<OutboundDeliveryResult> {
  const { cfg, accountId, to, text, replyToId } = params.ctx;
  const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
  const account = resolveQqAccount({ cfg, accountId: resolvedAccountId });

  if (!account.enabled) {
    throw new Error(`QQ account disabled: ${account.accountId}`);
  }

  const allowFrom = [...(account.config.allowFrom ?? []), ...(account.config.groupAllowFrom ?? [])];
  const targetResult = resolveOutboundTarget({ to, allowFrom });
  if (!targetResult.ok) {
    throw targetResult.error;
  }

  const result = await sendQqMessage({
    account,
    target: targetResult.target,
    text: text ?? "",
    mediaUrl: params.mediaUrl,
    replyToId: replyToId ?? undefined,
  });

  return {
    channel: "qq",
    messageId: result.messageId,
    timestamp: Date.now(),
    chatId: result.chatId,
  };
}

export const qqOutbound: ChannelOutboundAdapter = {
  deliveryMode: "gateway",
  chunker: (text, limit) => {
    return getQqRuntime().channel.text.chunkMarkdownText(text, limit);
  },
  chunkerMode: "markdown",
  textChunkLimit: 4096,
  resolveTarget: ({ to, allowFrom, mode }) => {
    const result = resolveOutboundTarget({ to, allowFrom, mode });
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, to: formatQqTarget(result.target) };
  },
  sendText: async (ctx) => sendMessage({ ctx }),
  sendMedia: async (ctx) => sendMessage({ ctx, mediaUrl: ctx.mediaUrl }),
};

export async function editMessage(params: {
  cfg: { channels?: { qq?: unknown } };
  accountId?: string;
  messageId: string | number;
  newText: string;
}): Promise<void> {
  const resolvedAccountId =
    params.accountId ??
    resolveDefaultQqAccountId(params.cfg as Parameters<typeof resolveDefaultQqAccountId>[0]);

  // Try native client first, then OB11
  const nativeClient = getActiveNativeClient(resolvedAccountId);
  if (nativeClient) {
    // oicq doesn't have a direct edit API, but we can recall the message
    // For now, throw not supported
    throw new Error("Edit message is not supported via native oicq client");
  }

  const client = getActiveQqClient(resolvedAccountId);
  if (!client) {
    throw new Error(`QQ client not running for account ${resolvedAccountId}`);
  }
  const response = await client.sendAction("edit_msg", {
    message_id: params.messageId,
    new_text: params.newText,
  });
  if (response.status !== "ok" && response.retcode !== 0) {
    throw new Error(response.msg ?? `Failed to edit message: retcode=${response.retcode}`);
  }
}

export async function deleteQqMessage(params: {
  cfg: { channels?: { qq?: unknown } };
  accountId?: string;
  messageId: string | number;
}): Promise<void> {
  const resolvedAccountId =
    params.accountId ??
    resolveDefaultQqAccountId(params.cfg as Parameters<typeof resolveDefaultQqAccountId>[0]);

  // Try native client first, then OB11
  const nativeClient = getActiveNativeClient(resolvedAccountId);
  if (nativeClient) {
    await nativeClient.deleteMsg(safeQqId(params.messageId, "messageId"));
    return;
  }

  const client = getActiveQqClient(resolvedAccountId);
  if (!client) {
    throw new Error(`QQ client not running for account ${resolvedAccountId}`);
  }
  const response = await client.sendAction("delete_msg", { message_id: params.messageId });
  if (response.status !== "ok" && response.retcode !== 0) {
    throw new Error(response.msg ?? `Failed to delete message: retcode=${response.retcode}`);
  }
}

// Group management functions

export async function muteUser(params: {
  cfg: { channels?: { qq?: unknown } };
  accountId?: string;
  groupId: string;
  userId: string;
  duration: number; // seconds, 0 = unmute
}): Promise<void> {
  const resolvedAccountId =
    params.accountId ??
    resolveDefaultQqAccountId(params.cfg as Parameters<typeof resolveDefaultQqAccountId>[0]);

  // Try native client first, then OB11
  const nativeClient = getActiveNativeClient(resolvedAccountId);
  if (nativeClient) {
    await nativeClient.client.setGroupBan(
      safeQqId(params.groupId, "groupId"),
      safeQqId(params.userId, "userId"),
      params.duration,
    );
    return;
  }

  const client = getActiveQqClient(resolvedAccountId);
  if (!client) {
    throw new Error(`QQ client not running for account ${resolvedAccountId}`);
  }
  const response = await client.sendAction("set_group_ban", {
    group_id: safeQqId(params.groupId, "groupId"),
    user_id: safeQqId(params.userId, "userId"),
    duration: params.duration,
  });
  if (response.status !== "ok" && response.retcode !== 0) {
    throw new Error(response.msg ?? `Failed to mute user: retcode=${response.retcode}`);
  }
}

export async function kickUser(params: {
  cfg: { channels?: { qq?: unknown } };
  accountId?: string;
  groupId: string;
  userId: string;
  rejectAdd?: boolean;
}): Promise<void> {
  const resolvedAccountId =
    params.accountId ??
    resolveDefaultQqAccountId(params.cfg as Parameters<typeof resolveDefaultQqAccountId>[0]);

  // Try native client first, then OB11
  const nativeClient = getActiveNativeClient(resolvedAccountId);
  if (nativeClient) {
    await nativeClient.client.setGroupKick(
      safeQqId(params.groupId, "groupId"),
      safeQqId(params.userId, "userId"),
      params.rejectAdd ?? false,
    );
    return;
  }

  const client = getActiveQqClient(resolvedAccountId);
  if (!client) {
    throw new Error(`QQ client not running for account ${resolvedAccountId}`);
  }
  const response = await client.sendAction("set_group_kick", {
    group_id: safeQqId(params.groupId, "groupId"),
    user_id: safeQqId(params.userId, "userId"),
    reject_add_request: params.rejectAdd ?? false,
  });
  if (response.status !== "ok" && response.retcode !== 0) {
    throw new Error(response.msg ?? `Failed to kick user: retcode=${response.retcode}`);
  }
}

export async function setGroupName(params: {
  cfg: { channels?: { qq?: unknown } };
  accountId?: string;
  groupId: string;
  name: string;
}): Promise<void> {
  const resolvedAccountId =
    params.accountId ??
    resolveDefaultQqAccountId(params.cfg as Parameters<typeof resolveDefaultQqAccountId>[0]);

  // Try native client first, then OB11
  const nativeClient = getActiveNativeClient(resolvedAccountId);
  if (nativeClient) {
    await nativeClient.client.setGroupName(safeQqId(params.groupId, "groupId"), params.name);
    return;
  }

  const client = getActiveQqClient(resolvedAccountId);
  if (!client) {
    throw new Error(`QQ client not running for account ${resolvedAccountId}`);
  }
  const response = await client.sendAction("set_group_name", {
    group_id: safeQqId(params.groupId, "groupId"),
    group_name: params.name,
  });
  if (response.status !== "ok" && response.retcode !== 0) {
    throw new Error(response.msg ?? `Failed to set group name: retcode=${response.retcode}`);
  }
}

export async function setGroupCard(params: {
  cfg: { channels?: { qq?: unknown } };
  accountId?: string;
  groupId: string;
  userId: string;
  card: string;
}): Promise<void> {
  const resolvedAccountId =
    params.accountId ??
    resolveDefaultQqAccountId(params.cfg as Parameters<typeof resolveDefaultQqAccountId>[0]);

  // Try native client first, then OB11
  const nativeClient = getActiveNativeClient(resolvedAccountId);
  if (nativeClient) {
    await nativeClient.client.setGroupCard(
      safeQqId(params.groupId, "groupId"),
      safeQqId(params.userId, "userId"),
      params.card,
    );
    return;
  }

  const client = getActiveQqClient(resolvedAccountId);
  if (!client) {
    throw new Error(`QQ client not running for account ${resolvedAccountId}`);
  }
  const response = await client.sendAction("set_group_card", {
    group_id: safeQqId(params.groupId, "groupId"),
    user_id: safeQqId(params.userId, "userId"),
    card: params.card,
  });
  if (response.status !== "ok" && response.retcode !== 0) {
    throw new Error(response.msg ?? `Failed to set group card: retcode=${response.retcode}`);
  }
}

export async function setGroupWholeBan(params: {
  cfg: { channels?: { qq?: unknown } };
  accountId?: string;
  groupId: string;
  enable: boolean;
}): Promise<void> {
  const resolvedAccountId =
    params.accountId ??
    resolveDefaultQqAccountId(params.cfg as Parameters<typeof resolveDefaultQqAccountId>[0]);

  // Try native client first, then OB11
  const nativeClient = getActiveNativeClient(resolvedAccountId);
  if (nativeClient) {
    await nativeClient.client.setGroupWholeBan(safeQqId(params.groupId, "groupId"), params.enable);
    return;
  }

  const client = getActiveQqClient(resolvedAccountId);
  if (!client) {
    throw new Error(`QQ client not running for account ${resolvedAccountId}`);
  }
  const response = await client.sendAction("set_group_whole_ban", {
    group_id: safeQqId(params.groupId, "groupId"),
    enable: params.enable,
  });
  if (response.status !== "ok" && response.retcode !== 0) {
    throw new Error(response.msg ?? `Failed to set whole group ban: retcode=${response.retcode}`);
  }
}

// Reactions support

export async function addReaction(params: {
  cfg: { channels?: { qq?: unknown } };
  accountId?: string;
  messageId: string;
  emojiId: string;
}): Promise<void> {
  const resolvedAccountId =
    params.accountId ??
    resolveDefaultQqAccountId(params.cfg as Parameters<typeof resolveDefaultQqAccountId>[0]);

  // Try native client first, then OB11
  const nativeClient = getActiveNativeClient(resolvedAccountId);
  if (nativeClient) {
    await nativeClient.client.setMsgEmojiLike(
      safeQqId(params.messageId, "messageId"),
      params.emojiId,
    );
    return;
  }

  const client = getActiveQqClient(resolvedAccountId);
  if (!client) {
    throw new Error(`QQ client not running for account ${resolvedAccountId}`);
  }
  const response = await client.sendAction("set_msg_emoji_like", {
    message_id: safeQqId(params.messageId, "messageId"),
    emoji_id: params.emojiId,
  });
  if (response.status !== "ok" && response.retcode !== 0) {
    throw new Error(response.msg ?? `Failed to add reaction: retcode=${response.retcode}`);
  }
}

export async function removeReaction(params: {
  cfg: { channels?: { qq?: unknown } };
  accountId?: string;
  messageId: string;
  emojiId: string;
}): Promise<void> {
  const resolvedAccountId =
    params.accountId ??
    resolveDefaultQqAccountId(params.cfg as Parameters<typeof resolveDefaultQqAccountId>[0]);

  // Try native client first, then OB11
  const nativeClient = getActiveNativeClient(resolvedAccountId);
  if (nativeClient) {
    await nativeClient.client.setMsgEmojiLike(
      safeQqId(params.messageId, "messageId"),
      params.emojiId,
      false,
    );
    return;
  }

  const client = getActiveQqClient(resolvedAccountId);
  if (!client) {
    throw new Error(`QQ client not running for account ${resolvedAccountId}`);
  }
  const response = await client.sendAction("set_msg_emoji_like", {
    message_id: safeQqId(params.messageId, "messageId"),
    emoji_id: params.emojiId,
    set: false,
  });
  if (response.status !== "ok" && response.retcode !== 0) {
    throw new Error(response.msg ?? `Failed to remove reaction: retcode=${response.retcode}`);
  }
}

/** Send a sticker (QQ face/emoji). */
export async function sendSticker(params: {
  cfg: { channels?: { qq?: unknown } };
  accountId?: string;
  targetId: string;
  stickerId: string;
}): Promise<void> {
  const resolvedAccountId =
    params.accountId ??
    resolveDefaultQqAccountId(params.cfg as Parameters<typeof resolveDefaultQqAccountId>[0]);

  // Parse target to determine if group or private
  const target = parseQqTarget(params.targetId);
  if (!target) {
    throw new Error(`Invalid QQ target: ${params.targetId}`);
  }

  // Try native client first, then OB11
  const nativeClient = getActiveNativeClient(resolvedAccountId);
  if (nativeClient) {
    // oicq uses sendGroupMsg with CQ code for stickers
    const cqCode = `[CQ:sticker,id=${params.stickerId}]`;
    if (target.kind === "group") {
      await nativeClient.client.sendGroupMsg(safeQqId(target.id, "groupId"), cqCode);
    } else {
      await nativeClient.client.sendPrivateMsg(safeQqId(target.id, "userId"), cqCode);
    }
    return;
  }

  const client = getActiveQqClient(resolvedAccountId);
  if (!client) {
    throw new Error(`QQ client not running for account ${resolvedAccountId}`);
  }
  const response = await client.sendAction(
    target.kind === "group" ? "send_group_msg" : "send_private_msg",
    target.kind === "group"
      ? { group_id: safeQqId(target.id, "groupId"), message: `[CQ:sticker,id=${params.stickerId}]` }
      : { user_id: safeQqId(target.id, "userId"), message: `[CQ:sticker,id=${params.stickerId}]` },
  );
  if (response.status !== "ok" && response.retcode !== 0) {
    throw new Error(response.msg ?? `Failed to send sticker: retcode=${response.retcode}`);
  }
}
