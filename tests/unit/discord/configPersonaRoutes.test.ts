/**
 * Route coverage for the `/config` Persona surface.
 *
 * Drives the real registered route through the real policy, catalog, and renderer. Where a test
 * proves that a denied actor writes nothing, it spies on the repository the canonical operation
 * actually calls rather than substituting an operations double, because a double would restate the
 * expected answer instead of exercising the guard.
 */
import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import { AttachmentBuilder, MessageFlags, PermissionsBitField, type APIAttachment, type Client } from "discord.js";
import type { PersonaSpriteRow, StmCategoryRow, TomoriState } from "@/types/db/schema";
import type { ConditioningGroup } from "@/utils/db/repositories/ConditioningMemoryRepository";
import { conditioningMemoryRepository } from "@/utils/db/repositories/ConditioningMemoryRepository";
import * as shortTermMemoryCache from "@/utils/cache/shortTermMemoryCache";
import * as tomoriStateCacheStore from "@/utils/cache/tomoriStateCacheStore";
import {
  llmOverrideRepo,
  personalMemoryRepository,
  personaRepository,
  personaSpriteRepository,
  serverMemoryRepository,
  userRepository,
} from "@/utils/db/repositories";
import { shortTermMemoryRepository } from "@/utils/db/repositories/ShortTermMemoryRepository";
import { execute as executeConditioningManage } from "@/commands/conditioning/manage";
import * as panelController from "@/utils/discord/interactions/panelController";
import * as modalModule from "@/utils/discord/ui/modals";
import * as embedModule from "@/utils/discord/ui/embeds";
import * as avatarStorage from "@/utils/storage/avatarStorage";
import * as imageProcessor from "@/utils/image/imageProcessor";
import * as safeDownloadModule from "@/utils/security/safeDownload";
import {
  CONFIG_ROUTE_CODECS,
  buildConfigRouteId,
  computeAttributeFingerprint,
  computeConditioningRemoveFingerprint,
  computeDialogueFingerprint,
  computeSpriteFingerprint,
  computeTriggerRemoveFingerprint,
  parseConfigPanelRoute,
  type ConfigPanelRoute,
} from "@/utils/discord/configPanelCatalog";
import { createConfigInteractionRoute, loadConfigPersonaMemoryView } from "@/utils/discord/interactions/configRoutes";
import {
  asEphemeralComponentsV2FollowUp,
  type ConfigPersonaMemoryView,
  type ConfigRouteDependencies,
  type ConfigScope,
} from "@/utils/discord/interactions/configRouteContext";
import { configPersonaOperations } from "@/utils/discord/interactions/configPersonaOperations";
import { configSpriteOperations } from "@/utils/discord/interactions/configSpriteOperations";
import {
  InteractionRouteRegistry,
  parseInteractionRoute,
  type ParsedInteractionRoute,
} from "@/utils/discord/interactions/routeRegistry";
import { hasRawModalAcknowledgement } from "@/utils/discord/ui/interactionCore";
import {
  buildConditioningCheckboxGroupId,
  buildConfigModalFieldId,
  buildTriggerRemoveCheckboxGroupId,
  CONFIG_PERSONA_PROMPT_PART_FIELDS,
  CONFIG_NAI_ATTG_AUTHOR_FIELD,
  CONFIG_NAI_ATTG_TITLE_FIELD,
  CONFIG_NAI_ATTG_TAGS_FIELD,
  CONFIG_NAI_ATTG_GENRE_FIELD,
  CONFIG_NAI_ATTG_STARS_FIELD,
  CONFIG_SPRITE_IDENTITY_OPTION_VALUE,
  CONFIG_SPRITE_INSTRUCTIONS_FIELD,
  CONFIG_SPRITE_NAME_FIELD,
} from "@/utils/discord/ui/configModals";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const CLIENT = {} as Client;

function requireRoute(customId: string): ParsedInteractionRoute {
  const parsed = parseInteractionRoute(customId);
  if (!parsed) throw new Error(`Failed to parse route for customId: ${customId}`);
  return parsed;
}

function makePersona(overrides: Partial<TomoriState> & { persona_id: number }): TomoriState {
  return {
    server_id: 9,
    persona_nickname: `Persona ${overrides.persona_id}`,
    is_alter: false,
    trigger_words: [],
    naming_config: { prefixes: {}, suffixes: {}, addressTerms: {} },
    persona_prompt: null,
    attribute_list: [],
    sample_dialogues_in: [],
    sample_dialogues_out: [],
    webhook_avatar_url: null,
    is_pointer: false,
    ...overrides,
  } as unknown as TomoriState;
}

const MAIN = makePersona({ persona_id: 55, persona_nickname: "Aphel", trigger_words: ["aphel", "hey aphel"] });
const ALTER = makePersona({ persona_id: 56, persona_nickname: "Wren", is_alter: true });

function makeTeachingPersona(
  overrides: Partial<TomoriState> & { persona_id: number },
  flags: { attribute?: boolean; dialogue?: boolean } = {},
): TomoriState {
  return makePersona({
    ...overrides,
    config: {
      attribute_memteaching_enabled: flags.attribute ?? true,
      sampledialogue_memteaching_enabled: flags.dialogue ?? true,
    } as TomoriState["config"],
  });
}

function makeTxtAttachment(text: string): APIAttachment {
  return {
    id: "attachment-1",
    filename: "memories.txt",
    size: Buffer.byteLength(text),
    url: `data:text/plain;base64,${Buffer.from(text, "utf8").toString("base64")}`,
    proxy_url: "https://cdn.example.invalid/memories.txt",
    content_type: "text/plain",
  };
}

const STM_SUMMARY_CATEGORY: StmCategoryRow = {
  server_id: 9,
  position: 0,
  label: "Summary",
  description: "Current summary",
};

const STM_CATEGORY_ROWS: StmCategoryRow[] = [
  STM_SUMMARY_CATEGORY,
  { server_id: 9, position: 1, label: "People", description: "People in the scene" },
];

const CONDITIONING_GROUP: ConditioningGroup = {
  conditioningType: "reward",
  actionKey: "headpat",
  reasonText: "The persona was helpful",
  reasonNormalized: "the persona was helpful",
  actionText: "A gentle headpat",
  totalCount: 2,
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  userDiscIds: ["user-1"],
  conditioningIds: [101],
};

function makeMemoryView(overrides: Partial<ConfigPersonaMemoryView> = {}): ConfigPersonaMemoryView {
  return {
    serverMemoryCount: 3,
    personalMemoryCount: 2,
    channelId: "channel-1",
    stmCategories: [STM_SUMMARY_CATEGORY],
    conditioningGroups: [CONDITIONING_GROUP],
    ...overrides,
  };
}

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
  makeSprite({ sprite_key: "happy", sprite_name: "Happy", usage_instructions: "When cheerful" }),
  makeSprite({ sprite_key: "sad", sprite_name: "Sad", sprite_id: 2 }),
];

interface HarnessOptions {
  isManager?: boolean;
  inGuild?: boolean;
  personas?: TomoriState[];
  refreshedPersonas?: TomoriState[];
  personaMemoryView?: ConfigPersonaMemoryView;
  operations?: Partial<ConfigRouteDependencies["operations"]>;
  sprites?: PersonaSpriteRow[];
  spriteOperations?: Partial<ConfigRouteDependencies["spriteOperations"]>;
  getPersonaAvatarReferenceData?: ConfigRouteDependencies["getPersonaAvatarReferenceData"];
}

interface Harness {
  dependencies: Partial<ConfigRouteDependencies>;
  telemetry: string[];
  edits: unknown[];
  replies: unknown[];
  followUps: unknown[];
  modals: unknown[];
  scopeLoads: boolean[];
  spriteLoads: number[];
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const telemetry: string[] = [];
  const edits: unknown[] = [];
  const replies: unknown[] = [];
  const followUps: unknown[] = [];
  const modals: unknown[] = [];
  const scopeLoads: boolean[] = [];
  const spriteLoads: number[] = [];

  const buildScope = (forceRefresh: boolean): ConfigScope => ({
    serverDiscId: options.inGuild === false ? "user-1" : "guild-1",
    guildId: options.inGuild === false ? null : "guild-1",
    internalServerId: 9,
    userId: 1,
    actor:
      options.inGuild === false
        ? { workspaceKind: "dm", isManager: true }
        : { workspaceKind: "guild", isManager: options.isManager ?? true },
    personas: (forceRefresh ? (options.refreshedPersonas ?? options.personas) : options.personas) ?? [MAIN, ALTER],
    readStatus: "fresh",
  });

  return {
    telemetry,
    edits,
    replies,
    followUps,
    modals,
    scopeLoads,
    spriteLoads,
    dependencies: {
      resolveScope: async (_interaction, forceRefresh = false) => {
        scopeLoads.push(forceRefresh);
        return buildScope(forceRefresh);
      },
      getPersonaAvatarData: async () => ({ url: null, files: [] }),
      getPersonaAvatarReferenceData: options.getPersonaAvatarReferenceData ?? (async () => ({ url: null, files: [] })),
      loadPersonaMemoryView: async () => options.personaMemoryView ?? makeMemoryView(),
      openServerMemoryPanel: async () => ({ components: [], flags: 32768 }),
      openPersonalMemoryPanel: async () => ({ components: [], flags: 32768 }),
      createGuildIdentity: () => ({
        setNickname: async () => true,
        setAvatar: async () => ({ ok: true, rateLimited: false }),
        currentAvatarReference: async () => null,
      }),
      recordAction: (input) => {
        telemetry.push(input.action);
      },
      createNonce: () => "nonce1234567",
      showModal: async (_interaction, payload) => {
        modals.push(payload);
      },
      takeAvatarUpload: () => undefined,
      takeCheckboxValues: () => [],
      operations: { ...configPersonaOperations, ...options.operations },
      loadPersonaSprites: async (personaId) => {
        spriteLoads.push(personaId);
        return options.sprites ?? SPRITES;
      },
      spriteOperations: { ...configSpriteOperations, ...options.spriteOperations },
    },
  };
}

interface FakeInteractionOptions {
  customId: string;
  kind?: "button" | "select" | "modal";
  values?: string[];
  fields?: Record<string, string>;
  isManager?: boolean;
  inGuild?: boolean;
  harness: Harness;
}

function makeInteraction(options: FakeInteractionOptions) {
  let deferred = false;
  let replied = false;
  const kind = options.kind ?? "button";

  const interaction = {
    id: "interaction-1",
    customId: options.customId,
    user: { id: "user-1", username: "Sparrow" },
    channelId: "channel-1",
    channel: { name: "lounge" },
    guildId: options.inGuild === false ? null : "guild-1",
    guild: options.inGuild === false ? null : { members: { me: null, fetch: async () => null } },
    client: { user: null },
    values: options.values ?? [],
    memberPermissions: {
      has: (flag: bigint) => (options.isManager ?? true) && flag === PermissionsBitField.Flags.ManageGuild,
    },
    isButton: () => kind === "button",
    isStringSelectMenu: () => kind === "select",
    isModalSubmit: () => kind === "modal",
    get deferred() {
      return deferred;
    },
    get replied() {
      return replied;
    },
    deferUpdate: async () => {
      deferred = true;
    },
    editReply: async (payload: unknown) => {
      options.harness.edits.push(payload);
      return payload;
    },
    reply: async (payload: unknown) => {
      replied = true;
      options.harness.replies.push(payload);
      return payload;
    },
    followUp: async (payload: unknown) => {
      options.harness.followUps.push(payload);
      return payload;
    },
    fields: {
      getTextInputValue: (fieldId: string) => options.fields?.[fieldId] ?? "",
    },
  };

  return interaction as unknown as Parameters<ReturnType<typeof createConfigInteractionRoute>["execute"]>[1] & {
    deferred: boolean;
  };
}

async function dispatch(harness: Harness, interaction: ReturnType<typeof makeInteraction>): Promise<void> {
  const registry = new InteractionRouteRegistry([createConfigInteractionRoute(harness.dependencies)]);
  await registry.dispatch(CLIENT, interaction);
}

/**
 * Pins the `/config` v2 wire contract: each literal custom ID and the exact route it must decode to.
 * Encoding and decoding through one shared codec table cannot catch a field reordering, because
 * both sides move together and a round-trip still succeeds; only literal bytes can.
 */
