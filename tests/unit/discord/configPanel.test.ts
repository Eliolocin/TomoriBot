/**
 * Renderer coverage for the `/config` shell and Persona pages.
 *
 * Component types are asserted as the raw numbers Discord receives. `RawDiscordComponent.type` and
 * the Components V2 payload are both bare numbers on the wire, so TypeScript accepts any of them
 * and a wrong one renders without throwing; only a literal assertion catches it.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { ComponentType } from "discord.js";
import type { PersonaSpriteRow, StmCategoryRow, TomoriState } from "@/types/db/schema";
import type { ConditioningGroup } from "@/utils/db/repositories/ConditioningMemoryRepository";
import {
  CONFIG_PERSONA_COLLECTION_PAGE_SIZE,
  CONFIG_PERSONA_SELECT_PAGE_SIZE,
  CONFIG_PERSONA_SPRITE_PAGE_SIZE,
  CONFIG_RANDOM_TRIGGER_CHECKBOX_CAPACITY,
  buildConfigRouteId,
  computeAttributeFingerprint,
  computeDialogueFingerprint,
  computeSpriteFingerprint,
} from "@/utils/discord/configPanelCatalog";
import type { ConfigActor } from "@/utils/discord/interactions/configPermissionPolicy";
import type { ConfigPersonaMemoryView } from "@/utils/discord/interactions/configRouteContext";
import { validateComponentsV2MessageLimits } from "@/utils/discord/ui/componentsV2Limits";
import { buildConfigModelsBody } from "@/utils/discord/ui/configModelsPanel";
import { buildConfigPanelPayload } from "@/utils/discord/ui/configPanel";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const ACTION_ROW = 1;
const BUTTON = 2;
const STRING_SELECT = 3;
const SECTION = 9;
const TEXT_DISPLAY = 10;
const THUMBNAIL = 11;
const SEPARATOR = 14;
const CONTAINER = 17;

const GUILD_MANAGER: ConfigActor = { workspaceKind: "guild", isManager: true };
const GUILD_MEMBER: ConfigActor = { workspaceKind: "guild", isManager: false };
const DM_OWNER: ConfigActor = { workspaceKind: "dm", isManager: true };

interface Observed {
  type: number;
  customId?: string;
  label?: string;
  style?: number;
  placeholder?: string;
  disabled?: boolean;
  content?: string;
  media?: { url?: string };
  options?: Array<{ value?: string; label?: string; default?: boolean }>;
}

function walk(value: unknown): Observed[] {
  if (Array.isArray(value)) return value.flatMap(walk);
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const here: Observed[] =
    typeof record.type === "number"
      ? [
          {
            type: record.type,
            customId: typeof record.customId === "string" ? record.customId : undefined,
            label: typeof record.label === "string" ? record.label : undefined,
            style: typeof record.style === "number" ? record.style : undefined,
            placeholder: typeof record.placeholder === "string" ? record.placeholder : undefined,
            disabled: typeof record.disabled === "boolean" ? record.disabled : undefined,
            content: typeof record.content === "string" ? record.content : undefined,
            media:
              typeof record.media === "object" && record.media !== null
                ? {
                    url:
                      typeof (record.media as Record<string, unknown>).url === "string"
                        ? ((record.media as Record<string, unknown>).url as string)
                        : undefined,
                  }
                : undefined,
            options: Array.isArray(record.options)
              ? record.options.map((option) => {
                  const entry = option as Record<string, unknown>;
                  return {
                    value: typeof entry.value === "string" ? entry.value : undefined,
                    label: typeof entry.label === "string" ? entry.label : undefined,
                    default: typeof entry.default === "boolean" ? entry.default : undefined,
                  };
                })
              : undefined,
          },
        ]
      : [];
  return [...here, ...Object.values(record).flatMap(walk)];
}

function actionRows(payload: unknown): string[][] {
  const rows: string[][] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    if (record.type === ACTION_ROW && Array.isArray(record.components)) {
      rows.push(
        record.components.map((component) => {
          if (typeof component !== "object" || component === null) return "";
          const customId = (component as Record<string, unknown>).customId;
          return typeof customId === "string" ? customId : "";
        }),
      );
    }
    Object.values(record).forEach(visit);
  };
  visit(payload);
  return rows;
}

function makePersona(overrides: Partial<TomoriState> & { persona_id: number }): TomoriState {
  return {
    server_id: 9,
    persona_nickname: `Persona ${overrides.persona_id}`,
    is_alter: false,
    trigger_words: [],
    naming_config: { prefixes: {}, suffixes: {}, addressTerms: {} },
    ...overrides,
  } as unknown as TomoriState;
}

const MAIN = makePersona({ persona_id: 55, persona_nickname: "Aphel", trigger_words: ["aphel", "hey aphel"] });
const ALTER = makePersona({ persona_id: 56, persona_nickname: "Wren", is_alter: true });

const MEMORY_CATEGORIES: StmCategoryRow[] = [
  { server_id: 9, position: 0, label: "Summary", description: "Current summary" },
  { server_id: 9, position: 1, label: "People", description: "People in the scene" },
];

const MEMORY_CONDITIONING: ConditioningGroup = {
  conditioningType: "reward",
  actionKey: "headpat",
  reasonText: "Helped with the scene",
  reasonNormalized: "helped with the scene",
  actionText: null,
  totalCount: 1,
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  userDiscIds: ["user-1"],
  conditioningIds: [1],
};

const MEMORY_VIEW: ConfigPersonaMemoryView = {
  serverMemoryCount: 4,
  personalMemoryCount: 2,
  channelId: "channel-1",
  stmCategories: MEMORY_CATEGORIES,
  stmEntry: {
    messages: [],
    serverId: "guild-1",
    channelId: "channel-1",
    personaId: 55,
    personaLineageId: 55,
    categories: { summary: "A stored scene", people: "Sparrow" },
    lastUpdated: Date.now(),
  },
  conditioningGroups: [MEMORY_CONDITIONING],
};

function build(
  actor: ConfigActor,
  overrides: Partial<Parameters<typeof buildConfigPanelPayload>[0]> = {},
): ReturnType<typeof buildConfigPanelPayload> {
  return buildConfigPanelPayload({
    locale: "en-US",
    actor,
    category: "persona",
    page: "general",
    personas: [MAIN, ALTER],
    selectedPersonaId: 55,
    readStatus: "fresh",
    ...overrides,
  });
}

function buttonFor(payload: unknown, route: Parameters<typeof buildConfigRouteId>[0]): Observed | undefined {
  const customId = buildConfigRouteId(route);
  return walk(payload).find((component) => component.customId === customId);
}

/** Returns the custom IDs of the button row holding a button whose custom ID contains `marker`. */
function buttonRowContaining(payload: unknown, marker: string): string[] | undefined {
  return actionRows(payload).find((row) => row.some((customId) => customId.includes(marker)));
}

function actionRowIndex(rows: readonly string[][], marker: string): number {
  return rows.findIndex((row) => row.some((customId) => customId.includes(marker)));
}

function expectCollectionActionPlacement(payload: unknown, selected: { attribute: boolean; dialogue: boolean }): void {
  const rows = actionRows(payload);
  const identityIndex = rows.findIndex((row) =>
    row.some((customId) => ["avatar-open", "rename-open", "promote-view"].some((marker) => customId.includes(marker))),
  );
  expect(identityIndex).toBeGreaterThanOrEqual(0);
  expect(
    rows[identityIndex]?.every(
      (customId) =>
        !customId.includes("attribute-") &&
        !customId.includes("dialogue-") &&
        !customId.includes("attr-") &&
        !customId.includes("dlg-"),
    ),
  ).toBe(true);
  expect(rows[identityIndex]).toHaveLength(3);
  expect(
    rows[identityIndex]?.every((customId) =>
      ["avatar-open", "rename-open", "promote-view"].some((marker) => customId.includes(marker)),
    ),
  ).toBe(true);

  const assertCollection = (name: "attribute" | "dialogue", isSelected: boolean): number => {
    const routePrefix = name === "attribute" ? "attr" : "dlg";
    const selectIndex = actionRowIndex(rows, `${routePrefix}-select`);
    const actionIndex = actionRowIndex(rows, `${routePrefix}-edit-open`);
    expect(selectIndex).toBeGreaterThanOrEqual(0);
    if (!isSelected) {
      expect(actionIndex).toBe(-1);
      return selectIndex;
    }

    expect(actionIndex).toBeGreaterThan(selectIndex);
    const interveningRows = rows.slice(selectIndex + 1, actionIndex);
    expect(
      interveningRows.every(
        (row) =>
          row.length > 0 &&
          row.every(
            (customId) => customId.includes(`${routePrefix}-page`) || customId.includes("pagination-indicator"),
          ),
      ),
    ).toBe(true);
    expect(
      rows[actionIndex]?.every(
        (customId) => customId.includes(`${routePrefix}-edit-open`) || customId.includes(`${routePrefix}-remove`),
      ),
    ).toBe(true);
    expect(rows[actionIndex]).toHaveLength(2);
    expect(rows[actionIndex]?.some((customId) => customId.includes(`${routePrefix}-edit-open`))).toBe(true);
    expect(rows[actionIndex]?.some((customId) => customId.includes(`${routePrefix}-remove`))).toBe(true);
    return actionIndex;
  };

  const attributeIndex = assertCollection("attribute", selected.attribute);
  const dialogueIndex = assertCollection("dialogue", selected.dialogue);
  if (selected.attribute && selected.dialogue) {
    const dialogueSelectIndex = actionRowIndex(rows, "dlg-select");
    expect(attributeIndex).toBeLessThan(dialogueSelectIndex);
    expect(dialogueSelectIndex).toBeLessThan(dialogueIndex);
  }
}

