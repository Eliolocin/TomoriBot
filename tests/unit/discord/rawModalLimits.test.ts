/**
 * Structural limit tests for the raw modal payloads the `/config` panel sends.
 *
 * Discord validates a modal as a whole: one out-of-range control rejects the entire payload with
 * a 400, so the button appears to do nothing. The builders that map an unbounded collection onto
 * a String Select or Checkbox Group are the ones that can drift past a limit as a workspace grows.
 * These cases drive builders across all runtime locales, roster sizes, and catalog-growth boundaries.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "bun:test";
import type { TomoriState } from "@/types/db/schema";
import type { RawDiscordComponent } from "@/types/discord/rawApiTypes";
import type { RawModalPayload } from "@/utils/discord/ui/configModals";
import {
  AUTO_TRIGGER_PERSONA_PAGE_SIZE,
  buildConfigAutoTriggerConfigureModal,
  buildConfigWelcomeModal,
  WELCOME_PERSONA_PAGE_SIZE,
} from "@/utils/discord/ui/configChannelModals";
import {
  buildBehaviorNoticeVisibilityModal,
  buildBehaviorWorkaroundsModal,
} from "@/utils/discord/ui/configBehaviorModals";
import {
  DISCORD_CHECKBOX_GROUP_OPTIONS_MAX,
  DISCORD_CHECKBOX_GROUP_OPTIONS_MIN,
  DISCORD_CUSTOM_ID_MAX,
  DISCORD_CUSTOM_ID_MIN,
  DISCORD_MODAL_COMPONENTS_MAX,
  DISCORD_MODAL_COMPONENTS_MIN,
  DISCORD_MODAL_FIELD_DESCRIPTION_MAX,
  DISCORD_MODAL_FIELD_LABEL_MAX,
  DISCORD_MODAL_TITLE_MAX,
  DISCORD_RADIO_GROUP_OPTIONS_MAX,
  DISCORD_RADIO_GROUP_OPTIONS_MIN,
  DISCORD_SELECT_OPTION_DESCRIPTION_MAX,
  DISCORD_SELECT_OPTION_LABEL_MAX,
  DISCORD_SELECT_OPTION_VALUE_MAX,
  DISCORD_SELECT_OPTIONS_MAX,
  DISCORD_SELECT_OPTIONS_MIN,
  assertRawModalLimits,
  getDiscordTextLength,
  validateRawModalLimits,
} from "@/utils/discord/ui/componentsV2Limits";
import { initializeLocalizer } from "@/utils/text/localizer";
import type { WorkaroundDefinition } from "@/utils/discord/workaroundConfigMapping";

const STRING_SELECT = 3;
const LABEL = 18;
const RADIO_GROUP = 21;
const CHECKBOX_GROUP = 22;

const localesDir = join(process.cwd(), "src", "locales");
const RUNTIME_LOCALES = readdirSync(localesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

function makePersona(personaId: number, nickname = `Persona ${personaId}`): TomoriState {
  return {
    server_id: 9,
    persona_id: personaId,
    persona_nickname: nickname,
    is_alter: personaId !== 1,
    trigger_words: [],
    naming_config: { prefixes: {}, suffixes: {}, addressTerms: {} },
    config: {},
  } as unknown as TomoriState;
}

function makePersonas(count: number): TomoriState[] {
  return Array.from({ length: count }, (_unused, index) => makePersona(index + 1));
}

function makeWorkaroundDefinitions(count: number): WorkaroundDefinition[] {
  return Array.from({ length: count }, (_unused, index) => ({
    value: `workaround_${index + 1}`,
    dbColumn: "verbatim_tool_calling_enabled",
    labelKey: "commands.config.workarounds.verbatim_tool_calling_option",
    descKey: "commands.config.workarounds.verbatim_tool_calling_desc",
    getState: () => false,
  }));
}

/** Walks a payload's component tree, since selects sit inside Label wrappers. */
function eachComponent(components: readonly RawDiscordComponent[], visit: (c: RawDiscordComponent) => void): void {
  for (const component of components) {
    visit(component);
    if (component.component) eachComponent([component.component], visit);
    if (component.components) eachComponent(component.components, visit);
  }
}

