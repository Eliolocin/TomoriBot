/**
 * Exact-boundary controls and adversarial tests for Discord Components V2 message limits.
 *
 * Enforces Discord's documented message component contract:
 * - at most 40 total nested components across the entire serialized tree
 * - at most 4,000 Unicode codepoints across all Text Display components
 * - Action Row and Section grammar, component cardinality, field limits, and uniqueness
 */

import { describe, expect, it } from "bun:test";
import { ButtonStyle, ComponentType, MessageFlags } from "discord.js";
import {
  DISCORD_ACTION_ROW_BUTTONS_MAX,
  DISCORD_BUTTON_LABEL_MAX,
  DISCORD_BUTTON_URL_MAX,
  DISCORD_CUSTOM_ID_MAX,
  DISCORD_MEDIA_DESCRIPTION_MAX,
  DISCORD_MEDIA_GALLERY_ITEMS_MAX,
  DISCORD_MEDIA_GALLERY_ITEMS_MIN,
  DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX,
  DISCORD_MESSAGE_TOTAL_COMPONENTS_MAX,
  DISCORD_SECTION_TEXT_DISPLAYS_MAX,
  DISCORD_SECTION_TEXT_DISPLAYS_MIN,
  DISCORD_SELECT_OPTION_DESCRIPTION_MAX,
  DISCORD_SELECT_OPTION_LABEL_MAX,
  DISCORD_SELECT_OPTION_VALUE_MAX,
  DISCORD_SELECT_OPTIONS_MAX,
  DISCORD_SELECT_OPTIONS_MIN,
  DISCORD_SELECT_PLACEHOLDER_MAX,
  assertComponentsV2MessageLimits,
  getDiscordTextLength,
  truncateDiscordText,
  validateComponentsV2MessageLimits,
  type ComponentsV2MessagePayload,
} from "@/utils/discord/ui/componentsV2Limits";
import {
  CONFIG_NAI_PRESET_NEXT_VALUE,
  CONFIG_NAI_PRESET_PAGE_SIZE,
  CONFIG_NAI_PRESET_PREVIOUS_VALUE,
} from "@/utils/discord/configPanelCatalog";
import { safeSelectOptionText } from "@/utils/discord/ui/interactionCore";