describe("config panel shell", () => {
  it("renders a Components V2 container with raw numeric component types", () => {
    const payload = build(GUILD_MANAGER);
    const seen = walk(payload);

    expect(seen.some((component) => component.type === CONTAINER)).toBe(true);
    expect(seen.some((component) => component.type === ACTION_ROW)).toBe(true);
    expect(seen.some((component) => component.type === BUTTON)).toBe(true);
    expect(seen.some((component) => component.type === STRING_SELECT)).toBe(true);
    expect(seen.some((component) => component.type === TEXT_DISPLAY)).toBe(true);
    expect(seen.some((component) => component.type === SEPARATOR)).toBe(true);
    expect(payload.components[0]).toMatchObject({ type: CONTAINER });
  });

  it("orders the five category buttons and marks only the active one Primary", () => {
    const payload = build(GUILD_MANAGER);
    const row = payload.components[0] as unknown as {
      components: Array<{ components: Array<Record<string, unknown>> }>;
    };
    const categoryRow = row.components[0].components;

    expect(categoryRow.map((button) => button.label)).toEqual([
      "Persona",
      "Engine",
      "Channels",
      "Permissions",
      "Models",
    ]);
    // ButtonStyle.Primary is 1, Secondary is 2.
    expect(categoryRow.map((button) => button.style)).toEqual([1, 2, 2, 2, 2]);
  });

  it("keeps Persona visible while manager-owned categories stay inert for a guild member", () => {
    const payload = build(GUILD_MEMBER);
    const row = payload.components[0] as unknown as { components: Array<{ components: Observed[] }> };
    const categoryRow = row.components[0].components;

    expect(categoryRow.map((button) => [button.label, button.disabled ?? false])).toEqual([
      ["Persona", false],
      ["Engine", true],
      ["Channels", true],
      ["Permissions", true],
      ["Models", true],
    ]);
  });

  it("omits the Channels category entirely in a DM workspace", () => {
    const payload = build(DM_OWNER);
    const row = payload.components[0] as unknown as { components: Array<{ components: Observed[] }> };

    expect(row.components[0].components.map((button) => button.label)).toEqual([
      "Persona",
      "Engine",
      "Permissions",
      "Models",
    ]);
  });

  it("renders no page selector when filtering leaves a category one page", () => {
    // A String Select option cannot be disabled, so a one-option selector would be inert furniture.
    const single = build(DM_OWNER, { category: "permissions", page: "capabilities" });
    const pageSelect = walk(single).find(
      (component) => component.type === STRING_SELECT && component.placeholder === "Choose a page...",
    );
    expect(pageSelect).toBeUndefined();

    const multi = build(GUILD_MANAGER, { category: "permissions", page: "capabilities" });
    const managerPageSelect = walk(multi).find(
      (component) => component.type === STRING_SELECT && component.placeholder === "Choose a page...",
    );
    expect(managerPageSelect?.options?.map((option) => option.value)).toEqual(["capabilities", "privacy"]);
  });

  it("lists only pages the actor may open in the page selector", () => {
    const payload = build(GUILD_MEMBER, { category: "persona", page: "general" });
    const pageSelect = walk(payload).find(
      (component) => component.type === STRING_SELECT && component.placeholder === "Choose a page...",
    );
    expect(pageSelect?.options?.map((option) => option.value)).toEqual([
      "general",
      "triggers",
      "memories",
      "naming",
      "sprites",
    ]);
  });

  it("keeps Advanced Memory last in the Behavior page selector", () => {
    const payload = build(GUILD_MANAGER, { category: "behavior", page: "general" });
    const pageSelect = walk(payload).find(
      (component) => component.type === STRING_SELECT && component.placeholder === "Choose a page...",
    );
    expect(pageSelect?.options?.map((option) => option.value)).toEqual([
      "general",
      "trigger",
      "notices",
      "experimental",
      "memory",
    ]);
  });
});

describe("config persona selector", () => {
  it("renders no pagination row when every persona fits one page", () => {
    const payload = build(GUILD_MANAGER);
    expect(walk(payload).some((component) => component.label === "Next →")).toBe(false);
  });

  it("paginates in place beyond 25 personas and keeps the selection visible off-page", () => {
    const personas = Array.from({ length: 60 }, (_, index) => makePersona({ persona_id: index + 1 }));
    const selected = personas[30];
    const payload = build(GUILD_MANAGER, { personas, selectedPersonaId: selected.persona_id as number });
    const seen = walk(payload);

    const personaSelect = seen.find(
      (component) => component.type === STRING_SELECT && component.options?.length === CONFIG_PERSONA_SELECT_PAGE_SIZE,
    );
    expect(personaSelect).toBeDefined();
    // Parked on the page holding the selection rather than resetting to the first page.
    expect(personaSelect?.options?.map((option) => option.value)).toContain(String(selected.persona_id));
    expect(personaSelect?.options?.find((option) => option.default)?.value).toBe(String(selected.persona_id));

    const previous = seen.find((component) => component.label === "← Previous");
    const next = seen.find((component) => component.label === "Next →");
    expect(previous?.disabled).toBe(false);
    expect(next?.disabled).toBe(false);
    expect(seen.some((component) => component.label === "Page 2 of 3")).toBe(true);

    // The placeholder carries the selection so paging away from it does not look like a reset.
    const firstPage = build(GUILD_MANAGER, {
      personas,
      selectedPersonaId: selected.persona_id as number,
      personaSelectStart: 0,
    });
    const firstPageSelect = walk(firstPage).find(
      (component) => component.type === STRING_SELECT && component.options?.length === CONFIG_PERSONA_SELECT_PAGE_SIZE,
    );
    expect(firstPageSelect?.options?.some((option) => option.default)).toBe(false);
    expect(firstPageSelect?.placeholder).toBe(selected.persona_nickname);
  });

  it("carries a stable persona identity rather than a list position", () => {
    const payload = build(GUILD_MANAGER, { selectedPersonaId: 56 });
    const personaSelect = walk(payload).find(
      (component) => component.type === STRING_SELECT && component.options?.some((option) => option.value === "56"),
    );
    expect(personaSelect?.customId).toBe(
      buildConfigRouteId({ action: "persona-select", locale: "en-US", personaId: 56 }),
    );
    expect(personaSelect?.options?.map((option) => option.value)).toEqual(["55", "56"]);
  });
});