const WIRE_CONTRACT_V2: ReadonlyArray<readonly [string, ConfigPanelRoute]> = [
  [
    "config:v2:category:en-US:persona:general",
    { action: "category", locale: "en-US", category: "persona", page: "general" },
  ],
  ["config:v2:page:en-US:models:switch", { action: "page", locale: "en-US", category: "models", page: "switch" }],
  [
    "config:v2:persona-page-select:en-US:persona:general:55",
    { action: "persona-page-select", locale: "en-US", category: "persona", page: "general", personaId: 55 },
  ],
  ["config:v2:persona-select:en-US:55", { action: "persona-select", locale: "en-US", personaId: 55 }],
  ["config:v2:persona-page:en-US:55:25", { action: "persona-page", locale: "en-US", personaId: 55, start: 25 }],
  ["config:v2:voice-select:en-US:55", { action: "voice-select", locale: "en-US", personaId: 55 }],
  ["config:v2:voice-page:en-US:55:25", { action: "voice-page", locale: "en-US", personaId: 55, start: 25 }],
  ["config:v2:voice-choose-cancel:en-US:55", { action: "voice-chooser-cancel", locale: "en-US", personaId: 55 }],
  ["config:v2:voice-clear:en-US:55", { action: "voice-clear", locale: "en-US", personaId: 55 }],
  ["config:v2:voice-design-open:en-US:55", { action: "voice-design-open", locale: "en-US", personaId: 55 }],
  [
    "config:v2:voice-design-sub:en-US:55:nonce1234567",
    { action: "voice-design-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
  ],
  ["config:v2:voice-design-rem:en-US:55", { action: "voice-design-remove", locale: "en-US", personaId: 55 }],
  ["config:v2:server-memory:en-US:55", { action: "server-memory-open", locale: "en-US", personaId: 55 }],
  ["config:v2:personal-memory:en-US:55", { action: "personal-memory-open", locale: "en-US", personaId: 55 }],
  ["config:v2:stm-edit-open:en-US:55", { action: "stm-edit-open", locale: "en-US", personaId: 55 }],
  [
    "config:v2:stm-edit-submit:en-US:55:nonce1234567",
    { action: "stm-edit-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
  ],
  ["config:v2:conditioning-open:en-US:55", { action: "conditioning-open", locale: "en-US", personaId: 55 }],
  [
    "config:v2:conditioning-submit:en-US:55:abcd1234:nonce1234567",
    {
      action: "conditioning-submit",
      locale: "en-US",
      personaId: 55,
      fp: "abcd1234",
      nonce: "nonce1234567",
    },
  ],
  ["config:v2:image-tags-open:en-US:55", { action: "image-tags-open", locale: "en-US", personaId: 55 }],
  [
    "config:v2:image-tags-submit:en-US:55:nonce1234567",
    { action: "image-tags-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
  ],
  ["config:v2:attg-open:en-US:55", { action: "attg-open", locale: "en-US", personaId: 55 }],
  [
    "config:v2:attg-submit:en-US:55:nonce1234567",
    { action: "attg-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
  ],
  ["config:v2:attg-clear-all:en-US:55", { action: "attg-clear-all", locale: "en-US", personaId: 55 }],
  ["config:v2:sprite-select:en-US:55", { action: "sprite-select", locale: "en-US", personaId: 55 }],
  ["config:v2:sprite-page:en-US:55:25", { action: "sprite-page", locale: "en-US", personaId: 55, start: 25 }],
  ["config:v2:sprite-add-open:en-US:55", { action: "sprite-add-open", locale: "en-US", personaId: 55 }],
  [
    "config:v2:sprite-add-sub:en-US:55:nonce1234567",
    { action: "sprite-add-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
  ],
  [
    "config:v2:sprite-edit-open:en-US:55:0:abcd1234",
    { action: "sprite-edit-open", locale: "en-US", personaId: 55, index: 0, fp: "abcd1234" },
  ],
  [
    "config:v2:sprite-edit-sub:en-US:55:0:abcd1234:nonce1234567",
    { action: "sprite-edit-submit", locale: "en-US", personaId: 55, index: 0, fp: "abcd1234", nonce: "nonce1234567" },
  ],
  [
    "config:v2:sprite-rem-view:en-US:55:0:abcd1234",
    { action: "sprite-remove-view", locale: "en-US", personaId: 55, index: 0, fp: "abcd1234" },
  ],
  [
    "config:v2:sprite-rem-confirm:en-US:55:0:abcd1234:nonce1234567",
    {
      action: "sprite-remove-confirm",
      locale: "en-US",
      personaId: 55,
      index: 0,
      fp: "abcd1234",
      nonce: "nonce1234567",
    },
  ],
  ["config:v2:sprite-rem-cancel:en-US:55", { action: "sprite-remove-cancel", locale: "en-US", personaId: 55 }],
  ["config:v2:sprite-import-open:en-US:55", { action: "sprite-import-open", locale: "en-US", personaId: 55 }],
  [
    "config:v2:sprite-import-sub:en-US:55:nonce1234567",
    { action: "sprite-import-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
  ],
  ["config:v2:sprite-export:en-US:55", { action: "sprite-export", locale: "en-US", personaId: 55 }],
  ["config:v2:char-ref-open:en-US:55", { action: "character-reference-open", locale: "en-US", personaId: 55 }],
  [
    "config:v2:char-ref-submit:en-US:55:nonce1234567",
    { action: "character-reference-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
  ],
  [
    "config:v2:char-ref-clear-view:en-US:55",
    { action: "character-reference-clear-view", locale: "en-US", personaId: 55 },
  ],
  [
    "config:v2:char-ref-clear-confirm:en-US:55:nonce1234567",
    { action: "character-reference-clear-confirm", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
  ],
  [
    "config:v2:char-ref-clear-cancel:en-US:55",
    { action: "character-reference-clear-cancel", locale: "en-US", personaId: 55 },
  ],
  ["config:v2:prompt-open:en-US:55", { action: "prompt-open", locale: "en-US", personaId: 55 }],
  [
    "config:v2:prompt-submit:en-US:55:nonce1234567",
    { action: "prompt-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
  ],
  ["config:v2:prompt-remove:en-US:55", { action: "prompt-remove", locale: "en-US", personaId: 55 }],
  ["config:v2:context-open:en-US:55", { action: "context-note-open", locale: "en-US", personaId: 55 }],
  [
    "config:v2:context-submit:en-US:55:nonce1234567",
    { action: "context-note-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
  ],
  ["config:v2:humanizer-open:en-US:55", { action: "humanizer-open", locale: "en-US", personaId: 55 }],
  ["config:v2:humanizer-select:en-US:55", { action: "humanizer-select", locale: "en-US", personaId: 55 }],
  [
    "config:v2:humanizer-submit:en-US:55:nonce1234567",
    { action: "humanizer-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
  ],
  ["config:v2:text-override-open:en-US:55", { action: "text-override-open", locale: "en-US", personaId: 55 }],
  [
    "config:v2:text-override-provider-select:en-US:55",
    { action: "text-override-provider-select", locale: "en-US", personaId: 55 },
  ],
  [
    "config:v2:text-override-model-select:en-US:55:openrouter",
    { action: "text-override-model-select", locale: "en-US", personaId: 55, provider: "openrouter" },
  ],
  [
    "config:v2:text-model-submit:en-US:55:openrouter:nonce1234567",
    {
      action: "text-override-model-submit",
      locale: "en-US",
      personaId: 55,
      provider: "openrouter",
      nonce: "nonce1234567",
    },
  ],
  [
    "config:v2:text-override-model-page:en-US:55:openrouter:25",
    { action: "text-override-model-page", locale: "en-US", personaId: 55, provider: "openrouter", start: 25 },
  ],
  ["config:v2:text-override-clear:en-US:55", { action: "text-override-clear", locale: "en-US", personaId: 55 }],
  ["config:v2:avatar-open:en-US:55", { action: "avatar-open", locale: "en-US", personaId: 55 }],
  [
    "config:v2:avatar-submit:en-US:55:nonce1234567",
    { action: "avatar-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
  ],
  ["config:v2:rename-open:en-US:55", { action: "rename-open", locale: "en-US", personaId: 55 }],
  [
    "config:v2:rename-submit:en-US:55:nonce1234567",
    { action: "rename-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
  ],
  ["config:v2:naming-style:en-US:55", { action: "naming-style-select", locale: "en-US", personaId: 55 }],
  [
    "config:v2:naming-open:en-US:55:neutral",
    { action: "naming-open", locale: "en-US", personaId: 55, style: "neutral" },
  ],
  [
    "config:v2:naming-submit:en-US:55:feminine:nonce1234567",
    { action: "naming-submit", locale: "en-US", personaId: 55, style: "feminine", nonce: "nonce1234567" },
  ],
  ["config:v2:trig-add-open:en-US:55", { action: "trigger-add-open", locale: "en-US", personaId: 55 }],
  [
    "config:v2:trig-add-sub:en-US:55:nonce1234567",
    { action: "trigger-add-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
  ],
  ["config:v2:trig-rem-open:en-US:55", { action: "trigger-remove-open", locale: "en-US", personaId: 55 }],
  [
    "config:v2:trig-rem-sub:en-US:55:abcd1234:nonce1234567",
    { action: "trigger-remove-submit", locale: "en-US", personaId: 55, fp: "abcd1234", nonce: "nonce1234567" },
  ],
  ["config:v2:attr-select:en-US:55", { action: "attribute-select", locale: "en-US", personaId: 55 }],
  ["config:v2:attr-page:en-US:55:24", { action: "attribute-page", locale: "en-US", personaId: 55, start: 24 }],
  ["config:v2:attr-add-open:en-US:55", { action: "attribute-add-open", locale: "en-US", personaId: 55 }],
  [
    "config:v2:attr-add-sub:en-US:55:nonce1234567",
    { action: "attribute-add-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
  ],
  [
    "config:v2:attr-edit-open:en-US:55:0:abcd1234",
    { action: "attribute-edit-open", locale: "en-US", personaId: 55, index: 0, fp: "abcd1234" },
  ],
  [
    "config:v2:attr-edit-sub:en-US:55:0:abcd1234:nonce1234567",
    {
      action: "attribute-edit-submit",
      locale: "en-US",
      personaId: 55,
      index: 0,
      fp: "abcd1234",
      nonce: "nonce1234567",
    },
  ],
  [
    "config:v2:attr-remove:en-US:55:0:abcd1234",
    { action: "attribute-remove", locale: "en-US", personaId: 55, index: 0, fp: "abcd1234" },
  ],
  ["config:v2:dlg-select:en-US:55", { action: "dialogue-select", locale: "en-US", personaId: 55 }],
  ["config:v2:dlg-page:en-US:55:24", { action: "dialogue-page", locale: "en-US", personaId: 55, start: 24 }],
  ["config:v2:dlg-add-open:en-US:55", { action: "dialogue-add-open", locale: "en-US", personaId: 55 }],
  [
    "config:v2:dlg-add-sub:en-US:55:nonce1234567",
    { action: "dialogue-add-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
  ],
  [
    "config:v2:dlg-edit-open:en-US:55:0:abcd1234",
    { action: "dialogue-edit-open", locale: "en-US", personaId: 55, index: 0, fp: "abcd1234" },
  ],
  [
    "config:v2:dlg-edit-sub:en-US:55:0:abcd1234:nonce1234567",
    {
      action: "dialogue-edit-submit",
      locale: "en-US",
      personaId: 55,
      index: 0,
      fp: "abcd1234",
      nonce: "nonce1234567",
    },
  ],
  [
    "config:v2:dlg-remove:en-US:55:0:abcd1234",
    { action: "dialogue-remove", locale: "en-US", personaId: 55, index: 0, fp: "abcd1234" },
  ],
  ["config:v2:promote-view:en-US:56", { action: "promote-view", locale: "en-US", personaId: 56 }],
  [
    "config:v2:promote-confirm:en-US:56:nonce1234567",
    { action: "promote-confirm", locale: "en-US", personaId: 56, nonce: "nonce1234567" },
  ],
  ["config:v2:promote-cancel:en-US:56", { action: "promote-cancel", locale: "en-US", personaId: 56 }],
  [
    "config:v2:retry:en-US:persona:general:55",
    { action: "retry", locale: "en-US", category: "persona", page: "general", personaId: 55 },
  ],
  [
    "config:v2:refresh:en-US:persona:general",
    { action: "refresh", locale: "en-US", category: "persona", page: "general" },
  ],
  ["config:v2:model-prov-select:en-US:text", { action: "model-provider-select", locale: "en-US", capability: "text" }],
  ["config:v2:ep-select:en-US:tts", { action: "endpoint-select", locale: "en-US", capability: "tts" }],
  ["config:v2:ep-select:en-US:stt", { action: "endpoint-select", locale: "en-US", capability: "stt" }],
  [
    "config:v2:model-modal:en-US:video:custom~12:nonce1234567",
    {
      action: "model-modal-submit",
      locale: "en-US",
      capability: "video",
      provider: "custom:12",
      nonce: "nonce1234567",
    },
  ],
  ["config:v2:param-prov-select:en-US", { action: "parameters-provider-select", locale: "en-US" }],
  [
    "config:v2:nai-preset-select:en-US:0:deadbeef",
    { action: "nai-preset-select", locale: "en-US", start: 0, fp: "deadbeef" },
  ],
  ["config:v2:sampling-open:en-US:google", { action: "sampling-open", locale: "en-US", provider: "google" }],
  [
    "config:v2:sampling-sub:en-US:google:nonce1234567",
    { action: "sampling-submit", locale: "en-US", provider: "google", nonce: "nonce1234567" },
  ],
  ["config:v2:generation-open:en-US:google", { action: "generation-open", locale: "en-US", provider: "google" }],
  [
    "config:v2:generation-sub:en-US:google:nonce1234567",
    { action: "generation-submit", locale: "en-US", provider: "google", nonce: "nonce1234567" },
  ],
  ["config:v2:stop-add-open:en-US", { action: "stop-add-open", locale: "en-US" }],
  ["config:v2:stop-add-sub:en-US:nonce1234567", { action: "stop-add-submit", locale: "en-US", nonce: "nonce1234567" }],
  ["config:v2:stop-man-open:en-US", { action: "stop-manage-open", locale: "en-US" }],
  [
    "config:v2:stop-man-sub:en-US:abcd1234:nonce1234567",
    { action: "stop-manage-submit", locale: "en-US", fp: "abcd1234", nonce: "nonce1234567" },
  ],
  ["config:v2:logit-add-open:en-US", { action: "logit-add-open", locale: "en-US" }],
  [
    "config:v2:logit-add-sub:en-US:nonce1234567",
    { action: "logit-add-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v2:logit-up-open:en-US", { action: "logit-upload-open", locale: "en-US" }],
  [
    "config:v2:logit-up-sub:en-US:nonce1234567",
    { action: "logit-upload-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v2:logit-man-select:en-US", { action: "logit-manage-select", locale: "en-US" }],
  ["config:v2:logit-man-open:en-US:0", { action: "logit-manage-open", locale: "en-US", start: 0 }],
  [
    "config:v2:logit-man-sub:en-US:50:abcd1234:nonce1234567",
    { action: "logit-manage-submit", locale: "en-US", start: 50, fp: "abcd1234", nonce: "nonce1234567" },
  ],
  ["config:v2:fb-prov-select:en-US", { action: "fallback-provider-select", locale: "en-US" }],
  ["config:v2:fb-prov-rng:en-US:24", { action: "fallback-provider-range", locale: "en-US", start: 24 }],
  [
    "config:v2:fb-prov-page:en-US:openrouter:48",
    { action: "fallback-provider-page", locale: "en-US", provider: "openrouter", start: 48 },
  ],
  [
    "config:v2:fb-sub:en-US:google:24:nonce1234567",
    { action: "fallback-submit", locale: "en-US", provider: "google", start: 24, nonce: "nonce1234567" },
  ],
  ["config:v2:randomizer-set:en-US:1", { action: "randomizer-set", locale: "en-US", enabled: true }],
  ["config:v2:randomizer-set:en-US:0", { action: "randomizer-set", locale: "en-US", enabled: false }],
  ["config:v2:img-tags-open:en-US:0", { action: "image-tags-default-open", locale: "en-US", negative: false }],
  [
    "config:v2:img-tags-sub:en-US:1:nonce1234567",
    { action: "image-tags-default-submit", locale: "en-US", negative: true, nonce: "nonce1234567" },
  ],
  ["config:v2:nai-params-open:en-US", { action: "nai-parameters-open", locale: "en-US" }],
  [
    "config:v2:nai-params-sub:en-US:nonce1234567",
    { action: "nai-parameters-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v2:beh-prompt-open:en-US", { action: "behavior-prompt-open", locale: "en-US" }],
  [
    "config:v2:beh-prompt-sub:en-US:nonce1234567",
    { action: "behavior-prompt-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v2:beh-preset-open:en-US", { action: "behavior-preset-open", locale: "en-US" }],
  [
    "config:v2:beh-preset-sub:en-US:nonce1234567",
    { action: "behavior-preset-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v2:beh-prompt-remove:en-US", { action: "behavior-prompt-remove", locale: "en-US" }],
  ["config:v2:beh-context-open:en-US", { action: "behavior-context-open", locale: "en-US" }],
  [
    "config:v2:beh-context-sub:en-US:nonce1234567",
    { action: "behavior-context-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v2:beh-humanizer-open:en-US", { action: "behavior-humanizer-open", locale: "en-US" }],
  [
    "config:v2:beh-humanizer-sub:en-US:nonce1234567",
    { action: "behavior-humanizer-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v2:beh-fetch-open:en-US", { action: "behavior-fetch-open", locale: "en-US" }],
  [
    "config:v2:beh-fetch-sub:en-US:nonce1234567",
    { action: "behavior-fetch-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v2:beh-timezone-open:en-US", { action: "behavior-timezone-open", locale: "en-US" }],
  [
    "config:v2:beh-timezone-sub:en-US:nonce1234567",
    { action: "behavior-timezone-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v2:beh-random-add-open:en-US", { action: "behavior-random-add-open", locale: "en-US" }],
  ["config:v2:beh-random-add-range:en-US", { action: "behavior-random-add-range-select", locale: "en-US" }],
  [
    "config:v2:beh-random-add-sub:en-US:nonce1234567",
    { action: "behavior-random-add-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v2:beh-random-rem-open:en-US", { action: "behavior-random-remove-open", locale: "en-US" }],
  ["config:v2:beh-random-rem-select:en-US", { action: "behavior-random-remove-select", locale: "en-US" }],
  ["config:v2:beh-random-rem-page:en-US:1250", { action: "behavior-random-remove-page", locale: "en-US", start: 1250 }],
  ["config:v2:beh-random-rem-cancel:en-US", { action: "behavior-random-remove-cancel", locale: "en-US" }],
  [
    "config:v2:beh-random-rem-cancel:en-US:1250",
    { action: "behavior-random-remove-cancel", locale: "en-US", start: 1250 },
  ],
  [
    "config:v2:beh-random-rem-sub:en-US:50:abcd1234:nonce1234567",
    { action: "behavior-random-remove-submit", locale: "en-US", start: 50, fp: "abcd1234", nonce: "nonce1234567" },
  ],
  ["config:v2:beh-limits-open:en-US", { action: "behavior-limits-open", locale: "en-US" }],
  [
    "config:v2:beh-limits-sub:en-US:nonce1234567",
    { action: "behavior-limits-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v2:beh-dtm-set:en-US:1", { action: "behavior-dtm-set", locale: "en-US", enabled: true }],
  ["config:v2:beh-always-set:en-US:0", { action: "behavior-always-set", locale: "en-US", enabled: false }],
  ["config:v2:beh-cooldown-open:en-US", { action: "behavior-cooldown-open", locale: "en-US" }],
  [
    "config:v2:beh-cooldown-sub:en-US:nonce1234567",
    { action: "behavior-cooldown-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v2:beh-tool-mode-set:en-US:1", { action: "behavior-tool-mode-set", locale: "en-US", enabled: true }],
  ["config:v2:beh-tool-context-open:en-US", { action: "behavior-tool-context-open", locale: "en-US" }],
  [
    "config:v2:beh-tool-context-sub:en-US:nonce1234567",
    { action: "behavior-tool-context-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v2:beh-tool-trigger-add-open:en-US", { action: "behavior-tool-trigger-add-open", locale: "en-US" }],
  [
    "config:v2:beh-tool-trigger-add-sub:en-US:nonce1234567",
    { action: "behavior-tool-trigger-add-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v2:beh-tool-trigger-remove-open:en-US", { action: "behavior-tool-trigger-remove-open", locale: "en-US" }],
  [
    "config:v2:beh-tool-trigger-remove-sub:en-US:nonce1234567",
    { action: "behavior-tool-trigger-remove-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v2:beh-send-limit-open:en-US", { action: "behavior-send-limit-open", locale: "en-US" }],
  [
    "config:v2:beh-send-limit-sub:en-US:nonce1234567",
    { action: "behavior-send-limit-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v2:beh-self-debug-set:en-US:1", { action: "behavior-self-debug-set", locale: "en-US", enabled: true }],
  ["config:v2:beh-workarounds-open:en-US", { action: "behavior-workarounds-open", locale: "en-US" }],
  [
    "config:v2:beh-workarounds-sub:en-US:nonce1234567",
    { action: "behavior-workarounds-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v2:beh-notices-open:en-US", { action: "behavior-notice-visibility-open", locale: "en-US" }],
  [
    "config:v2:beh-notices-sub:en-US:nonce1234567",
    { action: "behavior-notice-visibility-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  [
    "config:v2:beh-transcripts-set:en-US:0",
    { action: "behavior-speech-transcripts-set", locale: "en-US", enabled: false },
  ],
  ["config:v2:beh-memory-tag-open:en-US", { action: "behavior-memory-tagging-open", locale: "en-US" }],
  [
    "config:v2:beh-memory-tag-sub:en-US:nonce1234567",
    { action: "behavior-memory-tagging-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v2:beh-stm-params-open:en-US", { action: "behavior-stm-parameters-open", locale: "en-US" }],
  [
    "config:v2:beh-stm-params-sub:en-US:nonce1234567",
    { action: "behavior-stm-parameters-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v2:beh-stm-categories-open:en-US", { action: "behavior-stm-categories-open", locale: "en-US" }],
  [
    "config:v2:beh-stm-categories-sub:en-US:nonce1234567",
    { action: "behavior-stm-categories-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v2:beh-stm-prompt-open:en-US", { action: "behavior-stm-prompt-open", locale: "en-US" }],
  [
    "config:v2:beh-stm-prompt-sub:en-US:nonce1234567",
    { action: "behavior-stm-prompt-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v2:perm-tool-use-set:en-US:1", { action: "permissions-tool-use-set", locale: "en-US", enabled: true }],
  [
    "config:v2:perm-manage-open:en-US:available-tools",
    { action: "permissions-manage-open", locale: "en-US", page: "available-tools" },
  ],
  [
    "config:v2:perm-manage-submit:en-US:available-tools:1:nonce1234567",
    {
      action: "permissions-manage-submit",
      locale: "en-US",
      page: "available-tools",
      includeElevenLabs: true,
      nonce: "nonce1234567",
    },
  ],
  ["config:v2:perm-privacy-set:en-US:0", { action: "permissions-privacy-bypass-set", locale: "en-US", enabled: false }],
  ["config:v2:channels-log-open:en-US", { action: "channels-log-open", locale: "en-US" }],
  [
    "config:v2:channels-log-submit:en-US:nonce1234567",
    { action: "channels-log-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  [
    "config:v2:channels-log-clear:en-US:123456789012345678",
    { action: "channels-log-clear", locale: "en-US", channelId: "123456789012345678" },
  ],
  ["config:v2:channels-welcome-open:en-US", { action: "channels-welcome-open", locale: "en-US" }],
  ["config:v2:welcome-range-select:en-US", { action: "channels-welcome-range-select", locale: "en-US" }],
  [
    "config:v2:channels-welcome-submit:en-US:nonce1234567",
    { action: "channels-welcome-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  [
    "config:v2:channels-welcome-clear:en-US:123456789012345678",
    { action: "channels-welcome-clear", locale: "en-US", channelId: "123456789012345678" },
  ],
  ["config:v2:autoch-manage-open:en-US:0", { action: "channels-autoch-manage-open", locale: "en-US", start: 0 }],
  [
    "config:v2:autoch-submit:en-US:1:abcd1234:nonce1234567",
    {
      action: "channels-autoch-submit",
      locale: "en-US",
      start: 1,
      fp: "abcd1234",
      nonce: "nonce1234567",
    },
  ],
  ["config:v2:autoch-page:en-US:1", { action: "channels-autoch-page", locale: "en-US", start: 1 }],
  ["config:v2:autoch-config-open:en-US", { action: "channels-autoch-configure-open", locale: "en-US" }],
  ["config:v2:autoch-range-select:en-US", { action: "channels-autoch-range-select", locale: "en-US" }],
  [
    "config:v2:autoch-config-submit:en-US:abcd1234:nonce1234567",
    {
      action: "channels-autoch-configure-submit",
      locale: "en-US",
      fp: "abcd1234",
      nonce: "nonce1234567",
    },
  ],
  ["config:v2:autoch-threshold-open:en-US", { action: "channels-autoch-threshold-open", locale: "en-US" }],
  [
    "config:v2:autoch-threshold-submit:en-US:abcd1234:nonce1234567",
    {
      action: "channels-autoch-threshold-submit",
      locale: "en-US",
      fp: "abcd1234",
      nonce: "nonce1234567",
    },
  ],
  ["config:v2:private-manage-open:en-US:0", { action: "channels-private-manage-open", locale: "en-US", start: 0 }],
  [
    "config:v2:private-submit:en-US:1:abcd1234:nonce1234567",
    {
      action: "channels-private-submit",
      locale: "en-US",
      start: 1,
      fp: "abcd1234",
      nonce: "nonce1234567",
    },
  ],
  ["config:v2:private-page:en-US:1", { action: "channels-private-page", locale: "en-US", start: 1 }],
  ["config:v2:rp-manage-open:en-US:0", { action: "channels-rp-manage-open", locale: "en-US", start: 0 }],
  [
    "config:v2:rp-submit:en-US:1:abcd1234:nonce1234567",
    {
      action: "channels-rp-submit",
      locale: "en-US",
      start: 1,
      fp: "abcd1234",
      nonce: "nonce1234567",
    },
  ],
  ["config:v2:rp-page:en-US:1", { action: "channels-rp-page", locale: "en-US", start: 1 }],
  ["config:v2:blocklist-manage-open:en-US:0", { action: "channels-blocklist-manage-open", locale: "en-US", start: 0 }],
  [
    "config:v2:blocklist-submit:en-US:1:abcd1234:nonce1234567",
    {
      action: "channels-blocklist-submit",
      locale: "en-US",
      start: 1,
      fp: "abcd1234",
      nonce: "nonce1234567",
    },
  ],
  ["config:v2:blocklist-page:en-US:1", { action: "channels-blocklist-page", locale: "en-US", start: 1 }],
  ["config:v2:ch-ov-select:en-US", { action: "channels-overrides-select", locale: "en-US" }],
  [
    "config:v2:ch-ov-p-open:en-US:123456789012345678",
    { action: "channels-overrides-prompt-open", locale: "en-US", channelId: "123456789012345678" },
  ],
  [
    "config:v2:ch-ov-p-submit:en-US:123456789012345678:abcd1234:nonce1234567",
    {
      action: "channels-overrides-prompt-submit",
      locale: "en-US",
      channelId: "123456789012345678",
      fp: "abcd1234",
      nonce: "nonce1234567",
    },
  ],
  [
    "config:v2:ch-ov-p-clear:en-US:123456789012345678:abcd1234",
    {
      action: "channels-overrides-prompt-clear",
      locale: "en-US",
      channelId: "123456789012345678",
      fp: "abcd1234",
    },
  ],
  [
    "config:v2:ch-ov-c-open:en-US:123456789012345678",
    { action: "channels-overrides-context-note-open", locale: "en-US", channelId: "123456789012345678" },
  ],
  [
    "config:v2:ch-ov-c-submit:en-US:123456789012345678:abcd1234:nonce1234567",
    {
      action: "channels-overrides-context-note-submit",
      locale: "en-US",
      channelId: "123456789012345678",
      fp: "abcd1234",
      nonce: "nonce1234567",
    },
  ],
  [
    "config:v2:ch-ov-t-open:en-US:123456789012345678",
    { action: "channels-overrides-text-open", locale: "en-US", channelId: "123456789012345678" },
  ],
  [
    "config:v2:ch-ov-t-provider:en-US:123456789012345678:abcd1234",
    {
      action: "channels-overrides-text-provider-select",
      locale: "en-US",
      channelId: "123456789012345678",
      fp: "abcd1234",
    },
  ],
  [
    "config:v2:ch-ov-t-range:en-US:123456789012345678:openrouter:abcd1234",
    {
      action: "channels-overrides-text-model-range-select",
      locale: "en-US",
      channelId: "123456789012345678",
      provider: "openrouter",
      fp: "abcd1234",
    },
  ],
  [
    "config:v2:ch-ov-t-submit:en-US:123456789012345678:openrouter:abcd1234:nonce1234567",
    {
      action: "channels-overrides-text-model-submit",
      locale: "en-US",
      channelId: "123456789012345678",
      provider: "openrouter",
      fp: "abcd1234",
      nonce: "nonce1234567",
    },
  ],
  [
    "config:v2:ch-ov-t-clear:en-US:123456789012345678:abcd1234",
    {
      action: "channels-overrides-text-clear",
      locale: "en-US",
      channelId: "123456789012345678",
      fp: "abcd1234",
    },
  ],
  ["config:v2:tts-params-open:en-US", { action: "tts-parameters-open", locale: "en-US" }],
  [
    "config:v2:tts-params-sub:en-US:nonce1234567",
    { action: "tts-parameters-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  ["config:v2:tts-turbo-set:en-US:1", { action: "tts-turbo-set", locale: "en-US", enabled: true }],
  ["config:v2:vsample-select:en-US:25", { action: "voice-sample-select", locale: "en-US", start: 25 }],
  ["config:v2:vsample-page:en-US:0", { action: "voice-sample-page", locale: "en-US", start: 0 }],
  ["config:v2:vsample-add-open:en-US", { action: "voice-sample-add-open", locale: "en-US" }],
  [
    "config:v2:vsample-add-sub:en-US:nonce1234567",
    { action: "voice-sample-add-submit", locale: "en-US", nonce: "nonce1234567" },
  ],
  [
    "config:v2:vsample-rem-view:en-US:0:abcd1234",
    { action: "voice-sample-remove-view", locale: "en-US", index: 0, fp: "abcd1234" },
  ],
  [
    "config:v2:vsample-rem-conf:en-US:3:abcd1234:nonce1234567",
    { action: "voice-sample-remove-confirm", locale: "en-US", index: 3, fp: "abcd1234", nonce: "nonce1234567" },
  ],
  ["config:v2:vsample-rem-cancel:en-US", { action: "voice-sample-remove-cancel", locale: "en-US" }],
];

describe("config route wire contract", () => {
  it("decodes every pinned v2 wire string to its exact route", () => {
    for (const [customId, expected] of WIRE_CONTRACT_V2) {
      expect(customId.length).toBeLessThanOrEqual(100);
      expect(parseConfigPanelRoute(requireRoute(customId))).toEqual(expected);
    }
  });

  it("re-encodes every pinned route to the exact wire string it came from", () => {
    for (const [customId, route] of WIRE_CONTRACT_V2) {
      expect(buildConfigRouteId(route)).toBe(customId);
    }
  });

  it("covers every declared action in the pinned wire contract", () => {
    const pinned = new Set(WIRE_CONTRACT_V2.map(([, route]) => route.action));
    expect([...pinned].sort()).toEqual(Object.keys(CONFIG_ROUTE_CODECS).sort());
  });

  it("keeps the longest channel Text model submit route under Discord's limit", () => {
    const customId = buildConfigRouteId({
      action: "channels-overrides-text-model-submit",
      locale: "en-US",
      channelId: "99999999999999999999",
      provider: "openrouter",
      fp: "abcd1234",
      nonce: "nonce1234567",
    });
    expect(customId.length).toBeLessThan(100);
  });

  it("rejects a malformed or out-of-range field rather than defaulting it", () => {
    expect(parseConfigPanelRoute(requireRoute("config:v2:persona-select:en-US:0"))).toBeNull();
    expect(parseConfigPanelRoute(requireRoute("config:v2:persona-select:en-US:abc"))).toBeNull();
    // `general` is a Behavior page too, so a page must decode against its own category.
    expect(parseConfigPanelRoute(requireRoute("config:v2:page:en-US:models:general"))).toBeNull();
    expect(parseConfigPanelRoute(requireRoute("config:v2:persona-page-select:en-US:models:switch:55"))).toBeNull();
    expect(parseConfigPanelRoute(requireRoute("config:v2:naming-open:en-US:55:androgynous"))).toBeNull();
    expect(parseConfigPanelRoute(requireRoute("config:v2:not-a-token:en-US:55"))).toBeNull();
  });
});

describe("config route authorization", () => {
  it("writes nothing when a guild member replays a manager-owned rename", async () => {
    const renameSpy = spyOn(personaRepository, "renamePersona");
    const harness = makeHarness({ isManager: false });
    const customId = buildConfigRouteId({
      action: "rename-submit",
      locale: "en-US",
      personaId: 55,
      nonce: "nonce1234567",
    });

    await dispatch(
      harness,
      makeInteraction({
        customId,
        kind: "modal",
        isManager: false,
        harness,
        fields: { [buildConfigModalFieldId("nickname", "nonce1234567")]: "Renamed" },
      }),
    );

    expect(renameSpy).not.toHaveBeenCalled();
    expect(harness.telemetry).toEqual([]);
    renameSpy.mockRestore();
  });

  it("reaches the same repository write when the identical route carries a manager", async () => {
    // Pairs with the denial above so that test cannot pass vacuously: the only difference between
    // the two dispatches is the actor resolved from the interaction.
    const renameSpy = spyOn(personaRepository, "renamePersona").mockResolvedValue(true);
    const conflictSpy = spyOn(personaRepository, "hasNicknameConflict").mockResolvedValue(false);
    const triggerSpy = spyOn(personaRepository, "addTrigger").mockResolvedValue(true);
    const harness = makeHarness({ isManager: true });
    const customId = buildConfigRouteId({
      action: "rename-submit",
      locale: "en-US",
      personaId: 55,
      nonce: "nonce1234567",
    });

    await dispatch(
      harness,
      makeInteraction({
        customId,
        kind: "modal",
        isManager: true,
        harness,
        fields: { [buildConfigModalFieldId("nickname", "nonce1234567")]: "Renamed" },
      }),
    );

    expect(renameSpy).toHaveBeenCalledWith(55, "Renamed");
    expect(harness.telemetry).toEqual(["server-config.workspace.persona.rename"]);
    renameSpy.mockRestore();
    conflictSpy.mockRestore();
    triggerSpy.mockRestore();
  });

  it("writes nothing when a DM actor replays a guild-only trigger add", async () => {
    const addSpy = spyOn(personaRepository, "addTrigger");
    const harness = makeHarness({ inGuild: false });
    const customId = buildConfigRouteId({
      action: "trigger-add-submit",
      locale: "en-US",
      personaId: 55,
      nonce: "nonce1234567",
    });

    await dispatch(
      harness,
      makeInteraction({
        customId,
        kind: "modal",
        inGuild: false,
        harness,
        fields: { [buildConfigModalFieldId("triggers", "nonce1234567")]: "wren" },
      }),
    );

    expect(addSpy).not.toHaveBeenCalled();
    expect(harness.telemetry).toEqual([]);
    addSpy.mockRestore();
  });

  it("writes nothing when a guild member replays a manager trigger control", async () => {
    const addSpy = spyOn(personaRepository, "addTrigger");
    const harness = makeHarness({ isManager: false });
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "trigger-add-submit",
          locale: "en-US",
          personaId: 55,
          nonce: "nonce1234567",
        }),
        kind: "modal",
        isManager: false,
        harness,
        fields: { [buildConfigModalFieldId("triggers", "nonce1234567")]: "wren" },
      }),
    );

    expect(addSpy).not.toHaveBeenCalled();
    expect(harness.telemetry).toEqual([]);
    addSpy.mockRestore();
  });

  it("refuses a forged modal open without opening the modal", async () => {
    const harness = makeHarness({ isManager: false });
    const customId = buildConfigRouteId({ action: "avatar-open", locale: "en-US", personaId: 55 });

    await dispatch(harness, makeInteraction({ customId, isManager: false, harness }));

    expect(harness.modals).toEqual([]);
    expect(harness.replies).toHaveLength(1);
  });
});

describe("config route write behavior", () => {
  it("reports a nickname conflict when a concurrent rename wins the write race", async () => {
    const conflictSpy = spyOn(personaRepository, "hasNicknameConflict")
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const renameSpy = spyOn(personaRepository, "renamePersona").mockResolvedValue(false);

    const result = await configPersonaOperations.rename({
      persona: MAIN,
      serverDiscId: "guild-1",
      newNickname: "Renamed",
      guildIdentity: null,
    });

    expect(result).toEqual({ status: "name-conflict", nickname: "Renamed" });
    expect(renameSpy).toHaveBeenCalledWith(55, "Renamed");
    expect(conflictSpy).toHaveBeenNthCalledWith(1, 9, 55, "Renamed");
    expect(conflictSpy).toHaveBeenNthCalledWith(2, 9, 55, "Renamed");
    conflictSpy.mockRestore();
    renameSpy.mockRestore();
  });

  it("rejects a rename route carried by a button before reaching the repository", async () => {
    const renameSpy = spyOn(personaRepository, "renamePersona");
    const harness = makeHarness();
    const customId = buildConfigRouteId({
      action: "rename-submit",
      locale: "en-US",
      personaId: 55,
      nonce: "nonce1234567",
    });

    await expect(dispatch(harness, makeInteraction({ customId, kind: "button", harness }))).rejects.toThrow(
      "Config rename-submit route requires a modal submission",
    );

    expect(renameSpy).not.toHaveBeenCalled();
    renameSpy.mockRestore();
  });

  it("acknowledges the interaction before the write and repaints from a refreshed read", async () => {
    let acknowledgedDuringWrite = false;
    const renamed = makePersona({ persona_id: 55, persona_nickname: "Renamed", trigger_words: ["aphel", "renamed"] });
    const harness = makeHarness({
      personas: [MAIN, ALTER],
      refreshedPersonas: [renamed, ALTER],
      operations: {
        rename: async () => {
          acknowledgedDuringWrite = interaction.deferred;
          return {
            status: "success",
            oldNickname: "Aphel",
            newNickname: "Renamed",
            triggerAdded: true,
            guildNicknameSynced: true,
          };
        },
      },
    });
    const interaction = makeInteraction({
      customId: buildConfigRouteId({ action: "rename-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" }),
      kind: "modal",
      harness,
      fields: { [buildConfigModalFieldId("nickname", "nonce1234567")]: "Renamed" },
    });

    await dispatch(harness, interaction);

    expect(acknowledgedDuringWrite).toBe(true);
    expect(harness.telemetry).toEqual(["server-config.workspace.persona.rename"]);
    // A forced reload followed the write, so the repaint cannot show a pre-write value.
    expect(harness.scopeLoads).toContain(true);
    expect(JSON.stringify(harness.edits.at(-1))).toContain("Renamed");
  });

  it("writes nothing when the routed persona no longer exists in the workspace", async () => {
    // Falling back to the main persona is right for navigation and catastrophic for a write, so a
    // write whose target vanished must repaint instead of retargeting.
    let renameCalls = 0;
    const harness = makeHarness({
      personas: [MAIN],
      operations: {
        rename: async () => {
          renameCalls += 1;
          return { status: "write-failed" };
        },
      },
    });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "rename-submit",
          locale: "en-US",
          personaId: 999,
          nonce: "nonce1234567",
        }),
        kind: "modal",
        harness,
        fields: { [buildConfigModalFieldId("nickname", "nonce1234567")]: "Renamed" },
      }),
    );

    expect(renameCalls).toBe(0);
    expect(harness.telemetry).toEqual([]);
    expect(harness.edits).toHaveLength(1);
  });

  it("falls back to the main persona for navigation when the routed persona is gone", async () => {
    const harness = makeHarness({ personas: [MAIN] });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "persona-select", locale: "en-US", personaId: 999 }),
        kind: "select",
        values: [],
        harness,
      }),
    );

    const rendered = JSON.stringify(harness.edits.at(-1));
    expect(rendered).toContain(buildConfigRouteId({ action: "rename-open", locale: "en-US", personaId: 55 }));
  });

  it("reads the newly selected persona from the submitted value, not the route", async () => {
    const harness = makeHarness();

    await dispatch(
      harness,
      makeInteraction({
        // The custom ID names the persona that was selected when the menu rendered.
        customId: buildConfigRouteId({ action: "persona-select", locale: "en-US", personaId: 55 }),
        kind: "select",
        values: ["56"],
        harness,
      }),
    );

    const rendered = JSON.stringify(harness.edits.at(-1));
    expect(rendered).toContain(buildConfigRouteId({ action: "promote-view", locale: "en-US", personaId: 56 }));
  });

  it("reads the newly selected page from the submitted value and refuses one the actor cannot open", async () => {
    const allowed = makeHarness();
    await dispatch(
      allowed,
      makeInteraction({
        customId: buildConfigRouteId({ action: "page", locale: "en-US", category: "persona", page: "general" }),
        kind: "select",
        values: ["sprites"],
        harness: allowed,
      }),
    );
    expect(JSON.stringify(allowed.edits.at(-1))).toContain("Sprites");

    const denied = makeHarness({ isManager: false });
    await dispatch(
      denied,
      makeInteraction({
        customId: buildConfigRouteId({ action: "page", locale: "en-US", category: "persona", page: "general" }),
        kind: "select",
        values: ["advanced"],
        isManager: false,
        harness: denied,
      }),
    );
    // Advanced is omitted for a member, so the submitted value is discarded rather than honoured.
    expect(JSON.stringify(denied.edits.at(-1))).not.toContain("page_persona_advanced");
    expect(JSON.stringify(denied.edits.at(-1))).toContain(
      buildConfigRouteId({ action: "rename-open", locale: "en-US", personaId: 55 }),
    );
  });

  it("keeps Persona page navigation and rendered controls on the selected alter", async () => {
    const harness = makeHarness();

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "persona-select", locale: "en-US", personaId: 55 }),
        kind: "select",
        values: ["56"],
        harness,
      }),
    );
    expect(JSON.stringify(harness.edits.at(-1))).toContain(
      buildConfigRouteId({
        action: "persona-page-select",
        locale: "en-US",
        category: "persona",
        page: "general",
        personaId: 56,
      }),
    );

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "persona-page-select",
          locale: "en-US",
          category: "persona",
          page: "general",
          personaId: 56,
        }),
        kind: "select",
        values: ["sprites"],
        harness,
      }),
    );
    const sprites = JSON.stringify(harness.edits.at(-1));
    expect(sprites).toContain(buildConfigRouteId({ action: "sprite-select", locale: "en-US", personaId: 56 }));
    expect(sprites).not.toContain(buildConfigRouteId({ action: "sprite-select", locale: "en-US", personaId: 55 }));

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "persona-page-select",
          locale: "en-US",
          category: "persona",
          page: "sprites",
          personaId: 56,
        }),
        kind: "select",
        values: ["memories"],
        harness,
      }),
    );
    const memories = JSON.stringify(harness.edits.at(-1));
    expect(memories).toContain(buildConfigRouteId({ action: "server-memory-open", locale: "en-US", personaId: 56 }));
    expect(memories).not.toContain(
      buildConfigRouteId({ action: "server-memory-open", locale: "en-US", personaId: 55 }),
    );
  });

  it("keeps page navigation scoped to an alter beyond the first selector window", async () => {
    const personas = [
      MAIN,
      ...Array.from({ length: 25 }, (_, index) =>
        makePersona({ persona_id: 100 + index, persona_nickname: `Alter ${index + 1}`, is_alter: true }),
      ),
    ];
    const selectedPersonaId = 124;
    const harness = makeHarness({ personas });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "persona-select", locale: "en-US", personaId: 55 }),
        kind: "select",
        values: [String(selectedPersonaId)],
        harness,
      }),
    );
    const selected = JSON.stringify(harness.edits.at(-1));
    expect(selected).toContain(
      buildConfigRouteId({
        action: "persona-page-select",
        locale: "en-US",
        category: "persona",
        page: "general",
        personaId: selectedPersonaId,
      }),
    );

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "persona-page-select",
          locale: "en-US",
          category: "persona",
          page: "general",
          personaId: selectedPersonaId,
        }),
        kind: "select",
        values: ["sprites"],
        harness,
      }),
    );
    expect(JSON.stringify(harness.edits.at(-1))).toContain(
      buildConfigRouteId({ action: "sprite-select", locale: "en-US", personaId: selectedPersonaId }),
    );
  });

  it("falls back to the main persona when a carried page-navigation persona is gone", async () => {
    const harness = makeHarness();

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "persona-page-select",
          locale: "en-US",
          category: "persona",
          page: "general",
          personaId: 999,
        }),
        kind: "select",
        values: ["sprites"],
        harness,
      }),
    );

    const rendered = JSON.stringify(harness.edits.at(-1));
    expect(rendered).toContain(buildConfigRouteId({ action: "sprite-select", locale: "en-US", personaId: 55 }));
    expect(rendered).not.toContain(buildConfigRouteId({ action: "sprite-select", locale: "en-US", personaId: 999 }));
  });

  it("keeps the naming editor on the style the select submitted", async () => {
    const persona = makePersona({
      persona_id: 55,
      persona_nickname: "Aphel",
      naming_config: { prefixes: { masculine: "Sir" }, suffixes: {}, addressTerms: {} },
    } as Partial<TomoriState> & { persona_id: number });
    const harness = makeHarness({ personas: [persona], refreshedPersonas: [persona] });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "naming-style-select", locale: "en-US", personaId: 55 }),
        kind: "select",
        values: ["masculine"],
        harness,
      }),
    );

    const rendered = JSON.stringify(harness.edits.at(-1));
    expect(rendered).toContain(
      buildConfigRouteId({ action: "naming-open", locale: "en-US", personaId: 55, style: "masculine" }),
    );
    expect(rendered).toContain("Sir");
  });
});

