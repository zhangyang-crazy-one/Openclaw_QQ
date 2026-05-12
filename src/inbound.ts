import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { logInboundDrop, resolveControlCommandGate } from "openclaw/plugin-sdk/irc";
import { mergeAllowlist, resolveMentionGatingWithBypass } from "openclaw/plugin-sdk/zalouser";
import { getActiveQqClient } from "./adapter.js";
import { resolveGroupConfig } from "./config.js";
import { convertBareImageUrlsToCq, convertMarkdownImagesToCq, parseCqSegments } from "./cqcode.js";
import { convertMarkdownToQQ } from "./markdown-formatter.js";
import { createSendQueue } from "./message-queue.js";
import { parseOb11Message, hasSelfMention } from "./message-utils.js";
import { sendQqMessage } from "./native-ob11-bridge.js";
import { getActiveNativeClient } from "./qq-native.js";
import { getQqRuntime } from "./runtime.js";
import { rememberSelfSentResponse, wasSelfSentMessage } from "./self-sent.js";
import { sendOb11Message } from "./send.js";
import { formatQqTarget, normalizeAllowEntry, type QQTarget } from "./targets.js";
import { createDmTypingCallbacks, createToolProgressTracker } from "./typing-feedback.js";
import type {
  OB11ActionResponse,
  OB11Event,
  OB11GroupUploadNoticeEvent,
  OB11MessageSegment,
  ResolvedQQAccount,
} from "./types.js";

const CHANNEL_ID = "qq" as const;
const QQ_INBOUND_MEDIA_MAX_BYTES = 5 * 1024 * 1024;

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
  if (allowlist.hasWildcard) {return true;}
  return allowlist.list.includes(id);
}

function buildTarget(params: { isGroup: boolean; senderId: string; groupId?: string }): QQTarget {
  if (params.isGroup) {
    if (!params.groupId) {throw new Error("buildTarget: groupId required for group target");}
    return { kind: "group", id: params.groupId };
  }
  return { kind: "private", id: params.senderId };
}

function toSegmentString(value: unknown): string {
  if (value == null) {return "";}
  return String(value).trim();
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function resolveLocalMediaPath(value: string): string | null {
  if (!value) {return null;}
  if (value.startsWith("file://")) {
    try {
      return fileURLToPath(value);
    } catch {
      return null;
    }
  }
  return path.isAbsolute(value) ? value : null;
}

function isOb11ActionSuccess(response: OB11ActionResponse | undefined): boolean {
  if (!response) {return false;}
  if (response.status && response.status.toLowerCase() === "ok") {return true;}
  if (typeof response.retcode === "number") {return response.retcode === 0;}
  return false;
}

function extractMediaSourceFromActionData(value: unknown, depth = 0): string | null {
  if (depth > 4 || value == null) {return null;}
  if (typeof value === "string") {
    const candidate = value.trim();
    if (!candidate) {return null;}
    if (isHttpUrl(candidate)) {return candidate;}
    if (resolveLocalMediaPath(candidate)) {return candidate;}
    return null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const matched = extractMediaSourceFromActionData(entry, depth + 1);
      if (matched) {return matched;}
    }
    return null;
  }
  if (typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["file", "path", "url", "src", "download", "download_url"]) {
    const matched = extractMediaSourceFromActionData(record[key], depth + 1);
    if (matched) {return matched;}
  }
  for (const nested of Object.values(record)) {
    const matched = extractMediaSourceFromActionData(nested, depth + 1);
    if (matched) {return matched;}
  }
  return null;
}

function buildInboundMediaResolutionActions(params: {
  segmentType: string;
  fileToken: string;
}): Array<{ action: string; payload: Record<string, unknown> }> {
  const fileToken = params.fileToken.trim();
  if (!fileToken || isHttpUrl(fileToken) || resolveLocalMediaPath(fileToken)) {
    return [];
  }

  if (params.segmentType === "image") {
    return [{ action: "get_image", payload: { file: fileToken } }];
  }
  if (params.segmentType === "record") {
    return [
      { action: "get_record", payload: { file: fileToken } },
      { action: "get_record", payload: { file: fileToken, out_format: "mp3" } },
    ];
  }
  if (params.segmentType === "video") {
    return [{ action: "get_video", payload: { file: fileToken } }];
  }
  return [];
}