describe("config Persona General body", () => {
  it("shares the heading with the selected persona thumbnail when one resolves", () => {
    const withAvatar = build(GUILD_MANAGER, { selectedPersonaAvatarUrl: "https://cdn.example.invalid/55.png" });
    expect(walk(withAvatar).some((component) => component.type === SECTION)).toBe(true);
    expect(walk(withAvatar).some((component) => component.type === THUMBNAIL)).toBe(true);

    const withoutAvatar = build(GUILD_MANAGER, { selectedPersonaAvatarUrl: null });
    expect(walk(withoutAvatar).some((component) => component.type === THUMBNAIL)).toBe(false);
  });

  it("renders the name above the role of the selected persona", () => {
    expect(
      walk(build(GUILD_MANAGER, { selectedPersonaId: 55 })).some(
        (c) => c.content?.includes("> Name: Aphel\n> Role: Main persona") === true,
      ),
    ).toBe(true);
    expect(
      walk(build(GUILD_MANAGER, { selectedPersonaId: 56 })).some(
        (c) => c.content?.includes("> Name: Wren\n> Role: Alter persona") === true,
      ),
    ).toBe(true);
  });

  it("offers Promote to Main only for an alter persona", () => {
    expect(
      buttonFor(build(GUILD_MANAGER, { selectedPersonaId: 56 }), {
        action: "promote-view",
        locale: "en-US",
        personaId: 56,
      }),
    ).toBeDefined();
    expect(
      buttonFor(build(GUILD_MANAGER, { selectedPersonaId: 55 }), {
        action: "promote-view",
        locale: "en-US",
        personaId: 55,
      }),
    ).toBeUndefined();
  });

  it("disables manager-owned identity actions for a guild member without hiding them", () => {
    const payload = build(GUILD_MEMBER);
    expect(buttonFor(payload, { action: "avatar-open", locale: "en-US", personaId: 55 })?.disabled).toBe(true);
    expect(buttonFor(payload, { action: "rename-open", locale: "en-US", personaId: 55 })?.disabled).toBe(true);
  });

  it("omits guild-only identity actions in a DM workspace", () => {
    const payload = build(DM_OWNER);
    expect(buttonFor(payload, { action: "avatar-open", locale: "en-US", personaId: 55 })).toBeUndefined();
    expect(buttonFor(payload, { action: "trigger-add-open", locale: "en-US", personaId: 55 })).toBeUndefined();
    expect(buttonFor(payload, { action: "trigger-remove-open", locale: "en-US", personaId: 55 })).toBeUndefined();
    expect(buttonFor(payload, { action: "promote-view", locale: "en-US", personaId: 56 })).toBeUndefined();
    expect(buttonFor(payload, { action: "rename-open", locale: "en-US", personaId: 55 })?.disabled).toBe(false);

    const namingPayload = build(DM_OWNER, { page: "naming" });
    expect(
      buttonFor(namingPayload, { action: "naming-open", locale: "en-US", personaId: 55, style: "neutral" })?.disabled,
    ).toBe(false);
  });

  it("keeps Persona General states within Discord's component ceiling", () => {
    const personaCounts = [0, 1, 24, 25, 26, 50, 200] as const;
    // An alter carries the Promote button, so a main persona is one component short of this page's
    // maximum and cannot clear a change to its component budget on its own.
    const makeSelected = (isAlter: boolean) =>
      makePersona({
        persona_id: 55,
        persona_nickname: "Aphel",
        is_alter: isAlter,
        attribute_list: ["Likes tea"],
        sample_dialogues_in: ["Hello"],
        sample_dialogues_out: ["Hi"],
      });

    for (const personaCount of personaCounts) {
      for (const isAlter of [false, true]) {
        const selectedPersona = makeSelected(isAlter);
        const personas =
          personaCount === 0
            ? []
            : [
                selectedPersona,
                ...Array.from({ length: personaCount - 1 }, (_, index) => {
                  const personaId = index + 1;
                  return makePersona({ persona_id: personaId === 55 ? personaCount + 1000 : personaId });
                }),
              ];

        for (const hasReceipt of [false, true]) {
          for (const hasAvatar of [false, true]) {
            for (const hasSelectedAttribute of [false, true]) {
              for (const hasSelectedDialogue of [false, true]) {
                const state = {
                  personaCount,
                  isAlter,
                  hasReceipt,
                  hasAvatar,
                  hasSelectedAttribute,
                  hasSelectedDialogue,
                };
                const payload = build(GUILD_MANAGER, {
                  personas,
                  selectedAttributeIndex: hasSelectedAttribute ? 0 : undefined,
                  selectedDialogueIndex: hasSelectedDialogue ? 0 : undefined,
                  selectedPersonaAvatarUrl: hasAvatar ? "https://cdn.example.invalid/55.png" : null,
                  receipt: hasReceipt
                    ? { tone: "success", heading: "Saved", detail: "The change was saved." }
                    : undefined,
                });
                const result = validateComponentsV2MessageLimits(payload);

                expect(
                  result.valid,
                  `Persona General state ${JSON.stringify(state)} violations: ${JSON.stringify(result.violations)}`,
                ).toBe(true);
              }
            }
          }
        }
      }
    }

    for (const selected of [
      { name: "attribute only", attribute: true, dialogue: false },
      { name: "dialogue only", attribute: false, dialogue: true },
      { name: "both collections", attribute: true, dialogue: true },
    ]) {
      const semanticPersona = makePersona({
        persona_id: 56,
        persona_nickname: "Wren",
        is_alter: true,
        attribute_list: Array.from(
          { length: selected.attribute ? 25 : 1 },
          (_unused, index) => `Attribute ${index + 1}`,
        ),
        sample_dialogues_in: Array.from(
          { length: selected.dialogue && !selected.attribute ? 25 : 1 },
          (_unused, index) => `In ${index + 1}`,
        ),
        sample_dialogues_out: Array.from(
          { length: selected.dialogue && !selected.attribute ? 25 : 1 },
          (_unused, index) => `Out ${index + 1}`,
        ),
      });
      const payload = build(GUILD_MANAGER, {
        personas: [MAIN, semanticPersona],
        selectedPersonaId: 56,
        selectedAttributeIndex: selected.attribute ? 0 : undefined,
        selectedDialogueIndex: selected.dialogue ? 0 : undefined,
        selectedPersonaAvatarUrl: "https://cdn.example.invalid/56.png",
        receipt: { tone: "success", heading: "Saved", detail: "The change was saved." },
      });
      const result = validateComponentsV2MessageLimits(payload);
      expect(result.valid, `${selected.name} violations: ${JSON.stringify(result.violations)}`).toBe(true);
      expectCollectionActionPlacement(payload, selected);
    }
  });

  it("keeps collection pagination out of the identity action row when nothing is selected", () => {
    // Both collection bodies end on their own pagination row when nothing is selected, so a merge
    // that identifies the trailing row by position captures pagination buttons instead of the edit
    // and remove pair, stranding a collection's page controls in the identity row above its select.
    const persona = makePersona({
      persona_id: 55,
      attribute_list: Array.from({ length: 30 }, (_unused, index) => `Attribute ${index + 1}`),
      sample_dialogues_in: Array.from({ length: 30 }, (_unused, index) => `In ${index + 1}`),
      sample_dialogues_out: Array.from({ length: 30 }, (_unused, index) => `Out ${index + 1}`),
    });
    const payload = build(GUILD_MANAGER, {
      personas: [persona, ALTER],
      selectedPersonaAvatarUrl: "https://cdn.example.invalid/55.png",
      receipt: { tone: "success", heading: "Saved", detail: "The change was saved." },
    });
    const result = validateComponentsV2MessageLimits(payload);
    expect(result.valid, `violations: ${JSON.stringify(result.violations)}`).toBe(true);

    const identityRow = buttonRowContaining(payload, "avatar-open");
    expect(identityRow).toBeDefined();
    for (const customId of identityRow ?? []) {
      expect(customId, "identity row holds a collection page control").not.toContain("attr-page");
      expect(customId, "identity row holds a collection page control").not.toContain("dlg-page");
      expect(customId, "identity row holds a pagination indicator").not.toContain("pagination-indicator");
    }
  });

  it("keeps Persona confirmation, stale, unavailable, and receipt repaints valid", () => {
    const persona = makePersona({
      persona_id: 55,
      attribute_list: ["Likes tea"],
      sample_dialogues_in: ["Hello"],
      sample_dialogues_out: ["Hi"],
    });
    const base = {
      personas: [persona, ALTER],
      selectedAttributeIndex: 0,
      selectedDialogueIndex: 0,
      selectedPersonaAvatarUrl: "https://cdn.example.invalid/55.png",
    } satisfies Partial<Parameters<typeof buildConfigPanelPayload>[0]>;
    const repaints: Array<{
      name: string;
      overrides: Partial<Parameters<typeof buildConfigPanelPayload>[0]>;
    }> = [
      {
        name: "confirmation",
        overrides: { view: { kind: "promote-confirm", personaId: 56, nonce: "nonce1234567" } },
      },
      { name: "stale", overrides: { readStatus: "stale" } },
      { name: "unavailable and retry", overrides: { readStatus: "unavailable" } },
      {
        name: "receipt-bearing",
        overrides: { receipt: { tone: "success", heading: "Saved", detail: "The change was saved." } },
      },
    ];

    for (const repaint of repaints) {
      const result = validateComponentsV2MessageLimits(build(GUILD_MANAGER, { ...base, ...repaint.overrides }));
      expect(result.valid, `${repaint.name} violations: ${JSON.stringify(result.violations)}`).toBe(true);
    }
  });
});

describe("config Persona Triggers body", () => {
  it("disables both trigger actions for an ordinary guild member", () => {
    const payload = build(GUILD_MEMBER, { page: "triggers" });
    expect(buttonFor(payload, { action: "trigger-add-open", locale: "en-US", personaId: 55 })?.disabled).toBe(true);
    expect(buttonFor(payload, { action: "trigger-remove-open", locale: "en-US", personaId: 55 })?.disabled).toBe(true);
  });

  it("disables Remove Trigger when the persona has no trigger words", () => {
    expect(
      buttonFor(build(GUILD_MANAGER, { page: "triggers", selectedPersonaId: 56 }), {
        action: "trigger-remove-open",
        locale: "en-US",
        personaId: 56,
      })?.disabled,
    ).toBe(true);
    expect(
      buttonFor(build(GUILD_MANAGER, { page: "triggers", selectedPersonaId: 55 }), {
        action: "trigger-remove-open",
        locale: "en-US",
        personaId: 55,
      })?.disabled,
    ).toBe(false);
  });

  it("renders stored trigger words, and None when there are none", () => {
    expect(
      walk(build(GUILD_MANAGER, { page: "triggers", selectedPersonaId: 55 })).some((c) =>
        c.content?.includes("`aphel`"),
      ),
    ).toBe(true);
    expect(
      walk(build(GUILD_MANAGER, { page: "triggers", selectedPersonaId: 56 })).some((c) =>
        c.content?.includes("> None"),
      ),
    ).toBe(true);
  });

  it("omits the guild-only trigger page from a DM workspace", () => {
    const pageSelect = walk(build(DM_OWNER)).find(
      (component) => component.type === STRING_SELECT && component.placeholder === "Choose a page...",
    );
    expect(pageSelect?.options?.some((option) => option.value === "triggers")).toBe(false);
  });
});