describe("config trigger removal", () => {
  it("removes exactly the unchecked words and leaves the checked ones", async () => {
    const persona = makePersona({ persona_id: 55, trigger_words: ["one", "two", "three"] });
    const removeSpy = spyOn(personaRepository, "removeTrigger").mockResolvedValue(true);
    const harness = makeHarness({ personas: [persona], refreshedPersonas: [persona] });
    harness.dependencies.takeCheckboxValues = (_interactionId, fieldId) =>
      fieldId === buildTriggerRemoveCheckboxGroupId(0, "nonce1234567") ? ["0", "2"] : [];

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "trigger-remove-submit",
          locale: "en-US",
          personaId: 55,
          fp: computeTriggerRemoveFingerprint(55, persona.trigger_words),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        harness,
      }),
    );

    // Unchecked means remove, so index 1 ("two") goes and the remaining list is what is written.
    expect(removeSpy).toHaveBeenCalledWith(55, ["one", "three"]);
    expect(harness.telemetry).toEqual(["server-config.workspace.persona-trigger.remove"]);
    removeSpy.mockRestore();
  });

  it("writes nothing when the trigger list changed under the open modal", async () => {
    const persona = makePersona({ persona_id: 55, trigger_words: ["one", "two", "three"] });
    const removeSpy = spyOn(personaRepository, "removeTrigger").mockResolvedValue(true);
    const harness = makeHarness({ personas: [persona] });
    harness.dependencies.takeCheckboxValues = () => ["0"];

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "trigger-remove-submit",
          locale: "en-US",
          personaId: 55,
          // Fingerprint of the list as it was before a concurrent add.
          fp: computeTriggerRemoveFingerprint(55, ["one", "two"]),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        harness,
      }),
    );

    expect(removeSpy).not.toHaveBeenCalled();
    expect(harness.telemetry).toEqual([]);
    removeSpy.mockRestore();
  });

  it("treats missing checkbox data as stale without writing", async () => {
    const persona = makePersona({ persona_id: 55, trigger_words: ["one", "two"] });
    const removeSpy = spyOn(personaRepository, "removeTrigger");
    const harness = makeHarness({ personas: [persona] });
    harness.dependencies.takeCheckboxValues = () => undefined;

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "trigger-remove-submit",
          locale: "en-US",
          personaId: 55,
          fp: computeTriggerRemoveFingerprint(55, persona.trigger_words),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        harness,
      }),
    );

    expect(removeSpy).not.toHaveBeenCalled();
    expect(harness.telemetry).toEqual([]);
    removeSpy.mockRestore();
  });

  it("removes a group when its checkbox data is an explicit empty array", async () => {
    const triggerWords = Array.from({ length: 11 }, (_, index) => `word-${index}`);
    const persona = makePersona({ persona_id: 55, trigger_words: triggerWords });
    const removeSpy = spyOn(personaRepository, "removeTrigger").mockResolvedValue(true);
    const harness = makeHarness({ personas: [persona], refreshedPersonas: [persona] });
    harness.dependencies.takeCheckboxValues = (_interactionId, fieldId) => {
      if (fieldId === buildTriggerRemoveCheckboxGroupId(0, "nonce1234567")) return [];
      if (fieldId === buildTriggerRemoveCheckboxGroupId(1, "nonce1234567")) return ["10"];
      return undefined;
    };

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "trigger-remove-submit",
          locale: "en-US",
          personaId: 55,
          fp: computeTriggerRemoveFingerprint(55, triggerWords),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        harness,
      }),
    );

    expect(removeSpy).toHaveBeenCalledWith(55, ["word-10"]);
    expect(harness.telemetry).toEqual(["server-config.workspace.persona-trigger.remove"]);
    removeSpy.mockRestore();
  });

  it("binds the fingerprint to the persona as well as the list", () => {
    expect(computeTriggerRemoveFingerprint(55, ["one", "two"])).not.toBe(
      computeTriggerRemoveFingerprint(56, ["one", "two"]),
    );
    expect(computeTriggerRemoveFingerprint(55, ["one", "two"])).not.toBe(
      computeTriggerRemoveFingerprint(55, ["two", "one"]),
    );
  });
});

