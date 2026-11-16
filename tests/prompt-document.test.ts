import { describe, expect, it } from "vitest";
import {
  serializePromptDocument,
  type PromptDocumentNode,
} from "../src/generation/prompt-document";

const text = (value: string): PromptDocumentNode => ({
  type: "text",
  text: value,
});
const br = (): PromptDocumentNode => ({ type: "break" });
const mention = (token: string): PromptDocumentNode => ({
  type: "mention",
  token,
});
const inline = (...children: PromptDocumentNode[]): PromptDocumentNode => ({
  type: "element",
  block: false,
  children,
});
const block = (...children: PromptDocumentNode[]): PromptDocumentNode => ({
  type: "element",
  block: true,
  children,
});
const read = (...children: PromptDocumentNode[]) =>
  serializePromptDocument(inline(...children));

describe("prompt editor line serialization", () => {
  it("keeps the newline inserted by Chromium Enter, then subsequent text", () => {
    expect(read(text("A"))).toBe("A");
    // insertLineBreak under white-space: pre-wrap includes a final caret newline.
    expect(read(text("A\n\n"))).toBe("A\n");
    expect(read(text("A\nB"))).toBe("A\nB");
  });

  it("preserves multiple native Enter presses and a final empty line", () => {
    expect(read(text("A\n\n\n"))).toBe("A\n\n");
    expect(read(text("\n\n"))).toBe("\n");
    expect(read(text("\n"))).toBe("");
  });

  it("reads rendered BR lines and removes only the final placeholder", () => {
    expect(read(text("A"), br(), br())).toBe("A\n");
    expect(read(text("A"), br(), br(), br())).toBe("A\n\n");
    expect(read(text("A"), br(), text("B"))).toBe("A\nB");
    expect(read(br())).toBe("");
    expect(read(br(), br())).toBe("\n");
  });

  it("keeps leading lines without trimming the prompt text", () => {
    expect(read(br(), text("A"))).toBe("\nA");
    expect(read(br(), br(), text("A"))).toBe("\n\nA");
  });

  it("separates adjacent DIV or P line wrappers including empty wrappers", () => {
    expect(read(block(text("A")), block(text("B")))).toBe("A\nB");
    expect(read(block(text("A")), block(br()), block(text("B")))).toBe(
      "A\n\nB",
    );
    expect(read(block(text("A")), block(), block(text("B")))).toBe("A\n\nB");
    expect(read(block(text("A")), block(br()))).toBe("A\n");
    expect(read(block(br()), block(text("B")))).toBe("\nB");
    expect(read(block(br()), block(br()))).toBe("\n");
  });

  it("preserves each of several empty block lines", () => {
    expect(
      read(block(text("A")), block(br()), block(br()), block(text("B"))),
    ).toBe("A\n\n\nB");
  });

  it("trims the caret placeholder within each block independently", () => {
    expect(read(block(text("A"), br()), block(text("B"), br()))).toBe("A\nB");
    expect(read(block(text("A\n\n")), block(text("B")))).toBe("A\n\nB");
    expect(read(block(text("A"), br(), br()), block(text("B")))).toBe("A\n\nB");
  });

  it("separates block and inline content while honoring an existing line break", () => {
    expect(read(text("A"), block(text("B")))).toBe("A\nB");
    expect(read(block(text("A")), text("B"))).toBe("A\nB");
    expect(read(text("A"), br(), block(text("B")))).toBe("A\nB");
    expect(read(text("A\n"), block(text("B")))).toBe("A\nB");
  });

  it("keeps inline wrapper content on the same line", () => {
    expect(read(text("A"), inline(text("B")), text("C"))).toBe("ABC");
    expect(read(text("A"), inline(br()), text("B"))).toBe("A\nB");
    expect(read(inline(text("A"), br()))).toBe("A\n");
  });
});

describe("prompt editor mention and whitespace serialization", () => {
  const token = "@[图片1](draw-studio:node-1)";

  it("treats mentions as atomic tokens, without serializing their chip labels", () => {
    expect(read(text("Use "), mention(token), text(" as reference"))).toBe(
      "Use " + token + " as reference",
    );
    expect(read(mention(token), mention("@[视频2](draw-studio:node-2)"))).toBe(
      token + "@[视频2](draw-studio:node-2)",
    );
  });

  it("keeps Enter after a chip and text typed on its next line", () => {
    expect(read(mention(token), br(), br())).toBe(token + "\n");
    expect(read(mention(token), text("\n\n"))).toBe(token + "\n");
    expect(read(mention(token), br(), text("B"))).toBe(token + "\nB");
  });

  it("normalizes native nonbreaking spaces while preserving leading/trailing spaces", () => {
    expect(read(text("  A\u00a0 B  "))).toBe("  A  B  ");
    expect(read(mention(token), text("\u00a0"))).toBe(token + " ");
    expect(read(text(" \u00a0"), mention(token), text("\u00a0 "))).toBe(
      "  " + token + "  ",
    );
  });

  it("handles an empty prompt and empty inline wrappers", () => {
    expect(read()).toBe("");
    expect(read(inline())).toBe("");
    expect(read(text(""))).toBe("");
  });
});

describe("selection fragments", () => {
  it("preserves an actual terminal newline in a partial selection", () => {
    expect(serializePromptDocument(inline(text("A"), br()), false)).toBe("A\n");
    expect(serializePromptDocument(inline(text("A\n")), false)).toBe("A\n");
    expect(serializePromptDocument(inline(br(), br()), false)).toBe("\n\n");
  });

  it("preserves selected leading and trailing spaces next to an atomic chip", () => {
    const token = "@[图片1](draw-studio:node-1)";
    expect(
      serializePromptDocument(
        inline(text(" "), mention(token), text("\u00a0")),
        false,
      ),
    ).toBe(" " + token + " ");
  });

  it("still removes local block placeholders within partial selections", () => {
    expect(
      serializePromptDocument(
        inline(block(text("A"), br()), block(br()), block(text("B"))),
        false,
      ),
    ).toBe("A\n\nB");
  });

  it("trims exactly one placeholder when the selection reaches the editor end", () => {
    expect(serializePromptDocument(inline(text("A"), br(), br()), true)).toBe(
      "A\n",
    );
    expect(serializePromptDocument(inline(text("A\n\n")), true)).toBe("A\n");
  });
});