describe("config Persona General collections", () => {
  it("renders add-first collection selectors and selected fence-safe content", () => {
    const persona = makePersona({
      persona_id: 55,
      attribute_list: ["Likes tea", "Uses ``` safely"],
      persona_attributes: [
        { persona_id: 55, attribute_order: 1, attribute_text: "Likes tea", is_public: true },
        { persona_id: 55, attribute_order: 2, attribute_text: "Uses ``` safely", is_public: false },
      ],
      sample_dialogues_in: ["Hello"],
      sample_dialogues_out: ["Hi there"],
    });
    const payload = build(GUILD_MANAGER, {
      personas: [persona],
      selectedPersonaId: 55,
      selectedAttributeIndex: 1,
      selectedDialogueIndex: 0,
    });
    const seen = walk(payload);
    const attributeSelect = seen.find(
      (component) =>
        component.customId ===
        buildConfigRouteId({
          action: "attribute-select",
          locale: "en-US",
          personaId: 55,
        }),
    );
    const dialogueSelect = seen.find(
      (component) =>
        component.customId ===
        buildConfigRouteId({
          action: "dialogue-select",
          locale: "en-US",
          personaId: 55,
        }),
    );

    // The ordinal is load-bearing: edit and remove routes carry the index and paging is positional,
    // so it is how a user and the route agree on which entry is meant. The word is not, because the
    // section heading directly above the select already says it, and a label is capped at 100.
    expect(attributeSelect?.options?.[1]).toMatchObject({ label: "1. Likes tea", value: "0" });
    expect(dialogueSelect?.options?.[1]?.label).toBe("1. Hello");
    expect(attributeSelect?.options?.[0]).toMatchObject({ label: "+ Add new Attribute", value: "add" });
    expect(dialogueSelect?.options?.[0]).toMatchObject({ label: "+ Add new Dialogue", value: "add" });
    expect(attributeSelect?.options?.find((option) => option.default)?.value).toBe("1");
    expect(dialogueSelect?.options?.find((option) => option.default)?.value).toBe("0");
    // The attribute's own triple backtick must survive as guarded text, leaving only the wrapper's
    // opening and closing delimiters. Asserting the guard's byte shape instead would pin one
    // escaping algorithm rather than the property that keeps the fence closed.
    const guardedAttribute = seen.find((component) => component.content?.includes("Uses"));
    expect(guardedAttribute?.content).toBeDefined();
    expect(guardedAttribute?.content).not.toContain("Uses ``` safely");
    expect(guardedAttribute?.content).toContain("\u200b");
    expect((guardedAttribute?.content?.match(/```/g) ?? []).length % 2).toBe(0);
    expect(
      seen.some(
        (component) =>
          component.customId ===
          buildConfigRouteId({
            action: "attribute-edit-open",
            locale: "en-US",
            personaId: 55,
            index: 1,
            fp: computeAttributeFingerprint(55, 1, "Uses ``` safely", false),
          }),
      ),
    ).toBe(true);
    expect(
      seen.some(
        (component) =>
          component.customId ===
          buildConfigRouteId({
            action: "dialogue-remove",
            locale: "en-US",
            personaId: 55,
            index: 0,
            fp: computeDialogueFingerprint(55, 0, "Hello", "Hi there"),
          }),
      ),
    ).toBe(true);
  });

  it("renders only the add option for empty collections", () => {
    const seen = walk(build(GUILD_MANAGER));
    const attributeSelect = seen.find((component) => component.customId?.includes(":attr-select:"));
    const dialogueSelect = seen.find((component) => component.customId?.includes(":dlg-select:"));

    expect(attributeSelect?.options).toHaveLength(1);
    expect(dialogueSelect?.options).toHaveLength(1);
    expect(seen.some((component) => component.customId?.includes(":attr-edit-open:"))).toBe(false);
    expect(seen.some((component) => component.customId?.includes(":dlg-edit-open:"))).toBe(false);
  });

  it("filters collection writes for a non-manager when teaching is disabled", () => {
    const persona = makePersona({
      persona_id: 55,
      attribute_list: ["Likes tea"],
      sample_dialogues_in: ["Hello"],
      sample_dialogues_out: ["Hi there"],
    });
    const payload = build(GUILD_MEMBER, {
      personas: [persona],
      selectedPersonaId: 55,
      selectedAttributeIndex: 0,
      selectedDialogueIndex: 0,
      attributeMemteachingEnabled: false,
      sampledialogueMemteachingEnabled: false,
    });
    const seen = walk(payload);
    const attributeFingerprint = computeAttributeFingerprint(55, 0, "Likes tea", false);
    const dialogueFingerprint = computeDialogueFingerprint(55, 0, "Hello", "Hi there");

    expect(
      seen
        .find(
          (component) =>
            component.customId === buildConfigRouteId({ action: "attribute-select", locale: "en-US", personaId: 55 }),
        )
        ?.options?.some((option) => option.value === "add"),
    ).toBe(false);
    expect(
      seen
        .find(
          (component) =>
            component.customId === buildConfigRouteId({ action: "dialogue-select", locale: "en-US", personaId: 55 }),
        )
        ?.options?.some((option) => option.value === "add"),
    ).toBe(false);
    expect(
      buttonFor(payload, {
        action: "attribute-edit-open",
        locale: "en-US",
        personaId: 55,
        index: 0,
        fp: attributeFingerprint,
      })?.disabled,
    ).toBe(true);
    expect(
      buttonFor(payload, {
        action: "attribute-remove",
        locale: "en-US",
        personaId: 55,
        index: 0,
        fp: attributeFingerprint,
      })?.disabled,
    ).toBe(true);
    expect(
      buttonFor(payload, {
        action: "dialogue-edit-open",
        locale: "en-US",
        personaId: 55,
        index: 0,
        fp: dialogueFingerprint,
      })?.disabled,
    ).toBe(true);
    expect(
      buttonFor(payload, {
        action: "dialogue-remove",
        locale: "en-US",
        personaId: 55,
        index: 0,
        fp: dialogueFingerprint,
      })?.disabled,
    ).toBe(true);
    expect(
      seen.filter((component) => component.content === "-# Member teaching is disabled in this workspace."),
    ).toHaveLength(2);
  });

  it("omits empty collection selectors when teaching is disabled", () => {
    const seen = walk(
      build(GUILD_MEMBER, {
        attributeMemteachingEnabled: false,
        sampledialogueMemteachingEnabled: false,
      }),
    );

    expect(seen.some((component) => component.customId?.includes(":attr-select:"))).toBe(false);
    expect(seen.some((component) => component.customId?.includes(":dlg-select:"))).toBe(false);
  });

  it("lets guild managers write collections regardless of teaching flags", () => {
    const persona = makePersona({
      persona_id: 55,
      attribute_list: ["Likes tea"],
      sample_dialogues_in: ["Hello"],
      sample_dialogues_out: ["Hi there"],
    });
    const payload = build(GUILD_MANAGER, {
      personas: [persona],
      selectedPersonaId: 55,
      selectedAttributeIndex: 0,
      selectedDialogueIndex: 0,
      attributeMemteachingEnabled: false,
      sampledialogueMemteachingEnabled: false,
    });
    const seen = walk(payload);
    const attributeFingerprint = computeAttributeFingerprint(55, 0, "Likes tea", false);
    const dialogueFingerprint = computeDialogueFingerprint(55, 0, "Hello", "Hi there");

    expect(seen.find((component) => component.customId?.includes(":attr-select:"))?.options?.[0]?.value).toBe("add");
    expect(seen.find((component) => component.customId?.includes(":dlg-select:"))?.options?.[0]?.value).toBe("add");
    expect(
      buttonFor(payload, {
        action: "attribute-edit-open",
        locale: "en-US",
        personaId: 55,
        index: 0,
        fp: attributeFingerprint,
      })?.disabled,
    ).toBe(false);
    expect(
      buttonFor(payload, {
        action: "attribute-remove",
        locale: "en-US",
        personaId: 55,
        index: 0,
        fp: attributeFingerprint,
      })?.disabled,
    ).toBe(false);
    expect(
      buttonFor(payload, {
        action: "dialogue-edit-open",
        locale: "en-US",
        personaId: 55,
        index: 0,
        fp: dialogueFingerprint,
      })?.disabled,
    ).toBe(false);
    expect(
      buttonFor(payload, {
        action: "dialogue-remove",
        locale: "en-US",
        personaId: 55,
        index: 0,
        fp: dialogueFingerprint,
      })?.disabled,
    ).toBe(false);
  });

  it("keeps a DM owner behind the teaching flag", () => {
    const persona = makePersona({
      persona_id: 55,
      attribute_list: ["Likes tea"],
      sample_dialogues_in: ["Hello"],
      sample_dialogues_out: ["Hi there"],
    });
    const payload = build(DM_OWNER, {
      personas: [persona],
      selectedPersonaId: 55,
      selectedAttributeIndex: 0,
      selectedDialogueIndex: 0,
      attributeMemteachingEnabled: false,
      sampledialogueMemteachingEnabled: false,
    });
    const seen = walk(payload);

    expect(seen.find((component) => component.customId?.includes(":attr-select:"))?.options?.[0]?.value).not.toBe(
      "add",
    );
    expect(seen.find((component) => component.customId?.includes(":dlg-select:"))?.options?.[0]?.value).not.toBe("add");
  });

  it("keeps non-manager collection writes enabled when teaching is on", () => {
    const persona = makePersona({
      persona_id: 55,
      attribute_list: ["Likes tea"],
      sample_dialogues_in: ["Hello"],
      sample_dialogues_out: ["Hi there"],
    });
    const payload = build(GUILD_MEMBER, {
      personas: [persona],
      selectedPersonaId: 55,
      selectedAttributeIndex: 0,
      selectedDialogueIndex: 0,
      attributeMemteachingEnabled: true,
      sampledialogueMemteachingEnabled: true,
    });
    const seen = walk(payload);
    const attributeFingerprint = computeAttributeFingerprint(55, 0, "Likes tea", false);
    const dialogueFingerprint = computeDialogueFingerprint(55, 0, "Hello", "Hi there");

    expect(seen.find((component) => component.customId?.includes(":attr-select:"))?.options?.[0]?.value).toBe("add");
    expect(seen.find((component) => component.customId?.includes(":dlg-select:"))?.options?.[0]?.value).toBe("add");
    expect(
      buttonFor(payload, {
        action: "attribute-edit-open",
        locale: "en-US",
        personaId: 55,
        index: 0,
        fp: attributeFingerprint,
      })?.disabled,
    ).toBe(false);
    expect(
      buttonFor(payload, {
        action: "dialogue-edit-open",
        locale: "en-US",
        personaId: 55,
        index: 0,
        fp: dialogueFingerprint,
      })?.disabled,
    ).toBe(false);
    expect(
      buttonFor(payload, {
        action: "attribute-remove",
        locale: "en-US",
        personaId: 55,
        index: 0,
        fp: attributeFingerprint,
      })?.disabled,
    ).toBe(false);
    expect(
      buttonFor(payload, {
        action: "dialogue-remove",
        locale: "en-US",
        personaId: 55,
        index: 0,
        fp: dialogueFingerprint,
      })?.disabled,
    ).toBe(false);
    expect(seen.some((component) => component.content === "-# Member teaching is disabled in this workspace.")).toBe(
      false,
    );
  });

  it("uses 24 records per collection page and paginates only above that count", () => {
    const attributes = Array.from({ length: 25 }, (_, index) => `Attribute ${index + 1}`);
    const dialoguesIn = Array.from({ length: 25 }, (_, index) => `User ${index + 1}`);
    const dialoguesOut = Array.from({ length: 25 }, (_, index) => `Reply ${index + 1}`);
    const persona = makePersona({
      persona_id: 55,
      attribute_list: attributes,
      sample_dialogues_in: dialoguesIn,
      sample_dialogues_out: dialoguesOut,
    });
    const payload = build(GUILD_MANAGER, { personas: [persona], selectedPersonaId: 55 });
    const seen = walk(payload);
    const attributeSelect = seen.find((component) => component.customId?.includes(":attr-select:"));
    const dialogueSelect = seen.find((component) => component.customId?.includes(":dlg-select:"));

    expect(attributeSelect?.options).toHaveLength(CONFIG_PERSONA_COLLECTION_PAGE_SIZE + 1);
    expect(dialogueSelect?.options).toHaveLength(CONFIG_PERSONA_COLLECTION_PAGE_SIZE + 1);
    expect(seen.filter((component) => component.label === "Next →")).toHaveLength(2);
    expect(seen.filter((component) => component.label === "Page 1 of 2")).toHaveLength(2);
  });

  it("renders every addressing style with its own edit button", () => {
    const persona = makePersona({
      persona_id: 55,
      persona_nickname: "Aphel",
      naming_config: {
        prefixes: { feminine: "Miss" },
        suffixes: {},
        addressTerms: {},
      },
    } as Partial<TomoriState> & { persona_id: number });
    const payload = build(GUILD_MANAGER, { personas: [persona], page: "naming" });
    const components = walk(payload);

    // Showing all three styles is what retires the addressing-style selector: an edit route already
    // carries the style it belongs to, so no shared button needs telling which one is active.
    expect(
      components.some(
        (component) => component.type === STRING_SELECT && component.placeholder === "Choose an addressing style...",
      ),
    ).toBe(false);

    for (const style of ["masculine", "feminine", "neutral"] as const) {
      expect(buttonFor(payload, { action: "naming-open", locale: "en-US", personaId: 55, style })).toBeDefined();
    }

    expect(
      components.some((component) =>
        component.content?.includes(
          "**Feminine**\nControls how this persona addresses people\nwho identify as feminine.",
        ),
      ),
    ).toBe(true);
    expect(components.some((component) => component.content?.includes("> Prefix: `Miss`"))).toBe(true);
  });

  it("renders the Lilya preset's neutral suffix", () => {
    const lilya = makePersona({
      persona_id: 55,
      persona_nickname: "Lilya",
      naming_config: { prefixes: {}, suffixes: { neutral: "-senpai" }, addressTerms: {} },
    });
    const payload = build(GUILD_MANAGER, { personas: [lilya], selectedPersonaId: 55, page: "naming" });
    expect(walk(payload).some((component) => component.content?.includes("Suffix: `-senpai`"))).toBe(true);
  });

  it("disables every control while the panel state is stale", () => {
    const payload = build(GUILD_MANAGER, { readStatus: "stale" });
    const interactive = walk(payload).filter(
      (component) => component.type === BUTTON || component.type === STRING_SELECT,
    );
    expect(interactive.length).toBeGreaterThan(0);
    // The category row is not disabled by staleness, only by an unavailable read, so it is excluded.
    const bodyControls = interactive.filter((component) => component.customId?.includes(":category:") !== true);
    expect(bodyControls.every((component) => component.disabled === true)).toBe(true);
  });

  it("renders a retry affordance and no body when the workspace read is unavailable", () => {
    const payload = build(GUILD_MANAGER, { readStatus: "unavailable" });
    expect(
      buttonFor(payload, { action: "retry", locale: "en-US", category: "persona", page: "general", personaId: 55 }),
    ).toBeDefined();
    expect(buttonFor(payload, { action: "rename-open", locale: "en-US", personaId: 55 })).toBeUndefined();
  });
});

