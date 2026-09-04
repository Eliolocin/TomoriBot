/**
 * Structural limit tests for the raw modal payloads the `/config` panel sends.
 *
 * Discord validates a modal as a whole: one out-of-range control rejects the entire payload with
 * a 400, so the button appears to do nothing. The builders that map an unbounded collection onto
 * a String Select are the ones that can drift past a limit as a workspace grows, and a route-level
 * guard at one call site does not protect the builder's other callers. These cases drive those
 * builders at the boundaries a real workspace reaches.
 */

import { describe, expect, it } from "bun:test";
import type { TomoriState } from "@/types/db/schema";
import type { RawDiscordComponent } from "@/types/discord/rawApiTypes";
import type { RawModalPayload } from "@/utils/discord/ui/configModals";
import {
  AUTO_TRIGGER_PERSONA_PAGE_SIZE,
  buildConfigAutoTriggerConfigureModal,
  buildConfigWelcomeModal,
  WELCOME_PERSONA_PAGE_SIZE,
} from "@/utils/discord/ui/configChannelModals";

const STRING_SELECT = 3;
const LABEL = 18;

/** Discord's documented ceilings for the pieces these builders emit. */
const MODAL_COMPONENT_MIN = 1;
const MODAL_COMPONENT_MAX = 5;
const SELECT_OPTION_MIN = 1;
const SELECT_OPTION_MAX = 25;
const OPTION_TEXT_MAX = 100;
const MODAL_TITLE_MAX = 45;

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

/** Walks a payload's component tree, since selects sit inside Label wrappers. */
function eachComponent(components: readonly RawDiscordComponent[], visit: (c: RawDiscordComponent) => void): void {
  for (const component of components) {
    visit(component);
    if (component.component) eachComponent([component.component], visit);
    if (component.components) eachComponent(component.components, visit);
  }
}

function assertWithinDiscordLimits(payload: RawModalPayload, label: string): void {
  expect(payload.title.length, `${label}: title length`).toBeLessThanOrEqual(MODAL_TITLE_MAX);
  expect(payload.components.length, `${label}: component count`).toBeGreaterThanOrEqual(MODAL_COMPONENT_MIN);
  expect(payload.components.length, `${label}: component count`).toBeLessThanOrEqual(MODAL_COMPONENT_MAX);

  eachComponent(payload.components, (component) => {
    if (component.type === LABEL && component.label !== undefined) {
      expect(component.label.length, `${label}: label length`).toBeLessThanOrEqual(MODAL_TITLE_MAX);
    }
    if (component.type !== STRING_SELECT) return;
    const options = component.options ?? [];
    expect(options.length, `${label}: ${component.custom_id} option count`).toBeGreaterThanOrEqual(SELECT_OPTION_MIN);
    expect(options.length, `${label}: ${component.custom_id} option count`).toBeLessThanOrEqual(SELECT_OPTION_MAX);
    for (const option of options) {
      expect(option.label.length, `${label}: option label`).toBeLessThanOrEqual(OPTION_TEXT_MAX);
      expect(option.value.length, `${label}: option value`).toBeLessThanOrEqual(OPTION_TEXT_MAX);
      expect((option.description ?? "").length, `${label}: option description`).toBeLessThanOrEqual(OPTION_TEXT_MAX);
    }
  });
}

/** Roster sizes spanning both sides of the 25-option ceiling, including its exact boundary. */
const ROSTER_SIZES = [1, 2, 23, 24, 25, 26, 60, 200];

describe("raw config modal limits", () => {
  it("keeps the Welcome modal within Discord's limits at every roster size", () => {
    for (const size of ROSTER_SIZES) {
      const personas = makePersonas(size);
      for (const selected of [null, 1, size]) {
        const payload = buildConfigWelcomeModal("en-US", "nonce", personas, "Say hi", selected);
        assertWithinDiscordLimits(payload, `welcome/${size}/${selected}`);
      }
    }
  });

  it("keeps the Auto-Trigger configure modal within Discord's limits at every roster size", () => {
    for (const size of ROSTER_SIZES) {
      const personas = makePersonas(size);
      for (const selected of [null, 1, size]) {
        const payload = buildConfigAutoTriggerConfigureModal(
          "en-US",
          "nonce",
          "fp",
          personas,
          "chan-1",
          true,
          selected,
        );
        assertWithinDiscordLimits(payload, `auto-trigger/${size}/${selected}`);
      }
    }
  });

  it("reaches every persona across the ranges the panel offers", () => {
    // The panel offers one range per page and the modal renders that page, so the union of the
    // pages has to be the whole roster: a persona on none of them could never be assigned.
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
    // Marking it on a page it is absent from would offer a default the submit cannot honour; the
    // panel prints the stored value alongside, so an unmarked page reads as "not on this page".
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

    // Persona 47 is index 46, so a 24-per-page roster puts it on the page starting at 24.
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