function assertWithinDiscordLimits(payload: RawModalPayload, label: string): void {
  assertRawModalLimits(payload);

  expect(getDiscordTextLength(payload.title), `${label}: title length`).toBeLessThanOrEqual(DISCORD_MODAL_TITLE_MAX);
  expect(payload.components.length, `${label}: component count`).toBeGreaterThanOrEqual(DISCORD_MODAL_COMPONENTS_MIN);
  expect(payload.components.length, `${label}: component count`).toBeLessThanOrEqual(DISCORD_MODAL_COMPONENTS_MAX);

  const customIds = new Set<string>();
  eachComponent(payload.components, (component) => {
    if (component.custom_id !== undefined) {
      const cidLen = getDiscordTextLength(component.custom_id);
      expect(cidLen, `${label}: custom_id min length`).toBeGreaterThanOrEqual(DISCORD_CUSTOM_ID_MIN);
      expect(cidLen, `${label}: custom_id max length`).toBeLessThanOrEqual(DISCORD_CUSTOM_ID_MAX);
      expect(customIds.has(component.custom_id), `${label}: duplicate custom_id ${component.custom_id}`).toBe(false);
      customIds.add(component.custom_id);
    }

    if (component.type === LABEL) {
      if (component.label !== undefined) {
        expect(getDiscordTextLength(component.label), `${label}: label length`).toBeLessThanOrEqual(
          DISCORD_MODAL_FIELD_LABEL_MAX,
        );
      }
      if (component.description !== undefined) {
        expect(getDiscordTextLength(component.description), `${label}: description length`).toBeLessThanOrEqual(
          DISCORD_MODAL_FIELD_DESCRIPTION_MAX,
        );
      }
    }

    if (component.type === STRING_SELECT) {
      const options = component.options ?? [];
      expect(options.length, `${label}: ${component.custom_id} option count`).toBeGreaterThanOrEqual(
        DISCORD_SELECT_OPTIONS_MIN,
      );
      expect(options.length, `${label}: ${component.custom_id} option count`).toBeLessThanOrEqual(
        DISCORD_SELECT_OPTIONS_MAX,
      );
      for (const option of options) {
        expect(getDiscordTextLength(option.label), `${label}: option label`).toBeLessThanOrEqual(
          DISCORD_SELECT_OPTION_LABEL_MAX,
        );
        expect(getDiscordTextLength(option.value), `${label}: option value`).toBeLessThanOrEqual(
          DISCORD_SELECT_OPTION_VALUE_MAX,
        );
        expect(getDiscordTextLength(option.description ?? ""), `${label}: option description`).toBeLessThanOrEqual(
          DISCORD_SELECT_OPTION_DESCRIPTION_MAX,
        );
      }
    }

    if (component.type === CHECKBOX_GROUP) {
      const options = component.options ?? [];
      expect(options.length, `${label}: ${component.custom_id} checkbox count`).toBeGreaterThanOrEqual(
        DISCORD_CHECKBOX_GROUP_OPTIONS_MIN,
      );
      expect(options.length, `${label}: ${component.custom_id} checkbox count`).toBeLessThanOrEqual(
        DISCORD_CHECKBOX_GROUP_OPTIONS_MAX,
      );
      for (const option of options) {
        expect(getDiscordTextLength(option.label), `${label}: checkbox label`).toBeLessThanOrEqual(
          DISCORD_SELECT_OPTION_LABEL_MAX,
        );
        expect(getDiscordTextLength(option.value), `${label}: checkbox value`).toBeLessThanOrEqual(
          DISCORD_SELECT_OPTION_VALUE_MAX,
        );
      }
    }

    if (component.type === RADIO_GROUP) {
      const options = component.options ?? [];
      expect(options.length, `${label}: ${component.custom_id} radio count`).toBeGreaterThanOrEqual(
        DISCORD_RADIO_GROUP_OPTIONS_MIN,
      );
      expect(options.length, `${label}: ${component.custom_id} radio count`).toBeLessThanOrEqual(
        DISCORD_RADIO_GROUP_OPTIONS_MAX,
      );
      for (const option of options) {
        expect(getDiscordTextLength(option.label), `${label}: radio label`).toBeLessThanOrEqual(
          DISCORD_SELECT_OPTION_LABEL_MAX,
        );
        expect(getDiscordTextLength(option.value), `${label}: radio value`).toBeLessThanOrEqual(
          DISCORD_SELECT_OPTION_VALUE_MAX,
        );
      }
    }
  });
}