describe("config Persona Memories body", () => {
  it("sums conditioning per action and names each total in its own number", () => {
    // Groups key on reason as well as action, so two Headpat rows with different reasons are one
    // Headpat total to the reader; the singular label only survives on a count of exactly one.
    const group = (
      overrides: Partial<ConditioningGroup> & Pick<ConditioningGroup, "conditioningType" | "actionKey" | "totalCount">,
    ): ConditioningGroup => ({ ...MEMORY_CONDITIONING, ...overrides });
    const payload = build(GUILD_MANAGER, {
      page: "memories",
      personaMemoryView: {
        ...MEMORY_VIEW,
        conditioningGroups: [
          group({ conditioningType: "reward", actionKey: "headpat", totalCount: 3 }),
          group({ conditioningType: "reward", actionKey: "headpat", totalCount: 2, reasonText: "another reason" }),
          group({ conditioningType: "reward", actionKey: "kiss", totalCount: 18 }),
          group({ conditioningType: "punish", actionKey: "bonk", totalCount: 1 }),
        ],
      },
    });
    const text = walk(payload)
      .map((component) => component.content ?? "")
      .join("\n");

    expect(text).toContain("Rewarded 23 times:");
    // Ranked by count, so the larger total leads regardless of the order the rows arrived in.
    expect(text.indexOf("18 Kisses")).toBeLessThan(text.indexOf("5 Headpats"));
    expect(text).toContain("Punished once:");
    expect(text).toContain("1 Bonk");
  });

  it("renders long-term counts, selected-persona STM, conditioning, and route buttons", () => {
    const payload = build(GUILD_MANAGER, { page: "memories", personaMemoryView: MEMORY_VIEW });
    const seen = walk(payload);

    expect(seen.some((component) => component.content?.includes("Server memories: 4"))).toBe(true);
    expect(seen.some((component) => component.content?.includes("A stored scene"))).toBe(true);
    expect(seen.some((component) => component.content?.includes("Rewarded once:"))).toBe(true);
    expect(seen.some((component) => component.content?.includes("1 Headpat"))).toBe(true);
    expect(seen.some((component) => component.content?.includes("Punished 0 times"))).toBe(true);
    expect(buttonFor(payload, { action: "server-memory-open", locale: "en-US", personaId: 55 })).toBeDefined();
    expect(buttonFor(payload, { action: "personal-memory-open", locale: "en-US", personaId: 55 })).toBeDefined();
    expect(buttonFor(payload, { action: "stm-edit-open", locale: "en-US", personaId: 55 })?.disabled).toBe(false);
    expect(buttonFor(payload, { action: "conditioning-open", locale: "en-US", personaId: 55 })?.disabled).toBe(false);
    expect(seen.some((component) => component.content?.includes("```markdown"))).toBe(true);
  });

  it("keeps member STM readable while disabling editing and omitting conditioning management in DMs", () => {
    const member = walk(build(GUILD_MEMBER, { page: "memories", personaMemoryView: MEMORY_VIEW }));
    expect(member.some((component) => component.content?.includes("A stored scene"))).toBe(true);
    expect(
      buttonFor(build(GUILD_MEMBER, { page: "memories", personaMemoryView: MEMORY_VIEW }), {
        action: "stm-edit-open",
        locale: "en-US",
        personaId: 55,
      })?.disabled,
    ).toBe(true);

    const dm = build(DM_OWNER, { page: "memories", personaMemoryView: MEMORY_VIEW });
    expect(buttonFor(dm, { action: "stm-edit-open", locale: "en-US", personaId: 55 })?.disabled).toBe(false);
    expect(buttonFor(dm, { action: "conditioning-open", locale: "en-US", personaId: 55 })).toBeUndefined();
  });

  it("renders summary mode as well as category mode", () => {
    const summaryView = {
      ...MEMORY_VIEW,
      stmCategories: MEMORY_CATEGORIES.slice(0, 1),
      stmEntry: { ...MEMORY_VIEW.stmEntry, summary: "Summary mode text", categories: undefined },
    };
    const seen = walk(build(GUILD_MANAGER, { page: "memories", personaMemoryView: summaryView }));
    expect(seen.some((component) => component.content?.includes("Summary mode text"))).toBe(true);
    expect(seen.some((component) => component.content?.includes("People"))).toBe(false);
  });

  it("keeps the complete STM TextDisplay within its Discord length ceiling", () => {
    const longView = {
      ...MEMORY_VIEW,
      stmEntry: {
        ...MEMORY_VIEW.stmEntry,
        categories: { summary: "x".repeat(10000) },
      },
    };
    const stmDisplay = walk(build(GUILD_MANAGER, { page: "memories", personaMemoryView: longView })).find(
      (component) => component.content?.includes("Short-Term Memory") && component.content?.includes("Active channel"),
    );

    expect(stmDisplay?.content?.length).toBeLessThanOrEqual(3800);
    expect(stmDisplay?.content).toMatch(/Content truncated \(\d+\/\d+ shown\)\./);
  });
});

describe("config promote confirmation view", () => {
  it("replaces the body with a Danger confirm and a Cancel", () => {
    const payload = build(GUILD_MANAGER, {
      selectedPersonaId: 56,
      view: { kind: "promote-confirm", personaId: 56, nonce: "nonce1234567" },
    });

    const confirm = buttonFor(payload, {
      action: "promote-confirm",
      locale: "en-US",
      personaId: 56,
      nonce: "nonce1234567",
    });
    // ButtonStyle.Danger is 4.
    expect(confirm).toBeDefined();
    expect(
      (payload.components[0] as unknown as { components: unknown }) &&
        walk(payload).find((c) => c.customId === confirm?.customId),
    ).toBeDefined();
    expect(buttonFor(payload, { action: "promote-cancel", locale: "en-US", personaId: 56 })).toBeDefined();
    expect(buttonFor(payload, { action: "rename-open", locale: "en-US", personaId: 56 })).toBeUndefined();
  });
});