async function resolveInboundMediaSourceViaOneBot(params: {
  accountId: string;
  segmentType: string;
  fileToken: string;
  runtime: RuntimeEnv;
}): Promise<string | null> {
  const client = getActiveQqClient(params.accountId);
  if (!client) {return null;}

  const attempts = buildInboundMediaResolutionActions({
    segmentType: params.segmentType,
    fileToken: params.fileToken,
  });
  for (const attempt of attempts) {
    try {
      const response = await client.sendAction(attempt.action, attempt.payload);
      if (!isOb11ActionSuccess(response)) {
        continue;
      }
      const source = extractMediaSourceFromActionData(response.data);
      if (source) {return source;}
    } catch (err) {
      params.runtime.log?.(
        `qq: media action ${attempt.action} failed for ${params.segmentType}: ${String(err)}`,
      );
    }
  }
  return null;
}

async function resolveInboundMediaUrl(params: {
  source: string;
  fileNameHint?: string;
  runtime: RuntimeEnv;
}): Promise<string> {
  const source = params.source.trim();
  if (!source) {return source;}

  const core = getQqRuntime();
  const media = core.channel?.media;
  if (!media) {return source;}

  try {
    if (isHttpUrl(source)) {
      const fetched = await media.fetchRemoteMedia({
        url: source,
        filePathHint: params.fileNameHint || source,
        maxBytes: QQ_INBOUND_MEDIA_MAX_BYTES,
      });
      const saved = await media.saveMediaBuffer(
        fetched.buffer,
        fetched.contentType,
        "inbound",
        QQ_INBOUND_MEDIA_MAX_BYTES,
        fetched.fileName ?? params.fileNameHint,
      );
      return saved.path;
    }

    const localPath = resolveLocalMediaPath(source);
    if (!localPath) {
      return source;
    }
    const buffer = await fs.readFile(localPath);
    const saved = await media.saveMediaBuffer(
      buffer,
      undefined,
      "inbound",
      QQ_INBOUND_MEDIA_MAX_BYTES,
      params.fileNameHint ?? path.basename(localPath),
    );
    return saved.path;
  } catch (err) {
    params.runtime.log?.(`qq: failed to localize inbound media ${source}: ${String(err)}`);
    return source;
  }
}

function replaceMediaReferences(raw: string, replacements: Map<string, string>): string {
  if (!raw || replacements.size === 0) {
    return raw;
  }
  let next = raw;
  for (const [from, to] of replacements) {
    if (!from || !to || from === to) {continue;}
    next = next.split(from).join(to);
  }
  return next;
}

async function collectInboundMedia(params: {
  accountId: string;
  segments: OB11MessageSegment[] | undefined;
  runtime: RuntimeEnv;
}): Promise<{ mediaInfo: string; mediaUrls: string[]; replacements: Map<string, string> }> {
  const mediaInfoLines: string[] = [];
  const mediaUrls: string[] = [];
  const replacements = new Map<string, string>();
  const segments = params.segments ?? [];

  for (const seg of segments) {
    if (
      seg.type !== "image" &&
      seg.type !== "video" &&
      seg.type !== "record" &&
      seg.type !== "file"
    ) {
      continue;
    }

    const fileCandidate = toSegmentString(seg.data?.file);
    const urlCandidate = toSegmentString(seg.data?.url);
    const oneBotSource = await resolveInboundMediaSourceViaOneBot({
      accountId: params.accountId,
      segmentType: seg.type,
      fileToken: fileCandidate,
      runtime: params.runtime,
    });
    // Prefer local file paths from OneBot payloads when available.
    const source =
      oneBotSource ||
      (resolveLocalMediaPath(fileCandidate) ? fileCandidate : urlCandidate || fileCandidate);
    if (!source) {
      continue;
    }

    const fileNameHint =
      toSegmentString(seg.data?.name) ||
      (seg.type === "file" ? path.basename(source) : "") ||
      undefined;
    const resolved = await resolveInboundMediaUrl({
      source,
      fileNameHint,
      runtime: params.runtime,
    });

    mediaUrls.push(resolved);
    if (resolved !== source) {
      replacements.set(source, resolved);
    }
    if (urlCandidate && resolved !== urlCandidate) {
      replacements.set(urlCandidate, resolved);
    }
    if (fileCandidate && resolved !== fileCandidate) {
      replacements.set(fileCandidate, resolved);
    }

    if (seg.type === "image") {
      mediaInfoLines.push(`[Image: ${resolved}]`);
      continue;
    }
    if (seg.type === "video") {
      mediaInfoLines.push(`[Video: ${resolved}]`);
      continue;
    }
    if (seg.type === "record") {
      mediaInfoLines.push(`[Voice: ${resolved}]`);
      continue;
    }
    const displayName = fileNameHint || "file";
    mediaInfoLines.push(`[File: ${displayName}]`);
  }

  return {
    mediaInfo: mediaInfoLines.join("\n"),
    mediaUrls,
    replacements,
  };
}

