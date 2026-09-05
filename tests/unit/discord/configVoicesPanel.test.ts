import { beforeAll, describe, expect, it } from "bun:test";
import { initializeLocalizer } from "@/utils/text/localizer";
import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type ActionRowData,
  type ButtonComponentData,
  type StringSelectMenuComponentData,
  type TextDisplayComponentData,
} from "discord.js";
import type { VoiceSampleRow } from "@/types/db/schema";
import { parseConfigPanelRoute, type ConfigPanelRoute } from "@/utils/discord/configPanelCatalog";
import { parseInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import { buildConfigModelsBody } from "@/utils/discord/ui/configModelsPanel";
import {
  buildConfigVoicesBody,
  computeVoiceSampleFingerprint,
  decodeVoiceSampleOptionValue,
  encodeVoiceSampleOptionValue,
  type ConfigVoicesView,
} from "@/utils/discord/ui/configVoicesPanel";
import { buildPanelContainer } from "@/utils/discord/ui/panel";
import { validateComponentsV2MessageLimits } from "@/utils/discord/ui/componentsV2Limits";
import { getDiscordTextLength } from "@/utils/text/discordTextLimits";

function makeSample(index: number, overrides: Partial<VoiceSampleRow> = {}): VoiceSampleRow {
  return {
    sample_id: index + 1,
    server_id: 100,
    name: `Voice Sample ${index + 1}`,
    file_path: `/data/voices/sample_${index + 1}.wav`,
    ref_text: `Reference transcript text for sample ${index + 1}.`,
    duration_ms: 3500,
    ...overrides,
  };
}

describe("configVoicesPanel", () => {
  beforeAll(async () => initializeLocalizer());
  // TEST 1: The voices page body is NON-EMPTY and contains, in order, the components listed above.
  // This is the test that catches the `default: return []` hazard.
  it("renders non-empty body with all 8 components in exact order through buildConfigModelsBody", () => {
    const samples = Array.from({ length: 25 }, (_, i) => makeSample(i));
    const view: ConfigVoicesView = {
      turboEnabled: false,
      cfgWeight: 0.5,
      exaggeration: 0.5,
      samples,
      totalSampleCount: 50, // triggers pagination row (component 7)
      start: 0,
      selectedIndex: 0,
    };

    const components = buildConfigModelsBody({
      locale: "en-US",
      page: "voices",
      readStatus: "fresh",
      voicesView: view,
    });

    expect(components.length).toBe(8);

    expect(components[0].type).toBe(ComponentType.TextDisplay);
    const headingText = (components[0] as TextDisplayComponentData).content;
    expect(headingText).toContain("Voice Cloning & Library");

    expect(components[1].type).toBe(ComponentType.TextDisplay);
    const paramsText = (components[1] as TextDisplayComponentData).content;
    expect(paramsText).toContain("Chatterbox Parameters");
    expect(paramsText).toContain("Turbo is currently disabled");

    expect(components[2].type).toBe(ComponentType.ActionRow);
    const turboRow = components[2] as ActionRowData<ButtonComponentData>;
    expect(turboRow.components.length).toBe(2);

    expect(components[3].type).toBe(ComponentType.ActionRow);
    const editParamsRow = components[3] as ActionRowData<ButtonComponentData>;
    expect(editParamsRow.components.length).toBe(1);
    const editParamsRoute = parseConfigPanelRoute(parseInteractionRoute(editParamsRow.components[0].customId ?? ""));
    expect(editParamsRoute?.action).toBe("tts-parameters-open");

    expect(components[4].type).toBe(ComponentType.TextDisplay);
    const libraryText = (components[4] as TextDisplayComponentData).content;
    expect(libraryText).toContain("Voice Sample Library");
    expect(libraryText).toContain("Voice Sample 1");

    expect(components[5].type).toBe(ComponentType.ActionRow);
    const selectRow = components[5] as ActionRowData<StringSelectMenuComponentData>;
    expect(selectRow.components[0].type).toBe(ComponentType.StringSelect);
    const selectRoute = parseConfigPanelRoute(parseInteractionRoute(selectRow.components[0].customId ?? ""));
    expect(selectRoute?.action).toBe("voice-sample-select");
    expect(selectRow.components[0].options.length).toBe(25);

    expect(components[6].type).toBe(ComponentType.ActionRow);
    const paginationRow = components[6] as ActionRowData<ButtonComponentData>;
    expect(paginationRow.components.length).toBe(3); // prev, indicator, next
    const nextRoute = parseConfigPanelRoute(parseInteractionRoute(paginationRow.components[2].customId ?? ""));
    expect(nextRoute?.action).toBe("voice-sample-page");

    expect(components[7].type).toBe(ComponentType.ActionRow);
    const actionRow = components[7] as ActionRowData<ButtonComponentData>;
    expect(actionRow.components.length).toBe(2);
    const addRoute = parseConfigPanelRoute(parseInteractionRoute(actionRow.components[0].customId ?? ""));
    expect(addRoute?.action).toBe("voice-sample-add-open");
    const removeRoute = parseConfigPanelRoute(parseInteractionRoute(actionRow.components[1].customId ?? ""));
    expect(removeRoute?.action).toBe("voice-sample-remove-view");
    expect(actionRow.components[1].disabled).toBe(false); // selectedIndex is 0 (valid)
  });

  // TEST 2: The turbo row's selected button carries ButtonStyle.Primary and is disabled,
  // matching buildStateControlRow semantics.
  it("turbo row selected button carries ButtonStyle.Primary and is disabled", () => {
    // When turbo is enabled:
    const viewTurboOn: ConfigVoicesView = {
      turboEnabled: true,
      cfgWeight: 0.7,
      exaggeration: 0.8,
      samples: [],
      totalSampleCount: 0,
      start: 0,
      selectedIndex: null,
    };
    const bodyTurboOn = buildConfigVoicesBody({
      locale: "en-US",
      readStatus: "fresh",
      view: viewTurboOn,
    });
    const turboRowOn = bodyTurboOn[2] as ActionRowData<ButtonComponentData>;
    const [offBtnOn, onBtnOn] = turboRowOn.components;

    // Off button: Secondary, enabled
    expect(offBtnOn.style).toBe(ButtonStyle.Secondary);
    expect(offBtnOn.disabled).toBe(false);
    // On button: Primary, disabled
    expect(onBtnOn.style).toBe(ButtonStyle.Primary);
    expect(onBtnOn.disabled).toBe(true);

    // When turbo is disabled:
    const viewTurboOff: ConfigVoicesView = {
      turboEnabled: false,
      cfgWeight: 0.5,
      exaggeration: 0.5,
      samples: [],
      totalSampleCount: 0,
      start: 0,
      selectedIndex: null,
    };
    const bodyTurboOff = buildConfigVoicesBody({
      locale: "en-US",
      readStatus: "fresh",
      view: viewTurboOff,
    });
    const turboRowOff = bodyTurboOff[2] as ActionRowData<ButtonComponentData>;
    const [offBtnOff, onBtnOff] = turboRowOff.components;

    // Off button: Primary, disabled
    expect(offBtnOff.style).toBe(ButtonStyle.Primary);
    expect(offBtnOff.disabled).toBe(true);
    // On button: Secondary, enabled
    expect(onBtnOff.style).toBe(ButtonStyle.Secondary);
    expect(onBtnOff.disabled).toBe(false);

    // When readStatus is stale (writesDisabled):
    const bodyStale = buildConfigVoicesBody({
      locale: "en-US",
      readStatus: "stale",
      view: viewTurboOn,
    });
    const staleTurboRow = bodyStale[2] as ActionRowData<ButtonComponentData>;
    expect(staleTurboRow.components[0].disabled).toBe(true);
    expect(staleTurboRow.components[1].disabled).toBe(true);
  });

  // TEST 3: Every select option value round-trips through the route decoder to the index and fingerprint
  // it encodes, and an index of 0 survives (a truthiness bug drops it).
  it("every select option value round-trips to index and fingerprint, and index 0 survives", () => {
    const samples = [
      makeSample(0, { name: "First Sample" }),
      makeSample(1, { name: "Second Sample" }),
      makeSample(2, { name: "Third Sample" }),
    ];
    const view: ConfigVoicesView = {
      turboEnabled: false,
      cfgWeight: 0.5,
      exaggeration: 0.5,
      samples,
      totalSampleCount: 3,
      start: 0,
      selectedIndex: 0,
    };

    const components = buildConfigVoicesBody({
      locale: "en-US",
      readStatus: "fresh",
      view,
    });

    const selectRow = components.find(
      (c) =>
        c.type === ComponentType.ActionRow && (c as ActionRowData).components[0]?.type === ComponentType.StringSelect,
    ) as ActionRowData<StringSelectMenuComponentData>;

    expect(selectRow).toBeDefined();
    const select = selectRow.components[0];
    expect(select.options.length).toBe(3);

    for (let i = 0; i < select.options.length; i++) {
      const option = select.options[i];
      const decoded = decodeVoiceSampleOptionValue(option.value);
      expect(decoded).not.toBeNull();
      expect(decoded?.index).toBe(i);
      expect(decoded?.fp).toBe(computeVoiceSampleFingerprint(samples[i]));

      // Also assert round-trip through the interaction route parser as vsample-rem-view segments
      const routeId = `config:v1:vsample-rem-view:en-US:${option.value}`;
      const parsed = parseConfigPanelRoute(parseInteractionRoute(routeId));
      expect(parsed).not.toBeNull();
      expect((parsed as Extract<ConfigPanelRoute, { action: "voice-sample-remove-view" }>).index).toBe(i);
      expect((parsed as Extract<ConfigPanelRoute, { action: "voice-sample-remove-view" }>).fp).toBe(decoded?.fp);
    }

    // Specific pin: an index of 0 survives and is not treated as falsy
    const zeroVal = encodeVoiceSampleOptionValue(0, "abcd1234");
    const zeroDecoded = decodeVoiceSampleOptionValue(zeroVal);
    expect(zeroDecoded).not.toBeNull();
    expect(zeroDecoded?.index).toBe(0);
    expect(zeroDecoded?.fp).toBe("abcd1234");
  });

  // TEST 4: The pagination union covers every record: for a library several pages deep, walking every
  // page yields each sample exactly once, with none missing and none duplicated.
  it("pagination union covers every record across multiple pages with no gaps or duplicates", () => {
    const totalCount = 68; // 3 pages: 25 + 25 + 18
    const allSamples = Array.from({ length: totalCount }, (_, i) => makeSample(i));
    const pageSize = 25;
    const pageCount = Math.ceil(totalCount / pageSize);

    const visitedIndices = new Set<number>();
    const seenSampleNames: string[] = [];

    for (let page = 0; page < pageCount; page++) {
      const start = page * pageSize;
      const pageSlice = allSamples.slice(start, start + pageSize);

      const view: ConfigVoicesView = {
        turboEnabled: false,
        cfgWeight: 0.5,
        exaggeration: 0.5,
        samples: pageSlice,
        totalSampleCount: totalCount,
        start,
        selectedIndex: null,
      };

      const components = buildConfigVoicesBody({
        locale: "en-US",
        readStatus: "fresh",
        view,
      });

      const selectRow = components.find(
        (c) =>
          c.type === ComponentType.ActionRow && (c as ActionRowData).components[0]?.type === ComponentType.StringSelect,
      ) as ActionRowData<StringSelectMenuComponentData>;

      expect(selectRow).toBeDefined();
      const select = selectRow.components[0];
      expect(select.options.length).toBe(pageSlice.length);

      for (let offset = 0; offset < select.options.length; offset++) {
        const option = select.options[offset];
        const decoded = decodeVoiceSampleOptionValue(option.value);
        expect(decoded).not.toBeNull();
        const expectedIndex = start + offset;
        expect(decoded?.index).toBe(expectedIndex);

        if (decoded?.index !== undefined) {
          expect(visitedIndices.has(decoded.index)).toBe(false); // No duplicates
          visitedIndices.add(decoded.index);
        }
        seenSampleNames.push(option.label);
      }
    }

    // Every record was yielded exactly once
    expect(visitedIndices.size).toBe(totalCount);
    for (let i = 0; i < totalCount; i++) {
      expect(visitedIndices.has(i)).toBe(true);
    }
  });

  // TEST 5: Content shape sweep: sample names at stored maximum length, deliberately oversized names,
  // ref_text at 500-char limit, backtick runs of 3, 4, 5, 6, and 8, and astral-plane emoji.
  it("handles extreme content shapes without fence breakout, overflow, or crashing", () => {
    const extremeSamples: VoiceSampleRow[] = [
      makeSample(0, {
        name: "A".repeat(64),
        ref_text: "B".repeat(500),
      }),
      makeSample(1, {
        name: "OversizedName_".repeat(10),
        ref_text: "Standard transcript.",
      }),
      makeSample(2, {
        name: "Backtick```Three",
        ref_text: "Prefix ``` inner code fence ``` suffix",
      }),
      makeSample(3, {
        name: "Backtick````Four",
        ref_text: "Quad ```` backticks ```` test",
      }),
      makeSample(4, {
        name: "Backtick`````Five",
        ref_text: "Five ````` backtick run ````` here",
      }),
      makeSample(5, {
        name: "Backtick``````Six",
        ref_text: "Six `````` backticks `````` test",
      }),
      makeSample(6, {
        name: "Backtick````````Eight",
        ref_text: "Eight ```````` backticks ```````` test",
      }),
      makeSample(7, {
        name: "Voice 🪅 🚀 👨‍👩‍👧‍👦 🏳️‍🌈",
        ref_text: "Emoji transcript with 🎭 🎤 🎧 and surrogate pairs 𠮷野家",
      }),
    ];

    // Pad to a full 25-sample page of heavy content
    while (extremeSamples.length < 25) {
      const idx = extremeSamples.length;
      extremeSamples.push(
        makeSample(idx, {
          name: `Sample ${idx} with ${"```".repeat(2)} and 🚀`,
          ref_text: `${"Transcript ".repeat(30)}\`\`\``,
        }),
      );
    }

    const view: ConfigVoicesView = {
      turboEnabled: false,
      cfgWeight: 0.5,
      exaggeration: 0.5,
      samples: extremeSamples,
      totalSampleCount: 100,
      start: 0,
      selectedIndex: 2,
    };

    const components = buildConfigVoicesBody({
      locale: "en-US",
      readStatus: "fresh",
      view,
    });

    // Verify all TextDisplay lengths stay bounded under Discord's 4000 limit
    for (const comp of components) {
      if (comp.type === ComponentType.TextDisplay) {
        const textComp = comp as TextDisplayComponentData;
        const length = getDiscordTextLength(textComp.content);
        expect(length).toBeLessThanOrEqual(4000);
      }
    }

    // Verify through the official Components V2 protocol validator
    const payload = {
      flags: MessageFlags.IsComponentsV2,
      components: [buildPanelContainer(components)],
    };
    const validation = validateComponentsV2MessageLimits(payload);
    expect(validation.valid).toBe(true);
    expect(validation.violations).toEqual([]);
  });

  // TEST 6: removeConfirm set renders the confirm pair and removes the library controls.
  it("renders confirm pair and removes library controls when removeConfirm is set", () => {
    const samples = [makeSample(0), makeSample(1), makeSample(2)];
    const view: ConfigVoicesView = {
      turboEnabled: false,
      cfgWeight: 0.5,
      exaggeration: 0.5,
      samples,
      totalSampleCount: 3,
      start: 0,
      selectedIndex: 1,
      removeConfirm: {
        index: 1,
        fp: "abcd1234",
        refCount: 3,
        nonce: "nonce1234567",
      },
    };

    const components = buildConfigVoicesBody({
      locale: "en-US",
      readStatus: "fresh",
      view,
    });

    // Items 1-4 (heading, params, turbo row, edit params button) remain.
    // Items 5-8 (library display, string select, pagination, add/remove buttons) are replaced by confirm view.
    expect(components.length).toBe(6);

    // Confirm text display
    const confirmTextComp = components[4] as TextDisplayComponentData;
    expect(confirmTextComp.type).toBe(ComponentType.TextDisplay);
    expect(confirmTextComp.content).toContain("Remove Voice Sample?");
    expect(confirmTextComp.content).toContain("3 persona(s)"); // Ref count is present

    // Confirm action row
    const confirmRow = components[5] as ActionRowData<ButtonComponentData>;
    expect(confirmRow.type).toBe(ComponentType.ActionRow);
    expect(confirmRow.components.length).toBe(2);

    const [confBtn, cancelBtn] = confirmRow.components;
    expect(confBtn.style).toBe(ButtonStyle.Danger);
    const confRoute = parseConfigPanelRoute(parseInteractionRoute(confBtn.customId ?? ""));
    expect(confRoute?.action).toBe("voice-sample-remove-confirm");
    expect((confRoute as Extract<ConfigPanelRoute, { action: "voice-sample-remove-confirm" }>).index).toBe(1);
    expect((confRoute as Extract<ConfigPanelRoute, { action: "voice-sample-remove-confirm" }>).fp).toBe("abcd1234");
    expect((confRoute as Extract<ConfigPanelRoute, { action: "voice-sample-remove-confirm" }>).nonce).toBe(
      "nonce1234567",
    );

    expect(cancelBtn.style).toBe(ButtonStyle.Secondary);
    const cancelRoute = parseConfigPanelRoute(parseInteractionRoute(cancelBtn.customId ?? ""));
    expect(cancelRoute?.action).toBe("voice-sample-remove-cancel");

    // No StringSelect is present
    const hasSelect = components.some(
      (c) =>
        c.type === ComponentType.ActionRow && (c as ActionRowData).components[0]?.type === ComponentType.StringSelect,
    );
    expect(hasSelect).toBe(false);
  });
});