function createValidMessagePayload(): ComponentsV2MessagePayload {
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [
      {
        type: ComponentType.Container,
        components: [
          {
            type: ComponentType.Section,
            components: [
              {
                type: ComponentType.TextDisplay,
                content: "Valid section text",
              },
            ],
            accessory: {
              type: ComponentType.Button,
              customId: "sec_btn",
              label: "Click",
              style: ButtonStyle.Primary,
            },
          },
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                customId: "act_btn_1",
                label: "Action Button",
                style: ButtonStyle.Secondary,
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("componentsV2Limits Unicode truncation primitive", () => {
  it("measures text length in Unicode codepoints", () => {
    expect(getDiscordTextLength("hello")).toBe(5);
    // Emoji surrogate pair: 2 UTF-16 units but 1 Unicode codepoint
    expect(getDiscordTextLength("😀")).toBe(1);
    expect("😀".length).toBe(2);
    // Combining mark: 2 codepoints
    expect(getDiscordTextLength("e\u0301")).toBe(2);
  });

  it("truncates text without splitting surrogate pairs or combining graphemes", () => {
    expect(truncateDiscordText("hello", 10)).toBe("hello");
    expect(truncateDiscordText("hello world", 8, "...")).toBe("hello...");

    // Surrogate pair: taking 4 codepoints with suffix "..." (3) leaves budget 1.
    // "😀" is 1 codepoint and must not be split into an orphaned high surrogate.
    const emojiStr = "😀😀😀😀😀";
    const truncatedEmoji = truncateDiscordText(emojiStr, 4, "...");
    expect(truncatedEmoji).toBe("😀...");
    expect(getDiscordTextLength(truncatedEmoji)).toBe(4);

    // Combining character grapheme cluster: "e\u0301" is 1 grapheme of 2 codepoints.
    // With budget 4 and suffix "..." (3), available is 1, so "e\u0301" (2) does not fit and is not split.
    const combiningStr = "e\u0301e\u0301e\u0301";
    const truncatedCombining = truncateDiscordText(combiningStr, 4, "...");
    expect(truncatedCombining).toBe("...");
    expect(getDiscordTextLength(truncatedCombining)).toBe(3);
  });

  it("safeSelectOptionText delegates to Unicode-safe truncation", () => {
    const fits = "a".repeat(100);
    expect(safeSelectOptionText(fits, 100)).toBe(fits);

    const overlong = "a".repeat(101);
    const truncated = safeSelectOptionText(overlong, 100);
    expect(getDiscordTextLength(truncated)).toBe(100);
    expect(truncated.endsWith("...")).toBe(true);

    // 100 emojis: 100 codepoints, fits within 100 limit even though UTF-16 length is 200
    const emojis100 = "😀".repeat(100);
    expect(emojis100.length).toBe(200);
    expect(getDiscordTextLength(emojis100)).toBe(100);
    expect(safeSelectOptionText(emojis100, 100)).toBe(emojis100);

    // 101 emojis: 101 codepoints, truncated to 97 emojis + "..."
    const emojis101 = "😀".repeat(101);
    const truncatedEmojis = safeSelectOptionText(emojis101, 100);
    expect(getDiscordTextLength(truncatedEmojis)).toBe(100);
    expect(truncatedEmojis).toBe(`${"😀".repeat(97)}...`);
  });
});

describe("componentsV2Limits recursive component count boundaries", () => {
  it("accepts exact 40 components and rejects 41 components while hiding components in layout trees", () => {
    // Top-level is 1 Container.
    // Inside Container:
    // - 1 Section with 3 TextDisplays and 1 Button accessory = 5
    // - 5 ActionRows with 5 Buttons each = 5 * 6 = 30
    // - 1 ActionRow with 3 Buttons = 4
    // Container node itself = 1
    // Total nested components = 1 + 5 + 30 + 4 = 40.
    const payload40: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.Container,
          components: [
            {
              type: ComponentType.Section,
              components: [
                { type: ComponentType.TextDisplay, content: "Section T1" },
                { type: ComponentType.TextDisplay, content: "Section T2" },
                { type: ComponentType.TextDisplay, content: "Section T3" },
              ],
              accessory: {
                type: ComponentType.Button,
                customId: "btn_sec",
                label: "Sec",
                style: ButtonStyle.Primary,
              },
            },
            ...Array.from({ length: 5 }, (_, rIdx) => ({
              type: ComponentType.ActionRow as const,
              components: Array.from({ length: 5 }, (_, bIdx) => ({
                type: ComponentType.Button as const,
                customId: `btn_r${rIdx}_b${bIdx}`,
                label: `B${bIdx}`,
                style: ButtonStyle.Secondary,
              })),
            })),
            {
              type: ComponentType.ActionRow,
              components: [
                { type: ComponentType.Button, customId: "btn_last_0", label: "L0", style: ButtonStyle.Secondary },
                { type: ComponentType.Button, customId: "btn_last_1", label: "L1", style: ButtonStyle.Secondary },
                { type: ComponentType.Button, customId: "btn_last_2", label: "L2", style: ButtonStyle.Secondary },
              ],
            },
          ],
        },
      ],
    };

    // The top-level array has length 1, demonstrating that shallow length checks are insufficient.
    expect(payload40.components.length).toBe(1);
    const validResult = validateComponentsV2MessageLimits(payload40);
    expect(validResult.valid).toBe(true);
    expect(validResult.violations).toEqual([]);

    // Adding 1 button to the final ActionRow takes total to 41. Top-level length remains 1.
    const payload41: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.Container,
          components: [
            payload40.components[0].components[0],
            ...payload40.components[0].components.slice(1, 6),
            {
              type: ComponentType.ActionRow,
              components: [
                { type: ComponentType.Button, customId: "btn_last_0", label: "L0", style: ButtonStyle.Secondary },
                { type: ComponentType.Button, customId: "btn_last_1", label: "L1", style: ButtonStyle.Secondary },
                { type: ComponentType.Button, customId: "btn_last_2", label: "L2", style: ButtonStyle.Secondary },
                { type: ComponentType.Button, customId: "btn_last_3", label: "L3", style: ButtonStyle.Secondary },
              ],
            },
          ],
        },
      ],
    };

    expect(payload41.components.length).toBe(1);
    const invalidResult = validateComponentsV2MessageLimits(payload41);
    expect(invalidResult.valid).toBe(false);
    expect(invalidResult.violations).toContainEqual({
      path: "components",
      observed: 41,
      limit: DISCORD_MESSAGE_TOTAL_COMPONENTS_MAX,
      code: "TOTAL_COMPONENTS_EXCEEDED",
    });
  });
});