function resolveInboundSegments(
  message?: string | OB11MessageSegment[],
): OB11MessageSegment[] | undefined {
  if (Array.isArray(message)) {
    return message;
  }
  if (typeof message !== "string" || !message.trim()) {
    return undefined;
  }
  return parseCqSegments(message).map((segment) => ({
    type: segment.type,
    data: segment.data,
  }));
}

/** Validation result for inbound events */
type InboundValidation = {
  ok: boolean;
  postType: string;
  subType: string;
  messageType: string;
  isGroup: boolean;
  senderId: string;
  groupId?: string;
  target: QQTarget;
  groupConfig: ReturnType<typeof resolveGroupConfig> | null;
  parsed: ReturnType<typeof parseOb11Message>;
  rawBody: string;
  inboundSegments?: OB11MessageSegment[];
  hasTextContent: boolean;
  hasMediaContent: boolean;
};

/**
 * Validate inbound event and extract basic information.
 */
function validateInboundEvent(params: {
  event: OB11Event;
  account: ResolvedQQAccount;
}): InboundValidation | null {
  const { event, account } = params;

  const postType = String(event.post_type ?? "").toLowerCase();
  if (postType !== "message" && postType !== "message_sent" && postType !== "meta_event") {
    return null;
  }
  if (postType === "meta_event") {
    return null;
  }

  const subType = String(event.sub_type ?? "").toLowerCase();
  if (
    postType === "message" &&
    subType === "offline" &&
    !account.connection?.reportOfflineMessage
  ) {
    return null;
  }

  const messageType = String(event.message_type ?? "").toLowerCase();
  const isGroup = messageType === "group";
  const senderId = event.user_id != null ? String(event.user_id) : "";
  if (!senderId) {
    return null;
  }

  const groupId = event.group_id != null ? String(event.group_id) : undefined;
  const target = buildTarget({ isGroup, senderId, groupId });

  const groupConfig = isGroup ? resolveGroupConfig(account.config, groupId ?? "") : null;

  if (postType === "message_sent" && !account.connection?.reportSelfMessage) {
    return null;
  }

  const parsed = parseOb11Message(event.message ?? event.raw_message);
  const rawBody = parsed.text.trim();
  const inboundSegments = resolveInboundSegments(event.message ?? event.raw_message);

  // Check if message has any content (text or attachments)
  const hasTextContent = rawBody.length > 0;
  const hasMediaContent = Boolean(
    inboundSegments?.some(
      (seg) =>
        seg.type === "image" ||
        seg.type === "video" ||
        seg.type === "record" ||
        seg.type === "file",
    ),
  );

  if (!hasTextContent && !hasMediaContent) {
    return null;
  }

  return {
    ok: true,
    postType,
    subType,
    messageType,
    isGroup,
    senderId,
    groupId,
    target,
    groupConfig,
    parsed,
    rawBody,
    inboundSegments,
    hasTextContent,
    hasMediaContent,
  };
}

/**
 * Check if sender is allowed based on DM/group policy.
 */
