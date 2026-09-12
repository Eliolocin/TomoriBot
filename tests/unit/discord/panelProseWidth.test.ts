import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { ComponentType } from "discord.js";
import { PrivacyLevel, type TomoriState, type UserRow, type UserSavedProviderConfigRow } from "@/types/db/schema";
import { buildConfigPanelPayload } from "@/utils/discord/ui/configPanel";
import type { ConfigActor } from "@/utils/discord/interactions/configPermissionPolicy";
import { CONFIG_PAGES_BY_CATEGORY, type ConfigCategory } from "@/utils/discord/configPanelCatalog";
import { buildMemoriesPanelPayload } from "@/utils/discord/ui/memoriesPanel";
import {
  buildPersonalConfigPanelPayload,
  type PersonalConfigModelDisplayInfo,
} from "@/utils/discord/ui/personalConfigPanel";
import { buildPersonalMemoriesPanelPayload } from "@/utils/discord/ui/personalMemoriesPanel";
import {
  buildSetupSuccessPayload,
  buildSetupWizardPayload,
  type SetupSettingsCatalogs,
} from "@/utils/discord/ui/setupPanel";
import { SETUP_DRAFT_SCHEMA_VERSION, type SetupDraftRecord } from "@/types/discord/setupWizard";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";

await initializeLocalizer();

const PANEL_UI_DIR = "src/utils/discord/ui";

/**
 * Panel body prose wraps at the container width, and a line longer than this stretches the
 * container wider than the select menus beneath it, so the page stops looking like one column.
 * Authored strings therefore carry their own line breaks rather than relying on the client.
 *
 * Both budgets are measured, not specified. Components V2 exposes no width, margin, or padding
 * field on any component, so content is the only input to layout and these numbers come from
 * reading real panels. If Discord retunes its renderer they go stale silently: change the
 * constant and re-run, and the failures name every string that needs rewrapping.
 */
const MAX_PANEL_PROSE_LINE = 65;

/**
 * Budget for a `TextDisplay` sharing a Section with a Thumbnail accessory.
 *
 * The thumbnail takes its width from the same row, so prose beside it wraps sooner and pushes the
 * container back out past the selects. Roughly a third of the row is gone, hence the tighter cap.
 */
const MAX_PANEL_PROSE_LINE_BESIDE_THUMBNAIL = 40;

/**
 * Panel builders that render a Thumbnail, each of which needs a payload walked below.
 *
 * The static scan cannot tell which keys land beside a thumbnail: the wrapping is conditional and
 * the heading is built as a variable first. Listing the files here is what makes that gap fail
 * loudly, because a panel that grows a thumbnail without render coverage breaks this test.
 */
const THUMBNAIL_PANELS_WITH_RENDER_COVERAGE = new Set([
  "configPanel.ts",
  "configVoicePanel.ts",
  "memoriesPanel.ts",
  "personalConfigPanel.ts",
  "personalMemoriesPanel.ts",
]);

/**
 * Width as Discord draws it, not as the string is stored.
 *
 * A link's URL, and the markers around bold, italic, strikethrough, and inline code, all occupy
 * no width once rendered. Measuring them would push authors to break lines that already fit, and
 * would make a documentation link impossible to add to a heading.
 */
function renderedWidth(line: string): number {
  return line
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replaceAll("**", "")
    .replaceAll("__", "")
    .replaceAll("~~", "")
    .replaceAll("`", "").length;
}

interface ProseWidthViolation {
  where: string;
  width: number;
  budget: number;
  line: string;
}

/**
 * Walks a built payload and measures every `TextDisplay` against the budget for where it sits.
 *
 * Rendering rather than reading source is the only way to know a heading ended up inside a
 * Section with a Thumbnail accessory, because that wrapping is a runtime decision.
 */
