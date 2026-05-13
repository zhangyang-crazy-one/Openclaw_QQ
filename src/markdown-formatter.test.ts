import { describe, expect, it } from "vitest";
import {
  convertMarkdownToQQ, convertBold, convertInlineCode, convertLinks,
  convertHeadings, convertBlockquotes, convertFencedCodeBlocks, normalizeLists,
  splitAtParagraphs,
} from "./markdown-formatter.js";

describe("convertBold", () => {
  it("preserves **bold** as-is", () => {
    expect(convertBold("hello **world**")).toBe("hello **world**");
  });
});

describe("convertInlineCode", () => {
  it("preserves `code` as-is", () => {
    expect(convertInlineCode("use `Array.map()` here")).toBe("use `Array.map()` here");
  });
});

describe("convertBlockquotes", () => {
  it("> -> | prefix", () => {
    expect(convertBlockquotes("> quoted text")).toBe("▎quoted text");
  });
});

describe("convertHeadings", () => {
  it("adds ASCII separator bars", () => {
    const result = convertHeadings("## Hello");
    expect(result).toContain("Hello");
    expect(result).toContain("----");
  });
});

describe("normalizeLists", () => {
  it("* -> -", () => expect(normalizeLists("* item")).toBe("• item"));
  it("+ -> -", () => expect(normalizeLists("+ item")).toBe("• item"));
});

describe("convertFencedCodeBlocks", () => {
  it("ASCII code block with language", () => {
    const result = convertFencedCodeBlocks("```js\nconsole.log(1)\n```");
    expect(result).toContain("┌── js ──");
    expect(result).toContain("│ console.log(1)");
    expect(result).toContain("+--");
  });
});

describe("convertMarkdownToQQ", () => {
  it("bold preserved", () => {
    expect(convertMarkdownToQQ("【bold】")).toContain("【bold】");
  });
  it("code blocks ASCII", () => {
    const r = convertMarkdownToQQ("```js\n1+1\n```");
    expect(r).toContain("┌── js ──");
    expect(r).toContain("│ 1+1");
  });
  it("blockquote ASCII", () => {
    expect(convertMarkdownToQQ("> q")).toContain("▎q");
  });
  it("links", () => {
    expect(convertMarkdownToQQ("[a](b)")).toBe("a (b)");
  });
  it("lists", () => {
    expect(convertMarkdownToQQ("* item")).toBe("• item");
  });
  it("empty", () => expect(convertMarkdownToQQ("")).toBe(""));
  it("image -> CQ", () => {
    expect(convertMarkdownToQQ("![x](https://x.com/p.png)")).toContain("[CQ:image");
  });
});

describe("splitAtParagraphs", () => {
  it("short text", () => {
    expect(splitAtParagraphs("hello", 100)).toEqual(["hello"]);
  });
  it("respects limit", () => {
    const chunks = splitAtParagraphs("x".repeat(500) + "\n\n" + "y".repeat(500), 300);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(300);
  });
});
