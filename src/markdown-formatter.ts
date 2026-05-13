/**
 * Markdown-to-QQ text formatter.
 *
 * QQ (via OneBot) does not render markdown natively. This module converts
 * common markdown constructs into visually structured plain-text using
 * Unicode box-drawing and typographic characters for readability.
 */
import { convertBareImageUrlsToCq, convertMarkdownImagesToCq } from "./cqcode.js";

// ── Fenced code block isolation ──────────────────────────────────────────

let fencedBlockRegistry: string[] = [];
const fencedPlaceholder = (i: number) => `\x00FENCED_${i}\x00`;

export function extractFencedBlocks(text: string): string {
  fencedBlockRegistry = [];
  const fencedRegex = /```(\w*)\n([\s\S]*?)```/g;
  return text.replace(fencedRegex, (_match, lang, code) => {
    const idx = fencedBlockRegistry.length;
    const cleanCode = code.endsWith("\n") ? code.slice(0, -1) : code;
    const langLabel = lang || "code";
    const top = `┌── ${langLabel} ──`;
    const bottom = `└──`;
    const indented = cleanCode.split("\n").map((l: string) => `│ ${l}`).join("\n");
    fencedBlockRegistry.push(`${top}\n${indented}\n${bottom}`);
    return fencedPlaceholder(idx);
  });
}

export function restoreFencedBlocks(text: string): string {
  let result = text;
  for (let i = 0; i < fencedBlockRegistry.length; i++) {
    result = result.replace(fencedPlaceholder(i), fencedBlockRegistry[i] ?? "");
  }
  return result;
}

// ── Individual converters ────────────────────────────────────────────────

export function convertInlineCode(text: string): string {
  return text.replace(/`([^`]+)`/g, (_m: string, code: string) => `『${code}』`);
}

export function convertBold(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, (_m: string, content: string) => `【${content}】`);
}

export function convertItalic(text: string): string {
  // Preserve *text* — QQ displays it natively and it's a common plaintext convention
  return text;
}

export function convertLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m: string, t: string, u: string) => `${t} (${u})`);
}

export function convertImages(text: string): string {
  return text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m: string, alt: string, url: string) => {
    return alt ? `[img: ${alt}]` : `[img]`;
  });
}

/** Strip or convert basic HTML tags that may appear in markdown. */
export function convertHtmlTags(text: string): string {
  // Line breaks
  let result = text.replace(/<br\s*\/?>/gi, "\n");
  // Bold/strong → preserve content
  result = result.replace(/<\/?(?:b|strong)>/gi, "**");
  // Italic/em → preserve content
  result = result.replace(/<\/?(?:i|em)>/gi, "*");
  // Strikethrough
  result = result.replace(/<\/?(?:s|del|strike)>/gi, "~~");
  // Code
  result = result.replace(/<\/?(?:code|tt)>/gi, "`");
  // Paragraphs
  result = result.replace(/<\/?p>/gi, "\n");
  // Divs → newline
  result = result.replace(/<\/?div[^>]*>/gi, "\n");
  // Lists
  result = result.replace(/<\/?(?:ul|ol|li)>/gi, "");
  // Links (<a href="...">text</a>)
  result = result.replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, (_m, u, t) => `${t} (${u})`);
  // Images (<img src="..." alt="...">)
  result = result.replace(/<img\s+[^>]*src="([^"]*)"[^>]*alt="([^"]*)?"[^>]*\/?>/gi, (_m, u, a) => a ? `[img: ${a}]` : `[img]`);
  // Strip remaining unknown tags
  result = result.replace(/<[^>]+>/g, "");
  return result;
}

/** Convert ordered lists: preserve numbering, normalize format. */
export function normalizeOrderedLists(text: string): string {
  return text.replace(/^(\s*)\d+\.\s+/gm, "$11. ");
}

/** Convert task lists: - [ ] → ☐, - [x] → ☑ */
export function convertTaskLists(text: string): string {
  let result = text.replace(/^(\s*)[-*+]\s+\[ \]\s*/gm, "$1☐ ");
  result = result.replace(/^(\s*)[-*+]\s+\[x\]\s*/gim, "$1☑ ");
  return result;
}

/** Convert setext-style headings (underline with === or ---) */
export function convertSetextHeadings(text: string): string {
  let lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1] ?? "";
    const curr = lines[i] ?? "";
    if (/^=+\s*$/.test(curr)) {
      lines[i - 1] = `【${prev}】`;
      lines[i] = "";
    } else if (/^-+\s*$/.test(curr) && !prev.startsWith("|")) {
      lines[i - 1] = `【${prev}】`;
      lines[i] = "";
    }
  }
  return lines.join("\n");
}

/** Convert email-style quotes (> > >) to nested indicators. */
export function normalizeNestedBlockquotes(text: string): string {
  return text.replace(/^(>+)\s?(.*)$/gm, (_m: string, markers: string, content: string) => {
    const depth = markers.length;
    const prefix = "▎".repeat(Math.min(depth, 3));
    return `${prefix}${content}`;
  });
}

