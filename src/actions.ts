import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk";
import { jsonResult, readNumberParam, readStringParam } from "./sdk-compat.js";
import { listEnabledQqAccounts } from "./config.js";
import {
  addReaction,
  deleteQqMessage,
  editMessage,
  kickUser,
  muteUser,
  removeReaction,
  sendSticker,
  setGroupName,
  setGroupWholeBan,
} from "./outbound.js";

function resolveDurationSeconds(params: Record<string, unknown>): number {
  const direct = readNumberParam(params, "durationSeconds", { integer: true });
  if (direct !== undefined) {
    return Math.max(0, direct);
  }
  const fallback = readNumberParam(params, "duration", { integer: true });
  if (fallback !== undefined) {
    return Math.max(0, fallback);
  }
  const minutes = readNumberParam(params, "durationMinutes", { integer: true });
  if (minutes !== undefined) {
    return Math.max(0, minutes) * 60;
  }
  throw new Error("durationSeconds (or duration/durationMinutes) required");
}

function readBooleanValue(params: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
      if (normalized === "false" || normalized === "0" || normalized === "no") return false;
    }
  }
  return undefined;
}

type DescribeParams = Parameters<NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>>[0];

function describeQqMessageTool({ cfg }: DescribeParams) {
  const hasConfiguredAccount = listEnabledQqAccounts(cfg).some((account) => account.configured);
  if (!hasConfiguredAccount) {
    return { actions: [], capabilities: [], schema: null };
  }
  return {
    actions: ["send", "react", "delete", "edit", "sticker", "timeout", "kick", "ban", "renameGroup", "permissions"] as const,
    capabilities: [] as const,
    schema: null,
  };
}

// Standalone action handler function
async function handleQqActionImpl(
  action: string,
  params: Record<string, unknown>,
  cfg: Record<string, unknown>,
  accountId: string | undefined,
) {
  if (action === "send") {
    throw new Error("Send should be handled by outbound, not actions handler.");
  }

  if (action === "react") {
    const messageId = readStringParam(params, "messageId", { required: true })!;
    const emojiId: string =
      readStringParam(params, "emoji") ??
      readStringParam(params, "emojiId", { required: true })!;
    const remove = params.remove === true;
    const qqCfg = cfg as { channels?: { qq?: unknown } };
    if (remove) {
      await removeReaction({ cfg: qqCfg, accountId: accountId ?? undefined, messageId, emojiId });
      return { ok: true, removed: emojiId };
    }
    await addReaction({ cfg: qqCfg, accountId: accountId ?? undefined, messageId, emojiId });
    return { ok: true, added: emojiId };
  }

  if (action === "delete") {
    const messageId = readStringParam(params, "messageId", { required: true })!;
    await deleteQqMessage({ cfg: cfg as { channels?: { qq?: unknown } }, accountId: accountId ?? undefined, messageId });
    return { ok: true, action: "delete", messageId };
  }

  if (action === "edit") {
    const messageId = readStringParam(params, "messageId", { required: true })!;
    const newText = readStringParam(params, "text", { required: true }) ?? readStringParam(params, "newText", { required: true })!;
    await editMessage({
      cfg: cfg as { channels?: { qq?: unknown } },
      accountId: accountId ?? undefined,
      messageId,
      newText,
    });
    return { ok: true, action: "edit", messageId };
  }

  if (action === "sticker") {
    const stickerId = readStringParam(params, "stickerId", { required: true })!;
    // targetId with "group:" or "g:" prefix = group, otherwise private
    const rawTargetId = readStringParam(params, "targetId", { required: true }) ?? readStringParam(params, "groupId") ?? readStringParam(params, "userId", { required: true })!;
    // If the raw value came from groupId and has no prefix, add one
    const targetId = (params.groupId !== undefined && !rawTargetId.startsWith("group:") && !rawTargetId.startsWith("g:") && !rawTargetId.startsWith("user:"))
      ? `group:${rawTargetId}`
      : rawTargetId;
    await sendSticker({
      cfg: cfg as { channels?: { qq?: unknown } },
      accountId: accountId ?? undefined,
      targetId,
      stickerId,
    });
    return { ok: true, action: "sticker", stickerId, targetId };
  }

  if (action === "timeout") {
    const groupId = readStringParam(params, "groupId", { required: true })!;
    const userId = readStringParam(params, "userId", { required: true })!;
    const duration = resolveDurationSeconds(params);
    await muteUser({
      cfg: cfg as { channels?: { qq?: unknown } },
      accountId: accountId ?? undefined,
      groupId,
      userId,
      duration,
    });
    return { ok: true, action: "timeout", duration };
  }

  if (action === "kick" || action === "ban") {
    const groupId = readStringParam(params, "groupId", { required: true })!;
    const userId = readStringParam(params, "userId", { required: true })!;
    const rejectAdd = action === "ban" ? true : params.rejectAdd === true;
    await kickUser({
      cfg: cfg as { channels?: { qq?: unknown } },
      accountId: accountId ?? undefined,
      groupId,
      userId,
      rejectAdd,
    });
    return { ok: true, action, rejectAdd };
  }

  if (action === "renameGroup") {
    const groupId = readStringParam(params, "groupId", { required: true })!;
    const name: string =
      readStringParam(params, "name") ??
      readStringParam(params, "groupName", { required: true })!;
    await setGroupName({
      cfg: cfg as { channels?: { qq?: unknown } },
      accountId: accountId ?? undefined,
      groupId,
      name,
    });
    return { ok: true, action, groupId, name };
  }

  if (action === "permissions") {
    const groupId = readStringParam(params, "groupId", { required: true })!;
    const shouldApply =
      readBooleanValue(params, "apply", "set", "mutate", "write") ?? false;
    const enable = readBooleanValue(params, "enable", "wholeBan", "muteAll");
    if (!shouldApply) {
      return {
        ok: true,
        action,
        groupId,
        mode: "inspect",
        writable: true,
        supportedUpdates: ["wholeBan"],
        hint: "Set apply=true and enable=true|false to update QQ whole-group mute.",
      };
    }
    if (enable === undefined) {
      throw new Error("permissions apply requires enable=true|false");
    }
    await setGroupWholeBan({
      cfg: cfg as { channels?: { qq?: unknown } },
      accountId: accountId ?? undefined,
      groupId,
      enable,
    });
    return { ok: true, action, groupId, mode: "update", enable };
  }

  throw new Error(`Action ${action} not supported for qq.`);
}

// Wrapper that converts result to AgentToolResult
async function handleQqAction(
  action: string,
  params: Record<string, unknown>,
  cfg: Record<string, unknown>,
  accountId: string | undefined,
) {
  const result = await handleQqActionImpl(action, params, cfg, accountId);
  return jsonResult(result);
}

export const qqMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: describeQqMessageTool,
  supportsAction: ({ action }) => action !== "send" && action !== "broadcast",
  handleAction: async ({ action, params, cfg, accountId }) => {
    const result = await handleQqActionImpl(action, params, cfg, accountId ?? undefined);
    return jsonResult(result) as unknown as ReturnType<NonNullable<ChannelMessageActionAdapter["handleAction"]>>;
  },
};