describe("config Persona Memories routes", () => {
  it("allows a member to read but not edit STM or remove conditioning", async () => {
    const summarySpy = spyOn(shortTermMemoryRepository, "updateSummary");
    const conditioningSpy = spyOn(conditioningMemoryRepository, "deleteGroupsForPersona");
    const harness = makeHarness({ isManager: false });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "stm-edit-submit",
          locale: "en-US",
          personaId: 55,
          nonce: "nonce1234567",
        }),
        kind: "modal",
        isManager: false,
        harness,
        fields: { [buildConfigModalFieldId("stm_cat_summary", "nonce1234567")]: "new summary" },
      }),
    );
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "conditioning-submit",
          locale: "en-US",
          personaId: 55,
          fp: computeConditioningRemoveFingerprint(55, [CONDITIONING_GROUP]),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        isManager: false,
        harness,
      }),
    );

    expect(summarySpy).not.toHaveBeenCalled();
    expect(conditioningSpy).not.toHaveBeenCalled();
    summarySpy.mockRestore();
    conditioningSpy.mockRestore();
  });

  it("allows a DM owner to edit summary STM and acknowledges before the repository write", async () => {
    let acknowledged = false;
    const harness = makeHarness({ inGuild: false });
    const interaction = makeInteraction({
      customId: buildConfigRouteId({
        action: "stm-edit-submit",
        locale: "en-US",
        personaId: 55,
        nonce: "nonce1234567",
      }),
      kind: "modal",
      inGuild: false,
      harness,
      fields: { [buildConfigModalFieldId("stm_cat_summary", "nonce1234567")]: "DM summary" },
    });
    const summarySpy = spyOn(shortTermMemoryRepository, "updateSummary").mockImplementation(async () => {
      acknowledged = interaction.deferred;
    });

    await dispatch(harness, interaction);

    expect(summarySpy).toHaveBeenCalledWith(
      "user-1",
      "channel-1",
      "DM summary",
      "DM",
      undefined,
      "lounge",
      55,
      0,
      undefined,
    );
    expect(acknowledged).toBe(true);
    summarySpy.mockRestore();
  });

  it("writes category STM values and clears an empty summary through the matching repository methods", async () => {
    let categoryAcknowledged = false;
    const categoryHarness = makeHarness({ personaMemoryView: makeMemoryView({ stmCategories: STM_CATEGORY_ROWS }) });
    const categoryInteraction = makeInteraction({
      customId: buildConfigRouteId({
        action: "stm-edit-submit",
        locale: "en-US",
        personaId: 55,
        nonce: "nonce1234567",
      }),
      kind: "modal",
      harness: categoryHarness,
      fields: {
        [buildConfigModalFieldId("stm_cat_summary", "nonce1234567")]: "category summary",
        [buildConfigModalFieldId("stm_cat_people", "nonce1234567")]: "",
      },
    });
    const categoriesSpy = spyOn(shortTermMemoryRepository, "updateCategories").mockImplementation(async (...args) => {
      categoryAcknowledged = categoryInteraction.deferred;
      expect(args[2]).toEqual({ summary: "category summary" });
    });

    await dispatch(categoryHarness, categoryInteraction);

    expect(categoriesSpy).toHaveBeenCalled();
    expect(categoryAcknowledged).toBe(true);
    categoriesSpy.mockRestore();

    let clearAcknowledged = false;
    const summaryHarness = makeHarness();
    const summaryInteraction = makeInteraction({
      customId: buildConfigRouteId({
        action: "stm-edit-submit",
        locale: "en-US",
        personaId: 55,
        nonce: "nonce1234567",
      }),
      kind: "modal",
      harness: summaryHarness,
      fields: { [buildConfigModalFieldId("stm_cat_summary", "nonce1234567")]: "" },
    });
    const clearSpy = spyOn(shortTermMemoryRepository, "clearSummary").mockImplementation(async () => {
      clearAcknowledged = summaryInteraction.deferred;
    });
    const updateSpy = spyOn(shortTermMemoryRepository, "updateSummary");

    await dispatch(summaryHarness, summaryInteraction);

    expect(clearSpy).toHaveBeenCalledWith("user-1", "channel-1", 55, "guild-1");
    expect(updateSpy).not.toHaveBeenCalled();
    expect(clearAcknowledged).toBe(true);
    clearSpy.mockRestore();
    updateSpy.mockRestore();
  });

  it("treats missing conditioning checkbox evidence as stale and never deletes", async () => {
    const deleteSpy = spyOn(conditioningMemoryRepository, "deleteGroupsForPersona").mockResolvedValue(1);
    const harness = makeHarness({ isManager: true });
    harness.dependencies.takeCheckboxValues = () => undefined;

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "conditioning-submit",
          locale: "en-US",
          personaId: 55,
          fp: computeConditioningRemoveFingerprint(55, [CONDITIONING_GROUP]),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        harness,
      }),
    );

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.edits.at(-1))).toContain("Panel Out Of Date");
    deleteSpy.mockRestore();
  });

  it("rejects a conditioning continuation whose presented group list is stale", async () => {
    const deleteSpy = spyOn(conditioningMemoryRepository, "deleteGroupsForPersona").mockResolvedValue(1);
    const harness = makeHarness({ isManager: true });
    harness.dependencies.takeCheckboxValues = () => [];

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "conditioning-submit",
          locale: "en-US",
          personaId: 55,
          fp: computeConditioningRemoveFingerprint(55, [
            { ...CONDITIONING_GROUP, reasonNormalized: "a different reason" },
          ]),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        harness,
      }),
    );

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.edits.at(-1))).toContain("Panel Out Of Date");
    deleteSpy.mockRestore();
  });

  it("uses the raw CheckboxGroup component and preserves the conditioning removal identity triple", async () => {
    const harness = makeHarness({ isManager: true });
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "conditioning-open", locale: "en-US", personaId: 55 }),
        harness,
      }),
    );

    const modal = JSON.stringify(harness.modals.at(-1));
    expect(modal).toContain('"type":22');
    expect(modal).toContain('"custom_id":"conditioning_0_nonce1234567"');
  });

  it("routes a real memory button through the registry to the canonical panel seam", async () => {
    let selectedLineage: number | undefined;
    const main = makePersona({ persona_id: 55, persona_lineage_id: 101 });
    const alter = makePersona({ persona_id: 56, is_alter: true, persona_lineage_id: 202 });
    const harness = makeHarness({ personas: [main, alter] });
    harness.dependencies.openServerMemoryPanel = async (_interaction, _locale, lineageId) => {
      selectedLineage = lineageId;
      return { components: [], flags: 32768 };
    };

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "server-memory-open", locale: "en-US", personaId: 56 }),
        harness,
      }),
    );

    expect(selectedLineage).toBe(202);
    expect(harness.followUps).toHaveLength(1);
    expect(harness.edits).toHaveLength(0);
  });

  it("marks memory follow-ups as ephemeral Components V2 payloads", () => {
    const payload = asEphemeralComponentsV2FollowUp({ components: [] });

    expect(payload.flags).toBe(MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);
  });

  it("does not retarget a deleted STM persona to the current main persona", async () => {
    const updateSpy = spyOn(shortTermMemoryRepository, "updateSummary");
    const harness = makeHarness({ personas: [MAIN] });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "stm-edit-submit",
          locale: "en-US",
          personaId: 999,
          nonce: "nonce1234567",
        }),
        kind: "modal",
        harness,
        fields: { [buildConfigModalFieldId("stm_cat_summary", "nonce1234567")]: "must not write" },
      }),
    );

    expect(updateSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.edits.at(-1))).toContain(
      buildConfigRouteId({ action: "stm-edit-open", locale: "en-US", personaId: 55 }),
    );
    updateSpy.mockRestore();
  });

  it("deletes conditioning by lineage and identity after an explicit checkbox clear", async () => {
    let acknowledged = false;
    const persona = makePersona({ persona_id: 55, persona_lineage_id: 707 });
    const harness = makeHarness({ isManager: true, personas: [persona] });
    const interaction = makeInteraction({
      customId: buildConfigRouteId({
        action: "conditioning-submit",
        locale: "en-US",
        personaId: 55,
        fp: computeConditioningRemoveFingerprint(55, [CONDITIONING_GROUP]),
        nonce: "nonce1234567",
      }),
      kind: "modal",
      harness,
    });
    harness.dependencies.takeCheckboxValues = (_interactionId, fieldId) =>
      fieldId === buildConditioningCheckboxGroupId(0, "nonce1234567") ? [] : undefined;
    const deleteSpy = spyOn(conditioningMemoryRepository, "deleteGroupsForPersona").mockImplementation(
      async (serverId, lineageId, groups) => {
        acknowledged = interaction.deferred;
        expect(serverId).toBe(9);
        expect(lineageId).toBe(707);
        expect(groups).toEqual([
          {
            conditioningType: CONDITIONING_GROUP.conditioningType,
            actionKey: CONDITIONING_GROUP.actionKey,
            reasonNormalized: CONDITIONING_GROUP.reasonNormalized,
          },
        ]);
        return 1;
      },
    );

    await dispatch(harness, interaction);

    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(acknowledged).toBe(true);
    deleteSpy.mockRestore();
  });

  it("repaints an all-selected conditioning submit as a no-change receipt without deleting", async () => {
    const persona = makePersona({ persona_id: 55, persona_lineage_id: 707 });
    const harness = makeHarness({ isManager: true, personas: [persona] });
    harness.dependencies.takeCheckboxValues = (_interactionId, fieldId) =>
      fieldId === buildConditioningCheckboxGroupId(0, "nonce1234567") ? ["0"] : undefined;
    const deleteSpy = spyOn(conditioningMemoryRepository, "deleteGroupsForPersona").mockResolvedValue(1);

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "conditioning-submit",
          locale: "en-US",
          personaId: 55,
          fp: computeConditioningRemoveFingerprint(55, [CONDITIONING_GROUP]),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        harness,
      }),
    );

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(harness.edits).not.toHaveLength(0);
    const receipt = JSON.stringify(harness.edits.at(-1));
    expect(receipt).toContain(localizer("en-US", "commands.config.panel.conditioning_no_changes_heading"));
    expect(receipt).toContain(localizer("en-US", "commands.config.panel.conditioning_no_changes_detail"));
    deleteSpy.mockRestore();
  });

  it("prewarms the selected STM scope before reading its entry", async () => {
    let prewarmed = false;
    const prewarmSpy = spyOn(shortTermMemoryCache, "preWarmStmEntry").mockImplementation(async () => {
      await Promise.resolve();
      prewarmed = true;
    });
    const readSpy = spyOn(shortTermMemoryCache, "getShortTermMemoryForServerChannel").mockImplementation(() => {
      expect(prewarmed).toBe(true);
      return undefined;
    });
    const serverCountSpy = spyOn(serverMemoryRepository, "memoryCountsByLineage").mockResolvedValue(new Map([[0, 3]]));
    const personalCountSpy = spyOn(personalMemoryRepository, "memoryCountsByLineage").mockResolvedValue(new Map());
    const categoriesSpy = spyOn(shortTermMemoryRepository, "getStmCategories").mockResolvedValue([
      STM_SUMMARY_CATEGORY,
    ]);
    const conditioningSpy = spyOn(conditioningMemoryRepository, "loadGroupsForPersona").mockResolvedValue([]);
    const harness = makeHarness();

    await loadConfigPersonaMemoryView(
      makeInteraction({ customId: "unused", harness }),
      {
        serverDiscId: "guild-1",
        guildId: "guild-1",
        internalServerId: 9,
        userId: 1,
        actor: { workspaceKind: "guild", isManager: true },
        personas: [MAIN],
        readStatus: "fresh",
      },
      MAIN,
    );

    expect(prewarmSpy).toHaveBeenCalledWith("server", "guild-1", "channel-1", 55);
    expect(readSpy).toHaveBeenCalledWith("guild-1", "channel-1", 55);
    prewarmSpy.mockRestore();
    readSpy.mockRestore();
    serverCountSpy.mockRestore();
    personalCountSpy.mockRestore();
    categoriesSpy.mockRestore();
    conditioningSpy.mockRestore();
  });

  it("uses the user-scoped STM cache key in a DM", async () => {
    let prewarmed = false;
    const prewarmSpy = spyOn(shortTermMemoryCache, "preWarmStmEntry").mockImplementation(async () => {
      await Promise.resolve();
      prewarmed = true;
    });
    const readSpy = spyOn(shortTermMemoryCache, "getShortTermMemoryForUserChannel").mockImplementation(() => {
      expect(prewarmed).toBe(true);
      return undefined;
    });
    const serverCountSpy = spyOn(serverMemoryRepository, "memoryCountsByLineage").mockResolvedValue(new Map());
    const personalCountSpy = spyOn(personalMemoryRepository, "memoryCountsByLineage").mockResolvedValue(new Map());
    const categoriesSpy = spyOn(shortTermMemoryRepository, "getStmCategories").mockResolvedValue([
      STM_SUMMARY_CATEGORY,
    ]);
    const harness = makeHarness({ inGuild: false });

    await loadConfigPersonaMemoryView(
      makeInteraction({ customId: "unused", inGuild: false, harness }),
      {
        serverDiscId: "user-1",
        guildId: null,
        internalServerId: 9,
        userId: 1,
        actor: { workspaceKind: "dm", isManager: true },
        personas: [MAIN],
        readStatus: "fresh",
      },
      MAIN,
    );

    expect(prewarmSpy).toHaveBeenCalledWith("user", "user-1", "channel-1", 55);
    expect(readSpy).toHaveBeenCalledWith("user-1", "channel-1", 55);
    prewarmSpy.mockRestore();
    readSpy.mockRestore();
    serverCountSpy.mockRestore();
    personalCountSpy.mockRestore();
    categoriesSpy.mockRestore();
  });

  it("keeps conditioning manage as an all persona aggregate view", async () => {
    const main = makePersona({ persona_id: 55, persona_lineage_id: 101 });
    const alter = makePersona({ persona_id: 56, persona_lineage_id: 202, is_alter: true });
    const mainGroup = { ...CONDITIONING_GROUP, reasonNormalized: "main reason" };
    const alterGroup = { ...CONDITIONING_GROUP, reasonNormalized: "alter reason" };
    const loadPersonasSpy = spyOn(personaRepository, "loadAllForServer").mockResolvedValue([main, alter]);
    const loadGroupsSpy = spyOn(conditioningMemoryRepository, "loadGroupsForPersona").mockImplementation(
      async (_serverId, lineageId) => (lineageId === 101 ? [mainGroup] : [alterGroup]),
    );
    let deliveredModal: unknown;
    const modalSpy = spyOn(modalModule, "showRoutedRawModal").mockImplementation(async (_target, modal) => {
      deliveredModal = modal;
      return undefined as never;
    });
    let deferredWithFlags: unknown;
    const interaction = {
      guildId: "guild-1",
      memberPermissions: { has: () => true },
      user: { id: "user-1" },
      deferReply: async (opts: unknown) => {
        deferredWithFlags = opts;
      },
    } as unknown as Parameters<typeof executeConditioningManage>[1];

    await executeConditioningManage(
      CLIENT,
      interaction,
      {} as Parameters<typeof executeConditioningManage>[2],
      "en-US",
    );

    expect(loadPersonasSpy).toHaveBeenCalledWith("guild-1");
    expect(loadGroupsSpy).toHaveBeenCalledTimes(2);
    expect(loadGroupsSpy).toHaveBeenNthCalledWith(1, 9, 101);
    expect(loadGroupsSpy).toHaveBeenNthCalledWith(2, 9, 202);
    expect(deferredWithFlags).toBeUndefined();
    expect(modalSpy).toHaveBeenCalledTimes(1);
    const payloadText = JSON.stringify(deliveredModal);
    expect(payloadText).toContain("Persona 55");
    expect(payloadText).toContain("Persona 56");
    expect(payloadText).toContain("❤️");
    modalSpy.mockRestore();
    loadGroupsSpy.mockRestore();
    loadPersonasSpy.mockRestore();
  });

  it("denies conditioning manage to a non manager before reading or deleting anything", async () => {
    const loadPersonasSpy = spyOn(personaRepository, "loadAllForServer");
    const loadGroupsSpy = spyOn(conditioningMemoryRepository, "loadGroupsForPersona");
    const deleteSpy = spyOn(conditioningMemoryRepository, "deleteGroupsForPersona");
    const deliverSpy = spyOn(panelController, "deliverGuardedPanel");
    const modalSpy = spyOn(modalModule, "showRoutedRawModal");
    let deniedTitleKey: string | undefined;
    const replySpy = spyOn(embedModule, "replyInfoEmbed").mockImplementation(async (_interaction, _locale, options) => {
      deniedTitleKey = options.titleKey;
    });
    const interaction = {
      guildId: "guild-1",
      memberPermissions: { has: () => false },
      user: { id: "user-1" },
    } as unknown as Parameters<typeof executeConditioningManage>[1];

    await executeConditioningManage(
      CLIENT,
      interaction,
      {} as Parameters<typeof executeConditioningManage>[2],
      "en-US",
    );

    expect(deniedTitleKey).toBe("general.errors.permission_denied_title");
    expect(loadPersonasSpy).not.toHaveBeenCalled();
    expect(loadGroupsSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(deliverSpy).not.toHaveBeenCalled();
    expect(modalSpy).not.toHaveBeenCalled();
    replySpy.mockRestore();
    modalSpy.mockRestore();
    deliverSpy.mockRestore();
    deleteSpy.mockRestore();
    loadGroupsSpy.mockRestore();
    loadPersonasSpy.mockRestore();
  });
});

