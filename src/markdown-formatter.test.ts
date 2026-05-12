import { describe, expect, it } from "vitest";
import {
  convertBold,
  convertBlockquotes,
  convertFencedCodeBlocks,
  convertHeadings,
  convertHorizontalRules,
  convertImages,
  convertInlineCode,
  convertLinks,
  convertMarkdownToQQ,
  convertStrikethrough,
  normalizeLists,
  splitAtParagraphs,
} from "./markdown-formatter.js";

describe("convertBold", () => {
  it("converts **bold** to QQ emphasis", () => {
    expect(convertBold("**hello**")).toBe("【hello】");
  });

  it("handles multiple bold spans", () => {
    expect(convertBold("**a** and **b**")).toBe("【a】 and 【b】");
  });

  it("does not affect text without bold", () => {
    expect(convertBold("plain text")).toBe("plain text");
  });

  it("handles CJK text inside bold", () => {
    expect(convertBold("**你好世界**")).toBe("【你好世界】");
  });

  it("handles empty string", () => {
    expect(convertBold("")).toBe("");
  });
});

describe("convertFencedCodeBlocks", () => {
  it("converts fenced block with language", () => {
    const input = "```js\nconsole.log(1)\n```";
    const expected = "[Code: js]\nconsole.log(1)\n[/Code]";
    expect(convertFencedCodeBlocks(input)).toBe(expected);
  });

  it("converts fenced block without language", () => {
    const input = "```\nhello world\n```";
    const expected = "[Code]\nhello world\n[/Code]";
    expect(convertFencedCodeBlocks(input)).toBe(expected);
  });

  it("handles multi-line code", () => {
    const input = "```py\nline1\nline2\nline3\n```";
    const expected = "[Code: py]\nline1\nline2\nline3\n[/Code]";
    expect(convertFencedCodeBlocks(input)).toBe(expected);
  });

  it("preserves text outside code blocks", () => {
    const input = "before\n```\ncode\n```\nafter";
    const result = convertFencedCodeBlocks(input);
    expect(result).toContain("before");
    expect(result).toContain("after");
    expect(result).toContain("[Code]\ncode\n[/Code]");
  });

  it("handles multiple fenced blocks", () => {
    const input = "```js\na\n```\n\n```py\nb\n```";
    const result = convertFencedCodeBlocks(input);
    expect(result).toContain("[Code: js]");
    expect(result).toContain("[Code: py]");
    expect(result).toContain("a");
    expect(result).toContain("b");
  });

  it("does not break on text with no code blocks", () => {
    expect(convertFencedCodeBlocks("plain text")).toBe("plain text");
  });
});

describe("convertInlineCode", () => {
  it("converts backtick-wrapped code", () => {
    expect(convertInlineCode("use `Array.map()` here")).toBe("use <Array.map()> here");
  });

  it("handles multiple inline code spans", () => {
    expect(convertInlineCode("`foo` and `bar`")).toBe("<foo> and <bar>");
  });

  it("does not affect text without backticks", () => {
    expect(convertInlineCode("plain text")).toBe("plain text");
  });
});

describe("convertLinks", () => {
  it("converts [text](url) to text (url)", () => {
    expect(convertLinks("[click here](https://example.com)")).toBe(
      "click here (https://example.com)",
    );
  });

  it("handles multiple links", () => {
    expect(convertLinks("[a](url1) [b](url2)")).toBe("a (url1) b (url2)");
  });

  it("does not affect text without links", () => {
    expect(convertLinks("plain text")).toBe("plain text");
  });
});

describe("convertImages", () => {
  it("converts image with alt text", () => {
    expect(convertImages("![diagram](https://example.com/img.png)")).toBe(
      "[Image: diagram] (https://example.com/img.png)",
    );
  });

  it("converts image without alt text", () => {
    expect(convertImages("![](https://example.com/img.png)")).toBe(
      "[Image: https://example.com/img.png]",
    );
  });

  it("does not affect non-image text", () => {
    expect(convertImages("hello world")).toBe("hello world");
  });
});

describe("convertHeadings", () => {
  it("converts h1 heading", () => {
    expect(convertHeadings("# Title")).toBe("【Title】");
  });

  it("converts h2 heading", () => {
    expect(convertHeadings("## Subtitle")).toBe("【Subtitle】");
  });

  it("converts h3 heading", () => {
    expect(convertHeadings("### Section")).toBe("【Section】");
  });

  it("handles multiple headings", () => {
    const input = "# A\nSome text\n## B";
    const result = convertHeadings(input);
    expect(result).toContain("【A】");
    expect(result).toContain("【B】");
    expect(result).toContain("Some text");
  });

  it("does not convert non-heading lines with #", () => {
    expect(convertHeadings("not a # heading")).toBe("not a # heading");
  });
});

