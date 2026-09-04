import { describe, expect, it } from "bun:test";
import {
  buildTextPreview,
  CONFIRMATION_PREVIEW_BUDGET,
  CV2_TEXT_PREVIEW_BUDGET,
  textPreviewFooterKey,
  textPreviewFooterVars,
} from "@/utils/text/textPreview";

describe("buildTextPreview", () => {
  it("passes short text through untouched", () => {
    const preview = buildTextPreview("You are Ellen, a sharp-tongued librarian.");
    expect(preview.text).toBe("You are Ellen, a sharp-tongued librarian.");
    expect(preview.truncated).toBe(false);
    expect(preview.shownChars).toBe(41);
    expect(preview.totalChars).toBe(41);
  });

  it("trims surrounding whitespace before measuring", () => {
    const preview = buildTextPreview("\n\n  hello  \n");
    expect(preview.text).toBe("hello");
    expect(preview.totalChars).toBe(5);
  });

  it.each([[null], [undefined], [""], ["   \n  "]])("treats %p as having no content", (input) => {
    const preview = buildTextPreview(input);
    expect(preview.totalChars).toBe(0);
    expect(preview.text).toBe("");
    expect(preview.truncated).toBe(false);
  });

  it("neutralizes triple backticks so user text cannot escape the fence", () => {
    // A prompt containing its own code block would otherwise close the fence
    // the locale string wraps it in, mangling the rest of the card.
    const preview = buildTextPreview("intro\n```js\nalert(1)\n```\noutro");
    expect(preview.text).not.toContain("```");
    // Visible characters survive; only zero-width guards are interleaved.
    expect(preview.text.replaceAll("​", "")).toBe("intro\n```js\nalert(1)\n```\noutro");
  });

  it("neutralizes double backticks used as inline-code delimiters", () => {
    const preview = buildTextPreview("use ``code`` here");
    expect(preview.text).not.toContain("``");
  });

  it("leaves lone backticks alone", () => {
    // A single backtick cannot close a fence, so guarding it would only add noise.
    const preview = buildTextPreview("a ` b ` c");
    expect(preview.text).toBe("a ` b ` c");
  });

  it("truncates to the budget and reports counts against the original text", () => {
    const preview = buildTextPreview("x".repeat(7412));
    expect(preview.truncated).toBe(true);
    expect(preview.shownChars).toBe(CV2_TEXT_PREVIEW_BUDGET);
    expect(preview.totalChars).toBe(7412);
  });

  it("honors a caller-supplied budget", () => {
    const preview = buildTextPreview("abcdefghij", 4);
    expect(preview.text).toBe("abcd");
    expect(preview.truncated).toBe(true);
    expect(preview.shownChars).toBe(4);
    expect(preview.totalChars).toBe(10);
  });

  it("does not mark text sitting exactly on the budget as truncated", () => {
    const preview = buildTextPreview("abcd", 4);
    expect(preview.truncated).toBe(false);
    expect(preview.text).toBe("abcd");
  });

  it("leaves short confirmation previews unmarked", () => {
    // Regression guard for the old `{preview}...` locale strings, which claimed
    // truncation even for text far under the preview width.
    const preview = buildTextPreview("Speak warmly.", CONFIRMATION_PREVIEW_BUDGET);
    expect(preview.truncated).toBe(false);
    expect(textPreviewFooterKey(preview)).toBeUndefined();
  });

  it("marks confirmation previews that genuinely overflow", () => {
    const preview = buildTextPreview("y".repeat(4120), CONFIRMATION_PREVIEW_BUDGET);
    expect(preview.shownChars).toBe(CONFIRMATION_PREVIEW_BUDGET);
    expect(textPreviewFooterVars(preview)).toEqual({ shown: "200", total: "4,120" });
  });

  it("never produces a lone surrogate when cutting astral-plane text", () => {
    const input = "😀".repeat(10);
    const preview = buildTextPreview(input, 5);
    expect(preview.truncated).toBe(true);
    expect(preview.shownChars).toBe(5);
    expect(preview.totalChars).toBe(10);
    expect([...preview.text].length).toBe(5);
    expect(preview.text).toBe("😀".repeat(5));

    for (let i = 0; i < preview.text.length; i++) {
      const code = preview.text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = preview.text.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
        i++;
      } else {
        expect(code >= 0xdc00 && code <= 0xdfff).toBe(false);
      }
    }
  });

  it("measures totalChars and shownChars in codepoints rather than UTF-16 code units", () => {
    // Astral-plane emoji require 2 UTF-16 code units per codepoint.
    const emojiInput = "🎉🎈🚀🔥🌟";
    expect(emojiInput.length).toBe(10);
    expect([...emojiInput].length).toBe(5);

    const emojiPreview = buildTextPreview(emojiInput, 3);
    expect(emojiPreview.totalChars).toBe(5);
    expect(emojiPreview.shownChars).toBe(3);
    expect(emojiPreview.truncated).toBe(true);
    expect(emojiPreview.text).toBe("🎉🎈🚀");
    expect([...emojiPreview.text].length).toBe(3);

    // Basic Multilingual Plane characters remain 1 UTF-16 unit and 1 codepoint each.
    const bmpPreview = buildTextPreview("你好世界", 2);
    expect(bmpPreview.totalChars).toBe(4);
    expect(bmpPreview.shownChars).toBe(2);
    expect(bmpPreview.truncated).toBe(true);
    expect(bmpPreview.text).toBe("你好");
  });

  it("never appends an ellipsis suffix to truncated text", () => {
    const previewAscii = buildTextPreview("abcdefghij", 4);
    expect(previewAscii.text).toBe("abcd");
    expect(previewAscii.text.endsWith("...")).toBe(false);

    const previewEmoji = buildTextPreview("😀😁😂😃😄", 3);
    expect(previewEmoji.text).toBe("😀😁😂");
    expect(previewEmoji.text.endsWith("...")).toBe(false);

    const previewLong = buildTextPreview("x".repeat(5000), 100);
    expect(previewLong.text).toBe("x".repeat(100));
    expect(previewLong.text.endsWith("...")).toBe(false);
  });

  it("converges across runs of five and eight backticks leaving no adjacent backticks", () => {
    const input = "pre`````mid````````post";
    const preview = buildTextPreview(input);
    expect(preview.text).not.toContain("``");
    expect(preview.text.replaceAll("​", "")).toBe(input);
  });
});

describe("textPreviewFooter helpers", () => {
  it("omits the footer when nothing was cut", () => {
    expect(textPreviewFooterKey(buildTextPreview("short"))).toBeUndefined();
  });

  it("returns the shared truncation footer with separated counts", () => {
    const preview = buildTextPreview("x".repeat(7412));
    expect(textPreviewFooterKey(preview)).toBe("general.text_preview.truncated_footer");
    expect(textPreviewFooterVars(preview)).toEqual({ shown: "3,000", total: "7,412" });
  });
});