describe("config persona collections", () => {
  it("adds attributes from a .txt upload through the routed operation", async () => {
    let acknowledgedDuringWrite = false;
    let interaction: ReturnType<typeof makeInteraction>;
    const persona = makeTeachingPersona({ persona_id: 55, attribute_list: ["Existing"] });
    const refreshed = makeTeachingPersona({ persona_id: 55, attribute_list: ["Existing", "Likes tea", "Reads"] });
    const addSpy = spyOn(personaRepository, "addAttributes").mockImplementation(async () => {
      acknowledgedDuringWrite = interaction.deferred;
      return true;
    });
    const limitSpy = spyOn(personaRepository, "checkAttributeLimit").mockResolvedValue({
      isValid: true,
      currentCount: 1,
      maxAllowed: 100,
    });
    const blacklistSpy = spyOn(userRepository, "isBlacklisted").mockResolvedValue(false);
    const harness = makeHarness({ personas: [persona], refreshedPersonas: [refreshed], isManager: false });
    harness.dependencies.takeFileUpload = () => makeTxtAttachment("Likes tea\nReads");
    interaction = makeInteraction({
      customId: buildConfigRouteId({
        action: "attribute-add-submit",
        locale: "en-US",
        personaId: 55,
        nonce: "nonce1234567",
      }),
      kind: "modal",
      isManager: false,
      harness,
    });

    await dispatch(harness, interaction);

    expect(acknowledgedDuringWrite).toBe(true);
    expect(limitSpy).toHaveBeenCalledWith(55);
    expect(addSpy).toHaveBeenCalledWith(55, ["Likes tea", "Reads"], false);
    expect(harness.telemetry).toEqual(["server-config.workspace.persona-attribute.add"]);
    expect(JSON.stringify(harness.edits.at(-1))).toContain("Reads");
    expect(blacklistSpy).toHaveBeenCalledWith("guild-1", "user-1");
    addSpy.mockRestore();
    limitSpy.mockRestore();
    blacklistSpy.mockRestore();
  });

  it("edits attributes with checkbox evidence while preserving absent evidence", async () => {
    let acknowledgedDuringWrite = false;
    let interaction: ReturnType<typeof makeInteraction>;
    const persona = makeTeachingPersona({
      persona_id: 55,
      attribute_list: ["Old"],
      persona_attributes: [{ persona_id: 55, attribute_order: 1, attribute_text: "Old", is_public: true }],
    });
    const editSpy = spyOn(personaRepository, "editAttributeAt").mockImplementation(async () => {
      acknowledgedDuringWrite = interaction.deferred;
      return true;
    });
    const blacklistSpy = spyOn(userRepository, "isBlacklisted").mockResolvedValue(false);

    const firstHarness = makeHarness({ personas: [persona], isManager: false });
    firstHarness.dependencies.takeCheckboxValues = () => undefined;
    interaction = makeInteraction({
      customId: buildConfigRouteId({
        action: "attribute-edit-submit",
        locale: "en-US",
        personaId: 55,
        index: 0,
        fp: computeAttributeFingerprint(55, 0, "Old", true),
        nonce: "nonce1234567",
      }),
      kind: "modal",
      isManager: false,
      harness: firstHarness,
      fields: { [buildConfigModalFieldId("attribute_part1", "nonce1234567")]: "New" },
    });
    await dispatch(firstHarness, interaction);
    expect(acknowledgedDuringWrite).toBe(true);
    expect(editSpy).toHaveBeenNthCalledWith(1, 55, 1, "New", undefined);

    const secondHarness = makeHarness({ personas: [persona], isManager: false });
    secondHarness.dependencies.takeCheckboxValues = () => [];
    interaction = makeInteraction({
      customId: buildConfigRouteId({
        action: "attribute-edit-submit",
        locale: "en-US",
        personaId: 55,
        index: 0,
        fp: computeAttributeFingerprint(55, 0, "Old", true),
        nonce: "nonce1234567",
      }),
      kind: "modal",
      isManager: false,
      harness: secondHarness,
      fields: { [buildConfigModalFieldId("attribute_part1", "nonce1234567")]: "Private" },
    });
    await dispatch(secondHarness, interaction);
    expect(editSpy).toHaveBeenNthCalledWith(2, 55, 1, "Private", false);
    expect(blacklistSpy).toHaveBeenCalledTimes(2);
    editSpy.mockRestore();
    blacklistSpy.mockRestore();
  });

  it("returns a stale receipt without writing when an attribute fingerprint changed", async () => {
    const editSpy = spyOn(personaRepository, "editAttributeAt");
    const removeSpy = spyOn(personaRepository, "removeAttributeAt");
    const blacklistSpy = spyOn(userRepository, "isBlacklisted").mockResolvedValue(false);
    const persona = makeTeachingPersona({ persona_id: 55, attribute_list: ["Current"] });
    const harness = makeHarness({ personas: [persona], isManager: false });
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "attribute-edit-submit",
          locale: "en-US",
          personaId: 55,
          index: 0,
          fp: computeAttributeFingerprint(55, 0, "Old", false),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        isManager: false,
        harness,
        fields: { [buildConfigModalFieldId("attribute_part1", "nonce1234567")]: "New" },
      }),
    );
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "attribute-remove",
          locale: "en-US",
          personaId: 55,
          index: 0,
          fp: computeAttributeFingerprint(55, 0, "Old", false),
        }),
        isManager: false,
        harness,
      }),
    );

    expect(editSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(harness.edits.filter((entry) => JSON.stringify(entry).includes("Panel Out Of Date"))).toHaveLength(2);
    expect(blacklistSpy).toHaveBeenCalledTimes(1);
    editSpy.mockRestore();
    removeSpy.mockRestore();
    blacklistSpy.mockRestore();
  });

  it("removes an attribute even when the actor is blacklisted and clamps the page", async () => {
    let acknowledgedDuringWrite = false;
    let interaction: ReturnType<typeof makeInteraction>;
    const persona = makeTeachingPersona({
      persona_id: 55,
      attribute_list: ["Only"],
    });
    const refreshed = makeTeachingPersona({ persona_id: 55, attribute_list: [] });
    const removeSpy = spyOn(personaRepository, "removeAttributeAt").mockImplementation(async () => {
      acknowledgedDuringWrite = interaction.deferred;
      return true;
    });
    const blacklistSpy = spyOn(userRepository, "isBlacklisted").mockResolvedValue(true);
    const harness = makeHarness({ personas: [persona], refreshedPersonas: [refreshed], isManager: false });
    interaction = makeInteraction({
      customId: buildConfigRouteId({
        action: "attribute-remove",
        locale: "en-US",
        personaId: 55,
        index: 0,
        fp: computeAttributeFingerprint(55, 0, "Only", false),
      }),
      isManager: false,
      harness,
    });
    await dispatch(harness, interaction);

    expect(acknowledgedDuringWrite).toBe(true);
    expect(removeSpy).toHaveBeenCalledWith(55, 1);
    expect(blacklistSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.edits.at(-1))).not.toContain(":attr-edit-open:");
    removeSpy.mockRestore();
    blacklistSpy.mockRestore();
  });

  it("adds sample dialogues from a .txt upload and routes the last pair into view", async () => {
    let acknowledgedDuringWrite = false;
    let interaction: ReturnType<typeof makeInteraction>;
    const persona = makeTeachingPersona({ persona_id: 55 });
    const refreshed = makeTeachingPersona({
      persona_id: 55,
      sample_dialogues_in: ["Hello"],
      sample_dialogues_out: ["Hi"],
    });
    const addSpy = spyOn(personaRepository, "addSampleDialoguePair").mockImplementation(async () => {
      acknowledgedDuringWrite = interaction.deferred;
      return true;
    });
    const limitSpy = spyOn(personaRepository, "checkSampleDialogueLimit").mockResolvedValue({
      isValid: true,
      currentCount: 0,
      maxAllowed: 100,
    });
    const blacklistSpy = spyOn(userRepository, "isBlacklisted").mockResolvedValue(false);
    const harness = makeHarness({ personas: [persona], refreshedPersonas: [refreshed], isManager: false });
    harness.dependencies.takeFileUpload = () => makeTxtAttachment("{user}: Hello\n{bot}: Hi");
    interaction = makeInteraction({
      customId: buildConfigRouteId({
        action: "dialogue-add-submit",
        locale: "en-US",
        personaId: 55,
        nonce: "nonce1234567",
      }),
      kind: "modal",
      isManager: false,
      harness,
    });
    await dispatch(harness, interaction);

    expect(acknowledgedDuringWrite).toBe(true);
    expect(addSpy).toHaveBeenCalledWith(55, ["Hello"], ["Hi"]);
    expect(harness.telemetry).toEqual(["server-config.workspace.persona-dialogue.add"]);
    expect(blacklistSpy).toHaveBeenCalledWith("guild-1", "user-1");
    addSpy.mockRestore();
    limitSpy.mockRestore();
    blacklistSpy.mockRestore();
  });

  it("edits and removes sample dialogues through fingerprinted routes", async () => {
    let acknowledgedDuringWrite = false;
    let interaction: ReturnType<typeof makeInteraction>;
    const persona = makeTeachingPersona({
      persona_id: 55,
      sample_dialogues_in: ["Old"],
      sample_dialogues_out: ["Reply"],
    });
    const editSpy = spyOn(personaRepository, "editSampleDialoguePairAt").mockImplementation(async () => {
      acknowledgedDuringWrite = interaction.deferred;
      return true;
    });
    const removeSpy = spyOn(personaRepository, "removeSampleDialoguePairAt").mockImplementation(async () => {
      acknowledgedDuringWrite = interaction.deferred;
      return true;
    });
    const blacklistSpy = spyOn(userRepository, "isBlacklisted").mockResolvedValue(false);
    const editHarness = makeHarness({ personas: [persona], isManager: false });
    interaction = makeInteraction({
      customId: buildConfigRouteId({
        action: "dialogue-edit-submit",
        locale: "en-US",
        personaId: 55,
        index: 0,
        fp: computeDialogueFingerprint(55, 0, "Old", "Reply"),
        nonce: "nonce1234567",
      }),
      kind: "modal",
      isManager: false,
      harness: editHarness,
      fields: {
        [buildConfigModalFieldId("user_input_part1", "nonce1234567")]: "New",
        [buildConfigModalFieldId("bot_input_part1", "nonce1234567")]: "Response",
      },
    });
    await dispatch(editHarness, interaction);

    expect(acknowledgedDuringWrite).toBe(true);
    expect(editSpy).toHaveBeenCalledWith(55, 1, "New", "Response");
    expect(blacklistSpy).toHaveBeenCalledTimes(1);

    const removeHarness = makeHarness({ personas: [persona], isManager: false });
    interaction = makeInteraction({
      customId: buildConfigRouteId({
        action: "dialogue-remove",
        locale: "en-US",
        personaId: 55,
        index: 0,
        fp: computeDialogueFingerprint(55, 0, "Old", "Reply"),
      }),
      isManager: false,
      harness: removeHarness,
    });
    await dispatch(removeHarness, interaction);

    expect(removeSpy).toHaveBeenCalledWith(55, 1);
    expect(blacklistSpy).toHaveBeenCalledTimes(1);
    expect(editHarness.telemetry).toEqual(["server-config.workspace.persona-dialogue.edit"]);
    expect(removeHarness.telemetry).toEqual(["server-config.workspace.persona-dialogue.remove"]);
    editSpy.mockRestore();
    removeSpy.mockRestore();
    blacklistSpy.mockRestore();
  });

  it("repairs mismatched dialogue pairs before an edit", async () => {
    let interaction: ReturnType<typeof makeInteraction>;
    let acknowledgedDuringRepair = false;
    let acknowledgedDuringEdit = false;
    const persona = makeTeachingPersona({
      persona_id: 55,
      sample_dialogues_in: ["First", "Orphaned input"],
      sample_dialogues_out: ["Reply"],
    });
    const repairedIn = ["First"];
    const repairedOut = ["Reply"];
    const repairSpy = spyOn(personaRepository, "repairSampleDialogues").mockImplementation(async () => {
      acknowledgedDuringRepair = interaction.deferred;
      return { repairedIn, repairedOut };
    });
    const editSpy = spyOn(personaRepository, "editSampleDialoguePairAt").mockImplementation(async () => {
      acknowledgedDuringEdit = interaction.deferred;
      return true;
    });
    const blacklistSpy = spyOn(userRepository, "isBlacklisted").mockResolvedValue(false);
    const harness = makeHarness({ personas: [persona], isManager: false });
    interaction = makeInteraction({
      customId: buildConfigRouteId({
        action: "dialogue-edit-submit",
        locale: "en-US",
        personaId: 55,
        index: 0,
        fp: computeDialogueFingerprint(55, 0, "First", "Reply"),
        nonce: "nonce1234567",
      }),
      kind: "modal",
      isManager: false,
      harness,
      fields: {
        [buildConfigModalFieldId("user_input_part1", "nonce1234567")]: "Updated",
        [buildConfigModalFieldId("bot_input_part1", "nonce1234567")]: "Response",
      },
    });

    await dispatch(harness, interaction);

    expect(acknowledgedDuringRepair).toBe(true);
    expect(acknowledgedDuringEdit).toBe(true);
    expect(repairSpy).toHaveBeenCalledWith(55, 1);
    expect(editSpy).toHaveBeenCalledWith(55, 1, "Updated", "Response");
    expect(persona.sample_dialogues_in).toEqual(repairedIn);
    expect(persona.sample_dialogues_out).toEqual(repairedOut);
    expect(blacklistSpy).toHaveBeenCalledTimes(1);
    repairSpy.mockRestore();
    editSpy.mockRestore();
    blacklistSpy.mockRestore();
  });

  it("rejects stale dialogue edits and removals without writing", async () => {
    const editSpy = spyOn(personaRepository, "editSampleDialoguePairAt");
    const removeSpy = spyOn(personaRepository, "removeSampleDialoguePairAt");
    const blacklistSpy = spyOn(userRepository, "isBlacklisted").mockResolvedValue(false);
    const persona = makeTeachingPersona({
      persona_id: 55,
      sample_dialogues_in: ["Current"],
      sample_dialogues_out: ["Reply"],
    });
    const harness = makeHarness({ personas: [persona], isManager: false });
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "dialogue-edit-submit",
          locale: "en-US",
          personaId: 55,
          index: 0,
          fp: computeDialogueFingerprint(55, 0, "Old", "Reply"),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        isManager: false,
        harness,
        fields: {
          [buildConfigModalFieldId("user_input_part1", "nonce1234567")]: "New",
          [buildConfigModalFieldId("bot_input_part1", "nonce1234567")]: "Response",
        },
      }),
    );
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "dialogue-remove",
          locale: "en-US",
          personaId: 55,
          index: 0,
          fp: computeDialogueFingerprint(55, 0, "Old", "Reply"),
        }),
        isManager: false,
        harness,
      }),
    );

    expect(editSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(harness.edits.filter((entry) => JSON.stringify(entry).includes("Panel Out Of Date"))).toHaveLength(2);
    expect(blacklistSpy).toHaveBeenCalledTimes(1);
    editSpy.mockRestore();
    removeSpy.mockRestore();
    blacklistSpy.mockRestore();
  });

  it("applies dialogue blacklist and teaching gates to the real routes", async () => {
    let interaction: ReturnType<typeof makeInteraction>;
    let acknowledgedDuringRemove = false;
    const addSpy = spyOn(personaRepository, "addSampleDialoguePair").mockResolvedValue(true);
    const editSpy = spyOn(personaRepository, "editSampleDialoguePairAt");
    const removeSpy = spyOn(personaRepository, "removeSampleDialoguePairAt").mockImplementation(async () => {
      acknowledgedDuringRemove = interaction.deferred;
      return true;
    });
    const limitSpy = spyOn(personaRepository, "checkSampleDialogueLimit").mockResolvedValue({
      isValid: true,
      currentCount: 0,
      maxAllowed: 100,
    });
    const blacklistSpy = spyOn(userRepository, "isBlacklisted").mockResolvedValue(true);
    const memberPersona = makeTeachingPersona({
      persona_id: 55,
      sample_dialogues_in: ["Old"],
      sample_dialogues_out: ["Reply"],
    });
    const blacklistedHarness = makeHarness({ personas: [memberPersona], isManager: false });

    await dispatch(
      blacklistedHarness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "dialogue-add-submit",
          locale: "en-US",
          personaId: 55,
          nonce: "nonce1234567",
        }),
        kind: "modal",
        isManager: false,
        harness: blacklistedHarness,
        fields: {
          [buildConfigModalFieldId("user_input", "nonce1234567")]: "New",
          [buildConfigModalFieldId("bot_input", "nonce1234567")]: "Response",
        },
      }),
    );
    await dispatch(
      blacklistedHarness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "dialogue-edit-submit",
          locale: "en-US",
          personaId: 55,
          index: 0,
          fp: computeDialogueFingerprint(55, 0, "Old", "Reply"),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        isManager: false,
        harness: blacklistedHarness,
        fields: {
          [buildConfigModalFieldId("user_input_part1", "nonce1234567")]: "New",
          [buildConfigModalFieldId("bot_input_part1", "nonce1234567")]: "Response",
        },
      }),
    );
    expect(addSpy).not.toHaveBeenCalled();
    expect(editSpy).not.toHaveBeenCalled();

    interaction = makeInteraction({
      customId: buildConfigRouteId({
        action: "dialogue-remove",
        locale: "en-US",
        personaId: 55,
        index: 0,
        fp: computeDialogueFingerprint(55, 0, "Old", "Reply"),
      }),
      isManager: false,
      harness: blacklistedHarness,
    });
    await dispatch(blacklistedHarness, interaction);
    expect(acknowledgedDuringRemove).toBe(true);
    expect(removeSpy).toHaveBeenCalledWith(55, 1);

    const disabledPersona = makeTeachingPersona(
      {
        persona_id: 55,
        sample_dialogues_in: ["Old"],
        sample_dialogues_out: ["Reply"],
      },
      { dialogue: false },
    );
    const disabledHarness = makeHarness({ personas: [disabledPersona], isManager: false });
    await dispatch(
      disabledHarness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "dialogue-add-submit",
          locale: "en-US",
          personaId: 55,
          nonce: "nonce1234567",
        }),
        kind: "modal",
        isManager: false,
        harness: disabledHarness,
        fields: {
          [buildConfigModalFieldId("user_input", "nonce1234567")]: "New",
          [buildConfigModalFieldId("bot_input", "nonce1234567")]: "Response",
        },
      }),
    );
    await dispatch(
      disabledHarness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "dialogue-edit-submit",
          locale: "en-US",
          personaId: 55,
          index: 0,
          fp: computeDialogueFingerprint(55, 0, "Old", "Reply"),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        isManager: false,
        harness: disabledHarness,
        fields: {
          [buildConfigModalFieldId("user_input_part1", "nonce1234567")]: "New",
          [buildConfigModalFieldId("bot_input_part1", "nonce1234567")]: "Response",
        },
      }),
    );
    await dispatch(
      disabledHarness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "dialogue-remove",
          locale: "en-US",
          personaId: 55,
          index: 0,
          fp: computeDialogueFingerprint(55, 0, "Old", "Reply"),
        }),
        isManager: false,
        harness: disabledHarness,
      }),
    );
    expect(addSpy).not.toHaveBeenCalled();
    expect(editSpy).not.toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalledTimes(1);

    const managerPersona = makeTeachingPersona({ persona_id: 55 }, { dialogue: false });
    const managerHarness = makeHarness({ personas: [managerPersona], isManager: true });
    await dispatch(
      managerHarness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "dialogue-add-submit",
          locale: "en-US",
          personaId: 55,
          nonce: "nonce1234567",
        }),
        kind: "modal",
        isManager: true,
        harness: managerHarness,
        fields: {
          [buildConfigModalFieldId("user_input", "nonce1234567")]: "New",
          [buildConfigModalFieldId("bot_input", "nonce1234567")]: "Response",
        },
      }),
    );
    expect(addSpy).toHaveBeenCalledWith(55, ["New"], ["Response"]);
    expect(limitSpy).toHaveBeenCalledWith(55);
    expect(blacklistSpy).toHaveBeenCalledTimes(2);
    removeSpy.mockRestore();
    editSpy.mockRestore();
    addSpy.mockRestore();
    limitSpy.mockRestore();
    blacklistSpy.mockRestore();
  });

  it("opens add modals from the first selector option without deferring the select", async () => {
    const harness = makeHarness();
    const attributeInteraction = makeInteraction({
      customId: buildConfigRouteId({ action: "attribute-select", locale: "en-US", personaId: 55 }),
      kind: "select",
      values: ["add"],
      harness,
    });
    await dispatch(harness, attributeInteraction);
    expect(attributeInteraction.deferred).toBe(false);
    expect(harness.modals[0]).toMatchObject({
      custom_id: buildConfigRouteId({
        action: "attribute-add-submit",
        locale: "en-US",
        personaId: 55,
        nonce: "nonce1234567",
      }),
    });
    const attributeModal = harness.modals[0] as { components: Array<{ type: number; component?: { type: number } }> };
    expect(attributeModal.components.map((component) => component.component?.type)).toContain(19);
    expect(attributeModal.components.map((component) => component.component?.type)).toContain(22);

    const dialogueHarness = makeHarness();
    const dialogueInteraction = makeInteraction({
      customId: buildConfigRouteId({ action: "dialogue-select", locale: "en-US", personaId: 55 }),
      kind: "select",
      values: ["add"],
      harness: dialogueHarness,
    });
    await dispatch(dialogueHarness, dialogueInteraction);
    expect(dialogueHarness.modals[0]).toMatchObject({
      custom_id: buildConfigRouteId({
        action: "dialogue-add-submit",
        locale: "en-US",
        personaId: 55,
        nonce: "nonce1234567",
      }),
    });
    const dialogueModal = dialogueHarness.modals[0] as {
      components: Array<{ type: number; component?: { type: number } }>;
    };
    expect(dialogueModal.components.map((component) => component.component?.type)).toContain(19);

    const spriteHarness = makeHarness();
    const spriteInteraction = makeInteraction({
      customId: buildConfigRouteId({ action: "sprite-select", locale: "en-US", personaId: 55 }),
      kind: "select",
      values: ["add"],
      harness: spriteHarness,
    });
    await dispatch(spriteHarness, spriteInteraction);
    expect(spriteInteraction.deferred).toBe(false);
    expect(spriteHarness.modals[0]).toMatchObject({
      custom_id: buildConfigRouteId({
        action: "sprite-add-submit",
        locale: "en-US",
        personaId: 55,
        nonce: "nonce1234567",
      }),
    });
  });

  it("gates teaching-disabled members, lets managers bypass, and keeps DM blacklist reads absent", async () => {
    const addSpy = spyOn(personaRepository, "addAttributes").mockResolvedValue(true);
    const limitSpy = spyOn(personaRepository, "checkAttributeLimit").mockResolvedValue({
      isValid: true,
      currentCount: 0,
      maxAllowed: 100,
    });
    const blacklistSpy = spyOn(userRepository, "isBlacklisted").mockResolvedValue(true);
    const memberPersona = makeTeachingPersona({ persona_id: 55, attribute_list: ["Old"] });

    const blacklistedAddHarness = makeHarness({ personas: [memberPersona], isManager: false });
    await dispatch(
      blacklistedAddHarness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "attribute-add-submit",
          locale: "en-US",
          personaId: 55,
          nonce: "nonce1234567",
        }),
        kind: "modal",
        isManager: false,
        harness: blacklistedAddHarness,
        fields: { [buildConfigModalFieldId("attribute", "nonce1234567")]: "New" },
      }),
    );
    expect(addSpy).not.toHaveBeenCalled();

    const blacklistedEditSpy = spyOn(personaRepository, "editAttributeAt");
    await dispatch(
      blacklistedAddHarness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "attribute-edit-submit",
          locale: "en-US",
          personaId: 55,
          index: 0,
          fp: computeAttributeFingerprint(55, 0, "Old", false),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        isManager: false,
        harness: blacklistedAddHarness,
        fields: { [buildConfigModalFieldId("attribute_part1", "nonce1234567")]: "New" },
      }),
    );
    expect(blacklistedEditSpy).not.toHaveBeenCalled();

    const disabledPersona = makeTeachingPersona({ persona_id: 55, attribute_list: ["Old"] }, { attribute: false });
    const disabledHarness = makeHarness({ personas: [disabledPersona], isManager: false });
    await dispatch(
      disabledHarness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "attribute-add-submit",
          locale: "en-US",
          personaId: 55,
          nonce: "nonce1234567",
        }),
        kind: "modal",
        isManager: false,
        harness: disabledHarness,
        fields: { [buildConfigModalFieldId("attribute", "nonce1234567")]: "New" },
      }),
    );
    expect(addSpy).not.toHaveBeenCalled();

    const disabledEditSpy = spyOn(personaRepository, "editAttributeAt");
    await dispatch(
      disabledHarness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "attribute-edit-submit",
          locale: "en-US",
          personaId: 55,
          index: 0,
          fp: computeAttributeFingerprint(55, 0, "Old", false),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        isManager: false,
        harness: disabledHarness,
        fields: { [buildConfigModalFieldId("attribute_part1", "nonce1234567")]: "New" },
      }),
    );
    expect(disabledEditSpy).not.toHaveBeenCalled();

    const disabledRemoveSpy = spyOn(personaRepository, "removeAttributeAt");
    await dispatch(
      disabledHarness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "attribute-remove",
          locale: "en-US",
          personaId: 55,
          index: 0,
          fp: computeAttributeFingerprint(55, 0, "Old", false),
        }),
        isManager: false,
        harness: disabledHarness,
      }),
    );
    expect(disabledRemoveSpy).not.toHaveBeenCalled();

    const managerPersona = makeTeachingPersona({ persona_id: 55 }, { attribute: false });
    const managerHarness = makeHarness({ personas: [managerPersona], isManager: true });
    const managerInteraction = makeInteraction({
      customId: buildConfigRouteId({
        action: "attribute-add-submit",
        locale: "en-US",
        personaId: 55,
        nonce: "nonce1234567",
      }),
      kind: "modal",
      isManager: true,
      harness: managerHarness,
      fields: { [buildConfigModalFieldId("attribute", "nonce1234567")]: "New" },
    });
    await dispatch(managerHarness, managerInteraction);
    expect(addSpy).toHaveBeenCalledWith(55, ["New"], false);
    expect(blacklistSpy).toHaveBeenCalledTimes(2);

    const dmPersona = makeTeachingPersona({ persona_id: 55, attribute_list: ["Old"] }, { attribute: false });
    const dmHarness = makeHarness({ personas: [dmPersona], inGuild: false });
    const dmRemoveSpy = spyOn(personaRepository, "removeAttributeAt");
    await dispatch(
      dmHarness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "attribute-remove",
          locale: "en-US",
          personaId: 55,
          index: 0,
          fp: computeAttributeFingerprint(55, 0, "Old", false),
        }),
        inGuild: false,
        harness: dmHarness,
      }),
    );
    expect(dmRemoveSpy).not.toHaveBeenCalled();
    expect(blacklistSpy).toHaveBeenCalledTimes(2);
    disabledRemoveSpy.mockRestore();
    disabledEditSpy.mockRestore();
    blacklistedEditSpy.mockRestore();
    dmRemoveSpy.mockRestore();
    addSpy.mockRestore();
    limitSpy.mockRestore();
    blacklistSpy.mockRestore();
  });
});

