/**
 * Markdown-to-QQ text formatter.
 *
 * QQ (via OneBot) does not render markdown natively. This module converts
 * common markdown constructs into QQ-compatible plain-text representations
 * so agent responses are readable for QQ users.
 *
 * All functions are pure — they take a string and return a string.
 */

let fencedBlockRegistry: string[] = [];
const fencedPlaceholder = (i: number) => `__FENCED_BLOCK_${i}__`;

/**
 * Extract fenced code blocks and replace them with placeholders.
 * Returns text with placeholders inserted. The caller must call
 * restoreFencedBlocks() after all other markdown processing.
 */
export function extractFencedBlocks(text: string): string {
  fencedBlockRegistry = [];
  // Match ```optionalLang\ncontent\n``` — content is non-greedy per block
  const fencedRegex = /```(\w*)\n([\s\S]*?)```/g;

  return text.replace(fencedRegex, (_match, lang, code) => {
    const idx = fencedBlockRegistry.length;
    const langLabel = lang ? `Code: ${lang}` : "Code";
    // Remove trailing newline if present before the closing backticks
    const cleanCode = code.endsWith("\n") ? code.slice(0, -1) : code;
    fencedBlockRegistry.push(`[${langLabel}]\n${cleanCode}\n[/Code]`);
    return fencedPlaceholder(idx);
  });
}

/**
 * Restore fenced code blocks from their placeholders.
 * Must be called LAST, after all other markdown processing.
 */
export function restoreFencedBlocks(text: string): string {
  let result = text;
  for (let i = 0; i < fencedBlockRegistry.length; i++) {
    result = result.replace(fencedPlaceholder(i), fencedBlockRegistry[i] ?? "");
  }
  return result;
}

/**
 * Convert fenced code blocks (```lang\ncode\n```) to QQ-readable form.
 * Public convenience function for standalone use (extract + restore in one call).
 * NOTE: For use within convertMarkdownToQQ, prefer the two-phase approach
 * (extractFencedBlocks + restoreFencedBlocks) to properly isolate code content.
 */
export function convertFencedCodeBlocks(text: string): string {
  const extracted = extractFencedBlocks(text);
  return restoreFencedBlocks(extracted);
}

/**
 * Convert inline code spans (`code`) to QQ-readable form.
 * Must be called AFTER fenced code blocks are converted (so backticks
 * inside fenced blocks aren't misinterpreted).
 */
