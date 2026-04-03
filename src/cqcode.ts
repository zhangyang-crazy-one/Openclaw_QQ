export type CqSegment = {
  type: string;
  data: Record<string, string>;
};

function toSegmentString(value?: string | number): string {
  if (value == null) return "";
  return String(value);
}

export function parseCqSegments(message: string): CqSegment[] {
  const segments: CqSegment[] = [];
  const regex = /\[CQ:([a-zA-Z0-9_-]+)([^\]]*)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null = null;

  while ((match = regex.exec(message)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        type: "text",
        data: { text: message.slice(lastIndex, match.index) },
      });
    }

    const type = match[1] ?? "";
    const rawParams = match[2] ?? "";
    const data: Record<string, string> = {};

    const trimmed = rawParams.startsWith(",") ? rawParams.slice(1) : rawParams;
    if (trimmed) {
      for (const entry of trimmed.split(",")) {
        const [key, value = ""] = entry.split("=");
        if (!key) continue;
        data[key] = value;
      }
    }

    segments.push({ type, data });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < message.length) {
    segments.push({
      type: "text",
      data: { text: message.slice(lastIndex) },
    });
  }

  return segments;
}

export function renderCqSegments(segments: CqSegment[]): {
  text: string;
  mentions: string[];
  replyToId?: string;
} {
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
      const data = toSegmentString(segment.data.data);
      parts.push(`[JSON Card]`);
      continue;
    }
    if (segment.type === "xml") {
      const data = toSegmentString(segment.data.data);
      parts.push(`[XML Card]`);
      continue;
    }
  }

  return {
    text: parts.join("").trim(),
    mentions,
    replyToId,
  };
}

export function buildCqMessage(params: {
  text?: string;
  replyToId?: string;
  mediaUrl?: string;
  mediaType?: "image" | "record" | "video" | "file";
}): string {
  const parts: string[] = [];
  if (params.replyToId) {
    parts.push(`[CQ:reply,id=${params.replyToId}]`);
  }
  if (params.text) {
    parts.push(params.text);
  }
  if (params.mediaUrl) {
    const type = params.mediaType ?? "image";
    parts.push(`[CQ:${type},file=${params.mediaUrl}]`);
  }
  return parts.join("");
}