export function convertHeadings(text: string): string {
  return text.replace(/^#{1,6}\s+(.+)$/gm, (_m: string, content: string) => `\n【${content}】`);
}

export function convertStrikethrough(text: string): string {
  return text.replace(/~~([^~]+)~~/g, (_m: string, content: string) => `~${content}~`);
}

export function convertBlockquotes(text: string): string {
  return text.replace(/^>\s?(.*)$/gm, (_m: string, content: string) => `▎${content}`);
}

export function convertHorizontalRules(text: string): string {
  return text.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, "─".repeat(20));
}

export function normalizeLists(text: string): string {
  return text.replace(/^(\s*)[*+]\s/gm, "$1• ");
}

export function convertFencedCodeBlocks(text: string): string {
  return restoreFencedBlocks(extractFencedBlocks(text));
}

export function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

/**
 * Convert markdown tables to aligned plaintext.
 * Example:
 * | col1 | col2 |
 * |------|------|
 * | a    | b    |
 * →
 * ┌──────┬──────┐
 * │ col1 │ col2 │
 * ├──────┼──────┤
 * │ a    │ b    │
 * └──────┴──────┘
 */
export function convertTables(text: string): string {
  try {
    const tableRegex = /^\|(.+)\|\n\|[-| :]+\|\n((?:\|.+\|\n?)+)/gm;
    return text.replace(tableRegex, (_match: string, headerRow: string, _sep: string, bodyRows: string) => {
      if (!bodyRows || typeof bodyRows !== "string") return _match;
      const parseRow = (r: string) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const headers = parseRow(headerRow);
      const rows = bodyRows.trim().split("\n").map(parseRow);
      const colCount = headers.length;

      // Convert to bullet list — most readable in QQ, survives auto-wrap
      const result: string[] = [];
      for (const row of rows) {
        const vals: string[] = [];
        for (let ci = 0; ci < colCount; ci++) {
          const key = headers[ci] ?? "";
          const val = (row[ci] ?? "").trim();
          if (key && val) vals.push(`${key}: ${val}`);
          else if (val) vals.push(val);
        }
        result.push(`• ${vals.join(", ")}`);
      }
      return result.join("\n");
    });
  } catch {
    return text;
  }
}

// ── Main pipeline ────────────────────────────────────────────────────────

export function convertMarkdownToQQ(text: string): string {
  if (!text) return "";
  try {
    // Pre-process: extract images to CQ codes first
    let result = convertBareImageUrlsToCq(convertMarkdownImagesToCq(text));

    // Phase 1: Isolate fenced code blocks
    result = extractFencedBlocks(result);

    // Phase 2: Process inline constructs
    result = convertHtmlTags(result);
    result = convertTables(result);
    result = convertSetextHeadings(result);
    result = convertInlineCode(result);
    result = convertLinks(result);
    result = convertImages(result);
    result = convertBold(result);
    result = convertItalic(result);
    result = convertHeadings(result);
    result = convertStrikethrough(result);
    result = normalizeNestedBlockquotes(result);
    result = convertBlockquotes(result);
    result = convertHorizontalRules(result);

    // Phase 3: Normalize
    result = convertTaskLists(result);
    result = normalizeOrderedLists(result);
    result = normalizeLists(result);
    result = collapseBlankLines(result);

    // Phase 4: Restore fenced code blocks (LAST)
    result = restoreFencedBlocks(result);

    return result.replace(/\s+$/, "");
  } catch {
    return text; // never crash the pipeline
  }
}

// ── Paragraph splitting ──────────────────────────────────────────────────

export function splitAtParagraphs(text: string, limit: number): string[] {
  if (!text) return [];
  if (text.length <= limit) return [text];

  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= limit) {
      chunks.push(paragraph);
      continue;
    }
    const sentenceDelimiter = /(?<=[。！？.!?\n])\s*/g;
    let current = "";
    const sentences = paragraph.split(sentenceDelimiter).filter((s) => s.trim());
    for (const sentence of sentences) {
      const candidate = current ? `${current} ${sentence.trim()}` : sentence.trim();
      if (candidate.length <= limit) { current = candidate; continue; }
      if (current) chunks.push(current);
      if (sentence.trim().length > limit) {
        const trimmed = sentence.trim();
        for (let i = 0; i < trimmed.length; i += limit) chunks.push(trimmed.slice(i, i + limit));
        current = "";
      } else {
        current = sentence.trim();
      }
    }
    if (current) chunks.push(current);
  }
  return mergeSmallChunks(chunks, limit);
}

function mergeSmallChunks(chunks: string[], limit: number): string[] {
  if (chunks.length <= 1) return chunks;
  const merged: string[] = [];
  let current = chunks[0] ?? "";
  for (let i = 1; i < chunks.length; i++) {
    const next = chunks[i] ?? "";
    const candidate = `${current}\n\n${next}`;
    if (candidate.length <= limit) { current = candidate; }
    else { merged.push(current); current = next; }
  }
  merged.push(current);
  return merged;
}
