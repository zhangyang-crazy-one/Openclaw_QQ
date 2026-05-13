import type { Ob11Client } from "./adapter.js";
import { buildCqMessage } from "./cqcode.js";
import type { QQTarget } from "./targets.js";
import type { QQMessageFormat, OB11ActionResponse, OB11MessageSegment } from "./types.js";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".flac", ".silk", ".m4a"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi"]);
const FILE_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".zip",
  ".rar",
  ".7z",
  ".tar",
  ".gz",
  ".txt",
  ".csv",
  ".json",
]);

function getExtension(url: string): string {
  const lower = url.toLowerCase();
  const queryIndex = lower.indexOf("?");
  const clean = queryIndex >= 0 ? lower.slice(0, queryIndex) : lower;
  const dotIndex = clean.lastIndexOf(".");
  return dotIndex >= 0 ? clean.slice(dotIndex) : "";
}

function guessMediaType(path: string): "image" | "record" | "video" | "file" {
  const ext = getExtension(path);
  if (AUDIO_EXTENSIONS.has(ext)) return "record";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (FILE_EXTENSIONS.has(ext)) return "file";
  return "image";
}

function isLocalPath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("./") || path.startsWith("../");
}

export function buildOb11MessagePayload(params: {
  format: QQMessageFormat;
  text?: string;
  replyToId?: string;
  mediaUrl?: string;
  /** Send text as markdown segment (LLBot converts to QQ native Markdown element type 14). */
  asMarkdown?: boolean;
}): string | OB11MessageSegment[] {
  const mediaType = params.mediaUrl ? guessMediaType(params.mediaUrl) : undefined;

  if (params.format === "string") {
    return buildCqMessage({
      text: params.text,
      replyToId: params.replyToId,
      mediaUrl: params.mediaUrl,
      mediaType,
    });
  }

  const segments: OB11MessageSegment[] = [];

  if (params.replyToId) {
    segments.push({ type: "reply", data: { id: params.replyToId } });
  }

  if (params.text) {
    if (params.asMarkdown) {
      segments.push({ type: "markdown", data: { content: params.text } });
    } else {
      segments.push({ type: "text", data: { text: params.text } });
    }
  }

  if (params.mediaUrl) {
    segments.push({ type: mediaType || "image", data: { file: params.mediaUrl } });
  }

  return segments;
}

export async function sendOb11Message(params: {
  client: Ob11Client;
  target: QQTarget;
  text?: string;
  replyToId?: string;
  mediaUrl?: string;
  asMarkdown?: boolean;
}): Promise<OB11ActionResponse> {
  // 处理本地文件 - 使用 CQ码 方式发送
  if (params.mediaUrl && isLocalPath(params.mediaUrl)) {
    const fileName = params.mediaUrl.split("/").pop() || "file";
    const mediaType = guessMediaType(params.mediaUrl);

    // 使用 CQ码 方式发送本地文件
    const cqCode = `[CQ:${mediaType},file=${params.mediaUrl}]`;

    const fullMessage = params.text ? `${params.text}\n${cqCode}` : cqCode;

    if (params.target.kind === "group") {
      return params.client.sendAction("send_group_msg", {
        group_id: params.target.id,
        message: fullMessage,
      });
    }

    return params.client.sendAction("send_private_msg", {
      user_id: params.target.id,
      message: fullMessage,
    });
  }

  // 普通消息或远程媒体
  const payload = buildOb11MessagePayload({
    format: params.client.messageFormat,
    text: params.text,
    replyToId: params.replyToId,
    mediaUrl: params.mediaUrl,
    asMarkdown: params.asMarkdown,
  });

  if (params.target.kind === "group") {
    return params.client.sendAction("send_group_msg", {
      group_id: params.target.id,
      message: payload,
    });
  }

  return params.client.sendAction("send_private_msg", {
    user_id: params.target.id,
    message: payload,
  });
}