describe("config promotion", () => {
  it("transfers the live CDN avatar to the former main before cleaning up either source", async () => {
    const mainPersona = makePersona({
      persona_id: 55,
      persona_nickname: "Aphel",
      webhook_avatar_url: "data/avatars/personas/55/previous-main.png",
    });
    const alterPersona = makePersona({
      persona_id: 56,
      persona_nickname: "Wren",
      is_alter: true,
      webhook_avatar_url: "data/avatars/personas/56/selected-alter.png",
    });
    const liveCdnReference = "https://cdn.discordapp.com/avatars/guild-main.png";
    const formerMainReference = "data/avatars/personas/55/former-main.png";
    const promotedAlterReference = "data/avatars/personas/56/promoted-alter.png";
    const events: string[] = [];

    const loadSpy = spyOn(avatarStorage, "loadStoredPersonaAvatarBuffer").mockImplementation(async (reference) => {
      events.push(`load:${reference}`);
      return Buffer.from(`bytes:${reference}`);
    });
    const pngSpy = spyOn(imageProcessor, "convertToPNG").mockImplementation(async (buffer: Buffer) => {
      events.push(`png:${buffer.toString()}`);
      return buffer;
    });
    const swapSpy = spyOn(personaRepository, "swapPersona").mockImplementation(async (mainId, alterId) => {
      events.push(`swap:${mainId}:${alterId}`);
      return true;
    });
    const setAvatarSpy = spyOn(personaRepository, "setAvatar").mockImplementation(async (personaId, reference) => {
      events.push(`persist:${personaId}:${reference}`);
      return true;
    });
    const uploadSpy = spyOn(avatarStorage, "uploadPersonaAvatarToStorage").mockImplementation(
      async ({ personaId, label }) => {
        const reference = personaId === mainPersona.persona_id ? formerMainReference : promotedAlterReference;
        events.push(`upload:${personaId}:${label}:${reference}`);
        return reference;
      },
    );
    const deleteSpy = spyOn(avatarStorage, "deletePersonaAvatarFromStorage").mockImplementation(async (reference) => {
      events.push(`delete:${reference}`);
      return true;
    });
    const invalidateSpy = spyOn(tomoriStateCacheStore, "invalidateTomoriStateCache").mockImplementation(
      (serverDiscId) => {
        events.push(`invalidate:${serverDiscId}`);
      },
    );

    try {
      const result = await configPersonaOperations.promoteToMain({
        alterPersona,
        mainPersona,
        serverDiscId: "guild-1",
        guildId: "guild-1",
        guildIdentity: {
          currentAvatarReference: async () => {
            events.push("current-avatar");
            return liveCdnReference;
          },
          setNickname: async (nickname) => {
            events.push(`nickname:${nickname}`);
            return true;
          },
          setAvatar: async () => {
            events.push("guild-avatar");
            return { ok: true, rateLimited: false };
          },
        },
      });

      expect(result).toMatchObject({ status: "success", nicknameSynced: true, avatarSynced: true });
      expect(loadSpy).toHaveBeenCalledWith(liveCdnReference);
      expect(loadSpy).toHaveBeenCalledWith(alterPersona.webhook_avatar_url);
      expect(uploadSpy).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ personaId: mainPersona.persona_id, label: "former main swap" }),
      );
      expect(uploadSpy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ personaId: alterPersona.persona_id, label: "selected alter swap" }),
      );
      expect(setAvatarSpy).toHaveBeenCalledWith(mainPersona.persona_id, formerMainReference);
      expect(setAvatarSpy).toHaveBeenCalledWith(alterPersona.persona_id, promotedAlterReference);
      expect(deleteSpy).toHaveBeenCalledWith(mainPersona.webhook_avatar_url);
      expect(deleteSpy).toHaveBeenCalledWith(alterPersona.webhook_avatar_url);
      expect(deleteSpy).not.toHaveBeenCalledWith(formerMainReference);
      expect(deleteSpy).not.toHaveBeenCalledWith(promotedAlterReference);

      const loadIndex = events.indexOf(`load:${liveCdnReference}`);
      const swapIndex = events.indexOf(`swap:${mainPersona.persona_id}:${alterPersona.persona_id}`);
      const formerUploadIndex = events.indexOf(
        `upload:${mainPersona.persona_id}:former main swap:${formerMainReference}`,
      );
      const formerPersistIndex = events.indexOf(`persist:${mainPersona.persona_id}:${formerMainReference}`);
      const formerDeleteIndex = events.indexOf(`delete:${mainPersona.webhook_avatar_url}`);
      const finalInvalidateIndex = events.lastIndexOf("invalidate:guild-1");
      expect(loadIndex).toBeGreaterThanOrEqual(0);
      expect(loadIndex).toBeLessThan(swapIndex);
      expect(formerUploadIndex).toBeGreaterThanOrEqual(0);
      expect(swapIndex).toBeLessThan(formerUploadIndex);
      expect(formerUploadIndex).toBeLessThan(formerPersistIndex);
      expect(formerPersistIndex).toBeGreaterThanOrEqual(0);
      expect(formerPersistIndex).toBeLessThan(formerDeleteIndex);
      expect(invalidateSpy).toHaveBeenCalledTimes(1);
      expect(finalInvalidateIndex).toBe(events.length - 1);
    } finally {
      loadSpy.mockRestore();
      pngSpy.mockRestore();
      swapSpy.mockRestore();
      setAvatarSpy.mockRestore();
      uploadSpy.mockRestore();
      deleteSpy.mockRestore();
      invalidateSpy.mockRestore();
    }
  });

  it("uses the local former-main fallback and keeps avatar transfer after a nickname-sync failure", async () => {
    const mainPersona = makePersona({
      persona_id: 55,
      persona_nickname: "Aphel",
      webhook_avatar_url: "data/avatars/personas/55/local-main.png",
    });
    const alterPersona = makePersona({
      persona_id: 56,
      persona_nickname: "Wren",
      is_alter: true,
      webhook_avatar_url: "data/avatars/personas/56/local-alter.png",
    });
    const formerMainReference = "data/avatars/personas/55/local-former-main.png";
    const promotedAlterReference = "data/avatars/personas/56/local-promoted-alter.png";
    const events: string[] = [];

    const loadSpy = spyOn(avatarStorage, "loadStoredPersonaAvatarBuffer").mockImplementation(async (reference) => {
      events.push(`load:${reference}`);
      return Buffer.from(`bytes:${reference}`);
    });
    const pngSpy = spyOn(imageProcessor, "convertToPNG").mockImplementation(async (buffer: Buffer) => buffer);
    const swapSpy = spyOn(personaRepository, "swapPersona").mockImplementation(async (mainId, alterId) => {
      events.push(`swap:${mainId}:${alterId}`);
      return true;
    });
    const setAvatarSpy = spyOn(personaRepository, "setAvatar").mockImplementation(async (personaId, reference) => {
      events.push(`persist:${personaId}:${reference}`);
      return true;
    });
    const uploadSpy = spyOn(avatarStorage, "uploadPersonaAvatarToStorage").mockImplementation(
      async ({ personaId, label }) => {
        const reference = personaId === mainPersona.persona_id ? formerMainReference : promotedAlterReference;
        events.push(`upload:${personaId}:${label}:${reference}`);
        return reference;
      },
    );
    const deleteSpy = spyOn(avatarStorage, "deletePersonaAvatarFromStorage").mockImplementation(async (reference) => {
      events.push(`delete:${reference}`);
      return true;
    });
    const invalidateSpy = spyOn(tomoriStateCacheStore, "invalidateTomoriStateCache").mockImplementation(
      (serverDiscId) => {
        events.push(`invalidate:${serverDiscId}`);
      },
    );

    try {
      const result = await configPersonaOperations.promoteToMain({
        alterPersona,
        mainPersona,
        serverDiscId: "guild-1",
        guildId: "guild-1",
        guildIdentity: {
          currentAvatarReference: async () => {
            events.push("current-avatar");
            return null;
          },
          setNickname: async () => {
            events.push("nickname-failed");
            return false;
          },
          setAvatar: async () => ({ ok: true, rateLimited: false }),
        },
      });

      expect(result).toMatchObject({ status: "success", nicknameSynced: false, avatarSynced: true });
      expect(swapSpy).toHaveBeenCalledWith(mainPersona.persona_id, alterPersona.persona_id);
      expect(loadSpy).toHaveBeenCalledWith(mainPersona.webhook_avatar_url);
      expect(uploadSpy).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ personaId: mainPersona.persona_id, label: "former main swap" }),
      );
      expect(setAvatarSpy).toHaveBeenCalledWith(mainPersona.persona_id, formerMainReference);
      expect(setAvatarSpy).toHaveBeenCalledWith(alterPersona.persona_id, promotedAlterReference);
      expect(deleteSpy).toHaveBeenCalledWith(mainPersona.webhook_avatar_url);
      expect(deleteSpy).toHaveBeenCalledWith(alterPersona.webhook_avatar_url);
      expect(deleteSpy).not.toHaveBeenCalledWith(formerMainReference);
      expect(deleteSpy).not.toHaveBeenCalledWith(promotedAlterReference);

      const loadIndex = events.indexOf(`load:${mainPersona.webhook_avatar_url}`);
      const swapIndex = events.indexOf(`swap:${mainPersona.persona_id}:${alterPersona.persona_id}`);
      const formerUploadIndex = events.indexOf(
        `upload:${mainPersona.persona_id}:former main swap:${formerMainReference}`,
      );
      const formerPersistIndex = events.indexOf(`persist:${mainPersona.persona_id}:${formerMainReference}`);
      const formerDeleteIndex = events.indexOf(`delete:${mainPersona.webhook_avatar_url}`);
      const finalInvalidateIndex = events.lastIndexOf("invalidate:guild-1");
      expect(loadIndex).toBeLessThan(swapIndex);
      expect(formerUploadIndex).toBeGreaterThanOrEqual(0);
      expect(swapIndex).toBeLessThan(formerUploadIndex);
      expect(formerUploadIndex).toBeLessThan(formerPersistIndex);
      expect(formerPersistIndex).toBeGreaterThanOrEqual(0);
      expect(formerPersistIndex).toBeLessThan(formerDeleteIndex);
      expect(invalidateSpy).toHaveBeenCalledTimes(1);
      expect(finalInvalidateIndex).toBe(events.length - 1);
    } finally {
      loadSpy.mockRestore();
      pngSpy.mockRestore();
      swapSpy.mockRestore();
      setAvatarSpy.mockRestore();
      uploadSpy.mockRestore();
      deleteSpy.mockRestore();
      invalidateSpy.mockRestore();
    }
  });

  it("opens a confirmation before promoting rather than swapping on the first press", async () => {
    const swapSpy = spyOn(personaRepository, "swapPersona");
    const harness = makeHarness();

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "promote-view", locale: "en-US", personaId: 56 }),
        harness,
      }),
    );

    expect(swapSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.edits.at(-1))).toContain(
      buildConfigRouteId({ action: "promote-confirm", locale: "en-US", personaId: 56, nonce: "nonce1234567" }),
    );
    swapSpy.mockRestore();
  });

  it("refuses to promote a persona that is already the main one", async () => {
    let promoteCalls = 0;
    const harness = makeHarness({
      operations: {
        promoteToMain: async () => {
          promoteCalls += 1;
          return { status: "not-alter" };
        },
      },
    });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "promote-view", locale: "en-US", personaId: 55 }),
        harness,
      }),
    );

    expect(promoteCalls).toBe(0);
    expect(JSON.stringify(harness.edits.at(-1))).not.toContain("promote-confirm");
  });
});