export function convertInlineCode(text: string): string {
  return text.replace(/`([^`]+)`/g, (_match, code) => `<${code}>`);
}

/**
 * Convert bold markdown (**text**) to QQ-compatible emphasis.
 */
export function convertBold(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, (_match, content) => `【${content}】`);
}

/**
 * Convert italic markdown (*text* or _text_) — keep as-is since QQ
 * displays asterisks and underscores natively. This is a no-op but
 * kept for explicit documentation of the design decision.
 */
export function convertItalic(text: string): string {
  // QQ displays *text* and _text_ natively — no conversion needed
  return text;
}

/**
 * Convert markdown links [text](url) to text (url) format.
 */
export function convertLinks(text: string): string {
  return text.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_match, linkText, url) => `${linkText} (${url})`,
  );
}

/**
 * Convert markdown images ![alt](url) to a plain text reference.
 * (Primary image→CQ conversion is handled by cqcode.ts before formatting.)
 */
export function convertImages(text: string): string {
  return text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, url) => {
    if (alt) {
      return `[Image: ${alt}] (${url})`;
    }
    return `[Image: ${url}]`;
  });
}

/**
 * Convert ATX headings (# Heading, ## Heading, etc.) to QQ-compatible form.
 */
export function convertHeadings(text: string): string {
  return text.replace(/^#{1,6}\s+(.+)$/gm, (_match, content) => `【${content}】`);
}

/**
 * Convert strikethrough (~~text~~) to QQ-readable form.
 */
export function convertStrikethrough(text: string): string {
  return text.replace(/~~([^~]+)~~/g, (_match, content) => `~${content}~`);
}

/**
 * Convert blockquotes (> quote) — indent with spaces.
 */
export function convertBlockquotes(text: string): string {
  return text.replace(/^>\s?(.*)$/gm, (_match, content) => `  ${content}`);
}

/**
 * Convert horizontal rules (---, ***, ___) to a dash.
 */
export function convertHorizontalRules(text: string): string {
  return text.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, "—"); // em dash
}

/**
 * Normalize list markers — QQ renders `- item` and `1. item` natively,
 * but normalize inconsistent prefixes (e.g., `* item` → `- item`).
 */
export function normalizeLists(text: string): string {
  return text.replace(/^(\s*)[*+]\s/gm, "$1- ");
}

/**
 * Collapse excessive blank lines (3+ consecutive newlines → 2).
 */
export function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

/**
 * Convert all supported markdown to QQ-readable text.
 *
 * Transformation order matters:
 * 1. Fenced code blocks first (they contain raw text that must be isolated)
 * 2. Inline code (after fenced blocks, so backticks inside blocks are safe)
 * 3. Images (after links, so [text](url) doesn't match image syntax)
 *    Note: Links convert before images since image markdown starts with !
 * 4. Links
 * 5. Bold
 * 6. Italic
 * 7. Headings
 * 8. Strikethrough
 * 9. Blockquotes
 * 10. Horizontal rules
 * 11. List normalization
 * 12. Whitespace cleanup
 *
 * @param text - Raw markdown text from the agent
 * @returns QQ-compatible formatted text
 */
export function convertMarkdownToQQ(text: string): string {
  if (!text) {
    return "";
  }

  let result = text;

  // Phase 1: Extract fenced code blocks into placeholders (do NOT restore yet)
  result = extractFencedBlocks(result);

  // Phase 2: Process remaining inline constructs on placeholder-containing text
  result = convertInlineCode(result);
  result = convertLinks(result);
  result = convertImages(result);
  result = convertBold(result);
  result = convertItalic(result);
  result = convertHeadings(result);
  result = convertStrikethrough(result);
  result = convertBlockquotes(result);
  result = convertHorizontalRules(result);

  // Phase 3: Normalize and cleanup (before restoring code blocks)
  result = normalizeLists(result);
  result = collapseBlankLines(result);

  // Phase 4: Restore fenced code blocks (LAST — so code content is untouched)
  result = restoreFencedBlocks(result);

  // Trim trailing whitespace only (preserve leading blockquote indentation)
  result = result.replace(/\s+$/, "");

  return result;
}

/**
 * Split text at paragraph boundaries (double newline), respecting a
 * character limit as an upper bound for each chunk.
 *
 * Strategy:
 * - Split at \n\n boundaries first
 * - When a single paragraph exceeds the limit, fall back to sentence-level
 *   splitting at common punctuation boundaries
 * - Ensure no chunk exceeds the limit
 *
 * @param text - The text to split
 * @param limit - Maximum character count per chunk
 * @returns Array of text chunks, each within the limit
 */
export function splitAtParagraphs(text: string, limit: number): string[] {
  if (!text) {
    return [];
  }
  if (text.length <= limit) {
    return [text];
  }

  // Split at paragraph boundaries
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= limit) {
      chunks.push(paragraph);
      continue;
    }

    // Paragraph exceeds limit — try sentence splitting
    const sentenceDelimiter = /(?<=[。！？.!?\n])\s*/g;
    let current = "";

    const sentences = paragraph.split(sentenceDelimiter).filter((s) => s.trim());
    for (const sentence of sentences) {
      const candidate = current ? `${current} ${sentence.trim()}` : sentence.trim();
      if (candidate.length <= limit) {
        current = candidate;
        continue;
      }

      // Push accumulated text
      if (current) {
        chunks.push(current);
      }

      // If a single sentence exceeds the limit, hard-chop it
      if (sentence.trim().length > limit) {
        const trimmed = sentence.trim();
        for (let i = 0; i < trimmed.length; i += limit) {
          chunks.push(trimmed.slice(i, i + limit));
        }
        current = "";
      } else {
        current = sentence.trim();
      }
    }

    if (current) {
      chunks.push(current);
    }
  }

  // Merge adjacent small chunks to avoid too many tiny messages
  return mergeSmallChunks(chunks, limit);
}

/**
 * Merge adjacent chunks that can fit together within the limit.
 */
function mergeSmallChunks(chunks: string[], limit: number): string[] {
  if (chunks.length <= 1) {
    return chunks;
  }

  const merged: string[] = [];
  let current = chunks[0] ?? "";

  for (let i = 1; i < chunks.length; i++) {
    const next = chunks[i] ?? "";
    const candidate = `${current}\n\n${next}`;
    if (candidate.length <= limit) {
      current = candidate;
    } else {
      merged.push(current);
      current = next;
    }
  }

  merged.push(current);
  return merged;
}