describe("componentsV2Limits Text Display character budget boundaries", () => {
  it("accepts exact 4,000 characters and rejects 4,001 characters across multiple Text Displays", () => {
    // 1,500 + 1,500 + 1,000 = 4,000 characters
    const payload4000: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.Container,
          components: [
            {
              type: ComponentType.Section,
              components: [
                { type: ComponentType.TextDisplay, content: "a".repeat(1500) },
                { type: ComponentType.TextDisplay, content: "b".repeat(1500) },
              ],
              accessory: {
                type: ComponentType.Button,
                customId: "btn_acc",
                label: "Acc",
                style: ButtonStyle.Primary,
              },
            },
            {
              type: ComponentType.TextDisplay,
              content: "c".repeat(1000),
            },
          ],
        },
      ],
    };

    const validResult = validateComponentsV2MessageLimits(payload4000);
    expect(validResult.valid).toBe(true);
    expect(validResult.violations).toEqual([]);

    // Increasing the third text display by 1 character reaches 4,001
    const payload4001: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.Container,
          components: [
            payload4000.components[0].components[0],
            {
              type: ComponentType.TextDisplay,
              content: "c".repeat(1001),
            },
          ],
        },
      ],
    };

    const invalidResult = validateComponentsV2MessageLimits(payload4001);
    expect(invalidResult.valid).toBe(false);
    expect(invalidResult.violations).toContainEqual({
      path: "components",
      observed: 4001,
      limit: DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX,
      code: "TEXT_DISPLAY_TOTAL_EXCEEDED",
    });
  });

  it("measures Text Display characters by Unicode codepoints for emoji payloads", () => {
    // 4,000 emojis: 4,000 codepoints, accepted even though UTF-16 length is 8,000
    const payloadEmoji4000: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: "😀".repeat(4000),
        },
      ],
    };
    expect(validateComponentsV2MessageLimits(payloadEmoji4000).valid).toBe(true);

    // 4,001 emojis: 4,001 codepoints, rejected
    const payloadEmoji4001: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: "😀".repeat(4001),
        },
      ],
    };
    const res = validateComponentsV2MessageLimits(payloadEmoji4001);
    expect(res.valid).toBe(false);
    expect(res.violations).toContainEqual({
      path: "components",
      observed: 4001,
      limit: DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX,
      code: "TEXT_DISPLAY_TOTAL_EXCEEDED",
    });
  });
});