describe("config Persona Appearance and Advanced bodies", () => {
  const advancedPersona = makePersona({
    persona_id: 55,
    physical_appearance_tags: ["silver hair", "green eyes"],
    nai_char_ref_url: "data/charreferences/personas/55/old.png",
    nai_attg_author: "A careful author",
    nai_attg_title: "A careful title",
    nai_attg_tags: "archivist, mystery",
    nai_attg_genre: "fantasy",
    nai_attg_stars: 5,
    persona_prompt: "A careful archivist.",
    context_note: "Prefer concise answers.",
    context_note_depth: 4,
    humanizer_degree_override: 2,
    llm: {
      llm_id: 10,
      llm_provider: "openrouter",
      llm_codename: "server-model",
    },
    persona_llm: {
      llm_id: 11,
      llm_provider: "google",
      llm_codename: "persona-model",
    },
  });

  it("renders visual settings on Appearance without exposing the saved reference path", () => {
    const payload = build(GUILD_MANAGER, {
      page: "appearance",
      personas: [advancedPersona],
      selectedPersonaId: 55,
    });
    expect(buttonFor(payload, { action: "image-tags-open", locale: "en-US", personaId: 55 })).toBeDefined();
    expect(buttonFor(payload, { action: "character-reference-open", locale: "en-US", personaId: 55 })).toBeDefined();
    expect(
      buttonFor(payload, { action: "character-reference-clear-view", locale: "en-US", personaId: 55 })?.style,
    ).toBe(4);
    expect(JSON.stringify(payload)).toContain("Uploaded and Saved");
    expect(JSON.stringify(payload)).not.toContain("data/charreferences");
  });

  it("keeps the saved reference status adjacent to the persona-create hint", () => {
    const payload = build(GUILD_MANAGER, {
      page: "appearance",
      personas: [advancedPersona],
      selectedPersonaId: 55,
      selectedPersonaCharacterReferenceUrl: "attachment://persona_char_ref_55.png",
    });
    const savedReferenceDisplay = walk(payload).find(
      (component) =>
        component.type === TEXT_DISPLAY &&
        component.content?.includes("> Image: Uploaded and Saved") &&
        component.content?.includes("-# Add a new persona"),
    );

    expect(savedReferenceDisplay?.content).toContain("> Image: Uploaded and Saved\n-# Add a new persona");
    expect(savedReferenceDisplay?.content).not.toContain("> Image: Uploaded and Saved\n\n-# Add a new persona");

    const absentReferencePayload = build(GUILD_MANAGER, {
      page: "appearance",
      personas: [makePersona({ persona_id: 55, nai_char_ref_url: null })],
      selectedPersonaId: 55,
    });
    const hasBlankQuoteMarker = walk(absentReferencePayload).some(
      (component) =>
        component.type === TEXT_DISPLAY && component.content?.split("\n").some((line) => /^>\s*$/.test(line)),
    );
    expect(hasBlankQuoteMarker).toBe(false);
  });

  it("places a resolved character-reference gallery directly below its action row", () => {
    const payload = build(GUILD_MANAGER, {
      page: "appearance",
      personas: [advancedPersona],
      selectedPersonaId: 55,
      selectedPersonaCharacterReferenceUrl: "attachment://persona_char_ref_55.png",
    });
    const container = payload.components.find((component) => component.type === ComponentType.Container) as {
      components: Array<Record<string, unknown>>;
    };
    const actionId = buildConfigRouteId({ action: "character-reference-open", locale: "en-US", personaId: 55 });
    const actionRowIndex = container.components.findIndex((component) => {
      if (component.type !== ComponentType.ActionRow || !Array.isArray(component.components)) return false;
      return (component.components as Array<Record<string, unknown>>).some((child) => child.customId === actionId);
    });

    expect(actionRowIndex).toBeGreaterThanOrEqual(0);
    expect(container.components[actionRowIndex + 1]).toEqual({
      type: ComponentType.MediaGallery,
      items: [{ media: { url: "attachment://persona_char_ref_55.png" } }],
    });
    expect(container.components.at(-1)).toEqual(container.components[actionRowIndex + 1]);
    const limits = validateComponentsV2MessageLimits(payload);
    expect(limits.valid, JSON.stringify(limits.violations)).toBe(true);

    const withoutAsset = build(GUILD_MANAGER, {
      page: "appearance",
      personas: [advancedPersona],
      selectedPersonaId: 55,
    });
    expect(
      (
        withoutAsset.components.find((component) => component.type === ComponentType.Container) as {
          components: Array<Record<string, unknown>>;
        }
      ).components.some((component) => component.type === ComponentType.MediaGallery),
    ).toBe(false);
  });

  it("renders prompt, context, and ATTG sections on Advanced", () => {
    const payload = build(GUILD_MANAGER, {
      page: "advanced",
      personas: [advancedPersona],
      selectedPersonaId: 55,
      serverHumanizerDegree: 0,
    });
    const seen = walk(payload);
    expect(seen.some((component) => component.content?.includes("**Persona Prompt**"))).toBe(true);
    expect(seen.some((component) => component.content?.includes("**Context Note**"))).toBe(true);
    expect(seen.some((component) => component.content?.includes("**ATTG Configuration**"))).toBe(true);
    expect(seen.some((component) => component.content?.includes("**Response Style**"))).toBe(false);
    expect(seen.some((component) => component.content?.includes("**Text Model Override**"))).toBe(false);
    expect(buttonFor(payload, { action: "prompt-open", locale: "en-US", personaId: 55 })).toBeDefined();
    expect(buttonFor(payload, { action: "context-note-open", locale: "en-US", personaId: 55 })).toBeDefined();
    expect(buttonFor(payload, { action: "attg-open", locale: "en-US", personaId: 55 })?.style).toBe(2);
    expect(buttonFor(payload, { action: "attg-clear-all", locale: "en-US", personaId: 55 })?.style).toBe(4);
    expect(buttonFor(payload, { action: "humanizer-open", locale: "en-US", personaId: 55 })).toBeUndefined();
    expect(buttonFor(payload, { action: "text-override-clear", locale: "en-US", personaId: 55 })).toBeUndefined();
  });

  it("renders response style and text override sections on Overrides", () => {
    const payload = build(GUILD_MANAGER, {
      page: "overrides",
      personas: [advancedPersona],
      selectedPersonaId: 55,
      serverHumanizerDegree: 0,
    });
    const seen = walk(payload);
    expect(seen.some((component) => component.content?.includes("**Persona Prompt**"))).toBe(false);
    expect(seen.some((component) => component.content?.includes("**Context Note**"))).toBe(false);
    expect(seen.filter((component) => component.content?.includes("**Response Style**"))).toHaveLength(1);
    expect(seen.filter((component) => component.content?.includes("**Text Model Override**"))).toHaveLength(1);
    expect(buttonFor(payload, { action: "humanizer-open", locale: "en-US", personaId: 55 })).toBeDefined();
    expect(buttonFor(payload, { action: "text-override-clear", locale: "en-US", personaId: 55 })?.style).toBe(2);
    expect(seen.some((component) => component.content?.includes("> Server default: 0: None"))).toBe(true);
  });

  it("omits guild-only Advanced actions in a DM while retaining prompt and context", () => {
    const payload = build(DM_OWNER, { page: "advanced", personas: [advancedPersona] });
    expect(buttonFor(payload, { action: "image-tags-open", locale: "en-US", personaId: 55 })).toBeUndefined();
    expect(buttonFor(payload, { action: "character-reference-open", locale: "en-US", personaId: 55 })).toBeUndefined();
    expect(buttonFor(payload, { action: "attg-open", locale: "en-US", personaId: 55 })).toBeUndefined();
    expect(buttonFor(payload, { action: "attg-clear-all", locale: "en-US", personaId: 55 })).toBeUndefined();
    expect(buttonFor(payload, { action: "prompt-open", locale: "en-US", personaId: 55 })).toBeDefined();
    expect(buttonFor(payload, { action: "context-note-open", locale: "en-US", personaId: 55 })).toBeDefined();
    expect(buttonFor(payload, { action: "humanizer-open", locale: "en-US", personaId: 55 })).toBeUndefined();
    expect(buttonFor(payload, { action: "text-override-open", locale: "en-US", personaId: 55 })).toBeUndefined();
  });

  it("renders both Overrides actions in a DM", () => {
    const payload = build(DM_OWNER, { page: "overrides", personas: [advancedPersona] });
    expect(buttonFor(payload, { action: "humanizer-open", locale: "en-US", personaId: 55 })).toBeDefined();
    expect(buttonFor(payload, { action: "text-override-open", locale: "en-US", personaId: 55 })).toBeDefined();
  });

  it("omits both manager-owned bodies for a guild member", () => {
    const payload = build(GUILD_MEMBER, { page: "advanced", personas: [advancedPersona] });
    expect(walk(payload).some((component) => component.content?.includes("Advanced Persona Settings"))).toBe(false);
    expect(buttonFor(payload, { action: "prompt-open", locale: "en-US", personaId: 55 })).toBeUndefined();
    const overridesPayload = build(GUILD_MEMBER, { page: "overrides", personas: [advancedPersona] });
    expect(walk(overridesPayload).some((component) => component.content?.includes("Persona Overrides"))).toBe(false);
    expect(
      buttonFor(overridesPayload, { action: "text-override-open", locale: "en-US", personaId: 55 }),
    ).toBeUndefined();
  });
});

