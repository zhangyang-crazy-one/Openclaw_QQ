import { getActiveQqClient } from "./adapter.js";
import { getActiveNativeClient } from "./qq-native.js";
import { extractMessageIdFromResponse, rememberSelfSentResponse } from "./self-sent.js";
import { sendOb11Message } from "./send.js";
import { formatQqTarget, type QQTarget } from "./targets.js";
import { safeQqId } from "./message-utils.js";
import type { ResolvedQQAccount } from "./types.js";

export interface SendQqMessageParams {
  account: ResolvedQQAccount;
  target: QQTarget;
  text: string;
  mediaUrl?: string;
  replyToId?: string;
}

export interface SendQqMessageResult {
  messageId: string;
  chatId: string;
}

export async function sendQqMessage(params: SendQqMessageParams): Promise<SendQqMessageResult> {
  const { account, target, text, mediaUrl, replyToId } = params;

  // Try native oicq client first
  const nativeClient = getActiveNativeClient(account.accountId);
  if (nativeClient) {
    let messageId: string;
    const safeId = safeQqId(target.id);
    if (target.kind === "group") {
      messageId = String(await nativeClient.sendGroupMsg(Number(safeId), text));
    } else {
      messageId = String(await nativeClient.sendPrivateMsg(Number(safeId), text));
    }
    rememberSelfSentResponse({
      accountId: account.accountId,
      response: { status: "ok", data: { message_id: Number(messageId) } },
      target: formatQqTarget(target),
      text,
    });
    return { messageId, chatId: formatQqTarget(target) };
  }

  // Fall back to OB11 client
  const client = getActiveQqClient(account.accountId);
  if (!client) {
    throw new Error(`QQ client not running for account ${account.accountId}`);
  }
  const response = await sendOb11Message({ client, target, text, replyToId, mediaUrl });
  rememberSelfSentResponse({
    accountId: account.accountId,
    response,
    target: formatQqTarget(target),
    text,
  });
  return {
    messageId: extractMessageIdFromResponse(response) ?? String(Date.now()),
    chatId: formatQqTarget(target),
  };
}
