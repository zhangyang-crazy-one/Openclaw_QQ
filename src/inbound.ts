import {
  logInboundDrop,
  mergeAllowlist,
  resolveControlCommandGate,
  resolveMentionGatingWithBypass,
  type OpenClawConfig,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import type { OB11Event, ResolvedQQAccount } from "./types.js";
import { getActiveQqClient } from "./adapter.js";
import { resolveGroupConfig } from "./config.js";
import { parseOb11Message, hasSelfMention } from "./message-utils.js";
import { getQqRuntime } from "./runtime.js";
import { rememberSelfSentResponse, wasSelfSentMessage } from "./self-sent.js";
import { sendOb11Message } from "./send.js";
import { formatQqTarget, normalizeAllowEntry, type QQTarget } from "./targets.js";

const CHANNEL_ID = "qq" as const;

type StatusSink = (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;

type Allowlist = {
  list: string[];
  hasWildcard: boolean;
  configured: boolean;
};

function normalizeAllowList(entries?: Array<string | number>): Allowlist {
  const raw = (entries ?? []).map((entry) => String(entry).trim()).filter(Boolean);
  const hasWildcard = raw.includes("*");
  const list = raw
    .filter((entry) => entry !== "*")
    .map(normalizeAllowEntry)
    .filter(Boolean);
  return { list, hasWildcard, configured: list.length > 0 || hasWildcard };
}

function isAllowed(allowlist: Allowlist, id: string): boolean {
  if (allowlist.hasWildcard) return true;
  return allowlist.list.includes(id);
}

function buildTarget(params: {
  isGroup: boolean;
  senderId: string;
  groupId?: string;
}): QQTarget | null {
  if (params.isGroup) {
    if (!params.groupId) return null;
    return { kind: "group", id: params.groupId };
  }
  return { kind: "private", id: params.senderId };
}

export async function handleOb11Event(params: {
  event: OB11Event;
  account: ResolvedQQAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  statusSink?: StatusSink;
}): Promise<void> {
  const { event, account, config, runtime, statusSink } = params;

  try {
    const postType = String(event.post_type ?? "").toLowerCase();
    if (postType !== "message" && postType !== "message_sent") {
      return;
    }
    const subType = String(event.sub_type ?? "").toLowerCase();
    if (
      postType === "message" &&
      subType === "offline" &&
      !account.connection?.reportOfflineMessage
    ) {
      return;
    }

    const messageType = String(event.message_type ?? "").toLowerCase();
    const isGroup = messageType === "group";
    const senderId = event.user_id != null ? String(event.user_id) : "";
    if (!senderId) {
      return;
    }

    const groupId = event.group_id != null ? String(event.group_id) : undefined;
    const target = buildTarget({ isGroup, senderId, groupId });
    if (!target) {
      return;
    }
    const groupConfig = isGroup ? resolveGroupConfig(account.config, groupId ?? "") : null;

    if (postType === "message_sent" && !account.connection?.reportSelfMessage) {
      return;
    }
    const parsed = parseOb11Message(event.message ?? event.raw_message);
    const rawBody = parsed.text.trim();

    // Check if message has any content (text or attachments)
    const hasTextContent = rawBody.length > 0;
    const hasMediaContent = (event.message && Array.isArray(event.message))
      ? event.message.some(
          (seg) =>
            seg.type === "image" ||
            seg.type === "video" ||
            seg.type === "record" ||
            seg.type === "file",
        )
      : false;

    if (!hasTextContent && !hasMediaContent) {
      return;
    }

    if (postType === "message_sent") {
      const messageId = event.message_id != null ? String(event.message_id) : undefined;
      if (
        wasSelfSentMessage({
          accountId: account.accountId,
          messageId,
          target: formatQqTarget(target),
          text: rawBody,
        })
      ) {
        return;
      }
    }

    const core = getQqRuntime();

    const selfId = event.self_id != null ? String(event.self_id) : undefined;
    const wasMentioned = isGroup ? hasSelfMention(parsed.mentions, selfId) : false;
    const timestamp = typeof event.time === "number" ? event.time * 1000 : Date.now();

    statusSink?.({ lastInboundAt: timestamp });

    const dmPolicy = account.config.dmPolicy ?? "pairing";
    const defaultGroupPolicy = config.channels?.defaults?.groupPolicy;
    const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";

    const configGroupAllowFrom = normalizeAllowList(account.config.groupAllowFrom);
    const storeAllowFrom = (core.channel?.pairing)
      ? await core.channel.pairing.readAllowFromStore(CHANNEL_ID).catch(() => [])
      : [];

    const effectiveAllowFrom = normalizeAllowList(
      mergeAllowlist({ existing: account.config.allowFrom, additions: storeAllowFrom }),
    );

    const allowTextCommands = core.channel?.commands?.shouldHandleTextCommands({
      cfg: config as OpenClawConfig,
      surface: CHANNEL_ID,
    }) ?? false;
    const useAccessGroups = config.commands?.useAccessGroups !== false;
    const senderAllowedForCommands = isAllowed(
      isGroup ? configGroupAllowFrom : effectiveAllowFrom,
      isGroup ? `group:${groupId ?? ""}` : senderId,
    );
    const hasControlCommand = core.channel?.text?.hasControlCommand(rawBody, config as OpenClawConfig) ?? false;
    const commandGate = resolveControlCommandGate({
      useAccessGroups,
      authorizers: [
        {
          configured: (isGroup ? configGroupAllowFrom : effectiveAllowFrom).configured,
          allowed: senderAllowedForCommands,
        },
      ],
      allowTextCommands,
      hasControlCommand,
    });
    const commandAuthorized = commandGate.commandAuthorized;

    if (isGroup) {
      if (!groupConfig?.enabled) {
        runtime.log?.(`qq: drop group ${groupId ?? ""} (group disabled in config)`);
        return;
      }
      if (groupPolicy === "disabled") {
        runtime.log?.(`qq: drop group ${groupId ?? ""} (groupPolicy=disabled)`);
        return;
      }
      if (groupPolicy === "allowlist") {
        const groupKey = `group:${groupId ?? ""}`;
        if (!isAllowed(configGroupAllowFrom, groupKey)) {
          runtime.log?.(`qq: drop group ${groupId ?? ""} (not allowlisted)`);
          return;
        }
      }

      if (commandGate.shouldBlock) {
        logInboundDrop({
          log: (message) => runtime.log?.(message),
          channel: CHANNEL_ID,
          reason: "control command (unauthorized)",
          target: senderId,
        });
        return;
      }

      const requireMention = groupConfig?.requireMention ?? true;
      const mentionGate = resolveMentionGatingWithBypass({
        isGroup,
        requireMention,
        wasMentioned,
        allowTextCommands,
        hasControlCommand,
        commandAuthorized,
      });
      if (mentionGate.shouldSkip) {
        runtime.log?.(`qq: drop group ${groupId ?? ""} (no mention)`);
        return;
      }
    } else {
      if (dmPolicy === "disabled") {
        runtime.log?.(`qq: drop DM sender=${senderId} (dmPolicy=disabled)`);
        return;
      }
      const senderAllowed = isAllowed(effectiveAllowFrom, senderId);
      if (dmPolicy !== "open" && !senderAllowed) {
        if (dmPolicy === "pairing" && core.channel?.pairing) {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: CHANNEL_ID,
            id: senderId,
            meta: { name: event.sender?.nickname ?? undefined },
          });
          if (created) {
            try {
              const client = getActiveQqClient(account.accountId);
              if (client) {
                const pairingText = core.channel?.pairing?.buildPairingReply({
                  channel: CHANNEL_ID,
                  idLine: `Your QQ user id: ${senderId}`,
                  code,
                }) ?? "";
                const response = await sendOb11Message({
                  client,
                  target,
                  text: pairingText,
                });
                rememberSelfSentResponse({
                  accountId: account.accountId,
                  response,
                  target: formatQqTarget(target),
                  text: pairingText,
                });
                statusSink?.({ lastOutboundAt: Date.now() });
              }
            } catch (err) {
              runtime.error?.(`qq: pairing reply failed for ${senderId}: ${String(err)}`);
            }
          }
        }
        runtime.log?.(`qq: drop DM sender=${senderId} (dmPolicy=${dmPolicy})`);
        return;
      }
    }

    const route = core.channel?.routing?.resolveAgentRoute({
      cfg: config as OpenClawConfig,
      channel: CHANNEL_ID,
      accountId: account.accountId,
      peer: {
        kind: isGroup ? "group" : "dm",
        id: isGroup ? (groupId ?? senderId) : senderId,
      },
    }) ?? { agentId: "default", sessionKey: "" };
    const effectiveAgentId = groupConfig?.agentId ?? route.agentId;

    const senderName = event.sender?.card?.trim() || event.sender?.nickname?.trim() || undefined;
    const fromLabel = isGroup ? `group:${groupId ?? ""}` : senderName || `user:${senderId}`;

    const storePath = core.channel?.session?.resolveStorePath(config.session?.store, {
      agentId: effectiveAgentId,
    }) ?? "";
    const envelopeOptions = core.channel?.reply?.resolveEnvelopeFormatOptions(config as OpenClawConfig) ?? {};
    const previousTimestamp = core.channel?.session?.readSessionUpdatedAt({
      storePath,
      sessionKey: route.sessionKey,
    }) ?? Date.now();

    // Extract media URLs from message segments
    let mediaInfo = "";
    const mediaUrls: string[] = [];
    if (event.message && Array.isArray(event.message)) {
      for (const seg of event.message) {
        if (seg.type === "image") {
          const url = seg.data?.url || seg.data?.file;
          if (url) {
            mediaUrls.push(url);
            mediaInfo += `[Image: ${url}]\n`;
          }
        }
        if (seg.type === "video") {
          const url = seg.data?.url || seg.data?.file;
          if (url) {
            mediaUrls.push(url);
            mediaInfo += `[Video: ${url}]\n`;
          }
        }
        if (seg.type === "record") {
          const url = seg.data?.url || seg.data?.file;
          if (url) {
            mediaUrls.push(url);
            mediaInfo += `[Voice: ${url}]\n`;
          }
        }
        if (seg.type === "file") {
          const url = seg.data?.url || seg.data?.file;
          if (url) {
            mediaUrls.push(url);
            const fileName = seg.data?.name || seg.data?.file || "file";
            mediaInfo += `[File: ${fileName}]\n`;
          }
        }
      }
    }

    // Combine text body with media info
    const fullBody = rawBody ? (rawBody + "\n" + mediaInfo).trim() : mediaInfo.trim();

    const body = core.channel?.reply?.formatAgentEnvelope({
      channel: "QQ",
      from: fromLabel,
      timestamp,
      previousTimestamp,
      envelope: envelopeOptions,
      body: rawBody,
    }) ?? rawBody;

    const ctxPayload = core.channel?.reply?.finalizeInboundContext({
      Body: body,
      BodyForAgent: fullBody,
      RawBody: fullBody,
      CommandBody: fullBody,
      From: isGroup ? `qq:group:${groupId ?? ""}` : `qq:${senderId}`,
      To: `qq:${formatQqTarget(target)}`,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isGroup ? "group" : "direct",
      ConversationLabel: fromLabel,
      SenderName: senderName,
      SenderId: senderId,
      GroupSubject: isGroup ? (groupId ?? undefined) : undefined,
      Provider: CHANNEL_ID,
      Surface: CHANNEL_ID,
      WasMentioned: isGroup ? wasMentioned : undefined,
      MessageSid: event.message_id != null ? String(event.message_id) : undefined,
      Timestamp: timestamp,
      OriginatingChannel: CHANNEL_ID,
      OriginatingTo: `qq:${formatQqTarget(target)}`,
      CommandAuthorized: commandAuthorized,
      MediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
    });

    if (!ctxPayload) {
      return;
    }

    await core.channel?.session?.recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      onRecordError: (err) => {
        runtime.error?.(`qq: failed updating session meta: ${String(err)}`);
      },
    });

    await core.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: config as OpenClawConfig,
      dispatcherOptions: {
        deliver: async (payload) => {
          try {
            const mediaUrl = payload.mediaUrl ?? payload.mediaUrls?.[0];
            const client = getActiveQqClient(account.accountId);
            if (!client) {
              throw new Error(`QQ client not running for account ${account.accountId}`);
            }
            const response = await sendOb11Message({
              client,
              target,
              text: payload.text ?? "",
              replyToId: payload.replyToId,
              mediaUrl,
            });
            rememberSelfSentResponse({
              accountId: account.accountId,
              response,
              target: formatQqTarget(target),
              text: payload.text ?? "",
            });
            statusSink?.({ lastOutboundAt: Date.now() });
          } catch (err) {
            throw err;
          }
        },
        onError: (err, info) => {
          runtime.error?.(`qq ${info.kind} reply failed: ${String(err)}`);
        },
      },
    }).catch((err) => {
      runtime.error?.(`qq dispatch exception: ${String(err)}`);
    });
  } catch (err) {
    runtime.error?.(`qq handleOb11Event error: ${String(err)}`);
  }
}