/** Roster sizes spanning both sides of the 25-option ceiling, including its exact boundary. */
const ROSTER_SIZES = [1, 2, 23, 24, 25, 26, 60, 200];

describe("raw config modal limits", () => {
  beforeAll(async () => {
    await initializeLocalizer();
  });

  it("discovers all runtime locales dynamically", () => {
    expect(RUNTIME_LOCALES.length).toBeGreaterThanOrEqual(2);
    expect(RUNTIME_LOCALES).toContain("en-US");
    expect(RUNTIME_LOCALES).toContain("ja");
  });

  it("keeps the Welcome modal within Discord limits across all runtime locales and roster sizes", () => {
    for (const locale of RUNTIME_LOCALES) {
      for (const size of ROSTER_SIZES) {
        const personas = makePersonas(size);
        for (const selected of [null, 1, size]) {
          const payload = buildConfigWelcomeModal(locale, "nonce", personas, "Say hi", selected);
          assertWithinDiscordLimits(payload, `welcome/${locale}/${size}/${selected}`);
        }
      }
    }
  });

  it("keeps the Auto-Trigger configure modal within Discord limits across all runtime locales and roster sizes", () => {
    for (const locale of RUNTIME_LOCALES) {
      for (const size of ROSTER_SIZES) {
        const personas = makePersonas(size);
        for (const selected of [null, 1, size]) {
          const payload = buildConfigAutoTriggerConfigureModal(
            locale,
            "nonce",
            "fp",
            personas,
            "chan-1",
            true,
            selected,
          );
          assertWithinDiscordLimits(payload, `auto-trigger/${locale}/${size}/${selected}`);
        }
      }
    }
  });

  it("keeps the Notice Visibility modal within Discord limits across all runtime locales", () => {
    for (const locale of RUNTIME_LOCALES) {
      const payload = buildBehaviorNoticeVisibilityModal(locale, "nonce", []);
      assertWithinDiscordLimits(payload, `notices/${locale}`);
    }
  });

  it("keeps the Workarounds modal within Discord limits across all runtime locales", () => {
    for (const locale of RUNTIME_LOCALES) {
      const payload = buildBehaviorWorkaroundsModal(locale, "nonce", { verbatim_tool_calling: true });
      assertWithinDiscordLimits(payload, `workarounds/${locale}`);
      expect(payload.components.length).toBe(1);
    }
  });

  it("chunks Workarounds at 10, 11, and 50 definitions without exceeding modal limits", () => {
    for (const locale of RUNTIME_LOCALES) {
      // 10 definitions fit into exactly one Checkbox Group
      const tenDefs = makeWorkaroundDefinitions(10);
      const modal10 = buildBehaviorWorkaroundsModal(locale, "nonce", {}, tenDefs);
      assertWithinDiscordLimits(modal10, `workarounds-10/${locale}`);
      expect(modal10.components.length).toBe(1);

      // 11 definitions chunk into two Checkbox Groups
      const elevenDefs = makeWorkaroundDefinitions(11);
      const modal11 = buildBehaviorWorkaroundsModal(locale, "nonce", {}, elevenDefs);
      assertWithinDiscordLimits(modal11, `workarounds-11/${locale}`);
      expect(modal11.components.length).toBe(2);

      // 50 definitions chunk into exactly five Checkbox Groups (the 5-component modal boundary)
      const fiftyDefs = makeWorkaroundDefinitions(50);
      const modal50 = buildBehaviorWorkaroundsModal(locale, "nonce", {}, fiftyDefs);
      assertWithinDiscordLimits(modal50, `workarounds-50/${locale}`);
      expect(modal50.components.length).toBe(5);

      // 51 definitions produce 6 groups, which violates the 5-component modal boundary
      const fiftyOneDefs = makeWorkaroundDefinitions(51);
      const modal51 = buildBehaviorWorkaroundsModal(locale, "nonce", {}, fiftyOneDefs);
      const result51 = validateRawModalLimits(modal51);
      expect(result51.valid).toBe(false);
      expect(result51.violations.some((v) => v.code === "MODAL_COMPONENTS_OVERSIZED")).toBe(true);
    }
  });

  it("adversarially rejects title, component, and option boundary violations", () => {
    // Title: 45 accepted, 46 rejected
    const validTitlePayload: RawModalPayload = {
      title: "a".repeat(45),
      custom_id: "modal_title_test",
      components: [
        {
          type: LABEL,
          label: "Field",
          component: {
            type: 4,
            custom_id: "input_1",
          },
        },
      ],
    };
    expect(validateRawModalLimits(validTitlePayload).valid).toBe(true);

    const invalidTitlePayload: RawModalPayload = {
      ...validTitlePayload,
      title: "a".repeat(46),
    };
    const titleResult = validateRawModalLimits(invalidTitlePayload);
    expect(titleResult.valid).toBe(false);
    expect(titleResult.violations.some((v) => v.code === "MODAL_TITLE_OVERSIZED")).toBe(true);

    // Modal components: 0 rejected, 6 rejected
    const emptyComponentsPayload: RawModalPayload = {
      title: "Test",
      custom_id: "modal_comp_empty",
      components: [],
    };
    const emptyResult = validateRawModalLimits(emptyComponentsPayload);
    expect(emptyResult.valid).toBe(false);
    expect(emptyResult.violations.some((v) => v.code === "MODAL_COMPONENTS_EMPTY")).toBe(true);

    // Checkbox Group: 10 options accepted, 11 rejected
    const tenCheckboxPayload: RawModalPayload = {
      title: "Checkboxes",
      custom_id: "modal_check_10",
      components: [
        {
          type: LABEL,
          label: "Group",
          component: {
            type: CHECKBOX_GROUP,
            custom_id: "check_group",
            options: Array.from({ length: 10 }, (_, i) => ({
              label: `Opt ${i + 1}`,
              value: `val_${i + 1}`,
            })),
          },
        },
      ],
    };
    expect(validateRawModalLimits(tenCheckboxPayload).valid).toBe(true);

    const elevenCheckboxPayload: RawModalPayload = {
      title: "Checkboxes",
      custom_id: "modal_check_11",
      components: [
        {
          type: LABEL,
          label: "Group",
          component: {
            type: CHECKBOX_GROUP,
            custom_id: "check_group",
            options: Array.from({ length: 11 }, (_, i) => ({
              label: `Opt ${i + 1}`,
              value: `val_${i + 1}`,
            })),
          },
        },
      ],
    };
    const check11Result = validateRawModalLimits(elevenCheckboxPayload);
    expect(check11Result.valid).toBe(false);
    expect(check11Result.violations.some((v) => v.code === "MODAL_OPTION_COUNT_INVALID")).toBe(true);

    // Radio Group: 10 options accepted, 11 rejected
    const elevenRadioPayload: RawModalPayload = {
      title: "Radio",
      custom_id: "modal_radio_11",
      components: [
        {
          type: LABEL,
          label: "Group",
          component: {
            type: RADIO_GROUP,
            custom_id: "radio_group",
            options: Array.from({ length: 11 }, (_, i) => ({
              label: `Opt ${i + 1}`,
              value: `val_${i + 1}`,
            })),
          },
        },
      ],
    };
    const radio11Result = validateRawModalLimits(elevenRadioPayload);
    expect(radio11Result.valid).toBe(false);
    expect(radio11Result.violations.some((v) => v.code === "MODAL_OPTION_COUNT_INVALID")).toBe(true);

    // String Select: 25 options accepted, 26 rejected
    const twentySixSelectPayload: RawModalPayload = {
      title: "Select",
      custom_id: "modal_sel_26",
      components: [
        {
          type: LABEL,
          label: "Group",
          component: {
            type: STRING_SELECT,
            custom_id: "select_group",
            options: Array.from({ length: 26 }, (_, i) => ({
              label: `Opt ${i + 1}`,
              value: `val_${i + 1}`,
            })),
          },
        },
      ],
    };
    const sel26Result = validateRawModalLimits(twentySixSelectPayload);
    expect(sel26Result.valid).toBe(false);
    expect(sel26Result.violations.some((v) => v.code === "MODAL_OPTION_COUNT_INVALID")).toBe(true);

    // Duplicate custom_id
    const duplicateIdPayload: RawModalPayload = {
      title: "Duplicate",
      custom_id: "modal_dup",
      components: [
        {
          type: LABEL,
          label: "One",
          component: { type: 4, custom_id: "same_id" },
        },
        {
          type: LABEL,
          label: "Two",
          component: { type: 4, custom_id: "same_id" },
        },
      ],
    };
    const dupResult = validateRawModalLimits(duplicateIdPayload);
    expect(dupResult.valid).toBe(false);
    expect(dupResult.violations.some((v) => v.code === "CUSTOM_ID_DUPLICATE")).toBe(true);

    // Label length: 45 accepted, 46 rejected
    const overlongLabelPayload: RawModalPayload = {
      title: "Field Label",
      custom_id: "modal_lbl",
      components: [
        {
          type: LABEL,
          label: "a".repeat(46),
          component: { type: 4, custom_id: "inp_lbl" },
        },
      ],
    };
    const lblResult = validateRawModalLimits(overlongLabelPayload);
    expect(lblResult.valid).toBe(false);
    expect(lblResult.violations.some((v) => v.code === "MODAL_FIELD_LABEL_OVERSIZED")).toBe(true);

    // Description length: 100 accepted, 101 rejected
    const overlongDescPayload: RawModalPayload = {
      title: "Field Desc",
      custom_id: "modal_desc",
      components: [
        {
          type: LABEL,
          label: "Field",
          description: "d".repeat(101),
          component: { type: 4, custom_id: "inp_desc" },
        },
      ],
    };
    const descResult = validateRawModalLimits(overlongDescPayload);
    expect(descResult.valid).toBe(false);
    expect(descResult.violations.some((v) => v.code === "MODAL_FIELD_DESCRIPTION_OVERSIZED")).toBe(true);
  });

  it("reaches every persona across the ranges the panel offers", () => {
    const roster = 60;
    const personas = makePersonas(roster);
    const pages: Array<[string, number, (start: number) => RawModalPayload]> = [
      [
        "welcome",
        WELCOME_PERSONA_PAGE_SIZE,
        (start) => buildConfigWelcomeModal("en-US", "nonce", personas, "Say hi", null, start),
      ],
      [
        "auto-trigger",
        AUTO_TRIGGER_PERSONA_PAGE_SIZE,
        (start) => buildConfigAutoTriggerConfigureModal("en-US", "nonce", "fp", personas, "chan-1", true, null, start),
      ],
    ];

    for (const [label, pageSize, build] of pages) {
      const reachable = new Set<string>();
      for (let start = 0; start < roster; start += pageSize) {
        const payload = build(start);
        assertWithinDiscordLimits(payload, `${label}/page@${start}`);
        eachComponent(payload.components, (component) => {
          if (component.type !== STRING_SELECT) return;
          for (const option of component.options ?? []) reachable.add(option.value);
        });
      }
      for (let personaId = 1; personaId <= roster; personaId += 1) {
        expect(reachable.has(String(personaId)), `${label}: persona ${personaId} reachable`).toBe(true);
      }
    }
  });

  it("marks the stored persona only on the page that holds it", () => {
    const personas = makePersonas(60);
    const defaultsAt = (start: number): string[] => {
      const payload = buildConfigWelcomeModal("en-US", "nonce", personas, "Say hi", 47, start);
      const found: string[] = [];
      eachComponent(payload.components, (component) => {
        if (component.type !== STRING_SELECT) return;
        found.push(...(component.options ?? []).filter((option) => option.default).map((option) => option.value));
      });
      return found;
    };

    expect(defaultsAt(24)).toEqual(["47"]);
    expect(defaultsAt(0)).toEqual([]);
  });

  it("marks Random as the Welcome default only when no persona is stored", () => {
    const personas = makePersonas(60);
    const randomDefaulted = (selected: number | null): boolean => {
      const payload = buildConfigWelcomeModal("en-US", "nonce", personas, "Say hi", selected);
      let isDefault = false;
      eachComponent(payload.components, (component) => {
        if (component.type !== STRING_SELECT) return;
        isDefault = (component.options ?? []).some((o) => o.value === "random" && o.default === true);
      });
      return isDefault;
    };

    expect(randomDefaulted(null)).toBe(true);
    expect(randomDefaulted(3)).toBe(false);
  });
});
