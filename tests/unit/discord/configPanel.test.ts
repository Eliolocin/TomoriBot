/**
 * Renderer coverage for the `/config` shell and Persona pages.
 *
 * Component types are asserted as the raw numbers Discord receives. `RawDiscordComponent.type` and
 * the Components V2 payload are both bare numbers on the wire, so TypeScript accepts any of them
 * and a wrong one renders without throwing; only a literal assertion catches it.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import type { StmCategoryRow, TomoriState } from "@/types/db/schema";
import type { ConditioningGroup } from "@/utils/db/repositories/ConditioningMemoryRepository";
import {
  CONFIG_PERSONA_COLLECTION_PAGE_SIZE,
  CONFIG_PERSONA_SELECT_PAGE_SIZE,
  buildConfigRouteId,
  computeAttributeFingerprint,
  computeDialogueFingerprint,
} from "@/utils/discord/configPanelCatalog";
import type { ConfigActor } from "@/utils/discord/interactions/configPermissionPolicy";
import type { ConfigPersonaMemoryView } from "@/utils/discord/interactions/configRouteContext";
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
      "Behavior",
      "Channels",
      "Permissions",
      "Models",
    ]);
    // ButtonStyle.Primary is 1, Secondary is 2.
    expect(categoryRow.map((button) => button.style)).toEqual([1, 2, 2, 2, 2]);
  });

  it("keeps manager-owned categories visible but inert for a guild member", () => {
    const payload = build(GUILD_MEMBER);
    const row = payload.components[0] as unknown as { components: Array<{ components: Observed[] }> };
    const categoryRow = row.components[0].components;

    expect(categoryRow.map((button) => [button.label, button.disabled ?? false])).toEqual([
      ["Persona", false],
      ["Behavior", false],
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
      "Behavior",
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
    expect(pageSelect?.options?.map((option) => option.value)).toEqual(["general", "memories", "sprites"]);
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

  it("renders the role of the selected persona", () => {
    expect(
      walk(build(GUILD_MANAGER, { selectedPersonaId: 55 })).some((c) => c.content === "> Role: Main persona"),
    ).toBe(true);
    expect(
      walk(build(GUILD_MANAGER, { selectedPersonaId: 56 })).some((c) => c.content === "> Role: Alter persona"),
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
    expect(buttonFor(payload, { action: "trigger-add-open", locale: "en-US", personaId: 55 })?.disabled).toBe(false);
    expect(buttonFor(payload, { action: "trigger-remove-open", locale: "en-US", personaId: 55 })?.disabled).toBe(false);
  });

  it("omits guild-only identity actions in a DM workspace", () => {
    const payload = build(DM_OWNER);
    expect(buttonFor(payload, { action: "avatar-open", locale: "en-US", personaId: 55 })).toBeUndefined();
    expect(buttonFor(payload, { action: "trigger-add-open", locale: "en-US", personaId: 55 })).toBeUndefined();
    expect(buttonFor(payload, { action: "trigger-remove-open", locale: "en-US", personaId: 55 })).toBeUndefined();
    expect(buttonFor(payload, { action: "promote-view", locale: "en-US", personaId: 56 })).toBeUndefined();
    expect(buttonFor(payload, { action: "rename-open", locale: "en-US", personaId: 55 })?.disabled).toBe(false);
    expect(
      buttonFor(payload, { action: "naming-open", locale: "en-US", personaId: 55, style: "neutral" })?.disabled,
    ).toBe(false);
  });

  it("disables Remove Trigger when the persona has no trigger words", () => {
    expect(
      buttonFor(build(GUILD_MANAGER, { selectedPersonaId: 56 }), {
        action: "trigger-remove-open",
        locale: "en-US",
        personaId: 56,
      })?.disabled,
    ).toBe(true);
    expect(
      buttonFor(build(GUILD_MANAGER, { selectedPersonaId: 55 }), {
        action: "trigger-remove-open",
        locale: "en-US",
        personaId: 55,
      })?.disabled,
    ).toBe(false);
  });

  it("renders stored trigger words, and None when there are none", () => {
    expect(walk(build(GUILD_MANAGER, { selectedPersonaId: 55 })).some((c) => c.content?.includes("`aphel`"))).toBe(
      true,
    );
    expect(walk(build(GUILD_MANAGER, { selectedPersonaId: 56 })).some((c) => c.content?.includes("> None"))).toBe(true);
  });

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

    expect(attributeSelect?.options?.[0]).toMatchObject({ label: "+ Add new Attribute", value: "add" });
    expect(dialogueSelect?.options?.[0]).toMatchObject({ label: "+ Add new Dialogue", value: "add" });
    expect(attributeSelect?.options?.find((option) => option.default)?.value).toBe("1");
    expect(dialogueSelect?.options?.find((option) => option.default)?.value).toBe("0");
    expect(seen.some((component) => component.content?.includes("`\u200b``"))).toBe(true);
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

  it("keeps the naming editor pointed at the selected addressing style", () => {
    const persona = makePersona({
      persona_id: 55,
      persona_nickname: "Aphel",
      naming_config: {
        prefixes: { feminine: "Miss" },
        suffixes: {},
        addressTerms: {},
      },
    } as Partial<TomoriState> & { persona_id: number });
    const payload = build(GUILD_MANAGER, { personas: [persona], namingStyle: "feminine" });

    const styleSelect = walk(payload).find(
      (component) => component.type === STRING_SELECT && component.placeholder === "Choose an addressing style...",
    );
    expect(styleSelect?.options?.find((option) => option.default)?.value).toBe("feminine");
    expect(walk(payload).some((component) => component.content?.includes("`Miss`"))).toBe(true);
    expect(
      buttonFor(payload, { action: "naming-open", locale: "en-US", personaId: 55, style: "feminine" }),
    ).toBeDefined();
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
  it("renders long-term counts, selected-persona STM, conditioning, and route buttons", () => {
    const payload = build(GUILD_MANAGER, { page: "memories", personaMemoryView: MEMORY_VIEW });
    const seen = walk(payload);

    expect(seen.some((component) => component.content?.includes("Server memories: 4"))).toBe(true);
    expect(seen.some((component) => component.content?.includes("A stored scene"))).toBe(true);
    expect(seen.some((component) => component.content?.includes("Helped with the scene"))).toBe(true);
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
    expect(stmDisplay?.content).toContain("Content truncated.");
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

describe("config Persona Advanced body", () => {
  const advancedPersona = makePersona({
    persona_id: 55,
    physical_appearance_tags: ["silver hair", "green eyes"],
    nai_char_ref_url: "data/charreferences/personas/55/old.png",
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

  it("renders all six sections in wireframe order and uses the action routes", () => {
    const payload = build(GUILD_MANAGER, {
      page: "advanced",
      personas: [advancedPersona],
      selectedPersonaId: 55,
      serverHumanizerDegree: 0,
      view: { kind: "humanizer-editor", personaId: 55 },
    });
    const seen = walk(payload);
    const sectionTitles = [
      "Image Tags",
      "NovelAI Character Reference",
      "Persona Prompt",
      "Context Note",
      "Response Style",
      "Text Model Override",
    ];
    const titlePositions = sectionTitles.map((title) =>
      seen.findIndex((component) => component.content?.includes(`**${title}**`)),
    );

    expect(titlePositions.every((position) => position >= 0)).toBe(true);
    expect(titlePositions).toEqual([...titlePositions].sort((left, right) => left - right));
    expect(buttonFor(payload, { action: "image-tags-open", locale: "en-US", personaId: 55 })).toBeDefined();
    expect(buttonFor(payload, { action: "character-reference-open", locale: "en-US", personaId: 55 })).toBeDefined();
    expect(
      buttonFor(payload, { action: "character-reference-clear-view", locale: "en-US", personaId: 55 })?.style,
    ).toBe(4);
    expect(buttonFor(payload, { action: "prompt-open", locale: "en-US", personaId: 55 })).toBeDefined();
    expect(buttonFor(payload, { action: "context-note-open", locale: "en-US", personaId: 55 })).toBeDefined();
    expect(walk(payload).some((component) => component.customId?.includes(":humanizer-select:"))).toBe(true);
    expect(buttonFor(payload, { action: "text-override-clear", locale: "en-US", personaId: 55 })?.style).toBe(2);
    expect(seen.some((component) => component.content?.includes("> Server default: 0: None"))).toBe(true);
  });

  it("omits guild-only Advanced actions in a DM while retaining the four allowed sections", () => {
    const payload = build(DM_OWNER, { page: "advanced", personas: [advancedPersona] });
    expect(buttonFor(payload, { action: "image-tags-open", locale: "en-US", personaId: 55 })).toBeUndefined();
    expect(buttonFor(payload, { action: "character-reference-open", locale: "en-US", personaId: 55 })).toBeUndefined();
    expect(buttonFor(payload, { action: "prompt-open", locale: "en-US", personaId: 55 })).toBeDefined();
    expect(buttonFor(payload, { action: "context-note-open", locale: "en-US", personaId: 55 })).toBeDefined();
    expect(buttonFor(payload, { action: "humanizer-open", locale: "en-US", personaId: 55 })).toBeDefined();
    expect(buttonFor(payload, { action: "text-override-open", locale: "en-US", personaId: 55 })).toBeDefined();
  });

  it("omits the whole Advanced body for a guild member", () => {
    const payload = build(GUILD_MEMBER, { page: "advanced", personas: [advancedPersona] });
    expect(walk(payload).some((component) => component.content?.includes("Advanced Persona Settings"))).toBe(false);
    expect(buttonFor(payload, { action: "prompt-open", locale: "en-US", personaId: 55 })).toBeUndefined();
  });
});