export function collectProseWidthViolations(node: unknown, besideThumbnail = false): ProseWidthViolation[] {
  if (Array.isArray(node)) return node.flatMap((child) => collectProseWidthViolations(child, besideThumbnail));
  if (typeof node !== "object" || node === null) return [];

  const record = node as Record<string, unknown>;
  const accessory = record.accessory as { type?: number } | undefined;
  const inThumbnailSection =
    besideThumbnail || (record.type === ComponentType.Section && accessory?.type === ComponentType.Thumbnail);

  if (record.type === ComponentType.TextDisplay && typeof record.content === "string") {
    const budget = inThumbnailSection ? MAX_PANEL_PROSE_LINE_BESIDE_THUMBNAIL : MAX_PANEL_PROSE_LINE;
    return record.content
      .split("\n")
      .map((line) => ({ line, width: renderedWidth(line) }))
      .filter(({ width }) => width > budget)
      .map(({ line, width }) => ({
        where: inThumbnailSection ? "beside thumbnail" : "panel body",
        width,
        budget,
        line,
      }));
  }

  return Object.values(record).flatMap((child) => collectProseWidthViolations(child, inThumbnailSection));
}

/**
 * Locale keys rendered into a `TextDisplay` body, per panel file.
 *
 * Only `content:` values are collected. Modal field labels and descriptions are laid out by
 * Discord inside the modal and never widen the panel container, so they are out of scope even
 * though the same files build them.
 */