async function checkInboundAccess(params: {
  validation: InboundValidation;
  event: OB11Event;
  account: ResolvedQQAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
}): Promise<{ allowed: boolean; reason?: string }> {
  const { validation, event, account, config, runtime } = params;
  const { isGroup, senderId, groupId, groupConfig, parsed } = validation;
  const core = getQqRuntime();

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = config.channels?.defaults?.groupPolicy;
  const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";

  const configGroupAllowFrom = normalizeAllowList(account.config.groupAllowFrom);
  const storeAllowFrom = core.channel?.pairing
    ? await core.channel.pairing
        .readAllowFromStore({ channel: CHANNEL_ID, accountId: account.accountId })
        .catch(() => [])
    : [];

  const effectiveAllowFrom = normalizeAllowList(
    mergeAllowlist({ existing: account.config.allowFrom, additions: storeAllowFrom }),
  );

  const allowTextCommands =
    core.channel?.commands?.shouldHandleTextCommands({
      cfg: config,
      surface: CHANNEL_ID,
    }) ?? false;
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = isAllowed(
    isGroup ? configGroupAllowFrom : effectiveAllowFrom,
    isGroup ? `group:${groupId ?? ""}` : senderId,
  );
  const hasControlCommand =
    core.channel?.text?.hasControlCommand(validation.rawBody, config) ?? false;
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

  if (isGroup) {
    if (!groupConfig?.enabled) {
      return {
        allowed: false,
        reason: `qq: drop group ${groupId ?? ""} (group disabled in config)`,
      };
    }
    if (groupPolicy === "disabled") {
      return { allowed: false, reason: `qq: drop group ${groupId ?? ""} (groupPolicy=disabled)` };
    }
    if (groupPolicy === "allowlist") {
      const groupKey = `group:${groupId ?? ""}`;
      if (!isAllowed(configGroupAllowFrom, groupKey)) {
        return { allowed: false, reason: `qq: drop group ${groupId ?? ""} (not allowlisted)` };
      }
    }

    if (commandGate.shouldBlock) {
      return { allowed: false, reason: "control command (unauthorized)" };
    }

    const selfId = event.self_id != null ? String(event.self_id) : undefined;
    const wasMentioned = hasSelfMention(parsed.mentions, selfId);
    const requireMention = groupConfig?.requireMention ?? true;
    const canDetectMention = isGroup;
    const mentionGate = resolveMentionGatingWithBypass({
      isGroup,
      requireMention,
      canDetectMention,
      wasMentioned,
      allowTextCommands,
      hasControlCommand,
      commandAuthorized: commandGate.commandAuthorized,
    });
    if (mentionGate.shouldSkip) {
      return { allowed: false, reason: `qq: drop group ${groupId ?? ""} (no mention)` };
    }
  } else {
    if (dmPolicy === "disabled") {
      return { allowed: false, reason: `qq: drop DM sender=${senderId} (dmPolicy=disabled)` };
    }
    const senderAllowed = isAllowed(effectiveAllowFrom, senderId);
    if (dmPolicy !== "open" && !senderAllowed) {
      if (dmPolicy === "pairing" && core.channel?.pairing) {
        await handlePairingRequest({
          core,
          senderId,
          account,
          event,
          target: validation.target,
        });
      }
      return { allowed: false, reason: `qq: drop DM sender=${senderId} (dmPolicy=${dmPolicy})` };
    }
  }

  return { allowed: true };
}