describe("config Persona Sprites page", () => {
  function makeSprite(overrides: Partial<PersonaSpriteRow> & { sprite_key: string }): PersonaSpriteRow {
    return {
      sprite_id: 1,
      persona_id: 55,
      sprite_name: overrides.sprite_key,
      avatar_url: `personas/55/${overrides.sprite_key}.png`,
      usage_instructions: "",
      is_identity: false,
      ...overrides,
    };
  }

  const SPRITES: PersonaSpriteRow[] = [
    makeSprite({ sprite_key: "happy", sprite_name: "Happy", usage_instructions: "When cheerful", is_identity: true }),
    makeSprite({ sprite_key: "sad", sprite_name: "Sad", sprite_id: 2 }),
  ];

  const spritesPage = (actor: ConfigActor, overrides: Record<string, unknown> = {}) =>
    build(actor, { page: "sprites", personaSprites: SPRITES, ...overrides });

  it("renders an add-aware selector in English and Japanese", () => {
    const cases = [
      { locale: "en-US", placeholder: "Choose or add a sprite..." },
      { locale: "ja", placeholder: "スプライトを選択または追加..." },
    ] as const;

    for (const { locale, placeholder } of cases) {
      const payload = spritesPage(GUILD_MANAGER, { locale });
      const selector = walk(payload).find(
        (component) =>
          component.type === STRING_SELECT &&
          component.customId === buildConfigRouteId({ action: "sprite-select", locale, personaId: 55 }),
      );

      expect(selector?.options?.some((option) => option.value === "add")).toBe(true);
      expect(selector?.placeholder).toBe(placeholder);
    }
  });

  it("renders the selector, the selected sprite, and both transfer actions for a manager", () => {
    const payload = spritesPage(GUILD_MANAGER, {
      selectedSpriteIndex: 0,
      selectedSpriteAvatarUrl: "attachment://persona_sprite_55_1.png",
    });
    const seen = walk(payload);

    const selector = seen.find(
      (component) =>
        component.type === STRING_SELECT &&
        component.customId === buildConfigRouteId({ action: "sprite-select", locale: "en-US", personaId: 55 }),
    );
    expect(selector?.options?.map((option) => option.value)).toEqual(["add", "0", "1"]);
    expect(selector?.options?.[1]?.default).toBe(true);

    const fp = computeSpriteFingerprint(55, 0, "happy");
    expect(
      buttonFor(payload, { action: "sprite-edit-open", locale: "en-US", personaId: 55, index: 0, fp })?.disabled,
    ).toBe(false);
    expect(
      buttonFor(payload, { action: "sprite-remove-view", locale: "en-US", personaId: 55, index: 0, fp })?.style,
    ).toBe(4);
    expect(selector?.options?.[0]?.label).toBe("+ Add Sprite");
    expect(buttonFor(payload, { action: "sprite-import-open", locale: "en-US", personaId: 55 })?.disabled).toBe(false);
    expect(buttonFor(payload, { action: "sprite-export", locale: "en-US", personaId: 55 })?.disabled).toBe(false);

    // The selected-sprite block carries the stored name, usage note, and identity flag.
    const detail = seen.find((component) => component.content?.includes("> Name: Happy"));
    expect(detail?.content).toContain("> Usage: When cheerful");
    expect(detail?.content).toContain("> Identity: Identity");
    expect(
      seen.some(
        (component) => component.type === THUMBNAIL && component.media?.url === "attachment://persona_sprite_55_1.png",
      ),
    ).toBe(true);
  });

  it("keeps Export live for a guild member while every mutation renders inert", () => {
    const payload = spritesPage(GUILD_MEMBER, { selectedSpriteIndex: 0 });
    const fp = computeSpriteFingerprint(55, 0, "happy");

    expect(buttonFor(payload, { action: "sprite-export", locale: "en-US", personaId: 55 })?.disabled).toBe(false);
    expect(walk(payload).some((component) => component.options?.some((option) => option.value === "add"))).toBe(false);
    expect(buttonFor(payload, { action: "sprite-import-open", locale: "en-US", personaId: 55 })?.disabled).toBe(true);
    expect(
      buttonFor(payload, { action: "sprite-edit-open", locale: "en-US", personaId: 55, index: 0, fp })?.disabled,
    ).toBe(true);
    expect(
      buttonFor(payload, { action: "sprite-remove-view", locale: "en-US", personaId: 55, index: 0, fp })?.disabled,
    ).toBe(true);
  });

  it("omits the guild-only mutations in a DM while Export and the selector remain", () => {
    const payload = spritesPage(DM_OWNER, { selectedSpriteIndex: 0 });
    const fp = computeSpriteFingerprint(55, 0, "happy");

    expect(buttonFor(payload, { action: "sprite-add-open", locale: "en-US", personaId: 55 })).toBeUndefined();
    expect(buttonFor(payload, { action: "sprite-import-open", locale: "en-US", personaId: 55 })).toBeUndefined();
    expect(buttonFor(payload, { action: "sprite-export", locale: "en-US", personaId: 55 })?.disabled).toBe(false);
    // Edit and Remove still render beside the inspected sprite, disabled rather than hidden, so the
    // page does not silently lose its selection controls.
    expect(
      buttonFor(payload, { action: "sprite-edit-open", locale: "en-US", personaId: 55, index: 0, fp })?.disabled,
    ).toBe(true);
  });

  it("disables Export when the persona has no sprites to bundle", () => {
    const payload = build(GUILD_MANAGER, { page: "sprites", personaSprites: [] });
    expect(buttonFor(payload, { action: "sprite-export", locale: "en-US", personaId: 55 })?.disabled).toBe(true);
    expect(walk(payload).some((component) => component.customId?.includes("sprite-select"))).toBe(true);
    expect(walk(payload).some((component) => component.options?.[0]?.value === "add")).toBe(true);
  });

  it("pages a sprite set larger than one selector and keeps each option addressable", () => {
    const many = Array.from({ length: CONFIG_PERSONA_SPRITE_PAGE_SIZE + 5 }, (_unused, index) =>
      makeSprite({ sprite_key: `sprite${String(index).padStart(2, "0")}`, sprite_id: index + 1 }),
    );
    const payload = build(GUILD_MANAGER, {
      page: "sprites",
      personaSprites: many,
      selectedSpriteIndex: CONFIG_PERSONA_SPRITE_PAGE_SIZE,
    });
    // Found by custom ID rather than by shape: the page selector is also a String Select carrying
    // options, and it renders first.
    const selector = walk(payload).find(
      (component) =>
        component.type === STRING_SELECT &&
        component.customId === buildConfigRouteId({ action: "sprite-select", locale: "en-US", personaId: 55 }),
    );

    expect(selector?.options?.length).toBe(6);
    expect(selector?.options?.[1]?.value).toBe(String(CONFIG_PERSONA_SPRITE_PAGE_SIZE));
    expect(
      walk(payload).some((component) =>
        component.customId?.includes(
          buildConfigRouteId({
            action: "sprite-page",
            locale: "en-US",
            personaId: 55,
            start: 0,
          }),
        ),
      ),
    ).toBe(true);
  });

  it("names the sprite in its removal confirmation and keeps the Danger button", () => {
    const fp = computeSpriteFingerprint(55, 0, "happy");
    const payload = build(GUILD_MANAGER, {
      page: "sprites",
      personaSprites: SPRITES,
      view: { kind: "sprite-remove-confirm", personaId: 55, index: 0, fp, nonce: "nonce1234567" },
    });
    const seen = walk(payload);

    expect(seen.some((component) => component.content?.includes("Happy"))).toBe(true);
    expect(
      buttonFor(payload, {
        action: "sprite-remove-confirm",
        locale: "en-US",
        personaId: 55,
        index: 0,
        fp,
        nonce: "nonce1234567",
      })?.style,
    ).toBe(4);
    expect(buttonFor(payload, { action: "sprite-remove-cancel", locale: "en-US", personaId: 55 })).toBeDefined();
  });

  it("shows no removal confirmation to an actor who may not remove", () => {
    const fp = computeSpriteFingerprint(55, 0, "happy");
    const payload = build(GUILD_MEMBER, {
      page: "sprites",
      personaSprites: SPRITES,
      view: { kind: "sprite-remove-confirm", personaId: 55, index: 0, fp, nonce: "nonce1234567" },
    });

    expect(walk(payload).some((component) => component.customId?.includes("sprite-rem-confirm"))).toBe(false);
  });
});