function collectTextDisplayKeys(): Map<string, string[]> {
  const byFile = new Map<string, string[]>();

  for (const file of readdirSync(PANEL_UI_DIR).filter((name) => name.endsWith("Panel.ts"))) {
    const source = readFileSync(`${PANEL_UI_DIR}/${file}`, "utf8");
    const keys = new Set<string>();

    for (const block of source.matchAll(/content:\s*`([\s\S]*?)`,?\n/g)) {
      for (const call of block[1].matchAll(/localizer\(\s*[A-Za-z0-9_.]+\s*,\s*"([a-z0-9_.-]+)"/g)) {
        keys.add(call[1]);
      }
    }
    for (const direct of source.matchAll(/content:\s*localizer\(\s*[A-Za-z0-9_.]+\s*,\s*"([a-z0-9_.-]+)"/g)) {
      keys.add(direct[1]);
    }

    if (keys.size > 0) byFile.set(file, [...keys].sort());
  }

  return byFile;
}

describe("panel prose width", () => {
  const keysByFile = collectTextDisplayKeys();

  it("finds TextDisplay keys in every panel builder", () => {
    // Guards the extraction itself: a regex that silently matches nothing would make every
    // width assertion below vacuous.
    expect(keysByFile.size).toBeGreaterThanOrEqual(6);
    for (const [file, keys] of keysByFile) {
      expect(keys.length, `${file} yielded no TextDisplay locale keys`).toBeGreaterThan(0);
    }
  });

  it("keeps every authored panel line at or under 65 characters", () => {
    const violations: string[] = [];

    for (const [file, keys] of keysByFile) {
      for (const key of keys) {
        const text = localizer("en-US", key);
        // A key that resolves to itself is composed at runtime or missing; the composed-key
        // tests own that case and an unresolved key has no authored width to measure.
        if (text === key) continue;

        for (const line of text.split("\n")) {
          const width = renderedWidth(line);
          if (width > MAX_PANEL_PROSE_LINE) {
            violations.push(`${file} ${key} (${width}): ${line.slice(0, 72)}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("covers every panel that renders a Thumbnail with a payload walk", () => {
    const thumbnailPanels = readdirSync(PANEL_UI_DIR)
      .filter((name) => name.endsWith("Panel.ts"))
      .filter((name) => {
        const source = readFileSync(`${PANEL_UI_DIR}/${name}`, "utf8");
        return source.includes("ComponentType.Thumbnail") || source.includes("buildOptionalThumbnailSection");
      });

    // Fails closed: a panel that grows a thumbnail must gain a walk below, because the static
    // scan above would keep measuring its heading against the wider body budget.
    expect(thumbnailPanels.sort()).toEqual([...THUMBNAIL_PANELS_WITH_RENDER_COVERAGE].sort());
  });

  it("holds persona-scoped memories to 40 characters beside its avatar", () => {
    const personas = [
      {
        persona_id: 55,
        persona_lineage_id: 1770,
        persona_nickname: "Aphel",
        is_alter: false,
      } as unknown as TomoriState,
    ];
    const build = (selectedPersonaAvatarUrl: string | null) =>
      buildPersonalMemoriesPanelPayload({
        locale: "en-US",
        category: "persona",
        selectedLineageId: 1770,
        personas,
        selectedPersonaAvatarUrl,
        memories: [],
        stmCount: 0,
        privacyLevel: PrivacyLevel.MINIMAL,
        readStatus: "fresh",
        page: { kind: "main" },
      });

    expect(collectProseWidthViolations(build("https://cdn.example.invalid/55.png"))).toEqual([]);
    expect(collectProseWidthViolations(build(null))).toEqual([]);
  });

  it("holds persona naming to 40 characters beside its avatar", () => {
    const user = {
      user_id: 1,
      user_disc_id: "user-123",
      language_pref: "en-US",
      privacy_level: PrivacyLevel.MINIMAL,
    } as unknown as UserRow;
    const personas = [
      {
        persona_id: 55,
        persona_lineage_id: 1770,
        persona_nickname: "Aphel",
        is_alter: false,
      } as unknown as TomoriState,
    ];
    const build = (selectedPersonaAvatarUrl: string | null) =>
      buildPersonalConfigPanelPayload({
        locale: "en-US",
        category: "profile",
        page: "persona",
        user,
        resolvedNickname: "Bau",
        personas,
        guildId: "guild-123",
        selectedLineageId: 1770,
        selectedPersonaAvatarUrl,
        memoryCount: 0,
        stmCount: 0,
        readStatus: "fresh",
      });

    expect(collectProseWidthViolations(build("https://cdn.example.invalid/55.png"))).toEqual([]);
    expect(collectProseWidthViolations(build(null))).toEqual([]);
  });

  it("holds workspace persona memories to 40 characters beside its avatar", () => {
    const personas = [
      {
        persona_id: 55,
        persona_lineage_id: 1770,
        persona_nickname: "Aphel",
        is_alter: false,
      } as unknown as TomoriState,
    ];
    const build = (selectedPersonaAvatarUrl: string | null) =>
      buildMemoriesPanelPayload({
        locale: "en-US",
        category: "memories",
        selectedLineageId: 1770,
        personas,
        selectedPersonaAvatarUrl,
        memories: [],
        canManage: true,
        readStatus: "fresh",
        page: { kind: "main" },
      });

    expect(collectProseWidthViolations(build("https://cdn.example.invalid/55.png"))).toEqual([]);
    expect(collectProseWidthViolations(build(null))).toEqual([]);
  });

  /**
   * The Documents page grew its own thumbnail, and it renders one only under the persona scope.
   * Walking the serverwide payload alone would leave that Section unvisited while the file-level
   * coverage check above still passed, because the Memories page already puts this builder in the
   * covered set.
   */
  it("holds workspace documents to 40 characters beside its persona avatar", () => {
    const personas = [
      {
        persona_id: 55,
        persona_lineage_id: 1770,
        persona_nickname: "Aphel",
        is_alter: false,
      } as unknown as TomoriState,
    ];
    const build = (selectedDocumentPersonaId: number, selectedPersonaAvatarUrl: string | null) =>
      buildMemoriesPanelPayload({
        locale: "en-US",
        category: "documents",
        selectedLineageId: selectedDocumentPersonaId,
        selectedDocumentPersonaId,
        personas,
        selectedPersonaAvatarUrl,
        memories: [],
        documents: [],
        documentCount: 0,
        documentChunkCount: 0,
        canManage: true,
        readStatus: "fresh",
        page: { kind: "documents" },
      });

    expect(collectProseWidthViolations(build(55, "https://cdn.example.invalid/55.png"))).toEqual([]);
    expect(collectProseWidthViolations(build(0, null))).toEqual([]);
  });

  /**
   * The Models parameter summary composes each quote row at runtime from a label key and a stored
   * value, so the static scan above measures the bare label and never the rendered line. This walk
   * is the only thing holding those composed rows to the body budget, and it keeps covering them
   * when the summary moves into a shared builder that the `*Panel.ts` scan cannot see.
   *
   * The sampler columns are Postgres `real`, so `Math.fround` reproduces what the driver returns
   * rather than what someone typed. These are the values whose readback is widest inside each
   * column's own bounds: 0.01 returns as 0.009999999776482582 and -0.03 as -0.029999999329447746,
   * which put the Generation row at 78 characters if the values reach the panel unformatted. The
   * two integer columns carry their widest in-range values instead, since they cannot pick up the
   * artifact.
   */
  it("holds the Models parameter summary to 65 characters in every provider state", () => {
    const user = {
      user_id: 1,
      user_disc_id: "user-123",
      language_pref: "en-US",
      privacy_level: PrivacyLevel.MINIMAL,
    } as unknown as UserRow;

    const widestConfig = {
      provider: "vertexexpress",
      llm_temperature: Math.fround(0.01),
      llm_min_p: Math.fround(0.01),
      llm_top_p: Math.fround(0.01),
      llm_top_k: 256,
      llm_frequency_penalty: Math.fround(-0.03),
      llm_presence_penalty: Math.fround(-0.03),
      llm_max_output_tokens: 131072,
      thinking_level: "minimal",
    } as unknown as UserSavedProviderConfigRow;

    const build = (parametersProviders: string[]) =>
      buildPersonalConfigPanelPayload({
        locale: "en-US",
        category: "models",
        page: "parameters",
        user,
        resolvedNickname: "Bau",
        personas: [],
        guildId: "guild-123",
        memoryCount: 0,
        stmCount: 0,
        readStatus: "fresh",
        selectedParametersProvider: parametersProviders[0],
        modelDisplayInfo: {
          parametersProviders,
          selectedParametersConfig: parametersProviders.length > 0 ? widestConfig : undefined,
          fallbacksProviders: [],
          fallbackSlots: [],
          randomizerEnabled: false,
          canEnableRandomizer: false,
        } as unknown as PersonalConfigModelDisplayInfo,
      });

    // Zero, one, and several saved providers are three different renderings of this page, and the
    // longest provider display name is the one that can push a summary row over the budget.
    expect(collectProseWidthViolations(build([]))).toEqual([]);
    expect(collectProseWidthViolations(build(["vertexexpress"]))).toEqual([]);
    expect(collectProseWidthViolations(build(["vertexexpress", "openrouter", "novelai"]))).toEqual([]);
  });
  /**
   * `/config` filters its own body by actor, so a member and a DM owner render different pages
   * behind the same thumbnail Section. Each is walked because a heading only one of them reaches
   * would otherwise never be measured.
   */
  it("holds /config Persona General to 40 characters beside its avatar", () => {
    const personas = [
      {
        persona_id: 55,
        server_id: 9,
        persona_nickname: "Aphel",
        is_alter: false,
        trigger_words: ["aphel"],
        naming_config: { prefixes: {}, suffixes: {}, addressTerms: {} },
      } as unknown as TomoriState,
      {
        persona_id: 56,
        server_id: 9,
        persona_nickname: "Wren",
        is_alter: true,
        trigger_words: [],
        naming_config: { prefixes: {}, suffixes: {}, addressTerms: {} },
      } as unknown as TomoriState,
    ];
    const build = (actor: ConfigActor, selectedPersonaId: number, avatarUrl: string | null) =>
      buildConfigPanelPayload({
        locale: "en-US",
        actor,
        category: "persona",
        page: "general",
        personas,
        selectedPersonaId,
        selectedPersonaAvatarUrl: avatarUrl,
        readStatus: "fresh",
      });

    const guildManager: ConfigActor = { workspaceKind: "guild", isManager: true };
    const guildMember: ConfigActor = { workspaceKind: "guild", isManager: false };
    const dmOwner: ConfigActor = { workspaceKind: "dm", isManager: true };

    expect(collectProseWidthViolations(build(guildManager, 55, "https://cdn.example.invalid/55.png"))).toEqual([]);
    expect(collectProseWidthViolations(build(guildManager, 56, null))).toEqual([]);
    expect(collectProseWidthViolations(build(guildMember, 55, null))).toEqual([]);
    expect(collectProseWidthViolations(build(dmOwner, 55, null))).toEqual([]);
  });

  /**
   * The Sprites page is the only `/config` body whose detail lines interpolate stored values beside
   * a Thumbnail, and the loop below renders it with no sprites at all. The widest legal sprite name
   * and usage note are the inputs that decide whether those lines fit, so they are walked here.
   */
  it("holds /config Persona Sprites to 40 characters beside its sprite image", () => {
    const personas = [
      {
        persona_id: 55,
        server_id: 9,
        persona_nickname: "Aphel",
        is_alter: false,
        trigger_words: [],
        naming_config: { prefixes: {}, suffixes: {}, addressTerms: {} },
      } as unknown as TomoriState,
    ];
    const widestSprite = {
      sprite_id: 1,
      persona_id: 55,
      sprite_name: "s".repeat(64),
      sprite_key: "s".repeat(64),
      avatar_url: "https://cdn.example.invalid/sprites/happy.png",
      usage_instructions: "u".repeat(300),
      is_identity: true,
    };
    const build = (actor: ConfigActor, selectedPersonaAvatarUrl: string | null) =>
      buildConfigPanelPayload({
        locale: "en-US",
        actor,
        category: "persona",
        page: "sprites",
        personas,
        selectedPersonaId: 55,
        selectedPersonaAvatarUrl,
        personaSprites: [widestSprite],
        selectedSpriteIndex: 0,
        readStatus: "fresh",
      });

    const guildManager: ConfigActor = { workspaceKind: "guild", isManager: true };
    const guildMember: ConfigActor = { workspaceKind: "guild", isManager: false };
    const dmOwner: ConfigActor = { workspaceKind: "dm", isManager: true };

    expect(collectProseWidthViolations(build(guildManager, "https://cdn.example.invalid/55.png"))).toEqual([]);
    expect(collectProseWidthViolations(build(guildManager, null))).toEqual([]);
    expect(collectProseWidthViolations(build(guildMember, null))).toEqual([]);
    expect(collectProseWidthViolations(build(dmOwner, null))).toEqual([]);
  });

  it("holds every /config page placeholder and confirmation to 65 characters", () => {
    const personas = [
      {
        persona_id: 55,
        server_id: 9,
        persona_nickname: "Aphel",
        is_alter: false,
        trigger_words: [],
        naming_config: { prefixes: {}, suffixes: {}, addressTerms: {} },
      } as unknown as TomoriState,
      {
        persona_id: 56,
        server_id: 9,
        persona_nickname: "Wren",
        is_alter: true,
        trigger_words: [],
        naming_config: { prefixes: {}, suffixes: {}, addressTerms: {} },
      } as unknown as TomoriState,
    ];
    const actor: ConfigActor = { workspaceKind: "guild", isManager: true };

    for (const [category, pages] of Object.entries(CONFIG_PAGES_BY_CATEGORY)) {
      for (const page of pages) {
        const payload = buildConfigPanelPayload({
          locale: "en-US",
          actor,
          category: category as ConfigCategory,
          page,
          personas,
          selectedPersonaId: 55,
          readStatus: "fresh",
        });
        expect(collectProseWidthViolations(payload), `${category}/${page}`).toEqual([]);
      }
    }

    const confirm = buildConfigPanelPayload({
      locale: "en-US",
      actor,
      category: "persona",
      page: "general",
      personas,
      selectedPersonaId: 56,
      readStatus: "fresh",
      view: { kind: "promote-confirm", personaId: 56, nonce: "nonce1234567" },
    });
    expect(collectProseWidthViolations(confirm)).toEqual([]);
  });

  /**
   * The setup receipt is the terminal panel of `/setup`, and most of its prose is composed at
   * runtime from a locale key plus a stored name, so the static scan above measures the template
   * rather than the rendered line. The completion explanation names a model and an endpoint, both of
   * which reach their documented maximum before truncation, and the DM explanation is a paragraph
   * that has to carry its own line breaks to stay inside the column.
   */
  it("holds the setup receipt to 65 characters for every provider mode and context", () => {
    const maxEndpointLabel = "e".repeat(40);
    const maxModelCode = "m".repeat(200);

    const build = (
      providerAccess: Parameters<typeof buildSetupSuccessPayload>[0]["providerAccess"],
      modelName: string | null,
      providerLabel: string,
      context: "guild" | "dm",
    ) =>
      buildSetupSuccessPayload({
        locale: "en-US",
        context,
        providerAccess,
        modelName,
        providerLabel,
        personaName: "Lighthouse",
        notes: [
          {
            label: localizer("en-US", "commands.setup.novelai_expressions_warning_field"),
            detail: localizer("en-US", "commands.setup.novelai_expressions_warning_value"),
          },
        ],
        learnMore: localizer("en-US", "commands.setup.wizard.receipt_learn_more", { help: "</help:123456>" }),
        footerKey: context === "dm" ? "commands.setup.wizard.receipt_footer_avatar_skipped_dm" : undefined,
      });

    const catalogAccess = {
      mode: "catalog",
      provider: "anthropic",
      encryptedApiKey: Buffer.from("k"),
      keyVersion: 1,
    } as const;

    const cases = [
      build(catalogAccess, "claude-sonnet-4", "Anthropic", "guild"),
      build(catalogAccess, "claude-sonnet-4", "Anthropic", "dm"),
      build(catalogAccess, null, "Anthropic", "guild"),
      build(
        {
          mode: "custom-endpoint",
          connection: {
            label: maxEndpointLabel,
            apiStyle: "openai-compatible",
            endpointUrl: "https://example.invalid/v1",
            encryptedAuthToken: null,
            keyVersion: 1,
          },
          textModel: { modelCode: maxModelCode, numCtx: 8192, capabilities: ["tools"] },
        },
        maxModelCode,
        maxEndpointLabel,
        "guild",
      ),
      build({ mode: "user-byok" }, null, "", "guild"),
    ];

    for (const payload of cases) {
      expect(collectProseWidthViolations(payload)).toEqual([]);
    }
  });

  /**
   * The wizard anchor is what the actor reviews before committing, and every quote row under a step
   * is composed from a stored draft value rather than from a locale template. The static scan above
   * only sees what sits inside a `content:` literal, so it measures none of these rows: the endpoint
   * label, the custom model code, and the two catalog preset names each reach the longest value their
   * own editor accepts, and are truncated for display before they land here.
   */
  it("holds the setup wizard anchor to 65 characters for every draft state", () => {
    const maxEndpointLabel = "e".repeat(40);
    const maxModelCode = "m".repeat(200);
    const maxProviderId = "g".repeat(40);
    const maxPersonaName = "p".repeat(100);
    const maxPromptName = "r".repeat(100);

    const catalogs: SetupSettingsCatalogs = {
      personas: [{ id: 7, name: maxPersonaName, description: "A steady, watchful companion." }],
      prompts: [{ name: maxPromptName, description: "The standard reply style." }],
      promptTexts: new Map([[maxPromptName, "You are Tomori."]]),
    };

    const maxSettings = {
      presetId: 7,
      humanizer: 3,
      timezoneOffset: -12,
      systemPrompt: { kind: "preset" as const, presetName: maxPromptName },
    };

    const build = (
      overrides: Partial<SetupDraftRecord>,
      isHosted: boolean,
      settingsCatalogs: SetupSettingsCatalogs | null = catalogs,
    ) =>
      buildSetupWizardPayload({
        draft: {
          schemaVersion: SETUP_DRAFT_SCHEMA_VERSION,
          actorDiscId: "actor-1234567890",
          workspaceKey: "workspace-1234567890",
          context: "guild",
          providerAccess: null,
          startingSettings: null,
          policiesAccepted: false,
          requiresPolicies: false,
          ...overrides,
        },
        locale: "en-US",
        isHosted,
        nonce: "nonce-abc-12345",
        settingsCatalogs,
      });

    const cases: Array<[string, ReturnType<typeof build>]> = [
      ["pending hosted", build({ requiresPolicies: true }, true)],
      [
        "ready with maximum catalog names",
        build(
          {
            requiresPolicies: true,
            policiesAccepted: true,
            providerAccess: {
              mode: "catalog",
              provider: maxProviderId,
              encryptedApiKey: Buffer.from("key"),
              keyVersion: 1,
            },
            startingSettings: maxSettings,
          },
          true,
        ),
      ],
      [
        "custom endpoint at maximum label and model length",
        build(
          {
            providerAccess: {
              mode: "custom-endpoint",
              connection: {
                label: maxEndpointLabel,
                apiStyle: "openai-compatible",
                endpointUrl: "https://example.invalid/v1",
                encryptedAuthToken: null,
                keyVersion: 1,
              },
              textModel: { modelCode: maxModelCode, numCtx: 131072, capabilities: ["tools"] },
            },
            startingSettings: maxSettings,
          },
          false,
        ),
      ],
      [
        "settings re-pended by catalog drift",
        build({ providerAccess: { mode: "user-byok" }, startingSettings: maxSettings, context: "dm" }, false, {
          personas: [],
          prompts: [],
          promptTexts: new Map(),
        }),
      ],
      ["settings that could not be checked", build({ startingSettings: maxSettings, context: "dm" }, false, null)],
    ];

    const violations = cases.flatMap(([label, payload]) =>
      collectProseWidthViolations(payload).map(
        (violation) => `${label}: ${violation.width} > ${violation.budget}: ${violation.line}`,
      ),
    );
    expect(violations).toEqual([]);
  });
});