describe("convertStrikethrough", () => {
  it("converts strikethrough", () => {
    expect(convertStrikethrough("~~deleted~~")).toBe("~deleted~");
  });

  it("handles multiple strikethrough spans", () => {
    expect(convertStrikethrough("~~a~~ and ~~b~~")).toBe("~a~ and ~b~");
  });
});

describe("convertBlockquotes", () => {
  it("indents blockquote lines", () => {
    expect(convertBlockquotes("> A quote")).toBe("  A quote");
  });

  it("handles multiple blockquote lines", () => {
    expect(convertBlockquotes("> line1\n> line2")).toBe("  line1\n  line2");
  });

  it("does not affect non-blockquote text", () => {
    expect(convertBlockquotes("normal text")).toBe("normal text");
  });
});

describe("convertHorizontalRules", () => {
  it("converts three dashes to dash", () => {
    expect(convertHorizontalRules("---")).toBe("—");
  });

  it("converts three asterisks to dash", () => {
    expect(convertHorizontalRules("***")).toBe("—");
  });

  it("converts three underscores to dash", () => {
    expect(convertHorizontalRules("___")).toBe("—");
  });

  it("does not convert text that is not a rule", () => {
    expect(convertHorizontalRules("not a rule")).toBe("not a rule");
  });
});

describe("normalizeLists", () => {
  it("converts asterisk list markers to dashes", () => {
    expect(normalizeLists("* item")).toBe("- item");
  });

  it("converts plus list markers to dashes", () => {
    expect(normalizeLists("+ item")).toBe("- item");
  });

  it("preserves dashed list markers", () => {
    expect(normalizeLists("- item")).toBe("- item");
  });
});

describe("splitAtParagraphs", () => {
  it("returns single chunk when text is under limit", () => {
    expect(splitAtParagraphs("short", 100)).toEqual(["short"]);
  });

  it("splits at paragraph boundaries", () => {
    const text = "Paragraph 1.\n\nParagraph 2.\n\nParagraph 3.";
    const chunks = splitAtParagraphs(text, 20);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(20);
    }
  });

  it("handles empty string", () => {
    expect(splitAtParagraphs("", 100)).toEqual([]);
  });

  it("handles text exactly at limit", () => {
    const text = "12345";
    expect(splitAtParagraphs(text, 5)).toEqual([text]);
  });

  it("merges small adjacent chunks", () => {
    const text = "A\n\nB\n\nC";
    // Each is length 1, should merge to "A\n\nB" (5 chars = under 10 limit)
    const chunks = splitAtParagraphs(text, 10);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(10);
    }
  });

  it("hard-splits a paragraph exceeding the limit", () => {
    const longText = "x".repeat(50);
    const chunks = splitAtParagraphs(longText, 10);
    expect(chunks.length).toBe(5);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(10);
    }
  });
});

