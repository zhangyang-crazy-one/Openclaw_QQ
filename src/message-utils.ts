import { parseCqSegments, renderCqSegments } from "./cqcode.js";
import type { OB11MessageSegment } from "./types.js";

/**
 * Safely convert a value to a QQ ID (positive integer).
 * Throws if the value is not a valid positive number.
 */
export function safeQqId(value: string | number, _fieldName?: string): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0 || !Number.isInteger(num)) {
    throw new Error(`Invalid QQ ID: ${JSON.stringify(value)}`);
  }
  return num;
}

export type ParsedMessage = {
  text: string;
  mentions: string[];
  replyToId?: string;
};

function toSegmentString(value?: string | number): string {
  if (value == null) return "";
  return String(value);
}

function renderOb11Segments(segments: OB11MessageSegment[]): ParsedMessage {
  const parts: string[] = [];
  const mentions: string[] = [];
  let replyToId: string | undefined;

  for (const segment of segments) {
    if (segment.type === "text") {
      const text = toSegmentString(segment.data.text);
      if (text) parts.push(text);
      continue;
    }
    if (segment.type === "at") {
      const target = toSegmentString(segment.data.qq);
      if (target) {
        mentions.push(target);
        parts.push(target === "all" ? "@all" : `@${target}`);
      }
      continue;
    }
    if (segment.type === "reply") {
      const id = toSegmentString(segment.data.id);
      if (id) replyToId = id;
      continue;
    }
    if (segment.type === "image" || segment.type === "record" || segment.type === "video") {
      const file = toSegmentString(segment.data.url) || toSegmentString(segment.data.file);
      if (file) {
        parts.push(`Attachment: ${file}`);
      }
      continue;
    }
    if (segment.type === "forward") {
      const id = toSegmentString(segment.data.id);
      if (id) {
        parts.push(`[Forward Message: ${id}]`);
      }
      continue;
    }
    if (segment.type === "face") {
      const id = toSegmentString(segment.data.id);
      parts.push(`[Face:${id}]`);
      continue;
    }
    if (segment.type === "poke") {
      const pokeType = toSegmentString(segment.data.type);
      const pokeId = toSegmentString(segment.data.id);
      parts.push(`[Poke:${pokeType}:${pokeId}]`);
      continue;
    }
    if (segment.type === "json") {
      parts.push(`[JSON Card]`);
      continue;
    }
    if (segment.type === "xml") {
      parts.push(`[XML Card]`);
      continue;
    }
    if (segment.type === "file") {
      const name = toSegmentString(segment.data.name) || toSegmentString(segment.data.file);
      if (name) {
        parts.push(`[File: ${name}]`);
      }
      continue;
    }
  }

  return {
    text: parts.join("").trim(),
    mentions,
    replyToId,
  };
}

export function parseOb11Message(message?: string | OB11MessageSegment[]): ParsedMessage {
  if (!message) {
    return { text: "", mentions: [] };
  }
  if (typeof message === "string") {
    const segments = parseCqSegments(message);
    return renderCqSegments(segments);
  }
  return renderOb11Segments(message);
}

export function hasSelfMention(mentions: string[], selfId?: string): boolean {
  if (mentions.includes("all")) return true;
  if (!selfId) return false;
  return mentions.includes(selfId);
}