describe("componentsV2Limits rule mutations with exact path and code assertions", () => {
  it("rejects payload missing MessageFlags.IsComponentsV2", () => {
    const payload: ComponentsV2MessagePayload = {
      ...createValidMessagePayload(),
      flags: 0,
    };
    const res = validateComponentsV2MessageLimits(payload);
    expect(res.valid).toBe(false);
    expect(res.violations).toContainEqual({
      path: "flags",
      observed: 0,
      limit: MessageFlags.IsComponentsV2,
      code: "MISSING_V2_FLAG",
    });
  });

  it("rejects forbidden legacy content, embeds, poll, and stickers fields", () => {
    const withContent = { ...createValidMessagePayload(), content: "legacy" };
    expect(validateComponentsV2MessageLimits(withContent).violations).toContainEqual({
      path: "content",
      observed: "present",
      limit: "undefined",
      code: "LEGACY_FIELD_FORBIDDEN",
    });

    const withEmbeds = { ...createValidMessagePayload(), embeds: [{ title: "hi" }] };
    expect(validateComponentsV2MessageLimits(withEmbeds).violations).toContainEqual({
      path: "embeds",
      observed: "present",
      limit: "undefined",
      code: "LEGACY_FIELD_FORBIDDEN",
    });

    const withPoll = { ...createValidMessagePayload(), poll: {} };
    expect(validateComponentsV2MessageLimits(withPoll).violations).toContainEqual({
      path: "poll",
      observed: "present",
      limit: "undefined",
      code: "LEGACY_FIELD_FORBIDDEN",
    });

    const withStickers = { ...createValidMessagePayload(), stickers: [] };
    expect(validateComponentsV2MessageLimits(withStickers).violations).toContainEqual({
      path: "stickers",
      observed: "present",
      limit: "undefined",
      code: "LEGACY_FIELD_FORBIDDEN",
    });
  });

  it("rejects invalid top-level component type", () => {
    const payload: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.Button,
          customId: "top_btn",
          label: "Top",
          style: ButtonStyle.Primary,
        } as unknown as TopLevelComponentData,
      ],
    };
    const res = validateComponentsV2MessageLimits(payload);
    expect(res.valid).toBe(false);
    expect(res.violations).toContainEqual({
      path: "components[0]",
      componentType: ComponentType.Button,
      observed: ComponentType.Button,
      limit: "top-level component type",
      code: "INVALID_TOP_LEVEL_COMPONENT",
    });
  });

  it("rejects empty Action Row", () => {
    const payload: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.ActionRow,
          components: [],
        },
      ],
    };
    const res = validateComponentsV2MessageLimits(payload);
    expect(res.valid).toBe(false);
    expect(res.violations).toContainEqual({
      path: "components[0]",
      componentType: ComponentType.ActionRow,
      observed: 0,
      limit: "1-5 buttons or 1 select",
      code: "ACTION_ROW_EMPTY",
    });
  });

  it("rejects Action Row with more than 5 buttons", () => {
    const payload: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.ActionRow,
          components: Array.from({ length: 6 }, (_, i) => ({
            type: ComponentType.Button,
            customId: `btn_${i}`,
            label: `B${i}`,
            style: ButtonStyle.Secondary,
          })),
        },
      ],
    };
    const res = validateComponentsV2MessageLimits(payload);
    expect(res.valid).toBe(false);
    expect(res.violations).toContainEqual({
      path: "components[0]",
      componentType: ComponentType.ActionRow,
      observed: 6,
      limit: DISCORD_ACTION_ROW_BUTTONS_MAX,
      code: "ACTION_ROW_OVERSIZED",
    });
  });

  it("rejects Action Row mixing buttons and select menu", () => {
    const payload: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              customId: "btn_mix",
              label: "B",
              style: ButtonStyle.Secondary,
            },
            {
              type: ComponentType.StringSelect,
              customId: "sel_mix",
              options: [{ label: "Opt", value: "opt" }],
            },
          ],
        },
      ],
    };
    const res = validateComponentsV2MessageLimits(payload);
    expect(res.valid).toBe(false);
    expect(res.violations).toContainEqual({
      path: "components[0]",
      componentType: ComponentType.ActionRow,
      observed: "buttons: 1, selects: 1",
      limit: "buttons only or 1 select",
      code: "ACTION_ROW_MIXED",
    });
  });

  it("rejects Action Row containing invalid child component", () => {
    const payload: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.TextDisplay,
              content: "Not allowed in Action Row",
            } as unknown as TopLevelComponentData,
          ],
        },
      ],
    };
    const res = validateComponentsV2MessageLimits(payload);
    expect(res.valid).toBe(false);
    expect(res.violations).toContainEqual({
      path: "components[0].components[0]",
      componentType: ComponentType.TextDisplay,
      observed: ComponentType.TextDisplay,
      limit: "Button or Select",
      code: "ACTION_ROW_INVALID_CHILD",
    });
  });

  it("rejects Section with 0 Text Displays", () => {
    const payload: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.Section,
          components: [],
          accessory: {
            type: ComponentType.Button,
            customId: "btn_sec",
            label: "Acc",
            style: ButtonStyle.Primary,
          },
        },
      ],
    };
    const res = validateComponentsV2MessageLimits(payload);
    expect(res.valid).toBe(false);
    expect(res.violations).toContainEqual({
      path: "components[0]",
      componentType: ComponentType.Section,
      observed: 0,
      limit: DISCORD_SECTION_TEXT_DISPLAYS_MIN,
      code: "SECTION_EMPTY",
    });
  });

  it("rejects Section with more than 3 Text Displays", () => {
    const payload: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.Section,
          components: Array.from({ length: 4 }, (_, i) => ({
            type: ComponentType.TextDisplay,
            content: `Text ${i}`,
          })),
          accessory: {
            type: ComponentType.Button,
            customId: "btn_sec",
            label: "Acc",
            style: ButtonStyle.Primary,
          },
        },
      ],
    };
    const res = validateComponentsV2MessageLimits(payload);
    expect(res.valid).toBe(false);
    expect(res.violations).toContainEqual({
      path: "components[0]",
      componentType: ComponentType.Section,
      observed: 4,
      limit: DISCORD_SECTION_TEXT_DISPLAYS_MAX,
      code: "SECTION_OVERSIZED",
    });
  });

  it("rejects Section containing child other than Text Display", () => {
    const payload: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.Section,
          components: [
            {
              type: ComponentType.Button,
              customId: "btn_inside_sec",
              label: "Bad child",
              style: ButtonStyle.Secondary,
            } as unknown as TopLevelComponentData,
          ],
          accessory: {
            type: ComponentType.Button,
            customId: "btn_sec",
            label: "Acc",
            style: ButtonStyle.Primary,
          },
        },
      ],
    };
    const res = validateComponentsV2MessageLimits(payload);
    expect(res.valid).toBe(false);
    expect(res.violations).toContainEqual({
      path: "components[0].components[0]",
      componentType: ComponentType.Button,
      observed: ComponentType.Button,
      limit: ComponentType.TextDisplay,
      code: "SECTION_INVALID_CHILD",
    });
  });

  it("rejects Section missing accessory or carrying invalid accessory", () => {
    const missingAcc: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.Section,
          components: [{ type: ComponentType.TextDisplay, content: "Section" }],
        } as unknown as TopLevelComponentData,
      ],
    };
    expect(validateComponentsV2MessageLimits(missingAcc).violations).toContainEqual({
      path: "components[0].accessory",
      componentType: ComponentType.Section,
      observed: "missing",
      limit: "Button or Thumbnail",
      code: "SECTION_MISSING_ACCESSORY",
    });

    const invalidAcc: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.Section,
          components: [{ type: ComponentType.TextDisplay, content: "Section" }],
          accessory: {
            type: ComponentType.StringSelect,
            customId: "sel_acc",
            options: [{ label: "Opt", value: "opt" }],
          } as unknown as TopLevelComponentData,
        },
      ],
    };
    expect(validateComponentsV2MessageLimits(invalidAcc).violations).toContainEqual({
      path: "components[0].accessory",
      componentType: ComponentType.StringSelect,
      observed: ComponentType.StringSelect,
      limit: "Button or Thumbnail",
      code: "SECTION_INVALID_ACCESSORY",
    });
  });

  it("rejects empty Container and nested Container", () => {
    const emptyContainer: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.Container,
          components: [],
        },
      ],
    };
    expect(validateComponentsV2MessageLimits(emptyContainer).violations).toContainEqual({
      path: "components[0]",
      componentType: ComponentType.Container,
      observed: 0,
      limit: "> 0",
      code: "CONTAINER_EMPTY",
    });

    const nestedContainer: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.Container,
          components: [
            {
              type: ComponentType.Container,
              components: [{ type: ComponentType.TextDisplay, content: "Nested" }],
            } as unknown as TopLevelComponentData,
          ],
        },
      ],
    };
    expect(validateComponentsV2MessageLimits(nestedContainer).violations).toContainEqual({
      path: "components[0].components[0]",
      componentType: ComponentType.Container,
      observed: ComponentType.Container,
      limit: "ActionRow, TextDisplay, Section, MediaGallery, Separator, or File",
      code: "CONTAINER_INVALID_CHILD",
    });
  });

  it("rejects String Select option count boundary violations", () => {
    const emptyOptions: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.StringSelect,
              customId: "sel_empty",
              options: [],
            },
          ],
        },
      ],
    };
    expect(validateComponentsV2MessageLimits(emptyOptions).violations).toContainEqual({
      path: "components[0].components[0].options",
      componentType: ComponentType.StringSelect,
      observed: 0,
      limit: DISCORD_SELECT_OPTIONS_MIN,
      code: "SELECT_OPTIONS_EMPTY",
    });

    const oversizedOptions: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.StringSelect,
              customId: "sel_26",
              options: Array.from({ length: 26 }, (_, i) => ({
                label: `Opt ${i}`,
                value: `opt_${i}`,
              })),
            },
          ],
        },
      ],
    };
    expect(validateComponentsV2MessageLimits(oversizedOptions).violations).toContainEqual({
      path: "components[0].components[0].options",
      componentType: ComponentType.StringSelect,
      observed: 26,
      limit: DISCORD_SELECT_OPTIONS_MAX,
      code: "SELECT_OPTIONS_OVERSIZED",
    });
  });

  it("enforces the U9b preset page boundary with both navigation sentinels", () => {
    const selectableOptions = Array.from({ length: CONFIG_NAI_PRESET_PAGE_SIZE }, (_, index) => ({
      label: `Preset ${index + 1}`,
      value: `preset-${index + 1}`,
    }));
    const boundaryOptions = [
      { label: "Previous page", value: CONFIG_NAI_PRESET_PREVIOUS_VALUE },
      ...selectableOptions,
      { label: "Next page", value: CONFIG_NAI_PRESET_NEXT_VALUE },
    ];
    const makePayload = (options: Array<{ label: string; value: string }>): ComponentsV2MessagePayload => ({
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.StringSelect,
              customId: "nai-preset-page-boundary",
              options,
            },
          ],
        },
      ],
    });

    expect(selectableOptions).toHaveLength(CONFIG_NAI_PRESET_PAGE_SIZE);
    expect(boundaryOptions).toHaveLength(25);
    expect(validateComponentsV2MessageLimits(makePayload(boundaryOptions))).toMatchObject({
      valid: true,
      violations: [],
    });

    const oversizedOptions = [...boundaryOptions, { label: "Preset 24", value: "preset-24" }];
    expect(oversizedOptions).toHaveLength(26);
    expect(validateComponentsV2MessageLimits(makePayload(oversizedOptions)).violations).toContainEqual({
      path: "components[0].components[0].options",
      componentType: ComponentType.StringSelect,
      observed: 26,
      limit: DISCORD_SELECT_OPTIONS_MAX,
      code: "SELECT_OPTIONS_OVERSIZED",
    });
  });

  it("rejects String Select overlong label, value, description, and placeholder", () => {
    const payload: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.StringSelect,
              customId: "sel_fields",
              placeholder: "p".repeat(151),
              options: [
                {
                  label: "l".repeat(101),
                  value: "v".repeat(101),
                  description: "d".repeat(101),
                },
              ],
            },
          ],
        },
      ],
    };
    const res = validateComponentsV2MessageLimits(payload);
    expect(res.violations).toContainEqual({
      path: "components[0].components[0].placeholder",
      componentType: ComponentType.StringSelect,
      observed: 151,
      limit: DISCORD_SELECT_PLACEHOLDER_MAX,
      code: "SELECT_PLACEHOLDER_OVERSIZED",
    });
    expect(res.violations).toContainEqual({
      path: "components[0].components[0].options[0].label",
      componentType: ComponentType.StringSelect,
      observed: 101,
      limit: DISCORD_SELECT_OPTION_LABEL_MAX,
      code: "SELECT_OPTION_LABEL_OVERSIZED",
    });
    expect(res.violations).toContainEqual({
      path: "components[0].components[0].options[0].value",
      componentType: ComponentType.StringSelect,
      observed: 101,
      limit: DISCORD_SELECT_OPTION_VALUE_MAX,
      code: "SELECT_OPTION_VALUE_OVERSIZED",
    });
    expect(res.violations).toContainEqual({
      path: "components[0].components[0].options[0].description",
      componentType: ComponentType.StringSelect,
      observed: 101,
      limit: DISCORD_SELECT_OPTION_DESCRIPTION_MAX,
      code: "SELECT_OPTION_DESCRIPTION_OVERSIZED",
    });
  });

  it("rejects String Select invalid minValues, maxValues, and duplicate option values", () => {
    const payload: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.StringSelect,
              customId: "sel_coherence",
              minValues: 5,
              maxValues: 1,
              options: [
                { label: "O1", value: "dup_val" },
                { label: "O2", value: "dup_val" },
              ],
            },
          ],
        },
      ],
    };
    const res = validateComponentsV2MessageLimits(payload);
    expect(res.violations).toContainEqual({
      path: "components[0].components[0].minValues",
      componentType: ComponentType.StringSelect,
      observed: 5,
      limit: "0-2",
      code: "SELECT_MIN_VALUES_INVALID",
    });
    expect(res.violations).toContainEqual({
      path: "components[0].components[0].options[1].value",
      componentType: ComponentType.StringSelect,
      observed: "duplicate_value",
      limit: "unique",
      code: "SELECT_OPTION_VALUE_DUPLICATE",
    });
  });

  it("rejects Button overlong label, link URL, empty customId, and missing customId", () => {
    const payload: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              customId: "btn_overlong_label",
              label: "l".repeat(81),
              style: ButtonStyle.Primary,
            },
            {
              type: ComponentType.Button,
              label: "Link",
              style: ButtonStyle.Link,
              url: `https://example.com/${"u".repeat(500)}`,
            },
            {
              type: ComponentType.Button,
              customId: "",
              label: "Empty CID",
              style: ButtonStyle.Secondary,
            },
            {
              type: ComponentType.Button,
              label: "No CID",
              style: ButtonStyle.Danger,
            } as unknown as TopLevelComponentData,
          ],
        },
      ],
    };
    const res = validateComponentsV2MessageLimits(payload);
    expect(res.violations).toContainEqual({
      path: "components[0].components[0].label",
      componentType: ComponentType.Button,
      observed: 81,
      limit: DISCORD_BUTTON_LABEL_MAX,
      code: "BUTTON_LABEL_OVERSIZED",
    });
    expect(res.violations).toContainEqual({
      path: "components[0].components[1].url",
      componentType: ComponentType.Button,
      observed: 520,
      limit: DISCORD_BUTTON_URL_MAX,
      code: "BUTTON_URL_OVERSIZED",
    });
    expect(res.violations).toContainEqual({
      path: "components[0].components[2].customId",
      componentType: ComponentType.Button,
      observed: 0,
      limit: "1-100 characters",
      code: "CUSTOM_ID_EMPTY",
    });
    expect(res.violations).toContainEqual({
      path: "components[0].components[3].customId",
      componentType: ComponentType.Button,
      observed: "missing",
      limit: "1-100 characters",
      code: "CUSTOM_ID_MISSING",
    });
  });

  it("rejects duplicate customId across components in the same message", () => {
    const payload: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              customId: "shared_cid",
              label: "B1",
              style: ButtonStyle.Primary,
            },
            {
              type: ComponentType.Button,
              customId: "shared_cid",
              label: "B2",
              style: ButtonStyle.Secondary,
            },
          ],
        },
      ],
    };
    const res = validateComponentsV2MessageLimits(payload);
    expect(res.violations).toContainEqual({
      path: "components[0].components[1].customId",
      componentType: ComponentType.Button,
      observed: "duplicate_custom_id",
      limit: "unique",
      code: "CUSTOM_ID_DUPLICATE",
    });
  });

  it("rejects overlong customId past 100 characters", () => {
    const payload: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              customId: "c".repeat(101),
              label: "Long CID",
              style: ButtonStyle.Primary,
            },
          ],
        },
      ],
    };
    const res = validateComponentsV2MessageLimits(payload);
    expect(res.violations).toContainEqual({
      path: "components[0].components[0].customId",
      componentType: ComponentType.Button,
      observed: 101,
      limit: DISCORD_CUSTOM_ID_MAX,
      code: "CUSTOM_ID_OVERSIZED",
    });
  });

  it("rejects invalid or duplicate explicit component id values", () => {
    const payload: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.ActionRow,
          id: -1,
          components: [
            {
              type: ComponentType.Button,
              id: 42,
              customId: "btn_id_1",
              label: "B1",
              style: ButtonStyle.Primary,
            },
            {
              type: ComponentType.Button,
              id: 42,
              customId: "btn_id_2",
              label: "B2",
              style: ButtonStyle.Secondary,
            },
          ],
        },
      ],
    };
    const res = validateComponentsV2MessageLimits(payload);
    expect(res.violations).toContainEqual({
      path: "components[0].id",
      componentType: ComponentType.ActionRow,
      observed: -1,
      limit: "positive 32-bit integer",
      code: "COMPONENT_ID_INVALID",
    });
    expect(res.violations).toContainEqual({
      path: "components[0].components[1].id",
      componentType: ComponentType.Button,
      observed: "duplicate_id",
      limit: "unique",
      code: "COMPONENT_ID_DUPLICATE",
    });
  });

  it("rejects Thumbnail overlong description past 1024 characters", () => {
    const payload: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.Section,
          components: [{ type: ComponentType.TextDisplay, content: "Thumbnail section" }],
          accessory: {
            type: ComponentType.Thumbnail,
            description: "d".repeat(1025),
            media: { url: "https://example.com/thumb.png" },
          } as unknown as TopLevelComponentData,
        },
      ],
    };
    const res = validateComponentsV2MessageLimits(payload);
    expect(res.violations).toContainEqual({
      path: "components[0].accessory.description",
      componentType: ComponentType.Thumbnail,
      observed: 1025,
      limit: DISCORD_MEDIA_DESCRIPTION_MAX,
      code: "MEDIA_DESCRIPTION_OVERSIZED",
    });
  });

  it("rejects Media Gallery empty items, oversized items, and overlong description", () => {
    const emptyGallery: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.MediaGallery,
          items: [],
        },
      ],
    };
    expect(validateComponentsV2MessageLimits(emptyGallery).violations).toContainEqual({
      path: "components[0].items",
      componentType: ComponentType.MediaGallery,
      observed: 0,
      limit: DISCORD_MEDIA_GALLERY_ITEMS_MIN,
      code: "MEDIA_GALLERY_ITEMS_EMPTY",
    });

    const oversizedGallery: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.MediaGallery,
          items: Array.from({ length: 11 }, (_, i) => ({
            media: { url: `https://example.com/${i}.png` },
          })),
        },
      ],
    };
    expect(validateComponentsV2MessageLimits(oversizedGallery).violations).toContainEqual({
      path: "components[0].items",
      componentType: ComponentType.MediaGallery,
      observed: 11,
      limit: DISCORD_MEDIA_GALLERY_ITEMS_MAX,
      code: "MEDIA_GALLERY_ITEMS_OVERSIZED",
    });

    const overlongDescGallery: ComponentsV2MessagePayload = {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.MediaGallery,
          items: [
            {
              media: { url: "https://example.com/item.png" },
              description: "d".repeat(1025),
            },
          ],
        },
      ],
    };
    expect(validateComponentsV2MessageLimits(overlongDescGallery).violations).toContainEqual({
      path: "components[0].items[0].description",
      componentType: ComponentType.MediaGallery,
      observed: 1025,
      limit: DISCORD_MEDIA_DESCRIPTION_MAX,
      code: "MEDIA_DESCRIPTION_OVERSIZED",
    });
  });
});

describe("assertComponentsV2MessageLimits error handling", () => {
  it("does not throw for valid payload and throws ComponentsV2LimitError for invalid payload", () => {
    const valid = createValidMessagePayload();
    expect(() => assertComponentsV2MessageLimits(valid)).not.toThrow();

    const invalid = { ...valid, flags: 0 };
    expect(() => assertComponentsV2MessageLimits(invalid)).toThrowError(
      /Components V2 payload exceeded Discord limits/,
    );
  });
});