describe("config Behavior pages", () => {
  const behaviorView = {
    general: {
      systemPrompt: "Keep replies concise.",
      contextNote: "Stay on topic.",
      contextNoteDepth: 2,
      humanizerDegree: 2,
      messageFetchLimit: 60,
      timezoneOffset: 8,
    },
    trigger: {
      randomTriggers: [
        {
          trigger_id: 9,
          server_id: 9,
          channel_disc_id: "channel-1",
          persona_id: 55,
          timer_hours: 2,
          random_offset_range: 1,
          chance_percent: 40,
          silence_threshold_hours: null,
          respond_to_self: false,
          custom_prompt: null,
          failure_threshold: null,
          next_trigger_at: new Date("2026-01-01T00:00:00Z"),
        },
      ],
      cascadeLimit: 3,
      matchLimit: 2,
      deliberateTriggerMode: true,
      alwaysReplyEnabled: false,
      cooldownType: 1,
      cooldownLength: 5,
    },
  };

  it("renders General's stored prompt and note in markdown fences and omits Timezone in DMs", () => {
    const payload = build(DM_OWNER, { category: "behavior", page: "general", behaviorView });
    const seen = walk(payload);
    expect(seen.some((component) => component.content?.includes("```markdown\nKeep replies concise."))).toBe(true);
    expect(seen.some((component) => component.content?.includes("```markdown\nStay on topic."))).toBe(true);
    expect(buttonFor(payload, { action: "behavior-context-open", locale: "en-US" })).toBeDefined();
    expect(buttonFor(payload, { action: "behavior-timezone-open", locale: "en-US" })).toBeUndefined();
  });

  it("renders Trigger as direct Off/On state controls and no live values for a member", () => {
    const manager = build(GUILD_MANAGER, { category: "behavior", page: "trigger", behaviorView });
    const controls = walk(manager).filter((component) => component.label === "Off" || component.label === "On");
    expect(controls.map((component) => component.style)).toEqual([2, 1, 1, 2]);
    expect(walk(manager).some((component) => component.content?.includes("<#channel-1>"))).toBe(true);

    const member = build(GUILD_MEMBER, { category: "behavior", page: "trigger", behaviorView });
    expect(walk(member).some((component) => component.content?.includes("Cascade limit: 3"))).toBe(false);
    expect(buttonFor(member, { action: "behavior-dtm-set", locale: "en-US", enabled: true })).toBeUndefined();
  });

  it("describes deliberate trigger mode with the effective behavior for both selected states", () => {
    const enabled = build(GUILD_MANAGER, {
      category: "behavior",
      page: "trigger",
      behaviorView: {
        ...behaviorView,
        trigger: { ...behaviorView.trigger, deliberateTriggerMode: true },
      },
    });
    const disabled = build(GUILD_MANAGER, {
      category: "behavior",
      page: "trigger",
      behaviorView: {
        ...behaviorView,
        trigger: { ...behaviorView.trigger, deliberateTriggerMode: false },
      },
    });

    expect(
      walk(enabled).some((component) => component.content === "> Only an @mention, a reply, or /respond reaches me."),
    ).toBe(true);
    expect(walk(disabled).some((component) => component.content === "> You can trigger me by saying my name.")).toBe(
      true,
    );
  });

  it("hides the irrelevant cooldown duration while trigger cooldown is off", () => {
    const payload = build(GUILD_MANAGER, {
      category: "behavior",
      page: "trigger",
      behaviorView: {
        ...behaviorView,
        trigger: { ...behaviorView.trigger, cooldownType: 0, cooldownLength: 5 },
      },
    });
    const cooldown = walk(payload).find((component) => component.content?.includes("**Trigger Cooldown**"));
    expect(cooldown?.content).toContain("> Off");
    expect(cooldown?.content).not.toContain("5s");
  });

  it("renders D10 Behavior controls only on their authorized pages", () => {
    const d10View = {
      ...behaviorView,
      experimental: {
        deliberateToolMode: true,
        deliberateToolContextTurns: 4,
        deliberateToolTriggers: { image: ["draw it"] },
        sendLimit: 3,
        selfDebugEnabled: false,
        workarounds: { verbatim_tool_calling_enabled: true },
      },
      notices: {
        hiddenNoticeKeys: ["web_search" as const],
        speechTranscriptsEnabled: true,
      },
      memory: {
        memoryTaggingEnabled: true,
        channelMemoryEnabled: false,
        stmConfig: null,
        stmCategories: MEMORY_CATEGORIES,
      },
    };
    const experimental = build(GUILD_MANAGER, { category: "behavior", page: "experimental", behaviorView: d10View });
    const notices = build(GUILD_MANAGER, { category: "behavior", page: "notices", behaviorView: d10View });
    const memory = build(GUILD_MANAGER, { category: "behavior", page: "memory", behaviorView: d10View });
    const dmNotices = build(DM_OWNER, { category: "behavior", page: "notices", behaviorView: d10View });

    expect(buttonFor(experimental, { action: "behavior-tool-trigger-add-open", locale: "en-US" })?.disabled).toBe(
      false,
    );
    expect(buttonFor(experimental, { action: "behavior-tool-trigger-remove-open", locale: "en-US" })?.disabled).toBe(
      false,
    );
    expect(buttonFor(notices, { action: "behavior-notice-visibility-open", locale: "en-US" })?.disabled).toBe(false);
    expect(walk(notices).some((component) => component.content?.includes("🔴 Web Search"))).toBe(true);
    expect(
      walk(notices).some((component) =>
        component.content?.includes("All disabled notice embeds will be posted in the Logs channel\n-# instead."),
      ),
    ).toBe(true);
    expect(
      buttonFor(notices, { action: "behavior-speech-transcripts-set", locale: "en-US", enabled: true })?.disabled,
    ).toBe(true);
    expect(
      buttonFor(notices, { action: "behavior-speech-transcripts-set", locale: "en-US", enabled: false })?.disabled,
    ).toBe(false);
    expect(
      buttonFor(dmNotices, { action: "behavior-speech-transcripts-set", locale: "en-US", enabled: false }),
    ).toBeDefined();
    expect(buttonFor(memory, { action: "behavior-stm-categories-open", locale: "en-US" })?.disabled).toBe(false);
    expect(walk(memory).some((component) => component.content?.includes("memory/#stm-configuration"))).toBe(true);
  });

  it("offers a page selector when random-trigger removal exceeds one modal", () => {
    const first = behaviorView.trigger.randomTriggers[0];
    const overflowingView = {
      ...behaviorView,
      trigger: {
        ...behaviorView.trigger,
        randomTriggers: Array.from({ length: 51 }, (_entry, index) => ({
          ...first,
          trigger_id: index + 1,
        })),
      },
    };
    const payload = build(GUILD_MANAGER, { category: "behavior", page: "trigger", behaviorView: overflowingView });
    expect(buttonFor(payload, { action: "behavior-random-remove-open", locale: "en-US" })).toMatchObject({
      disabled: false,
    });
    expect(buttonFor(payload, { action: "behavior-random-remove-select", locale: "en-US" })).toBeDefined();
    expect(walk(payload).some((component) => component.options?.some((option) => option.value === "50"))).toBe(true);
  });

  it("reaches random-trigger page ranges beyond the 25-option selector limit", () => {
    const first = behaviorView.trigger.randomTriggers[0];
    const triggers = Array.from({ length: 1300 }, (_entry, index) => ({ ...first, trigger_id: index + 1 }));
    const triggerView = {
      ...behaviorView,
      trigger: { ...behaviorView.trigger, randomTriggers: triggers },
    };
    const firstGroup = build(GUILD_MANAGER, {
      category: "behavior",
      page: "trigger",
      behaviorView: triggerView,
    });
    const firstSelector = walk(firstGroup).find(
      (component) =>
        component.type === STRING_SELECT &&
        component.customId === buildConfigRouteId({ action: "behavior-random-remove-select", locale: "en-US" }),
    );
    expect(firstSelector?.options).toHaveLength(CONFIG_PERSONA_SELECT_PAGE_SIZE);
    expect(firstSelector?.options?.at(-1)?.value).toBe(
      String((CONFIG_PERSONA_SELECT_PAGE_SIZE - 1) * CONFIG_RANDOM_TRIGGER_CHECKBOX_CAPACITY),
    );

    const nextGroupButton = walk(firstGroup).find((component) => component.label === "Next →");
    expect(nextGroupButton?.customId).toBe(
      buildConfigRouteId({
        action: "behavior-random-remove-page",
        locale: "en-US",
        start: CONFIG_PERSONA_SELECT_PAGE_SIZE * CONFIG_RANDOM_TRIGGER_CHECKBOX_CAPACITY,
      }),
    );

    const secondGroup = build(GUILD_MANAGER, {
      category: "behavior",
      page: "trigger",
      behaviorView: triggerView,
      randomTriggerPageStart: CONFIG_PERSONA_SELECT_PAGE_SIZE * CONFIG_RANDOM_TRIGGER_CHECKBOX_CAPACITY,
    });
    const secondSelector = walk(secondGroup).find(
      (component) =>
        component.type === STRING_SELECT &&
        component.customId === buildConfigRouteId({ action: "behavior-random-remove-select", locale: "en-US" }),
    );
    expect(secondSelector?.options?.map((option) => option.value)).toEqual([
      String(CONFIG_PERSONA_SELECT_PAGE_SIZE * CONFIG_RANDOM_TRIGGER_CHECKBOX_CAPACITY),
    ]);
    expect(
      buttonFor(secondGroup, {
        action: "behavior-random-remove-open",
        locale: "en-US",
        start: CONFIG_PERSONA_SELECT_PAGE_SIZE * CONFIG_RANDOM_TRIGGER_CHECKBOX_CAPACITY,
      })?.disabled,
    ).toBe(false);
  });

  describe("configModelsPanel image tags fence guard convergence", () => {
    for (const runLen of [3, 4, 5, 6, 8]) {
      it(`neutralizes backtick runs of ${runLen} in image tags so no two adjacent backticks survive`, () => {
        const backtickRun = `tag_${"`".repeat(runLen)}_test`;
        const components = buildConfigModelsBody({
          locale: "en-US",
          page: "image",
          readStatus: "fresh",
          imageView: {
            positiveTags: [backtickRun],
            negativeTags: [`neg_${"`".repeat(runLen)}_run`],
            sampler: "Euler",
            steps: "28",
            scale: "5.0",
            noiseSchedule: "native",
            cfgRescale: "0.0",
          },
        });
        const displays = walk(components).filter(
          (c): c is typeof c & { content: string } =>
            typeof c.content === "string" && c.content.includes("```markdown"),
        );
        expect(displays.length).toBeGreaterThanOrEqual(1);
        for (const display of displays) {
          const content = display.content;
          const fenceMatches = [...content.matchAll(/```markdown\n([\s\S]*?)\n```/g)];
          expect(fenceMatches.length).toBeGreaterThanOrEqual(2);
          for (const match of fenceMatches) {
            const innerContent = match[1];
            expect(innerContent).not.toContain("``");
          }
        }
      });
    }
  });
});
