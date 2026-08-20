import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as localizerModule from "@/utils/text/localizer";
import { checkTargetEmbedTitle } from "@/utils/discord/embedClassifier";

const REWARD_TITLE_KEY = "commands.reward.headpat.embed_title";
const PUNISH_TITLE_KEY = "commands.punish.bonk.embed_title";
const RESET_TITLE_KEY = "commands.refresh.title";
const HUG_TITLE_KEY = "commands.reward.hug.embed_title";

// Captured before any spy so a mocked implementation can still delegate to the real lookup.
const realLocalizer = localizerModule.localizer;
const realGetLocaleSubKeys = localizerModule.getLocaleSubKeys;

describe("checkTargetEmbedTitle", () => {
  beforeAll(async () => {
    await localizerModule.initializeLocalizer();
  });

  it("classifies a reward title and a punish title by their own types", () => {
    expect(checkTargetEmbedTitle(realLocalizer("en-US", REWARD_TITLE_KEY))).toEqual({
      isTarget: true,
      type: "reward",
    });
    expect(checkTargetEmbedTitle(realLocalizer("en-US", PUNISH_TITLE_KEY))).toEqual({
      isTarget: true,
      type: "punish",
    });
  });

  it("classifies the localized reward title in every loaded locale, not just en-US", () => {
    for (const locale of localizerModule.getSupportedLocales()) {
      expect(checkTargetEmbedTitle(realLocalizer(locale, REWARD_TITLE_KEY))).toEqual({
        isTarget: true,
        type: "reward",
      });
    }
  });

  it("still classifies a reward title that ends in a period", () => {
    // The old implementation filtered titles with `!t.includes(".")` as a proxy for "the
    // localizer echoed back the key path", which also discarded any real title punctuated
    // with a period. Only the title string is substituted here: the existence check still
    // runs against the genuine locale tree.
    const spy = spyOn(localizerModule, "localizer").mockImplementation((locale, key, variables) =>
      key === HUG_TITLE_KEY ? "Hug Time." : realLocalizer(locale, key, variables),
    );

    try {
      expect(checkTargetEmbedTitle("Hug Time.")).toEqual({ isTarget: true, type: "reward" });
    } finally {
      spy.mockRestore();
    }
  });

  it("ignores a reward sub-namespace that defines no embed_title", () => {
    const phantomKey = "commands.reward.phantom.embed_title";
    const spy = spyOn(localizerModule, "getLocaleSubKeys").mockImplementation((locale, path) =>
      path === "commands.reward"
        ? [...realGetLocaleSubKeys(locale, path), "phantom"]
        : realGetLocaleSubKeys(locale, path),
    );

    try {
      expect(checkTargetEmbedTitle(phantomKey)).toEqual({ isTarget: false, type: null });
      expect(checkTargetEmbedTitle(realLocalizer("en-US", REWARD_TITLE_KEY))).toEqual({
        isTarget: true,
        type: "reward",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("classifies the refresh title as a reset marker", () => {
    // contextPipeline slices conversation history on this marker, so a locale-key move that
    // is not mirrored here silently stops context resets instead of failing loudly.
    expect(localizerModule.hasLocaleKey("en-US", RESET_TITLE_KEY)).toBe(true);
    expect(checkTargetEmbedTitle(realLocalizer("en-US", RESET_TITLE_KEY))).toEqual({
      isTarget: true,
      type: "reset",
    });
  });

  it("does not classify an unrelated title or an empty one", () => {
    expect(checkTargetEmbedTitle("Sparrow posted a link")).toEqual({ isTarget: false, type: null });
    expect(checkTargetEmbedTitle(null)).toEqual({ isTarget: false, type: null });
  });
});