describe("config Persona Advanced routes", () => {
  const attgFields = (values: Partial<Record<string, string>> = {}) =>
    Object.fromEntries(
      [
        CONFIG_NAI_ATTG_AUTHOR_FIELD,
        CONFIG_NAI_ATTG_TITLE_FIELD,
        CONFIG_NAI_ATTG_TAGS_FIELD,
        CONFIG_NAI_ATTG_GENRE_FIELD,
        CONFIG_NAI_ATTG_STARS_FIELD,
      ].map((field) => [buildConfigModalFieldId(field, "nonce1234567"), values[field] ?? ""]),
    );

  it("opens ATTG with five prefilled routed inputs and acknowledges through showModal", async () => {
    const persona = makePersona({
      persona_id: 55,
      nai_attg_author: "Old Author",
      nai_attg_title: "Old Title",
      nai_attg_tags: "old, tags",
      nai_attg_genre: "fantasy",
      nai_attg_stars: 4,
    });
    const harness = makeHarness({ personas: [persona] });
    const interaction = makeInteraction({
      customId: buildConfigRouteId({ action: "attg-open", locale: "en-US", personaId: 55 }),
      harness,
    });

    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    let stateAtShowModal: { deferred: boolean; replied: boolean; rawModalAcknowledged: boolean } | undefined;
    let stateAfterShowModal: { deferred: boolean; replied: boolean; rawModalAcknowledged: boolean } | undefined;
    harness.dependencies.showModal = async (modalInteraction, payload) => {
      stateAtShowModal = {
        deferred: modalInteraction.deferred,
        replied: modalInteraction.replied,
        rawModalAcknowledged: hasRawModalAcknowledgement(modalInteraction),
      };
      await modalModule.showRoutedRawModal(modalInteraction, payload);
      stateAfterShowModal = {
        deferred: modalInteraction.deferred,
        replied: modalInteraction.replied,
        rawModalAcknowledged: hasRawModalAcknowledgement(modalInteraction),
      };
      harness.modals.push(payload);
    };

    await dispatch(harness, interaction);

    expect(stateAtShowModal).toEqual({ deferred: false, replied: false, rawModalAcknowledged: false });
    expect(stateAfterShowModal).toEqual({ deferred: false, replied: false, rawModalAcknowledged: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
    const modal = harness.modals[0] as {
      custom_id: string;
      components: Array<{ component?: { type: number; custom_id: string; value?: string; max_length?: number } }>;
    };
    expect(modal.custom_id).toBe(
      buildConfigRouteId({ action: "attg-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" }),
    );
    expect(modal.components).toHaveLength(5);
    expect(modal.components.map((entry) => entry.component?.type)).toEqual([4, 4, 4, 4, 4]);
    expect(modal.components.map((entry) => entry.component?.custom_id)).toEqual(
      [
        CONFIG_NAI_ATTG_AUTHOR_FIELD,
        CONFIG_NAI_ATTG_TITLE_FIELD,
        CONFIG_NAI_ATTG_TAGS_FIELD,
        CONFIG_NAI_ATTG_GENRE_FIELD,
        CONFIG_NAI_ATTG_STARS_FIELD,
      ].map((field) => buildConfigModalFieldId(field, "nonce1234567")),
    );
    expect(modal.components.map((entry) => entry.component?.value)).toEqual([
      "Old Author",
      "Old Title",
      "old, tags",
      "fantasy",
      "4",
    ]);
    expect(modal.components.map((entry) => entry.component?.max_length)).toEqual([256, 256, 256, 256, 1]);
  });

  it("trims ATTG fields, clears blanks, and writes all five columns together", async () => {
    const setAttgSpy = spyOn(personaRepository, "setNaiAttg").mockResolvedValue(true);
    const harness = makeHarness({ personas: [makePersona({ persona_id: 55 })] });
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "attg-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" }),
        kind: "modal",
        fields: attgFields({
          [CONFIG_NAI_ATTG_AUTHOR_FIELD]: " Author ",
          [CONFIG_NAI_ATTG_TITLE_FIELD]: " ",
          [CONFIG_NAI_ATTG_TAGS_FIELD]: " tags ",
          [CONFIG_NAI_ATTG_GENRE_FIELD]: "Genre",
          [CONFIG_NAI_ATTG_STARS_FIELD]: " 5 ",
        }),
        harness,
      }),
    );
    expect(setAttgSpy).toHaveBeenCalledWith(55, {
      nai_attg_author: "Author",
      nai_attg_title: null,
      nai_attg_tags: "tags",
      nai_attg_genre: "Genre",
      nai_attg_stars: 5,
    });

    setAttgSpy.mockClear();
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "attg-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" }),
        kind: "modal",
        fields: attgFields({
          [CONFIG_NAI_ATTG_AUTHOR_FIELD]: "  ",
          [CONFIG_NAI_ATTG_TITLE_FIELD]: "\t",
          [CONFIG_NAI_ATTG_TAGS_FIELD]: "",
          [CONFIG_NAI_ATTG_GENRE_FIELD]: "  ",
          [CONFIG_NAI_ATTG_STARS_FIELD]: "",
        }),
        harness,
      }),
    );
    expect(setAttgSpy).toHaveBeenCalledWith(55, {
      nai_attg_author: null,
      nai_attg_title: null,
      nai_attg_tags: null,
      nai_attg_genre: null,
      nai_attg_stars: null,
    });
    setAttgSpy.mockRestore();
  });

  it("rejects every non-canonical Stars value before the repository call", async () => {
    const setAttgSpy = spyOn(personaRepository, "setNaiAttg").mockResolvedValue(true);
    for (const stars of ["0", "6", "01", "1.0", "abc"]) {
      const harness = makeHarness({ personas: [makePersona({ persona_id: 55 })] });
      await dispatch(
        harness,
        makeInteraction({
          customId: buildConfigRouteId({
            action: "attg-submit",
            locale: "en-US",
            personaId: 55,
            nonce: "nonce1234567",
          }),
          kind: "modal",
          fields: attgFields({ [CONFIG_NAI_ATTG_STARS_FIELD]: stars }),
          harness,
        }),
      );
    }
    expect(setAttgSpy).not.toHaveBeenCalled();
    setAttgSpy.mockRestore();
  });

  it("accepts only canonical Stars values and preserves a blank as null", async () => {
    const setAttgSpy = spyOn(personaRepository, "setNaiAttg").mockResolvedValue(true);
    const cases: Array<{ raw: string; expected: number | null | false }> = [
      { raw: "0", expected: false },
      { raw: "1", expected: 1 },
      { raw: "5", expected: 5 },
      { raw: "6", expected: false },
      { raw: "01", expected: false },
      { raw: "", expected: null },
      { raw: "abc", expected: false },
    ];

    for (const entry of cases) {
      setAttgSpy.mockClear();
      const harness = makeHarness({ personas: [makePersona({ persona_id: 55 })] });
      await dispatch(
        harness,
        makeInteraction({
          customId: buildConfigRouteId({
            action: "attg-submit",
            locale: "en-US",
            personaId: 55,
            nonce: "nonce1234567",
          }),
          kind: "modal",
          fields: attgFields({ [CONFIG_NAI_ATTG_STARS_FIELD]: entry.raw }),
          harness,
        }),
      );

      if (entry.expected === false) {
        expect(setAttgSpy).not.toHaveBeenCalled();
      } else {
        expect(setAttgSpy).toHaveBeenCalledWith(55, {
          nai_attg_author: null,
          nai_attg_title: null,
          nai_attg_tags: null,
          nai_attg_genre: null,
          nai_attg_stars: entry.expected,
        });
      }
    }
    setAttgSpy.mockRestore();
  });

  it("clears one ATTG column at a time while retaining the other values", async () => {
    const setAttgSpy = spyOn(personaRepository, "setNaiAttg").mockResolvedValue(true);
    const fields = [
      CONFIG_NAI_ATTG_AUTHOR_FIELD,
      CONFIG_NAI_ATTG_TITLE_FIELD,
      CONFIG_NAI_ATTG_TAGS_FIELD,
      CONFIG_NAI_ATTG_GENRE_FIELD,
      CONFIG_NAI_ATTG_STARS_FIELD,
    ];

    for (const blankField of fields) {
      setAttgSpy.mockClear();
      const values = Object.fromEntries(
        fields.map((field) => [
          field,
          field === blankField ? " " : field === CONFIG_NAI_ATTG_STARS_FIELD ? " 5 " : ` ${field} `,
        ]),
      );
      const harness = makeHarness({ personas: [makePersona({ persona_id: 55 })] });
      await dispatch(
        harness,
        makeInteraction({
          customId: buildConfigRouteId({
            action: "attg-submit",
            locale: "en-US",
            personaId: 55,
            nonce: "nonce1234567",
          }),
          kind: "modal",
          fields: attgFields(values),
          harness,
        }),
      );

      expect(setAttgSpy).toHaveBeenCalledWith(55, {
        nai_attg_author: blankField === CONFIG_NAI_ATTG_AUTHOR_FIELD ? null : CONFIG_NAI_ATTG_AUTHOR_FIELD,
        nai_attg_title: blankField === CONFIG_NAI_ATTG_TITLE_FIELD ? null : CONFIG_NAI_ATTG_TITLE_FIELD,
        nai_attg_tags: blankField === CONFIG_NAI_ATTG_TAGS_FIELD ? null : CONFIG_NAI_ATTG_TAGS_FIELD,
        nai_attg_genre: blankField === CONFIG_NAI_ATTG_GENRE_FIELD ? null : CONFIG_NAI_ATTG_GENRE_FIELD,
        nai_attg_stars: blankField === CONFIG_NAI_ATTG_STARS_FIELD ? null : 5,
      });
    }
    setAttgSpy.mockRestore();
  });

  it("keeps Clear All's receipt distinct from a saved ATTG receipt", async () => {
    const setAttgSpy = spyOn(personaRepository, "setNaiAttg").mockResolvedValue(true);
    const harness = makeHarness({ personas: [makePersona({ persona_id: 55 })] });
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "attg-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" }),
        kind: "modal",
        fields: attgFields({ [CONFIG_NAI_ATTG_AUTHOR_FIELD]: "Author" }),
        harness,
      }),
    );
    const savedReceipt = JSON.stringify(harness.edits.at(-1));

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "attg-clear-all", locale: "en-US", personaId: 55 }),
        harness,
      }),
    );
    const clearedReceipt = JSON.stringify(harness.edits.at(-1));

    expect(setAttgSpy).toHaveBeenNthCalledWith(1, 55, {
      nai_attg_author: "Author",
      nai_attg_title: null,
      nai_attg_tags: null,
      nai_attg_genre: null,
      nai_attg_stars: null,
    });
    expect(setAttgSpy).toHaveBeenNthCalledWith(2, 55, {
      nai_attg_author: null,
      nai_attg_title: null,
      nai_attg_tags: null,
      nai_attg_genre: null,
      nai_attg_stars: null,
    });
    expect(savedReceipt).toContain(localizer("en-US", "commands.config.panel.attg.success_title"));
    expect(clearedReceipt).toContain(localizer("en-US", "commands.config.panel.attg.cleared_title"));
    expect(clearedReceipt).not.toContain(localizer("en-US", "commands.config.panel.attg.success_title"));
    setAttgSpy.mockRestore();
  });

  it("does not write for malformed or stale ATTG custom IDs through the registry", async () => {
    const setAttgSpy = spyOn(personaRepository, "setNaiAttg").mockResolvedValue(true);
    for (const customId of ["config:v2:attg-submit:en-US:55:", "config:v0:attg-submit:en-US:55:nonce1234567"]) {
      const harness = makeHarness({ personas: [makePersona({ persona_id: 55 })] });
      await dispatch(
        harness,
        makeInteraction({
          customId,
          kind: "modal",
          fields: attgFields({ [CONFIG_NAI_ATTG_AUTHOR_FIELD]: "Author" }),
          harness,
        }),
      );
    }
    expect(setAttgSpy).not.toHaveBeenCalled();
    setAttgSpy.mockRestore();
  });

  it("clears ATTG from a button and invalidates after a false repository result", async () => {
    let interaction: ReturnType<typeof makeInteraction>;
    let acknowledged = false;
    const setAttgSpy = spyOn(personaRepository, "setNaiAttg").mockImplementation(async () => {
      acknowledged = interaction.deferred || interaction.replied;
      return false;
    });
    const invalidateSpy = spyOn(tomoriStateCacheStore, "invalidateTomoriStateCache").mockImplementation(
      () => undefined,
    );
    const harness = makeHarness({
      personas: [
        makePersona({
          persona_id: 55,
          nai_attg_author: "Author",
          nai_attg_title: "Title",
          nai_attg_tags: "Tags",
          nai_attg_genre: "Genre",
          nai_attg_stars: 3,
        }),
      ],
    });
    interaction = makeInteraction({
      customId: buildConfigRouteId({ action: "attg-clear-all", locale: "en-US", personaId: 55 }),
      harness,
    });
    await dispatch(harness, interaction);
    expect(setAttgSpy).toHaveBeenCalledWith(55, {
      nai_attg_author: null,
      nai_attg_title: null,
      nai_attg_tags: null,
      nai_attg_genre: null,
      nai_attg_stars: null,
    });
    expect(acknowledged).toBe(true);
    expect(invalidateSpy).toHaveBeenCalledWith("guild-1");
    expect(harness.modals).toHaveLength(0);
    setAttgSpy.mockRestore();
    invalidateSpy.mockRestore();
  });

  it("does not clear a saved character reference when an upload is missing", async () => {
    let writes = 0;
    const persona = makePersona({ persona_id: 55, nai_char_ref_url: "saved/reference.png" });
    const harness = makeHarness({
      personas: [persona],
      operations: {
        replaceCharacterReference: async () => {
          writes += 1;
          return { status: "success", cleared: true };
        },
      },
    });
    harness.dependencies.takeFileUpload = () => undefined;

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "character-reference-submit",
          locale: "en-US",
          personaId: 55,
          nonce: "nonce1234567",
        }),
        kind: "modal",
        harness,
      }),
    );

    expect(writes).toBe(0);
    expect(JSON.stringify(harness.edits.at(-1))).toContain("Please upload an image attachment");
  });

  it("round-trips a prompt longer than 4000 characters through four modal parts", async () => {
    const prompt = `${"a".repeat(4000)}${"b".repeat(4000)}${"c".repeat(4000)}${"d".repeat(25)}`;
    const persona = makePersona({ persona_id: 55, persona_prompt: null });
    let interaction: ReturnType<typeof makeInteraction>;
    let acknowledged = false;
    let persistedPrompt = "";
    const harness = makeHarness({
      personas: [persona],
      operations: {
        setPrompt: async (input) => {
          acknowledged = interaction.deferred || interaction.replied;
          persistedPrompt = input.prompt;
          persona.persona_prompt = input.prompt;
          return { status: "success" };
        },
      },
    });
    const fields = Object.fromEntries(
      CONFIG_PERSONA_PROMPT_PART_FIELDS.map((field, index) => [
        buildConfigModalFieldId(field, "nonce1234567"),
        prompt.slice(index * 4000, (index + 1) * 4000),
      ]),
    );
    interaction = makeInteraction({
      customId: buildConfigRouteId({ action: "prompt-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" }),
      kind: "modal",
      fields,
      harness,
    });

    await dispatch(harness, interaction);

    expect(acknowledged).toBe(true);
    expect(persistedPrompt).toBe(prompt);
  });

  it("rechecks prompt eligibility when the prompt vanishes before removal", async () => {
    const persona = makePersona({ persona_id: 55, persona_prompt: "A prompt" });
    let removeCalled = false;
    const harness = makeHarness({
      personas: [persona],
      operations: {
        removePrompt: async () => {
          removeCalled = true;
          return { status: "no-prompt" };
        },
      },
    });
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "prompt-remove", locale: "en-US", personaId: 55 }),
        harness,
      }),
    );

    expect(removeCalled).toBe(true);
    expect(JSON.stringify(harness.edits.at(-1))).toContain("No Persona Prompt");
  });

  it("maps Humanizer Inherit to null and acknowledges before the write", async () => {
    let interaction: ReturnType<typeof makeInteraction>;
    let acknowledged = false;
    let selectedValue: number | null | undefined;
    const harness = makeHarness({
      operations: {
        setHumanizerOverride: async (input) => {
          acknowledged = interaction.deferred || interaction.replied;
          selectedValue = input.value;
          return { status: "success" };
        },
      },
    });
    interaction = makeInteraction({
      customId: buildConfigRouteId({ action: "humanizer-select", locale: "en-US", personaId: 55 }),
      kind: "select",
      values: ["inherit"],
      harness,
    });

    await dispatch(harness, interaction);

    expect(acknowledged).toBe(true);
    expect(selectedValue).toBeNull();
    expect(JSON.stringify(harness.edits.at(-1))).toContain("Persona Overrides");
  });

  it("opens Humanizer as a modal with the persona override selected", async () => {
    const persona = makePersona({ persona_id: 55, humanizer_degree_override: 2 });
    const harness = makeHarness({
      personas: [persona],
    });
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "humanizer-open", locale: "en-US", personaId: 55 }),
        harness,
      }),
    );

    const modal = JSON.stringify(harness.modals.at(-1));
    expect(modal).toContain("config:v2:humanizer-submit");
    expect(modal).toContain('"value":"2"');
    expect(modal).toContain('"default":true');
  });

  it("opens the selected provider's model choices in a modal", async () => {
    const harness = makeHarness();
    harness.dependencies.loadSavedTextProviders = async () => [{ provider: "openrouter" }];
    harness.dependencies.loadPersonaTextModels = async () => [
      {
        llm_id: 17,
        llm_provider: "openrouter",
        llm_codename: "example-model",
        llm_description: "Example model",
      } as TomoriState["llm"],
    ];

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "text-override-provider-select",
          locale: "en-US",
          personaId: 55,
        }),
        kind: "select",
        values: ["openrouter"],
        harness,
      }),
    );

    const modal = JSON.stringify(harness.modals.at(-1));
    expect(modal).toContain("config:v2:text-model-submit");
    expect(modal).toContain('"value":"example-model"');
  });

  it("submits Humanizer and text override modal selections through their routed writes", async () => {
    let humanizerValue: number | null | undefined;
    const humanizerHarness = makeHarness({
      operations: {
        setHumanizerOverride: async (input) => {
          humanizerValue = input.value;
          return { status: "success" };
        },
      },
    });
    humanizerHarness.dependencies.takeSelectValue = () => "inherit";
    await dispatch(
      humanizerHarness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "humanizer-submit",
          locale: "en-US",
          personaId: 55,
          nonce: "nonce1234567",
        }),
        kind: "modal",
        harness: humanizerHarness,
      }),
    );
    expect(humanizerValue).toBeNull();

    let selectedModelId: number | null | undefined;
    const textHarness = makeHarness({
      operations: {
        setTextModelOverride: async (input) => {
          selectedModelId = input.llmId;
          return { status: "success" };
        },
      },
    });
    textHarness.dependencies.takeSelectValue = () => "example-model";
    textHarness.dependencies.loadSavedTextProviders = async () => [{ provider: "openrouter" }];
    textHarness.dependencies.loadPersonaTextModels = async () => [
      {
        llm_id: 17,
        llm_provider: "openrouter",
        llm_codename: "example-model",
      } as TomoriState["llm"],
    ];
    await dispatch(
      textHarness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "text-override-model-submit",
          locale: "en-US",
          personaId: 55,
          provider: "openrouter",
          nonce: "nonce1234567",
        }),
        kind: "modal",
        harness: textHarness,
      }),
    );
    expect(selectedModelId).toBe(17);
  });

  it("does not write for the moved OpenRouter model and clears through the canonical override operation", async () => {
    const movedModel = {
      llm_id: 17,
      llm_provider: "openrouter",
      llm_codename: "other-model",
    } as TomoriState["llm"];
    let modelWrites = 0;
    const noWriteHarness = makeHarness({
      operations: {
        setTextModelOverride: async () => {
          modelWrites += 1;
          return { status: "success" };
        },
      },
    });
    noWriteHarness.dependencies.loadPersonaTextModels = async () => [movedModel];
    const interaction = makeInteraction({
      customId: buildConfigRouteId({
        action: "text-override-model-select",
        locale: "en-US",
        personaId: 55,
        provider: "openrouter",
      }),
      kind: "select",
      values: ["other-model"],
      harness: noWriteHarness,
    });

    await dispatch(noWriteHarness, interaction);

    expect(modelWrites).toBe(0);
    expect(interaction.deferred).toBe(true);

    let clearInput: unknown;
    let clearAcknowledged = false;
    const persona = makePersona({ persona_id: 55, persona_llm: movedModel });
    const clearHarness = makeHarness({
      personas: [persona],
      operations: {
        setTextModelOverride: async (input) => {
          clearAcknowledged = clearInteraction.deferred || clearInteraction.replied;
          clearInput = input;
          return { status: "success" };
        },
      },
    });
    let clearInteraction: ReturnType<typeof makeInteraction>;
    clearInteraction = makeInteraction({
      customId: buildConfigRouteId({ action: "text-override-clear", locale: "en-US", personaId: 55 }),
      harness: clearHarness,
    });

    await dispatch(clearHarness, clearInteraction);

    expect(clearAcknowledged).toBe(true);
    expect(clearInput).toEqual({ scope: "persona", personaId: 55, llmId: null, serverDiscId: "guild-1" });
  });

  it("denies every manager-only Advanced write before any repository write", async () => {
    const imageTagsSpy = spyOn(personaRepository, "setPhysicalAppearanceTags").mockResolvedValue(true);
    const promptSpy = spyOn(personaRepository, "setPrompt").mockResolvedValue(true);
    const removePromptSpy = spyOn(personaRepository, "removePrompt").mockResolvedValue(true);
    const contextSpy = spyOn(personaRepository, "setContextNote").mockResolvedValue(true);
    const attgSpy = spyOn(personaRepository, "setNaiAttg").mockResolvedValue(true);
    const humanizerSpy = spyOn(personaRepository, "setHumanizerOverride").mockResolvedValue(true);
    const charRefSpy = spyOn(personaRepository, "setNaiCharRef").mockResolvedValue(true);
    const modelSpy = spyOn(llmOverrideRepo, "setPersonaLlmOverride").mockResolvedValue(true);

    const cases: Array<{
      route: ConfigPanelRoute;
      kind?: "modal" | "select" | "button";
      fields?: Record<string, string>;
    }> = [
      {
        route: { action: "image-tags-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
        kind: "modal",
        fields: { [buildConfigModalFieldId("image_tags", "nonce1234567")]: "tag" },
      },
      {
        route: { action: "attg-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
        kind: "modal",
        fields: attgFields({ [CONFIG_NAI_ATTG_AUTHOR_FIELD]: "author" }),
      },
      { route: { action: "attg-clear-all", locale: "en-US", personaId: 55 } },
      {
        route: { action: "character-reference-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
        kind: "modal",
      },
      {
        route: { action: "character-reference-clear-confirm", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
      },
      {
        route: { action: "prompt-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
        kind: "modal",
        fields: Object.fromEntries(
          CONFIG_PERSONA_PROMPT_PART_FIELDS.map((field) => [buildConfigModalFieldId(field, "nonce1234567"), "prompt"]),
        ),
      },
      {
        route: { action: "prompt-remove", locale: "en-US", personaId: 55 },
      },
      {
        route: { action: "context-note-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
        kind: "modal",
        fields: {
          [buildConfigModalFieldId("context_note_text", "nonce1234567")]: "note",
          [buildConfigModalFieldId("context_note_depth", "nonce1234567")]: "1",
        },
      },
      { route: { action: "humanizer-select", locale: "en-US", personaId: 55 }, kind: "select", fields: undefined },
      { route: { action: "text-override-clear", locale: "en-US", personaId: 55 } },
    ];

    for (const entry of cases) {
      const harness = makeHarness({
        isManager: false,
        personas: [makePersona({ persona_id: 55, persona_prompt: "prompt" })],
      });
      await dispatch(
        harness,
        makeInteraction({
          customId: buildConfigRouteId(entry.route),
          kind: entry.kind,
          fields: entry.fields,
          isManager: false,
          harness,
        }),
      );
    }

    expect(imageTagsSpy).not.toHaveBeenCalled();
    expect(promptSpy).not.toHaveBeenCalled();
    expect(removePromptSpy).not.toHaveBeenCalled();
    expect(contextSpy).not.toHaveBeenCalled();
    expect(attgSpy).not.toHaveBeenCalled();
    expect(humanizerSpy).not.toHaveBeenCalled();
    expect(charRefSpy).not.toHaveBeenCalled();
    expect(modelSpy).not.toHaveBeenCalled();

    imageTagsSpy.mockRestore();
    promptSpy.mockRestore();
    removePromptSpy.mockRestore();
    contextSpy.mockRestore();
    attgSpy.mockRestore();
    humanizerSpy.mockRestore();
    charRefSpy.mockRestore();
    modelSpy.mockRestore();
  });

  it("denies the guild-only Advanced writes in a DM while the DM-capable ones still land", async () => {
    const imageTagsSpy = spyOn(personaRepository, "setPhysicalAppearanceTags").mockResolvedValue(true);
    const attgSpy = spyOn(personaRepository, "setNaiAttg").mockResolvedValue(true);
    const charRefSpy = spyOn(personaRepository, "setNaiCharRef").mockResolvedValue(true);
    const promptSpy = spyOn(personaRepository, "setPrompt").mockResolvedValue(true);

    const guildOnlyCases: Array<{
      route: ConfigPanelRoute;
      kind?: "modal" | "button";
      fields?: Record<string, string>;
    }> = [
      {
        route: { action: "image-tags-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
        kind: "modal",
        fields: { [buildConfigModalFieldId("image_tags", "nonce1234567")]: "tag" },
      },
      {
        route: { action: "attg-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
        kind: "modal",
        fields: attgFields({ [CONFIG_NAI_ATTG_AUTHOR_FIELD]: "author" }),
      },
      {
        route: { action: "character-reference-clear-confirm", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
      },
    ];

    for (const entry of guildOnlyCases) {
      const harness = makeHarness({ inGuild: false, personas: [makePersona({ persona_id: 55 })] });
      await dispatch(
        harness,
        makeInteraction({
          customId: buildConfigRouteId(entry.route),
          kind: entry.kind,
          fields: entry.fields,
          inGuild: false,
          harness,
        }),
      );
    }

    expect(imageTagsSpy).not.toHaveBeenCalled();
    expect(attgSpy).not.toHaveBeenCalled();
    expect(charRefSpy).not.toHaveBeenCalled();

    // Asserting a write that must still land keeps the denials above meaningful: a route layer that
    // refused every Advanced action in a DM would satisfy the two negatives on its own.
    const allowedHarness = makeHarness({ inGuild: false, personas: [makePersona({ persona_id: 55 })] });
    await dispatch(
      allowedHarness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "prompt-submit",
          locale: "en-US",
          personaId: 55,
          nonce: "nonce1234567",
        }),
        kind: "modal",
        fields: Object.fromEntries(
          CONFIG_PERSONA_PROMPT_PART_FIELDS.map((field) => [buildConfigModalFieldId(field, "nonce1234567"), "prompt"]),
        ),
        inGuild: false,
        harness: allowedHarness,
      }),
    );

    expect(promptSpy).toHaveBeenCalledTimes(1);

    imageTagsSpy.mockRestore();
    attgSpy.mockRestore();
    charRefSpy.mockRestore();
    promptSpy.mockRestore();
  });
});

describe("config Persona Sprites routes", () => {
  const SPRITE_NONCE = "nonce1234567";
  const spriteFields = (name: string, instructions = "") => ({
    [buildConfigModalFieldId(CONFIG_SPRITE_NAME_FIELD, SPRITE_NONCE)]: name,
    [buildConfigModalFieldId(CONFIG_SPRITE_INSTRUCTIONS_FIELD, SPRITE_NONCE)]: instructions,
  });

  it("keeps a member's Export working while every sprite mutation reaches no repository", async () => {
    const upsertSpy = spyOn(personaSpriteRepository, "upsertSprite").mockResolvedValue(null);
    const updateSpy = spyOn(personaSpriteRepository, "updateSpriteMetadata").mockResolvedValue(null);
    const deleteSpy = spyOn(personaSpriteRepository, "deleteSpritesByKeys").mockResolvedValue([]);

    const deniedRoutes: Array<{ route: ConfigPanelRoute; kind?: "modal" }> = [
      {
        route: { action: "sprite-add-submit", locale: "en-US", personaId: 55, nonce: SPRITE_NONCE },
        kind: "modal",
      },
      {
        route: {
          action: "sprite-edit-submit",
          locale: "en-US",
          personaId: 55,
          index: 0,
          fp: computeSpriteFingerprint(55, 0, "happy"),
          nonce: SPRITE_NONCE,
        },
        kind: "modal",
      },
      {
        route: {
          action: "sprite-remove-confirm",
          locale: "en-US",
          personaId: 55,
          index: 0,
          fp: computeSpriteFingerprint(55, 0, "happy"),
          nonce: SPRITE_NONCE,
        },
      },
      {
        route: { action: "sprite-import-submit", locale: "en-US", personaId: 55, nonce: SPRITE_NONCE },
        kind: "modal",
      },
    ];

    for (const entry of deniedRoutes) {
      const harness = makeHarness({ isManager: false, personas: [MAIN] });
      await dispatch(
        harness,
        makeInteraction({
          customId: buildConfigRouteId(entry.route),
          kind: entry.kind,
          fields: spriteFields("Happy"),
          isManager: false,
          harness,
        }),
      );
    }

    expect(upsertSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();

    // The denials above are only meaningful if the same read-only page still serves Export: a route
    // layer that refused every sprite action for a member would satisfy them on its own.
    let exported = false;
    const exportHarness = makeHarness({
      isManager: false,
      personas: [MAIN],
      spriteOperations: {
        exportSprites: async () => {
          exported = true;
          return {
            status: "success",
            buffer: Buffer.from("zip"),
            filename: "aphel-sprites.zip",
            spriteCount: 2,
            skippedCount: 0,
          };
        },
      },
    });
    await dispatch(
      exportHarness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "sprite-export", locale: "en-US", personaId: 55 }),
        isManager: false,
        harness: exportHarness,
      }),
    );

    expect(exported).toBe(true);

    upsertSpy.mockRestore();
    updateSpy.mockRestore();
    deleteSpy.mockRestore();
  });

  it("delivers the archive as a public follow-up rather than through the ephemeral panel", async () => {
    const harness = makeHarness({
      personas: [MAIN],
      spriteOperations: {
        exportSprites: async () => ({
          status: "success",
          buffer: Buffer.from("zip"),
          filename: "aphel-sprites.zip",
          spriteCount: 2,
          skippedCount: 0,
        }),
      },
    });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "sprite-export", locale: "en-US", personaId: 55 }),
        harness,
      }),
    );

    // The panel root defers ephemerally, so an `editReply` carrying the archive would silently make
    // a public export private. The archive must arrive on its own message with no Ephemeral flag.
    expect(harness.followUps).toHaveLength(1);
    const followUp = harness.followUps[0] as { files?: unknown[]; flags?: number };
    expect(followUp.files).toHaveLength(1);
    expect(followUp.flags ?? 0).toBe(0);
    // The panel still repaints in place beside it.
    expect(harness.edits.length).toBeGreaterThan(0);
    expect(harness.telemetry).toContain("server-config.workspace.persona-sprite.export");
  });

  it("refuses an edit whose fingerprint no longer matches the sprite at that position", async () => {
    const updateSpy = spyOn(personaSpriteRepository, "updateSpriteMetadata").mockResolvedValue(null);
    const harness = makeHarness({ personas: [MAIN] });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "sprite-edit-submit",
          locale: "en-US",
          personaId: 55,
          index: 0,
          // The fingerprint of the sprite that used to sit at position 0.
          fp: computeSpriteFingerprint(55, 0, "angry"),
          nonce: SPRITE_NONCE,
        }),
        kind: "modal",
        fields: spriteFields("Renamed"),
        harness,
      }),
    );

    expect(updateSpy).not.toHaveBeenCalled();
    updateSpy.mockRestore();
  });

  it("reports a concurrently removed sprite as stale instead of a successful removal of nothing", async () => {
    const deleteSpy = spyOn(personaSpriteRepository, "deleteSpritesByKeys").mockResolvedValue([]);
    const materializeSpy = spyOn(personaRepository, "materializeIfPointer").mockResolvedValue(true);
    let removedName: string | undefined;
    const harness = makeHarness({
      personas: [MAIN],
      spriteOperations: {
        removeSprite: async (input) => {
          const result = await configSpriteOperations.removeSprite(input);
          if (result.status === "success") removedName = result.spriteName;
          return result;
        },
      },
    });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "sprite-remove-confirm",
          locale: "en-US",
          personaId: 55,
          index: 0,
          fp: computeSpriteFingerprint(55, 0, "happy"),
          nonce: SPRITE_NONCE,
        }),
        harness,
      }),
    );

    // The DELETE ran and matched nothing, so no receipt may claim a removal and no storage delete
    // may follow from an empty result.
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(removedName).toBeUndefined();
    expect(JSON.stringify(harness.edits)).toContain(localizer("en-US", "commands.config.panel.stale_heading"));

    deleteSpy.mockRestore();
    materializeSpy.mockRestore();
  });

  it("hands each removed sprite image to storage exactly once", async () => {
    const removedRows: PersonaSpriteRow[] = [makeSprite({ sprite_key: "happy", avatar_url: "personas/55/happy.png" })];
    const deleteSpy = spyOn(personaSpriteRepository, "deleteSpritesByKeys").mockResolvedValue(removedRows);
    const materializeSpy = spyOn(personaRepository, "materializeIfPointer").mockResolvedValue(true);
    const storageDeletes: string[] = [];
    const storageSpy = spyOn(avatarStorage, "deletePersonaSpriteFromStorage").mockImplementation(async (reference) => {
      storageDeletes.push(reference);
      return true;
    });

    const result = await configSpriteOperations.removeSprite({
      persona: MAIN,
      serverDiscId: "guild-1",
      spriteKey: "happy",
    });

    expect(result.status).toBe("success");
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(storageDeletes).toEqual(["personas/55/happy.png"]);

    deleteSpy.mockRestore();
    materializeSpy.mockRestore();
    storageSpy.mockRestore();
  });

  it("pages a persona past twenty-five sprites and keeps a later page's selection addressable", async () => {
    const many = Array.from({ length: 30 }, (_unused, index) =>
      makeSprite({ sprite_key: `sprite${String(index).padStart(2, "0")}`, sprite_id: index + 1 }),
    );
    const harness = makeHarness({ personas: [MAIN], sprites: many });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "sprite-select", locale: "en-US", personaId: 55 }),
        kind: "select",
        values: ["27"],
        harness,
      }),
    );

    const rendered = JSON.stringify(harness.edits);
    // Selecting index 27 must move the selector onto its own page rather than leaving it on the
    // first twenty-five, where the option would not exist.
    expect(rendered).toContain('"value":"27"');
    expect(rendered).not.toContain('"value":"0"');
    expect(rendered).toContain(
      buildConfigRouteId({
        action: "sprite-edit-open",
        locale: "en-US",
        personaId: 55,
        index: 27,
        fp: computeSpriteFingerprint(55, 27, many[27].sprite_key),
      }),
    );
  });

  it("attaches a selected local sprite before repainting its thumbnail", async () => {
    const spriteFile = new AttachmentBuilder(Buffer.from("sprite"), { name: "persona_sprite_55_1.png" });
    const harness = makeHarness({
      personas: [MAIN],
      getPersonaAvatarReferenceData: async () => ({
        url: "attachment://persona_sprite_55_1.png",
        files: [spriteFile],
      }),
    });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "sprite-select", locale: "en-US", personaId: 55 }),
        kind: "select",
        values: ["0"],
        harness,
      }),
    );

    const payload = harness.edits.at(-1) as { files?: AttachmentBuilder[] };
    expect(payload.files).toEqual([spriteFile]);
    expect(JSON.stringify(payload)).toContain("attachment://persona_sprite_55_1.png");
  });

  it("builds sprite modals from the raw component types Discord needs", async () => {
    const harness = makeHarness({ personas: [MAIN] });
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "sprite-add-open", locale: "en-US", personaId: 55 }),
        harness,
      }),
    );
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "sprite-edit-open",
          locale: "en-US",
          personaId: 55,
          index: 0,
          fp: computeSpriteFingerprint(55, 0, "happy"),
        }),
        harness,
      }),
    );
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "sprite-import-open", locale: "en-US", personaId: 55 }),
        harness,
      }),
    );

    const componentTypes = (
      harness.modals as Array<{ components: Array<{ type: number; component: { type: number } }> }>
    ).map((modal) => modal.components.map((label) => label.component.type));
    // 4 is TextInput, 19 is FileUpload, 22 is CheckboxGroup. Every component type is a bare number
    // on the wire, so TypeScript accepts a wrong one and only a literal assertion catches it.
    expect(componentTypes).toEqual([[4, 19, 4, 22], [4, 19, 4, 22], [19]]);
    // The image is required on add and optional on edit, so an edit can change only the name.
    const [addModal, editModal] = harness.modals as Array<{
      components: Array<{ component: { type: number; required?: boolean; min_values?: number } }>;
    }>;
    expect(addModal.components[1].component.min_values).toBe(1);
    expect(editModal.components[1].component.min_values).toBe(0);
  });

  it("refuses to open an edit modal whose fingerprint is stale", async () => {
    const harness = makeHarness({ personas: [MAIN] });
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "sprite-edit-open",
          locale: "en-US",
          personaId: 55,
          index: 0,
          fp: computeSpriteFingerprint(55, 0, "angry"),
        }),
        harness,
      }),
    );

    expect(harness.modals).toEqual([]);
    expect(harness.replies).toHaveLength(1);
  });

  it("round-trips a persona's sprites out through Export and back in through Import", async () => {
    const stored: PersonaSpriteRow[] = [
      makeSprite({ sprite_key: "happy", sprite_name: "Happy", usage_instructions: "When cheerful", is_identity: true }),
      makeSprite({ sprite_key: "sad", sprite_name: "Sad", sprite_id: 2 }),
    ];
    const listSpy = spyOn(personaSpriteRepository, "listForPersona").mockResolvedValue(stored);
    const loadSpy = spyOn(avatarStorage, "loadStoredPersonaAvatarBuffer").mockImplementation(async (reference) =>
      Buffer.from(`bytes:${reference}`),
    );
    // The archive carries whatever bytes it is handed, so identity is what this asserts, not codec
    // behavior: a real re-encode would make the two sides incomparable.
    const pngSpy = spyOn(imageProcessor, "convertToPNG").mockImplementation(async (buffer: Buffer) => buffer);

    const exported = await configSpriteOperations.exportSprites({ persona: MAIN });
    expect(exported.status).toBe("success");
    if (exported.status !== "success") return;
    expect(exported.spriteCount).toBe(2);
    expect(exported.skippedCount).toBe(0);

    const materializeSpy = spyOn(personaRepository, "materializeIfPointer").mockResolvedValue(true);
    const uploadSpy = spyOn(avatarStorage, "uploadPersonaSpriteToStorage").mockImplementation(
      async ({ label }) => `personas/99/${label}.png`,
    );
    const upserts: Array<{ spriteKey: string; usageInstructions: string; isIdentity: boolean }> = [];
    const upsertSpy = spyOn(personaSpriteRepository, "upsertSprite").mockImplementation(async (input) => {
      upserts.push({
        spriteKey: input.spriteKey,
        usageInstructions: input.usageInstructions,
        isIdentity: input.isIdentity,
      });
      return {
        sprite: makeSprite({ sprite_key: input.spriteKey, sprite_name: input.spriteName }),
        previousAvatarUrl: null,
        replaced: false,
      };
    });
    const downloadSpy = spyOn(safeDownloadModule, "safeDownload").mockResolvedValue({
      success: true,
      buffer: exported.buffer,
    } as Awaited<ReturnType<typeof safeDownloadModule.safeDownload>>);
    // The target persona starts empty, so every archive entry lands as a new sprite.
    listSpy.mockResolvedValue([]);

    const imported = await configSpriteOperations.importSprites({
      persona: makePersona({ persona_id: 99 }),
      serverDiscId: "guild-1",
      quotaKey: "user-import-roundtrip",
      attachment: {
        id: "a1",
        filename: "aphel-sprites.zip",
        size: exported.buffer.byteLength,
        url: "https://cdn.example.invalid/aphel-sprites.zip",
        proxy_url: "https://cdn.example.invalid/aphel-sprites.zip",
        content_type: "application/zip",
      },
    });

    expect(imported).toMatchObject({ status: "success", created: 2, replaced: 0, failed: 0 });
    expect(upserts.map((entry) => entry.spriteKey).sort()).toEqual(["happy", "sad"]);
    // The identity flag and usage note survive the archive rather than resetting to their defaults.
    expect(upserts.find((entry) => entry.spriteKey === "happy")).toMatchObject({
      usageInstructions: "When cheerful",
      isIdentity: true,
    });
    expect(upserts.find((entry) => entry.spriteKey === "sad")).toMatchObject({ isIdentity: false });

    listSpy.mockRestore();
    loadSpy.mockRestore();
    pngSpy.mockRestore();
    materializeSpy.mockRestore();
    uploadSpy.mockRestore();
    upsertSpy.mockRestore();
    downloadSpy.mockRestore();
  });

  it("carries the identity checkbox into the write rather than dropping it", async () => {
    let received: boolean | undefined;
    const harness = makeHarness({
      personas: [MAIN],
      spriteOperations: {
        addSprite: async (input) => {
          received = input.isIdentity;
          return { status: "success", spriteName: input.rawName, replaced: false };
        },
      },
    });
    harness.dependencies.takeCheckboxValues = () => [CONFIG_SPRITE_IDENTITY_OPTION_VALUE];

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "sprite-add-submit",
          locale: "en-US",
          personaId: 55,
          nonce: SPRITE_NONCE,
        }),
        kind: "modal",
        fields: spriteFields("Happy", "When cheerful"),
        harness,
      }),
    );

    expect(received).toBe(true);
    expect(harness.telemetry).toContain("server-config.workspace.persona-sprite.add");
  });
});

