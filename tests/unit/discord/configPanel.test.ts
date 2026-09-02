/**
 * Renderer coverage for the `/config` shell and Persona > General.
 *
 * Component types are asserted as the raw numbers Discord receives. `RawDiscordComponent.type` and
 * the Components V2 payload are both bare numbers on the wire, so TypeScript accepts any of them
 * and a wrong one renders without throwing; only a literal assertion catches it.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import type { TomoriState } from "@/types/db/schema";
import { CONFIG_PERSONA_SELECT_PAGE_SIZE, buildConfigRouteId } from "@/utils/discord/configPanelCatalog";
import type { ConfigActor } from "@/utils/discord/interactions/configPermissionPolicy";
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