async function handlePairingRequest(params: {
  core: ReturnType<typeof getQqRuntime>;
  senderId: string;
  account: ResolvedQQAccount;
  event: OB11Event;
  target: QQTarget;
}): Promise<void> {
  const { core, senderId, account, event, target } = params;
  const { code, created } = await core.channel.pairing.upsertPairingRequest({
    channel: CHANNEL_ID,
    id: senderId,
    accountId: account.accountId,
    meta: { name: event.sender?.nickname ?? undefined },
  });
  if (created) {
    try {
      const client = getActiveQqClient(account.accountId);
      if (client) {
        const pairingText =
          core.channel?.pairing?.buildPairingReply({
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
      }
    } catch (err) {
      // Error handling is done by caller
    }
  }
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
    // Step 0: Handle notice events (file uploads) separately
    const postType = String(event.post_type ?? "").toLowerCase();
    if (postType === "notice") {
      await handleNoticeEvent({ event, account, config, runtime, statusSink });
      return;
    }

    // Step 1: Validate event and extract basic info
    const validation = validateInboundEvent({ event, account });
    if (!validation) {
      return;
    }

    // Step 2: Check if this is a self-sent message
    if (validation.postType === "message_sent") {
      const messageId = event.message_id != null ? String(event.message_id) : undefined;
      if (
        wasSelfSentMessage({
          accountId: account.accountId,
          messageId,
          target: formatQqTarget(validation.target),
          text: validation.rawBody,
        })
      ) {
        return;
      }
    }

    const core = getQqRuntime();
    const timestamp = typeof event.time === "number" ? event.time * 1000 : Date.now();
    statusSink?.({ lastInboundAt: timestamp });

    // Step 3: Check access control (DM policy, group policy, mention, etc.)
    const accessResult = await checkInboundAccess({ validation, event, account, config, runtime });
    if (!accessResult.allowed) {
      runtime.log?.(accessResult.reason ?? "dropped by access control");
      return;
    }

    // Step 4: Resolve routing
    const route = core.channel?.routing?.resolveAgentRoute({
      cfg: config,
      channel: CHANNEL_ID,
      accountId: account.accountId,
      peer: {
        kind: validation.isGroup ? "group" : "direct",
        id: validation.isGroup ? (validation.groupId ?? validation.senderId) : validation.senderId,
      },
    }) ?? { agentId: "default", sessionKey: "" };
    const effectiveAgentId = validation.groupConfig?.agentId ?? route.agentId;

    // Step 5: Build session and context
    const senderName = event.sender?.card?.trim() || event.sender?.nickname?.trim() || undefined;
    const fromLabel = validation.isGroup
      ? `group:${validation.groupId ?? ""}`
      : senderName || `user:${validation.senderId}`;

    const storePath =
      core.channel?.session?.resolveStorePath(config.session?.store, {
        agentId: effectiveAgentId,
      }) ?? "";
    const envelopeOptions =
      core.channel?.reply?.resolveEnvelopeFormatOptions(config) ?? {};
    const previousTimestamp =
      core.channel?.session?.readSessionUpdatedAt({
        storePath,
        sessionKey: route.sessionKey,
      }) ?? Date.now();

    // Step 6: Collect and process media
    const media = await collectInboundMedia({
      accountId: account.accountId,
      segments: validation.inboundSegments,
      runtime,
    });
    const normalizedRawBody = replaceMediaReferences(validation.rawBody, media.replacements);

    // Combine text body with media info
    const fullBody = normalizedRawBody
      ? (normalizedRawBody + "\n" + media.mediaInfo).trim()
      : media.mediaInfo.trim();

    const body =
      core.channel?.reply?.formatAgentEnvelope({
        channel: "QQ",
        from: fromLabel,
        timestamp,
        previousTimestamp,
        envelope: envelopeOptions,
        body: normalizedRawBody,
      }) ?? normalizedRawBody;

    const selfId = event.self_id != null ? String(event.self_id) : undefined;
    const wasMentioned = validation.isGroup
      ? hasSelfMention(validation.parsed.mentions, selfId)
      : false;

    const ctxPayload = core.channel?.reply?.finalizeInboundContext({
      Body: body,
      BodyForAgent: fullBody,
      RawBody: fullBody,
      CommandBody: fullBody,
      From: validation.isGroup
        ? `qq:group:${validation.groupId ?? ""}`
        : `qq:${validation.senderId}`,
      To: `qq:${formatQqTarget(validation.target)}`,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: validation.isGroup ? "group" : "direct",
      ConversationLabel: fromLabel,
      SenderName: senderName,
      SenderId: validation.senderId,
      GroupSubject: validation.isGroup ? (validation.groupId ?? undefined) : undefined,
      Provider: CHANNEL_ID,
      Surface: CHANNEL_ID,
      WasMentioned: validation.isGroup ? wasMentioned : undefined,
      MessageSid: event.message_id != null ? String(event.message_id) : undefined,
      Timestamp: timestamp,
      OriginatingChannel: CHANNEL_ID,
      OriginatingTo: `qq:${formatQqTarget(validation.target)}`,
      CommandAuthorized: true,
      MediaUrls: media.mediaUrls.length > 0 ? media.mediaUrls : undefined,
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

    const sendQueue = createSendQueue({ interSendDelayMs: 350 });

    const toolProgress = createToolProgressTracker({
      statusCtx: {
        account,
        target: validation.target,
        sendQueue,
        statusSink,
      },
    });

    const typingCallbacks = createDmTypingCallbacks({
      isDm: !validation.isGroup,
      statusCtx: {
        account,
        target: validation.target,
        sendQueue,
        statusSink,
      },
      responseState: toolProgress.getState(),
      runtime,
    });

    await core.channel?.reply
      ?.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: config,
        dispatcherOptions: {
          typingCallbacks,
          deliver: async (payload, info) => {
            if (info.kind === "tool") {
              toolProgress.recordTool(payload.text);
              toolProgress.scheduleProgress();
              return;
            }
            // Block or final: text has arrived, reset tool progress
            toolProgress.resetProgress();

            const rawText = payload.text ?? "";
            const mediaUrl = payload.mediaUrl ?? payload.mediaUrls?.[0];
            if (!rawText && !mediaUrl) {return;}

            // Format markdown for QQ readability:
            // 1. Extract markdown images → CQ codes
            // 2. Detect bare image URLs → CQ codes
            // 3. Convert remaining markdown to QQ-readable text
            const formattedText = convertMarkdownToQQ(
              convertBareImageUrlsToCq(convertMarkdownImagesToCq(rawText)),
            );

            const targetKey = formatQqTarget(validation.target);
            sendQueue.enqueue(targetKey, async () => {
              await sendQqMessage({
                account,
                target: validation.target,
                text: formattedText,
                mediaUrl,
                replyToId: payload.replyToId,
              });
              statusSink?.({ lastOutboundAt: Date.now() });
            });
          },
          onError: (err, info) => {
            runtime.error?.(`qq ${info.kind} reply failed: ${String(err)}`);
          },
        },
      })
      .catch((err) => {
        runtime.error?.(`qq dispatch exception: ${String(err)}`);
      })
      .finally(() => {
        toolProgress.cleanup();
      });
  } catch (err) {
    runtime.error?.(`qq handleOb11Event error: ${String(err)}`);
    throw err;
  }
}

/**
 * Handle OneBot 11 notice events related to file uploads.
 *
 * QQ sends files via two notice types:
 * - group_upload: A user uploaded a file to a group
 * - offline_file: A user sent a file in private chat
 *
 * These events have post_type="notice" and were previously silently dropped.
 */
async function handleNoticeEvent(params: {
  event: OB11Event;
  account: ResolvedQQAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  statusSink?: StatusSink;
}): Promise<void> {
  const { event, account, config, runtime, statusSink } = params;
  const noticeType = String(event.notice_type ?? "").toLowerCase();

  if (noticeType !== "group_upload" && noticeType !== "offline_file") {
    return;
  }

  // Extract file info from the notice event
  const file = event.file as
    | { id?: string; name?: string; url?: string; size?: number }
    | undefined;
  if (!file?.url && !file?.name) {
    runtime.log?.(`qq: notice ${noticeType} has no file info, skipping`);
    return;
  }

  const fileUrl = file.url || "";
  const fileName = file.name || "unknown_file";
  const fileSize = file.size;

  const isGroup = noticeType === "group_upload";
  const senderId = event.user_id != null ? String(event.user_id) : "";
  if (!senderId) {
    return;
  }

  const groupId = event.group_id != null ? String(event.group_id) : undefined;
  if (isGroup && !groupId) {
    return;
  }

  const target: QQTarget = isGroup
    ? { kind: "group", id: groupId! }
    : { kind: "private", id: senderId };

  const timestamp = typeof event.time === "number" ? event.time * 1000 : Date.now();
  statusSink?.({ lastInboundAt: timestamp });

  // Access control for groups
  if (isGroup) {
    const groupConfig = resolveGroupConfig(account.config, groupId!);
    if (!groupConfig?.enabled) {
      runtime.log?.(`qq: drop group file ${groupId} (group disabled in config)`);
      return;
    }
    const defaultGroupPolicy = config.channels?.defaults?.groupPolicy;
    const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
    if (groupPolicy === "disabled") {
      runtime.log?.(`qq: drop group file ${groupId} (groupPolicy=disabled)`);
      return;
    }
    if (groupPolicy === "allowlist") {
      const configGroupAllowFrom = normalizeAllowList(account.config.groupAllowFrom);
      const groupKey = `group:${groupId}`;
      if (!isAllowed(configGroupAllowFrom, groupKey)) {
        runtime.log?.(`qq: drop group file ${groupId} (not allowlisted)`);
        return;
      }
    }
  } else {
    // DM access control
    const dmPolicy = account.config.dmPolicy ?? "pairing";
    if (dmPolicy === "disabled") {
      runtime.log?.(`qq: drop DM file sender=${senderId} (dmPolicy=disabled)`);
      return;
    }
    const effectiveAllowFrom = normalizeAllowList(account.config.allowFrom);
    const senderAllowed = isAllowed(effectiveAllowFrom, senderId);
    if (dmPolicy !== "open" && !senderAllowed) {
      runtime.log?.(`qq: drop DM file sender=${senderId} (dmPolicy=${dmPolicy})`);
      return;
    }
  }

  const core = getQqRuntime();

  // Step 1: Resolve the actual file source via OneBot get_file API
  // The file.url from notice events is often empty or has a short-lived token.
  // We need to use get_file with file.id to get the actual local path or download URL.
  const fileId = file.id || fileUrl;
  let resolvedSource: string | null = null;

  if (fileId) {
    // Try OneBot get_file API first
    const ob11Client = getActiveQqClient(account.accountId);
    if (ob11Client) {
      try {
        const response = await ob11Client.sendAction("get_file", {
          file: fileId,
        });
        if (isOb11ActionSuccess(response)) {
          const extracted = extractMediaSourceFromActionData(response.data);
          if (extracted) {
            resolvedSource = extracted;
            runtime.log?.(`qq: resolved file via get_file: ${resolvedSource}`);
          }
        }
      } catch (err) {
        runtime.log?.(`qq: get_file failed for ${fileId}: ${String(err)}`);
      }
    }

    // Fallback: try native client if available
    if (!resolvedSource) {
      const nativeClient = getActiveNativeClient(account.accountId);
      if (nativeClient) {
        try {
          // Use OB11 get_file through the WS client instead (native oicq has no getFile API)
          runtime.log?.(`qq: native client available but has no getFile; skipping native fallback`);
        } catch (err) {
          runtime.log?.(`qq: native file fallback failed for ${fileId}: ${String(err)}`);
        }
      }
    }
  }

  // Fallback to the original URL from the notice event
  if (!resolvedSource) {
    resolvedSource = fileUrl || null;
  }

  // Step 2: Download the file to local storage if possible
  let localFilePath: string | null = null;
  if (resolvedSource) {
    try {
      localFilePath = await resolveInboundMediaUrl({
        source: resolvedSource,
        fileNameHint: fileName,
        runtime,
      });
    } catch (err) {
      runtime.log?.(`qq: failed to download file ${resolvedSource}: ${String(err)}`);
    }
  }

  const effectiveFilePath = localFilePath || resolvedSource;

  // Build the file description message for the agent
  const sizeInfo = fileSize ? ` (${formatFileSize(fileSize)})` : "";
  const fileDescription = `[File received: ${fileName}${sizeInfo}]`;
  const filePathInfo = effectiveFilePath
    ? localFilePath && localFilePath !== resolvedSource
      ? `Local: ${localFilePath}\nSource: ${resolvedSource}`
      : `URL: ${effectiveFilePath}`
    : "(file could not be downloaded — no accessible URL or local path)";
  const fullBody = `${fileDescription}\n${filePathInfo}`;

  const mediaUrls = effectiveFilePath ? [effectiveFilePath] : [];

  const route = core.channel?.routing?.resolveAgentRoute({
    cfg: config,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: isGroup ? groupId! : senderId,
    },
  }) ?? { agentId: "default", sessionKey: "" };

  const groupConfig = isGroup ? resolveGroupConfig(account.config, groupId!) : null;
  const effectiveAgentId = groupConfig?.agentId ?? route.agentId;

  const fromLabel = isGroup ? `group:${groupId}` : `user:${senderId}`;

  const storePath =
    core.channel?.session?.resolveStorePath(config.session?.store, {
      agentId: effectiveAgentId,
    }) ?? "";
  const envelopeOptions =
    core.channel?.reply?.resolveEnvelopeFormatOptions(config) ?? {};
  const previousTimestamp =
    core.channel?.session?.readSessionUpdatedAt({
      storePath,
      sessionKey: route.sessionKey,
    }) ?? Date.now();

  const body =
    core.channel?.reply?.formatAgentEnvelope({
      channel: "QQ",
      from: fromLabel,
      timestamp,
      previousTimestamp,
      envelope: envelopeOptions,
      body: fullBody,
    }) ?? fullBody;

  const ctxPayload = core.channel?.reply?.finalizeInboundContext({
    Body: body,
    BodyForAgent: fullBody,
    RawBody: fullBody,
    CommandBody: fullBody,
    From: isGroup ? `qq:group:${groupId}` : `qq:${senderId}`,
    To: `qq:${formatQqTarget(target)}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: undefined,
    SenderId: senderId,
    GroupSubject: isGroup ? groupId : undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    WasMentioned: undefined,
    MessageSid: undefined,
    Timestamp: timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `qq:${formatQqTarget(target)}`,
    CommandAuthorized: false,
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
      runtime.error?.(`qq: failed updating session meta for file notice: ${String(err)}`);
    },
  });

  const noticeSendQueue = createSendQueue({ interSendDelayMs: 350 });

  const noticeToolProgress = createToolProgressTracker({
    statusCtx: {
      account,
      target,
      sendQueue: noticeSendQueue,
      statusSink,
    },
  });

  const noticeTypingCallbacks = createDmTypingCallbacks({
    isDm: !isGroup,
    statusCtx: {
      account,
      target,
      sendQueue: noticeSendQueue,
      statusSink,
    },
    responseState: noticeToolProgress.getState(),
    runtime,
  });

  await core.channel?.reply
    ?.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: config,
      dispatcherOptions: {
        typingCallbacks: noticeTypingCallbacks,
        deliver: async (payload, info) => {
          if (info.kind === "tool") {
            noticeToolProgress.recordTool(payload.text);
            noticeToolProgress.scheduleProgress();
            return;
          }

          noticeToolProgress.resetProgress();

          const rawText = payload.text ?? "";
          const mediaUrl = payload.mediaUrl ?? payload.mediaUrls?.[0];
          if (!rawText && !mediaUrl) {return;}

          // Format markdown for QQ readability
          const formattedText = convertMarkdownToQQ(
            convertBareImageUrlsToCq(convertMarkdownImagesToCq(rawText)),
          );

          const targetKey = formatQqTarget(target);
          noticeSendQueue.enqueue(targetKey, async () => {
            await sendQqMessage({
              account,
              target,
              text: formattedText,
              mediaUrl,
              replyToId: payload.replyToId,
            });
            statusSink?.({ lastOutboundAt: Date.now() });
          });
        },
        onError: (err, info) => {
          runtime.error?.(`qq file notice ${info.kind} reply failed: ${String(err)}`);
        },
      },
    })
    .catch((err) => {
      runtime.error?.(`qq file notice dispatch exception: ${String(err)}`);
    })
    .finally(() => {
      noticeToolProgress.cleanup();
    });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {return `${bytes}B`;}
  if (bytes < 1024 * 1024) {return `${(bytes / 1024).toFixed(1)}KB`;}
  if (bytes < 1024 * 1024 * 1024) {return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;}
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}