describe("config modal opening", () => {
  it("opens a modal as the acknowledgement rather than deferring first", async () => {
    const harness = makeHarness();
    const interaction = makeInteraction({
      customId: buildConfigRouteId({ action: "rename-open", locale: "en-US", personaId: 55 }),
      harness,
    });

    await dispatch(harness, interaction);

    expect(interaction.deferred).toBe(false);
    expect(harness.edits).toEqual([]);
    expect(harness.modals).toHaveLength(1);
    expect(harness.modals[0]).toMatchObject({
      custom_id: buildConfigRouteId({
        action: "rename-submit",
        locale: "en-US",
        personaId: 55,
        nonce: "nonce1234567",
      }),
    });
  });

  it("prefills the rename modal with the persona's current name", async () => {
    const harness = makeHarness();
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "rename-open", locale: "en-US", personaId: 55 }),
        harness,
      }),
    );

    expect(JSON.stringify(harness.modals[0])).toContain('"value":"Aphel"');
  });

  it("names the naming modal for the selected addressing style", async () => {
    const harness = makeHarness();
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "naming-open",
          locale: "en-US",
          personaId: 55,
          style: "feminine",
        }),
        harness,
      }),
    );

    expect(harness.modals[0]).toMatchObject({ title: "Edit Feminine Naming Habits" });
  });

  it("does not open a modal for a persona absent from the workspace", async () => {
    const harness = makeHarness({ personas: [MAIN] });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "rename-open", locale: "en-US", personaId: 999 }),
        harness,
      }),
    );

    expect(harness.modals).toEqual([]);
    expect(harness.replies).toHaveLength(1);
  });

  it("declines to open the removal modal for a persona with no trigger words", async () => {
    const harness = makeHarness();
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "trigger-remove-open", locale: "en-US", personaId: 56 }),
        harness,
      }),
    );

    expect(harness.modals).toEqual([]);
    expect(harness.replies).toHaveLength(1);
  });

  it("builds the removal modal from CheckboxGroup components, never FileUpload", async () => {
    const harness = makeHarness();
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "trigger-remove-open", locale: "en-US", personaId: 55 }),
        harness,
      }),
    );

    const modal = harness.modals[0] as { components: Array<{ type: number; component: { type: number } }> };
    // 22 is CheckboxGroup. A FileUpload (19) also renders and submits, but carries no option values,
    // which would make unchecked-means-remove delete every presented word.
    expect(modal.components.every((label) => label.type === 18)).toBe(true);
    expect(modal.components.map((label) => label.component.type)).toEqual([22]);
  });
});