describe("convertMarkdownToQQ (integration)", () => {
  it("returns empty for empty input", () => {
    expect(convertMarkdownToQQ("")).toBe("");
  });

  it("preserves plain text", () => {
    expect(convertMarkdownToQQ("hello world")).toBe("hello world");
  });

  it("converts bold in context", () => {
    expect(convertMarkdownToQQ("This is **important** text.")).toBe("This is 【important】 text.");
  });

  it("converts links in context", () => {
    expect(convertMarkdownToQQ("See [docs](https://example.com) for info.")).toBe(
      "See docs (https://example.com) for info.",
    );
  });

  it("converts fenced code blocks in context", () => {
    const input = "Here is some code:\n```js\nconst x = 1;\n```\nEnd.";
    const result = convertMarkdownToQQ(input);
    expect(result).toContain("[Code: js]");
    expect(result).toContain("[/Code]");
    expect(result).toContain("const x = 1;");
  });

  it("handles markdown inside CJK text", () => {
    expect(convertMarkdownToQQ("请注意 **这个** 重要信息")).toBe("请注意 【这个】 重要信息");
  });

  it("collapses excessive blank lines", () => {
    const input = "A\n\n\n\n\nB";
    const result = convertMarkdownToQQ(input);
    expect(result).toBe("A\n\nB");
  });

  it("handles strikethrough", () => {
    expect(convertMarkdownToQQ("This is ~~wrong~~ correct.")).toBe("This is ~wrong~ correct.");
  });

  it("handles blockquotes", () => {
    expect(convertMarkdownToQQ("> Note: this is important")).toBe("  Note: this is important");
  });

  it("handles horizontal rules", () => {
    expect(convertMarkdownToQQ("---")).toBe("—");
  });

  it("handles inline code in context", () => {
    expect(convertMarkdownToQQ("Use `console.log()` for debugging.")).toBe(
      "Use <console.log()> for debugging.",
    );
  });

  it("handles headings in context", () => {
    const input = "# Introduction\nThis is the intro.";
    const result = convertMarkdownToQQ(input);
    expect(result).toContain("【Introduction】");
    expect(result).toContain("This is the intro.");
  });

  it("handles mixed markdown constructs", () => {
    const input =
      "# Summary\n\n**Note:** See the `example` code:\n\n```js\nconst x = 1;\n```\n\n~~Old info~~ [New info](https://example.com)";
    const result = convertMarkdownToQQ(input);
    expect(result).toContain("【Summary】");
    expect(result).toContain("【Note:】");
    expect(result).toContain("<example>");
    expect(result).toContain("[Code: js]");
    expect(result).toContain("[/Code]");
    expect(result).toContain("~Old info~");
    expect(result).toContain("New info (https://example.com)");
  });

  it("does not process markdown inside fenced code blocks", () => {
    const input = "```md\n**bold** and `code`\n```";
    const result = convertMarkdownToQQ(input);
    // Code inside fences should remain untouched
    expect(result).toContain("**bold**");
    expect(result).toContain("`code`");
    // Should not have QQ-formatted bold
    expect(result).not.toContain("【bold】");
  });

  it("converts list asterisks to dashes", () => {
    const input = "* item1\n* item2";
    const result = convertMarkdownToQQ(input);
    expect(result).toContain("- item1");
    expect(result).toContain("- item2");
  });

  it("preserves numbered lists", () => {
    expect(convertMarkdownToQQ("1. first\n2. second")).toBe("1. first\n2. second");
  });

  it("handles many links", () => {
    const input = "[a](url1) [b](url2) [c](url3)";
    const result = convertMarkdownToQQ(input);
    expect(result).toBe("a (url1) b (url2) c (url3)");
  });

  it("handles many inline code spans", () => {
    const input = "`a` `b` `c`";
    const result = convertMarkdownToQQ(input);
    expect(result).toBe("<a> <b> <c>");
  });

  it("handles complex real-world agent output", () => {
    const input = `## Analysis

Based on your request, here is the breakdown:

**Key findings:**
1. The \`processData()\` function handles input validation
2. Error handling uses the \`Result<T, E>\` pattern

### Code Example

\`\`\`typescript
function processData(input: string): Result<Data, Error> {
  if (!input) return { ok: false, error: new Error("empty") };
  return { ok: true, value: parse(input) };
}
\`\`\`

~~Previous approach~~ The updated approach uses [TypeScript docs](https://typescriptlang.org).

> Note: This is the recommended pattern.`;

    const result = convertMarkdownToQQ(input);
    // Bold
    expect(result).toContain("【Key findings");
    // Inline code
    expect(result).toContain("<processData()>");
    expect(result).toContain("<Result<T, E>");
    // Fenced code
    expect(result).toContain("[Code: typescript]");
    expect(result).toContain("[/Code]");
    // Strikethrough
    expect(result).toContain("~Previous approach~");
    // Links
    expect(result).toContain("TypeScript docs (https://typescriptlang.org)");
    // Blockquotes
    expect(result).toContain("  Note: This is the recommended pattern.");
    // Headings
    expect(result).toContain("【Analysis】");
    expect(result).toContain("【Code Example】");
    // Lists preserved
    expect(result).toContain("1.");
    expect(result).toContain("2.");
  });

  it("handles null/undefined gracefully", () => {
    // @ts-expect-error testing runtime behavior
    expect(convertMarkdownToQQ(null)).toBe("");
    // @ts-expect-error testing runtime behavior
    expect(convertMarkdownToQQ(undefined)).toBe("");
  });

  it("does not mangle CQ codes in text", () => {
    const input = "Here is an image: [CQ:image,file=https://example.com/img.png] and **bold**";
    const result = convertMarkdownToQQ(input);
    expect(result).toContain("[CQ:image,file=https://example.com/img.png]");
    expect(result).toContain("【bold】");
  });
});
