import {
  AttachmentBuilder,
  MessageFlags,
  type ChannelSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import type { PanelAction } from "@/constants/panelActions";
import type { PersonaSpriteRow, TomoriState } from "@/types/db/schema";
import type { PanelReceipt, PanelReceiptTone } from "@/types/discord/panel";
import type { AddressingStyle } from "@/types/personaNaming";
import { isToolNoticeKey } from "@/constants/toolNotices";
import { getCachedAllPersonas, getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import {
  getShortTermMemoryForServerChannel,
  getShortTermMemoryForUserChannel,
  preWarmStmEntry,
  type ShortTermMemoryEntry,
} from "@/utils/cache/shortTermMemoryCache";
import { getCachedUserRow } from "@/utils/cache/userCache";
import { conditioningMemoryRepository } from "@/utils/db/repositories/ConditioningMemoryRepository";
import { personalMemoryRepository } from "@/utils/db/repositories/PersonalMemoryRepository";
import {
  configRepository,
  channelContextNoteRepo,
  channelPromptRepo,
  llmModelRepo,
  llmOverrideRepo,
  personaRepository,
  serverMemoryRepository,
  serverScheduleRepository,
  userRepository,
} from "@/utils/db/repositories";
import { shortTermMemoryRepository } from "@/utils/db/repositories/ShortTermMemoryRepository";
import {
  CONFIG_PERSONA_COLLECTION_PAGE_SIZE,
  CONFIG_PERSONA_SPRITE_PAGE_SIZE,
  CONFIG_ROUTE_NAMESPACE,
  CONFIG_ROUTE_VERSION,
  CONFIG_TRIGGER_CHECKBOX_CAPACITY,
  CONFIG_TRIGGER_CHECKBOX_GROUP_SIZE,
  CONFIG_CONDITIONING_CHECKBOX_CAPACITY,
  CONFIG_CONDITIONING_CHECKBOX_GROUP_SIZE,
  computeConditioningRemoveFingerprint,
  computeTriggerRemoveFingerprint,
  computeAttributeFingerprint,
  computeDialogueFingerprint,
  computeSpriteFingerprint,
  parseConfigPanelRoute,
  type ConfigCategory,
  type ConfigPage,
  type ConfigPanelRoute,
} from "@/utils/discord/configPanelCatalog";
import { setGuildBotAvatar, setGuildBotNickname } from "@/utils/discord/guildIdentity";
import { beginPanelInteraction } from "@/utils/discord/interactions/panelController";
import {
  isConfigRouteAuthorized,
  PERSONA_ADVANCED_ACTION_BY_ROUTE,
  resolveConfigActor,
  resolveConfigLanding,
  resolvePersonaSpritesActionState,
  visibleConfigPages,
  type ConfigActor,
} from "@/utils/discord/interactions/configPermissionPolicy";
import { configPersonaOperations, type GuildIdentityPort } from "@/utils/discord/interactions/configPersonaOperations";
import { configSpriteOperations, loadPersonaSpriteList } from "@/utils/discord/interactions/configSpriteOperations";
import { configModelOperations, loadConfigModelProviders } from "@/utils/discord/interactions/configModelOperations";
import {
  loadConfigFallbackOptions,
  loadConfigFallbacksView,
  loadConfigImageGenerationView,
  loadConfigModelListView,
  loadConfigParametersView,
  loadConfigSwitchModelsView,
} from "@/utils/discord/interactions/configModelLoaders";
import {
  CONFIG_MODEL_MODAL_OPEN_ACTIONS,
  CONFIG_MODEL_MODAL_SUBMIT_ACTIONS,
  CONFIG_MODEL_SELECT_ACTIONS,
  handleConfigModelModalOpen,
  handleConfigModelRoutes,
} from "@/utils/discord/interactions/configModelRoutes";
import {
  CONFIG_BEHAVIOR_MODAL_OPEN_ACTIONS,
  CONFIG_BEHAVIOR_MODAL_SUBMIT_ACTIONS,
  CONFIG_BEHAVIOR_SELECT_ACTIONS,
  handleConfigBehaviorModalOpen,
  handleConfigBehaviorRoutes,
  CONFIG_BEHAVIOR_D10_MODAL_OPEN_ACTIONS,
  CONFIG_BEHAVIOR_D10_MODAL_SUBMIT_ACTIONS,
  handleConfigBehaviorD10Routes,
  handleConfigBehaviorD10ModalOpen,
} from "@/utils/discord/interactions/configBehaviorRoutes";
import {
  CONFIG_PERMISSION_MODAL_OPEN_ACTIONS,
  CONFIG_PERMISSION_MODAL_SUBMIT_ACTIONS,
  handleConfigPermissionModalOpen,
  handleConfigPermissionRoutes,
  loadConfigPermissionsView,
} from "@/utils/discord/interactions/configPermissionRoutes";
import {
  CONFIG_CHANNEL_MODAL_OPEN_ACTIONS,
  CONFIG_CHANNEL_MODAL_SUBMIT_ACTIONS,
  handleConfigChannelModalOpen,
  handleConfigChannelRoutes,
} from "@/utils/discord/interactions/configChannelRoutes";
import {
  loadCachedGuildBlocklistChannels,
  loadCachedGuildChannelOverrideChannels,
  loadCachedGuildTextChecklistChannels,
} from "@/utils/discord/channelChecklistManager";
import {
  deniedReceipt,
  repaint,
  resolveSelectedPersona,
  staleReceipt,
  terminalPayload,
  asEphemeralComponentsV2FollowUp,
  type ConfigBehaviorGeneralView,
  type ConfigBehaviorExperimentalView,
  type ConfigBehaviorMemoryView,
  type ConfigBehaviorNoticesView,
  type ConfigBehaviorTriggerView,
  type ConfigBehaviorView,
  type ConfigChannelsView,
  type ConfigPersonaMemoryView,
  type ConfigRouteDependencies,
  type ConfigScope,
} from "@/utils/discord/interactions/configRouteContext";
import type { GlobalInteractionRoute, GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import type { ConfigPanelView } from "@/utils/discord/ui/configPanel";
import { createNonce } from "@/utils/discord/panelRouteTokens";
import { resolvePersonaPanelAvatar } from "@/utils/discord/personaPanelAvatar";
import {
  buildConfigModalFieldId,
  buildConditioningCheckboxGroupId,
  buildPersonaAttributeAddModal,
  buildPersonaAttributeEditModal,
  buildPersonaAvatarModal,
  buildPersonaCharacterReferenceModal,
  buildPersonaContextNoteModal,
  buildPersonaDialogueAddModal,
  buildPersonaDialogueEditModal,
  buildPersonaImageTagsModal,
  buildPersonaHumanizerModal,
  buildPersonaNamingHabitsModal,
  buildPersonaPromptModal,
  buildPersonaRenameModal,
  buildPersonaSpriteAddModal,
  buildPersonaSpriteEditModal,
  buildPersonaSpriteImportModal,
  buildPersonaConditioningRemoveModal,
  buildPersonaStmEditModal,
  buildPersonaTextOverrideModelModal,
  buildTriggerAddModal,
  buildTriggerRemoveCheckboxGroupId,
  buildTriggerRemoveModal,
  CONFIG_ATTRIBUTE_FILE_FIELD,
  CONFIG_ATTRIBUTE_INPUT_FIELD,
  CONFIG_ATTRIBUTE_PUBLIC_FIELD,
  CONFIG_CHARACTER_REFERENCE_FILE_FIELD,
  CONFIG_HUMANIZER_FIELD,
  CONFIG_CONTEXT_NOTE_DEPTH_FIELD,
  CONFIG_CONTEXT_NOTE_TEXT_FIELD,
  CONFIG_PERSONA_PROMPT_PART_FIELDS,
  CONFIG_DIALOGUE_BOT_INPUT_FIELD,
  CONFIG_DIALOGUE_FILE_FIELD,
  CONFIG_DIALOGUE_USER_INPUT_FIELD,
  CONFIG_SPRITE_ARCHIVE_FIELD,
  CONFIG_SPRITE_IDENTITY_FIELD,
  CONFIG_SPRITE_IDENTITY_OPTION_VALUE,
  CONFIG_SPRITE_IMAGE_FIELD,
  CONFIG_SPRITE_INSTRUCTIONS_FIELD,
  CONFIG_SPRITE_NAME_FIELD,
  CONFIG_STM_CATEGORY_INPUT_PREFIX,
  CONFIG_TEXT_OVERRIDE_MODEL_FIELD,
} from "@/utils/discord/ui/configModals";
import {
  showRoutedRawModal,
  takeRawModalChannelSelectValue,
  takeRawModalCheckboxGroupValues,
  takeRawModalFileUpload,
  takeRawModalSelectValue,
} from "@/utils/discord/ui/modals";
import { combineModalPromptParts } from "@/utils/text/modalPromptParts";
import { buildTextPreview, textPreviewFooterKey, textPreviewFooterVars } from "@/utils/text/textPreview";
import {
  getHumanizerLabel,
  HUMANIZER_DEFAULT,
  HUMANIZER_INHERIT_VALUE,
  HUMANIZER_MAX,
  HUMANIZER_MIN,
} from "@/utils/discord/humanizerOptions";
import { DEFAULT_MESSAGE_FETCH_LIMIT } from "@/utils/discord/messageFetchLimit";
import { hasPersonaPrompt } from "@/utils/discord/ui/personaEligibility";
import { MAX_TAG_LENGTH, MAX_TAGS } from "@/utils/image/tagHelpers";
import { PERSONA_SPRITE_LIMITS } from "@/utils/persona/sprites";
import { IMPORT_LIMITS, PERSONA_LIMITS } from "@/utils/security/rateLimiter";
import { log } from "@/utils/misc/logger";
import { recordPanelActionStat } from "@/utils/stats/panelActionMetrics";
import { localizer } from "@/utils/text/localizer";
import { buildSlugMap } from "@/utils/text/slugifyLabel";
import { buildInitialMemoriesPanel } from "@/utils/discord/interactions/memoriesRoutes";
import { buildInitialPersonalMemoriesPanel } from "@/utils/discord/interactions/personalMemoriesRoutes";
import { loadSavedProvidersForCapability } from "@/utils/provider/savedProviderConfig";
import { resolveDeliberateToolContextTurns } from "@/utils/tools/deliberateToolMode";

const MODAL_OPEN_ACTIONS = new Set<ConfigPanelRoute["action"]>([
  "avatar-open",
  "rename-open",
  "naming-open",
  "trigger-add-open",
  "trigger-remove-open",
  "attribute-add-open",
  "attribute-edit-open",
  "dialogue-add-open",
  "dialogue-edit-open",
  "stm-edit-open",
  "conditioning-open",
  "image-tags-open",
  "character-reference-open",
  "prompt-open",
  "context-note-open",
  "humanizer-open",
  "sprite-add-open",
  "sprite-edit-open",
  "sprite-import-open",
]);

/** Sprite routes repaint their own page rather than the Persona General default. */
const SPRITE_ACTIONS = new Set<ConfigPanelRoute["action"]>([
  "sprite-select",
  "sprite-page",
  "sprite-add-open",
  "sprite-add-submit",
  "sprite-edit-open",
  "sprite-edit-submit",
  "sprite-remove-view",
  "sprite-remove-confirm",
  "sprite-remove-cancel",
  "sprite-import-open",
  "sprite-import-submit",
  "sprite-export",
]);

/**
 * Resolves the sprite a route's list position names, refusing when the fingerprint no longer
 * matches.
 *
 * The route carries a position rather than a `sprite_key` because a key may be 64 characters and
 * would push the custom ID past Discord's limit. The fingerprint is what makes the position safe: a
 * concurrent add, rename, or removal changes it, so a replayed route reports staleness instead of
 * resolving to whichever sprite now sits at that position.
 */
function resolveSpriteAtIndex(
  sprites: readonly PersonaSpriteRow[],
  personaId: number,
  index: number,
  fp: string,
): PersonaSpriteRow | null {
  const sprite = sprites[index];
  if (!sprite) return null;
  return computeSpriteFingerprint(personaId, index, sprite.sprite_key) === fp ? sprite : null;
}

function receipt(
  locale: string,
  tone: PanelReceiptTone,
  headingKey: string,
  detailKey: string,
  vars: Record<string, string | number> = {},
): PanelReceipt {
  return {
    tone,
    heading: localizer(locale, headingKey),
    detail: localizer(locale, detailKey, vars),
  };
}

/**
 * Maps the shared sprite failure statuses onto their receipts.
 *
 * Add, edit, and import fail through the same transfer statuses, so a single mapping keeps one
 * wording per cause rather than three that drift apart.
 */
function spriteFailureReceipt(
  locale: string,
  result: { status: string; reason?: string; resetAt?: number | null },
): PanelReceipt {
  const key = (suffix: string) => `commands.config.panel.${suffix}`;
  switch (result.status) {
    case "invalid-name":
      return receipt(locale, "error", key("sprite_invalid_name_heading"), key("sprite_invalid_name_detail"), {
        max_length: PERSONA_SPRITE_LIMITS.MAX_NAME_LENGTH,
      });
    case "instructions-too-long":
      return receipt(locale, "error", key("sprite_invalid_name_heading"), key("sprite_instructions_long_detail"), {
        max_length: PERSONA_SPRITE_LIMITS.MAX_INSTRUCTIONS_LENGTH,
      });
    case "invalid-image":
      return receipt(
        locale,
        "error",
        key("sprite_invalid_image_heading"),
        result.reason === "file_too_large" ? key("sprite_image_too_large_detail") : key("sprite_invalid_image_detail"),
        { max_size: PERSONA_LIMITS.MAX_AVATAR_SIZE_MB },
      );
    case "memory-critical":
      return receipt(
        locale,
        "error",
        "rate_limit.error_memory_critical_title",
        "rate_limit.error_memory_critical_description",
      );
    case "quota-exceeded":
      return receipt(
        locale,
        "error",
        "rate_limit.error_quota_exceeded_title",
        "rate_limit.error_quota_exceeded_description",
        {
          reset_time: result.resetAt
            ? new Date(result.resetAt).toLocaleString(locale)
            : localizer(locale, "general.unknown"),
        },
      );
    case "download-failed":
      return receipt(locale, "error", key("sprite_invalid_image_heading"), key("sprite_download_failed_detail"));
    case "conversion-failed":
      return receipt(locale, "error", key("sprite_invalid_image_heading"), key("sprite_conversion_failed_detail"));
    default:
      return receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail"));
  }
}

const PROMOTED_AVATAR_OPTIONS = { size: 1024, extension: "png", forceStatic: true } as const;

function createGuildIdentityPort(guildId: string, interaction: GlobalRoutableInteraction): GuildIdentityPort {
  return {
    async setNickname(nickname) {
      return (await setGuildBotNickname(guildId, nickname)).success;
    },
    async setAvatar(avatarDataUri) {
      const result = await setGuildBotAvatar(guildId, avatarDataUri);
      return { ok: result.success, rateLimited: result.error === "rate_limited", details: result.details };
    },
    async currentAvatarReference() {
      // The bot's live guild avatar is what the outgoing main persona actually looked like. A
      // forced fetch avoids a cached member returning the pre-swap image on a repeat promotion.
      const fetched = interaction.client.user
        ? await interaction.guild?.members.fetch({ user: interaction.client.user.id, force: true }).catch(() => null)
        : null;
      return (
        fetched?.displayAvatarURL(PROMOTED_AVATAR_OPTIONS) ??
        interaction.guild?.members.me?.displayAvatarURL(PROMOTED_AVATAR_OPTIONS) ??
        interaction.client.user?.displayAvatarURL(PROMOTED_AVATAR_OPTIONS) ??
        null
      );
    },
  };
}

async function loadWorkspacePersonas(serverDiscId: string, forceRefresh: boolean): Promise<TomoriState[]> {
  const personas = forceRefresh
    ? await personaRepository.loadAllForServer(serverDiscId)
    : await getCachedAllPersonas(serverDiscId);
  return personas.filter((persona) => typeof persona.persona_id === "number");
}

export async function loadConfigPersonaMemoryView(
  interaction: GlobalRoutableInteraction,
  scope: ConfigScope,
  persona: TomoriState,
): Promise<ConfigPersonaMemoryView> {
  const personaId = persona.persona_id;
  const lineageId = persona.persona_lineage_id ?? 0;
  const ownerFilter = scope.actor.isManager ? undefined : scope.userId;
  const [serverCounts, personalCounts, stmCategories, conditioningGroups] = await Promise.all([
    serverMemoryRepository.memoryCountsByLineage(persona.server_id, ownerFilter),
    personalMemoryRepository.memoryCountsByLineage(scope.userId),
    shortTermMemoryRepository.getStmCategories(persona.server_id),
    scope.guildId
      ? conditioningMemoryRepository.loadGroupsForPersona(persona.server_id, lineageId)
      : Promise.resolve([]),
  ]);

  let stmEntry: ShortTermMemoryEntry | undefined;
  const channelId = interaction.channelId;
  if (personaId && channelId) {
    if (interaction.guildId) {
      await preWarmStmEntry("server", interaction.guildId, channelId, personaId);
      stmEntry = getShortTermMemoryForServerChannel(interaction.guildId, channelId, personaId);
    } else {
      await preWarmStmEntry("user", interaction.user.id, channelId, personaId);
      stmEntry = getShortTermMemoryForUserChannel(interaction.user.id, channelId, personaId);
    }
  }

  return {
    serverMemoryCount: serverCounts.get(lineageId) ?? 0,
    personalMemoryCount: personalCounts.get(lineageId) ?? 0,
    channelId: channelId ?? null,
    stmEntry,
    stmCategories,
    conditioningGroups: conditioningGroups.filter((group) => group.reasonText.trim().length > 0),
  };
}

const defaultDependencies: ConfigRouteDependencies = {
  async resolveScope(interaction, forceRefresh = false) {
    const guildId = interaction.guildId ?? null;
    // Every absorbed command keys its workspace this way, so the panel must not invent a different
    // one or a DM's settings would land under a second, empty workspace.
    const serverDiscId = guildId ?? interaction.user.id;
    try {
      const personas = await loadWorkspacePersonas(serverDiscId, forceRefresh);
      if (personas.length === 0) return null;
      const user =
        (await getCachedUserRow(interaction.user.id)) ??
        (await userRepository.register(interaction.user.id, interaction.user.username));
      if (!user || user.user_id === undefined) return null;
      return {
        serverDiscId,
        guildId,
        internalServerId: personas[0]?.server_id ?? null,
        userId: user.user_id,
        actor: resolveConfigActor(interaction),
        personas,
        readStatus: "fresh",
      };
    } catch (error) {
      await log.error("Failed to resolve /config workspace scope", error, {
        errorType: "InteractionRouteError",
        metadata: { serverDiscId },
      });
      return null;
    }
  },
  getPersonaAvatarData: resolvePersonaPanelAvatar,
  loadPersonaMemoryView: loadConfigPersonaMemoryView,
  loadServerHumanizerDegree: async (serverId) =>
    (await configRepository.getChatConfig(serverId))?.humanizer_degree ?? null,
  loadPersonaSprites: loadPersonaSpriteList,
  loadSavedTextProviders: async (serverId) => loadSavedProvidersForCapability(serverId, "text"),
  loadPersonaTextModels: async (provider, serverId) =>
    (await llmModelRepo.loadAvailableModelsForProvider(provider, false, { kind: "server", ownerId: serverId })) ?? [],
  openServerMemoryPanel: async (interaction, locale, lineageId) => {
    const panel = await buildInitialMemoriesPanel(interaction, locale, undefined, lineageId);
    return asEphemeralComponentsV2FollowUp(panel);
  },
  openPersonalMemoryPanel: async (interaction, locale, lineageId) => {
    const panel = await buildInitialPersonalMemoriesPanel(interaction, locale, undefined, lineageId);
    return asEphemeralComponentsV2FollowUp(panel);
  },
  operations: configPersonaOperations,
  spriteOperations: configSpriteOperations,
  modelOperations: configModelOperations,
  loadSwitchModelsView: loadConfigSwitchModelsView,
  loadParametersView: loadConfigParametersView,
  loadFallbacksView: loadConfigFallbacksView,
  loadImageGenerationView: loadConfigImageGenerationView,
  loadBehaviorView: async (state) => {
    const rawChatConfig = await configRepository.getChatConfig(state.server_id);
    const [speechConfig, stmConfig, stmCategories] = await Promise.all([
      configRepository.getSpeechConfig(state.server_id),
      shortTermMemoryRepository.getStmConfig(state.server_id),
      shortTermMemoryRepository.getStmCategories(state.server_id),
    ]);
    const triggers = (await serverScheduleRepository.getServerTriggers(state.server_id)).filter(
      (trigger): trigger is typeof trigger & { trigger_id: number } => trigger.trigger_id !== undefined,
    );
    const general: ConfigBehaviorGeneralView = {
      systemPrompt: rawChatConfig?.system_prompt ?? state.config.system_prompt ?? null,
      contextNote: rawChatConfig?.context_note ?? state.config.context_note ?? null,
      contextNoteDepth: rawChatConfig?.context_note_depth ?? state.config.context_note_depth ?? 0,
      // The assembled state may overlay a persona-specific degree; the General page is the raw
      // workspace setting and must not mistake that overlay for its global value.
      humanizerDegree: rawChatConfig?.humanizer_degree ?? HUMANIZER_DEFAULT,
      messageFetchLimit:
        rawChatConfig?.message_fetch_limit ?? state.config.message_fetch_limit ?? DEFAULT_MESSAGE_FETCH_LIMIT,
      timezoneOffset: rawChatConfig?.timezone_offset ?? state.config.timezone_offset ?? 0,
    };
    const trigger: ConfigBehaviorTriggerView = {
      randomTriggers: triggers,
      cascadeLimit: state.config.cascade_limit ?? 3,
      matchLimit: state.config.match_limit ?? 3,
      deliberateTriggerMode: state.config.deliberate_trigger_mode ?? false,
      alwaysReplyEnabled: state.config.always_reply_enabled ?? false,
      cooldownType: state.config.cooldown_type ?? 0,
      cooldownLength: state.config.cooldown_length ?? 5,
    };
    const experimental: ConfigBehaviorExperimentalView = {
      deliberateToolMode: state.config.deliberate_tool_mode ?? false,
      deliberateToolContextTurns: resolveDeliberateToolContextTurns(state.config.deliberate_tool_context_turns),
      deliberateToolTriggers: state.config.deliberate_tool_triggers ?? {},
      sendLimit: rawChatConfig?.send_message_limit ?? state.config.send_message_limit ?? 0,
      selfDebugEnabled: rawChatConfig?.self_debug_enabled ?? state.config.self_debug_enabled ?? false,
      workarounds: { verbatim_tool_calling_enabled: state.config.verbatim_tool_calling_enabled ?? false },
    };
    const notices: ConfigBehaviorNoticesView = {
      hiddenNoticeKeys: (state.config.tool_notice_hidden_keys ?? []).filter(isToolNoticeKey),
      speechTranscriptsEnabled:
        speechConfig?.voice_transcript_chat_mode ?? state.config.voice_transcript_chat_mode ?? true,
    };
    const memory: ConfigBehaviorMemoryView = {
      memoryTaggingEnabled: state.config.memory_tagging_enabled ?? false,
      channelMemoryEnabled: state.config.channel_memory_enabled ?? false,
      stmConfig,
      stmCategories,
    };
    const view: ConfigBehaviorView = { general, trigger, experimental, notices, memory };
    return view;
  },
  loadPermissionsView: loadConfigPermissionsView,
  loadChannelsView: async (interaction, selectedChannelId): Promise<ConfigChannelsView> => {
    const availableTextChannels = interaction.guild ? loadCachedGuildTextChecklistChannels(interaction.guild) : [];
    const availableBlocklistChannels = interaction.guild ? loadCachedGuildBlocklistChannels(interaction.guild) : [];
    const availableOverrideChannels = interaction.guild
      ? loadCachedGuildChannelOverrideChannels(interaction.guild)
      : [];
    const state = interaction.guildId ? await getCachedTomoriState(interaction.guildId) : null;
    const enabledChannelIds = new Set(state?.config.autoch_disc_ids ?? []);
    const privateChannelIds = new Set(state?.config.private_channel_ids ?? []);
    const roleplayChannelIds = new Set(state?.config.rp_channel_ids ?? []);
    const blockedChannelIds = new Set(state?.config.crosschannel_blocklist_ids ?? []);
    const selectedOverrideChannel = availableOverrideChannels.find((channel) => channel.id === selectedChannelId);
    const selectedOverrideChannelId = selectedOverrideChannel?.id ?? null;
    const [prompt, contextNote, textModelOverride] =
      selectedOverrideChannelId && state
        ? await Promise.all([
            channelPromptRepo.getChannelPromptOverride(state.server_id, selectedOverrideChannelId),
            channelContextNoteRepo.getChannelContextNote(state.server_id, selectedOverrideChannelId),
            llmOverrideRepo.getChannelLlmOverride(state.server_id, selectedOverrideChannelId),
          ])
        : [null, null, null];
    return {
      destinations: {
        thoughtLogChannelId: state?.config.thought_log_channel_disc_id ?? null,
        welcomeChannelId: state?.config.welcome_channel_disc_id ?? null,
        welcomePrompt: state?.config.welcome_prompt ?? null,
        welcomePersonaId: state?.config.welcome_persona_id ?? null,
      },
      autoTrigger: {
        enabledChannels: availableTextChannels.filter((channel) => enabledChannelIds.has(channel.id)),
        personaOverrides: state?.config.autoch_persona_overrides ?? [],
        threshold: state?.config.autoch_threshold ?? 0,
        maxThreshold: state?.config.autoch_threshold_max ?? state?.config.autoch_threshold ?? 0,
      },
      rules: {
        privateChannels: availableTextChannels.filter((channel) => privateChannelIds.has(channel.id)),
        roleplayChannels: availableTextChannels.filter((channel) => roleplayChannelIds.has(channel.id)),
        crossChannelBlocklist: availableBlocklistChannels.filter((channel) => blockedChannelIds.has(channel.id)),
      },
      availableTextChannels,
      availableBlocklistChannels,
      availableOverrideChannels,
      overrides: {
        selectedChannelId: selectedOverrideChannelId,
        prompt,
        contextNote,
        textModelOverride,
      },
    };
  },
  loadModelListView: async (state, capability, provider, start) => ({
    capability,
    provider,
    ...(await loadConfigModelListView(state, capability, provider, start)),
  }),
  loadFallbackOptions: loadConfigFallbackOptions,
  loadModelProviders: async (state, capability) =>
    (await loadConfigModelProviders(state.server_id, capability)).map((row) => row.provider),
  createGuildIdentity: createGuildIdentityPort,
  recordAction: (input) => {
    void recordPanelActionStat(input);
  },
  createNonce,
  showModal: (interaction, payload) => {
    if (interaction.isModalSubmit()) throw new Error("A modal submit cannot open another modal");
    return showRoutedRawModal(interaction, payload);
  },
  takeAvatarUpload: (interactionId, nonce) =>
    takeRawModalFileUpload(interactionId, buildConfigModalFieldId("avatar", nonce)),
  takeFileUpload: takeRawModalFileUpload,
  takeCheckboxValues: takeRawModalCheckboxGroupValues,
  takeSelectValue: takeRawModalSelectValue,
  takeChannelSelectValue: takeRawModalChannelSelectValue,
};

/**
 * A write must land on exactly the persona its button named. Navigation may fall back to the main
 * persona when a route outlives its row, but a write that fell back would silently mutate a
 * different persona than the one the user was looking at.
 */
function findExactPersona(personas: readonly TomoriState[], personaId: number | null): TomoriState | null {
  if (personaId === null) return null;
  return personas.find((persona) => persona.persona_id === personaId) ?? null;
}

function parseAddressingStyleValue(value: string | null): AddressingStyle | null {
  return value === "masculine" || value === "feminine" || value === "neutral" ? value : null;
}

function hasManageableReason(group: { reasonText: string }): boolean {
  return group.reasonText.trim().length > 0;
}

function personaLocation(route: ConfigPanelRoute): { personaId: number | null; explicitStart?: number } {
  if ("personaId" in route && route.personaId !== undefined) {
    return {
      personaId: route.personaId,
      ...(route.action === "persona-page" ? { explicitStart: route.start } : {}),
    };
  }
  return { personaId: null };
}

type CollectionFamily = "attribute" | "dialogue";
type CollectionOperation = "add" | "edit" | "remove";

function collectionOperationForRoute(
  route: ConfigPanelRoute,
  selectedValue?: string | null,
): { family: CollectionFamily; operation: CollectionOperation } | null {
  switch (route.action) {
    case "attribute-select":
      return selectedValue === "add" ? { family: "attribute", operation: "add" } : null;
    case "attribute-add-open":
    case "attribute-add-submit":
      return { family: "attribute", operation: "add" };
    case "attribute-edit-open":
    case "attribute-edit-submit":
      return { family: "attribute", operation: "edit" };
    case "attribute-remove":
      return { family: "attribute", operation: "remove" };
    case "dialogue-select":
      return selectedValue === "add" ? { family: "dialogue", operation: "add" } : null;
    case "dialogue-add-open":
    case "dialogue-add-submit":
      return { family: "dialogue", operation: "add" };
    case "dialogue-edit-open":
    case "dialogue-edit-submit":
      return { family: "dialogue", operation: "edit" };
    case "dialogue-remove":
      return { family: "dialogue", operation: "remove" };
    default:
      return null;
  }
}

async function authorizeCollectionOperation(
  interaction: GlobalRoutableInteraction,
  scope: ConfigScope,
  operation: { family: CollectionFamily; operation: CollectionOperation } | null,
): Promise<boolean> {
  if (!operation) return true;

  // DM owners are not guild managers. Their workspace still obeys the same teaching flag as the
  // legacy commands even though the static actor policy marks the DM owner as the workspace owner.
  if (scope.guildId && scope.actor.isManager) return true;

  const config = scope.personas[0]?.config;
  const teachingEnabled =
    operation.family === "attribute"
      ? config?.attribute_memteaching_enabled === true
      : config?.sampledialogue_memteaching_enabled === true;
  if (!teachingEnabled) return false;

  if (scope.guildId && (operation.operation === "add" || operation.operation === "edit")) {
    try {
      if (await userRepository.isBlacklisted(scope.serverDiscId, interaction.user.id)) return false;
    } catch (error) {
      await log.error("Failed to resolve persona collection blacklist state", error, {
        errorType: "InteractionRouteError",
        metadata: { serverDiscId: scope.serverDiscId, userDiscordId: interaction.user.id },
      });
      return false;
    }
  }

  return true;
}

async function repairDialogueState(
  scope: ConfigScope,
  persona: TomoriState,
  dependencies: ConfigRouteDependencies,
): Promise<boolean> {
  const result = await dependencies.operations.repairSampleDialogues({
    persona,
    serverDiscId: scope.serverDiscId,
  });
  if (result.status === "write-failed") return false;
  persona.sample_dialogues_in = result.inputs;
  persona.sample_dialogues_out = result.outputs;
  return true;
}

async function handleModalOpen(
  interaction: GlobalRoutableInteraction,
  route: ConfigPanelRoute,
  dependencies: ConfigRouteDependencies,
  actor: ConfigActor,
): Promise<void> {
  if (!isConfigRouteAuthorized(route, actor)) {
    await interaction.reply({
      content: localizer(route.locale, "commands.config.panel.denied_detail"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const scope = await dependencies.resolveScope(interaction, false);
  if (!scope) {
    await interaction.reply({
      content: localizer(route.locale, "commands.config.panel.unavailable"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { personaId } = personaLocation(route);
  const persona = findExactPersona(scope.personas, personaId);
  if (!persona?.persona_id) {
    await interaction.reply({
      content: localizer(route.locale, "commands.config.panel.unavailable"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const locale = route.locale;
  if (!(await authorizeCollectionOperation(interaction, scope, collectionOperationForRoute(route)))) {
    const denied = deniedReceipt(locale);
    await interaction.reply({
      content: `${denied.heading}\n${denied.detail}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const nonce = dependencies.createNonce();

  switch (route.action) {
    case "stm-edit-open": {
      const memoryView = await dependencies.loadPersonaMemoryView(interaction, scope, persona);
      if (!memoryView.channelId) {
        await interaction.reply({
          content: localizer(locale, "commands.config.panel.stm_no_channel"),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await dependencies.showModal(
        interaction,
        buildPersonaStmEditModal(locale, persona.persona_id, nonce, memoryView.stmCategories, memoryView.stmEntry),
      );
      return;
    }
    case "conditioning-open": {
      const memoryView = await dependencies.loadPersonaMemoryView(interaction, scope, persona);
      const presentedGroups = memoryView.conditioningGroups
        .filter(hasManageableReason)
        .slice(0, CONFIG_CONDITIONING_CHECKBOX_CAPACITY);
      if (presentedGroups.length === 0) {
        await interaction.reply({
          content: localizer(locale, "commands.config.panel.conditioning_no_groups_detail"),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await dependencies.showModal(
        interaction,
        buildPersonaConditioningRemoveModal(
          locale,
          persona.persona_id,
          computeConditioningRemoveFingerprint(persona.persona_id, presentedGroups),
          nonce,
          persona.persona_nickname,
          presentedGroups,
        ),
      );
      return;
    }
    case "image-tags-open":
      await dependencies.showModal(
        interaction,
        buildPersonaImageTagsModal(locale, persona.persona_id, nonce, persona.physical_appearance_tags),
      );
      return;
    case "character-reference-open":
      await dependencies.showModal(interaction, buildPersonaCharacterReferenceModal(locale, persona.persona_id, nonce));
      return;
    case "prompt-open":
      await dependencies.showModal(interaction, buildPersonaPromptModal(locale, persona.persona_id, nonce, persona));
      return;
    case "context-note-open":
      await dependencies.showModal(
        interaction,
        buildPersonaContextNoteModal(
          locale,
          persona.persona_id,
          nonce,
          persona.context_note,
          persona.context_note_depth,
        ),
      );
      return;
    case "humanizer-open":
      await dependencies.showModal(
        interaction,
        buildPersonaHumanizerModal(locale, persona.persona_id, nonce, persona.humanizer_degree_override),
      );
      return;
    case "avatar-open":
      await dependencies.showModal(interaction, buildPersonaAvatarModal(locale, persona.persona_id, nonce));
      return;
    case "sprite-add-open":
      await dependencies.showModal(interaction, buildPersonaSpriteAddModal(locale, persona.persona_id, nonce));
      return;
    case "sprite-import-open":
      await dependencies.showModal(interaction, buildPersonaSpriteImportModal(locale, persona.persona_id, nonce));
      return;
    case "sprite-edit-open": {
      const sprites = await dependencies.loadPersonaSprites(persona.persona_id);
      const sprite = resolveSpriteAtIndex(sprites, persona.persona_id, route.index, route.fp);
      if (!sprite) {
        const stale = staleReceipt(locale);
        await interaction.reply({ content: `${stale.heading}\n${stale.detail}`, flags: MessageFlags.Ephemeral });
        return;
      }
      await dependencies.showModal(
        interaction,
        buildPersonaSpriteEditModal(locale, persona.persona_id, route.index, route.fp, nonce, sprite),
      );
      return;
    }
    case "rename-open":
      await dependencies.showModal(
        interaction,
        buildPersonaRenameModal(locale, persona.persona_id, nonce, persona.persona_nickname),
      );
      return;
    case "naming-open":
      await dependencies.showModal(
        interaction,
        buildPersonaNamingHabitsModal(locale, persona.persona_id, route.style, nonce, {
          prefix: persona.naming_config.prefixes[route.style] ?? "",
          suffix: persona.naming_config.suffixes[route.style] ?? "",
          addressTerm: persona.naming_config.addressTerms[route.style] ?? "",
        }),
      );
      return;
    case "trigger-add-open":
      await dependencies.showModal(interaction, buildTriggerAddModal(locale, persona.persona_id, nonce));
      return;
    case "trigger-remove-open": {
      const triggerWords = persona.trigger_words ?? [];
      if (triggerWords.length === 0) {
        await interaction.reply({
          content: localizer(locale, "commands.config.panel.trigger_remove_none_detail"),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await dependencies.showModal(
        interaction,
        buildTriggerRemoveModal(
          locale,
          persona.persona_id,
          computeTriggerRemoveFingerprint(persona.persona_id, triggerWords),
          nonce,
          triggerWords,
        ),
      );
      return;
    }
    case "attribute-add-open":
      await dependencies.showModal(interaction, buildPersonaAttributeAddModal(locale, persona.persona_id, nonce));
      return;
    case "attribute-edit-open": {
      const attribute = persona.attribute_list?.[route.index];
      const isPublic =
        persona.persona_attributes?.find((candidate) => candidate.attribute_order === route.index + 1)?.is_public ??
        false;
      if (
        attribute === undefined ||
        computeAttributeFingerprint(persona.persona_id, route.index, attribute, isPublic) !== route.fp
      ) {
        const stale = staleReceipt(locale);
        await interaction.reply({ content: `${stale.heading}\n${stale.detail}`, flags: MessageFlags.Ephemeral });
        return;
      }
      await dependencies.showModal(
        interaction,
        buildPersonaAttributeEditModal(locale, persona.persona_id, route.index, route.fp, nonce, attribute, isPublic),
      );
      return;
    }
    case "dialogue-add-open":
      await dependencies.showModal(interaction, buildPersonaDialogueAddModal(locale, persona.persona_id, nonce));
      return;
    case "dialogue-edit-open": {
      if (!(await repairDialogueState(scope, persona, dependencies))) {
        const stale = staleReceipt(locale);
        await interaction.reply({ content: `${stale.heading}\n${stale.detail}`, flags: MessageFlags.Ephemeral });
        return;
      }
      const input = persona.sample_dialogues_in?.[route.index];
      const output = persona.sample_dialogues_out?.[route.index];
      if (
        input === undefined ||
        output === undefined ||
        computeDialogueFingerprint(persona.persona_id, route.index, input, output) !== route.fp
      ) {
        const stale = staleReceipt(locale);
        await interaction.reply({ content: `${stale.heading}\n${stale.detail}`, flags: MessageFlags.Ephemeral });
        return;
      }
      await dependencies.showModal(
        interaction,
        buildPersonaDialogueEditModal(locale, persona.persona_id, route.index, route.fp, nonce, input, output),
      );
      return;
    }
  }
}

async function handleCollectionAddSelection(
  interaction: GlobalRoutableInteraction,
  route: ConfigPanelRoute,
  dependencies: ConfigRouteDependencies,
  actor: ConfigActor,
): Promise<void> {
  if (!isConfigRouteAuthorized(route, actor)) {
    await interaction.reply({
      content: localizer(route.locale, "commands.config.panel.denied_detail"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const scope = await dependencies.resolveScope(interaction, false);
  if (!scope) {
    await interaction.reply({
      content: localizer(route.locale, "commands.config.panel.unavailable"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const operation = collectionOperationForRoute(route, "add");
  if (!(await authorizeCollectionOperation(interaction, scope, operation))) {
    const denied = deniedReceipt(route.locale);
    await interaction.reply({ content: `${denied.heading}\n${denied.detail}`, flags: MessageFlags.Ephemeral });
    return;
  }

  const persona = findExactPersona(scope.personas, personaLocation(route).personaId);
  if (!persona?.persona_id) {
    await interaction.reply({
      content: localizer(route.locale, "commands.config.panel.unavailable"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const nonce = dependencies.createNonce();
  await dependencies.showModal(
    interaction,
    route.action === "attribute-select"
      ? buildPersonaAttributeAddModal(route.locale, persona.persona_id, nonce)
      : buildPersonaDialogueAddModal(route.locale, persona.persona_id, nonce),
  );
}

async function handleSpriteAddSelection(
  interaction: GlobalRoutableInteraction,
  route: ConfigPanelRoute,
  dependencies: ConfigRouteDependencies,
  actor: ConfigActor,
): Promise<void> {
  if (resolvePersonaSpritesActionState("add", actor) !== "enabled") {
    await interaction.reply({
      content: localizer(route.locale, "commands.config.panel.denied_detail"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const scope = await dependencies.resolveScope(interaction, false);
  const persona = scope ? findExactPersona(scope.personas, personaLocation(route).personaId) : null;
  if (!persona?.persona_id) {
    await interaction.reply({
      content: localizer(route.locale, "commands.config.panel.unavailable"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await dependencies.showModal(
    interaction,
    buildPersonaSpriteAddModal(route.locale, persona.persona_id, dependencies.createNonce()),
  );
}

async function handleTextOverrideChoice(
  interaction: GlobalRoutableInteraction,
  route: ConfigPanelRoute,
  scope: ConfigScope,
  persona: TomoriState,
  dependencies: ConfigRouteDependencies,
  submittedValue: string | null,
): Promise<void> {
  const personaId = persona.persona_id;
  if (personaId === undefined) return;

  const savedProviders = await dependencies.loadSavedTextProviders(persona.server_id);
  if (savedProviders.length === 0) {
    await repaint(interaction, {
      locale: route.locale,
      scope,
      category: "persona",
      page: "advanced",
      selectedPersonaId: personaId,
      receipt: receipt(
        route.locale,
        "error",
        "commands.model.providerPicker.no_providers_title",
        "commands.model.providerPicker.no_providers_description",
      ),
      dependencies,
    });
    return;
  }

  let provider: string | undefined;
  if (route.action === "text-override-model-page") {
    provider = savedProviders.find((saved) => saved.provider.toLowerCase() === route.provider.toLowerCase())?.provider;
  } else {
    if (route.action === "text-override-open") {
      if (savedProviders.length > 1) {
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "persona",
          page: "advanced",
          selectedPersonaId: personaId,
          view: {
            kind: "text-override-provider",
            personaId,
            providers: savedProviders.map((saved) => saved.provider),
          },
          dependencies,
        });
        return;
      }
      provider = savedProviders[0]?.provider;
    } else {
      provider = savedProviders.find(
        (saved) => saved.provider.toLowerCase() === submittedValue?.toLowerCase(),
      )?.provider;
    }
  }

  if (!provider) {
    await repaint(interaction, {
      locale: route.locale,
      scope,
      category: "persona",
      page: "advanced",
      selectedPersonaId: personaId,
      receipt: staleReceipt(route.locale),
      dependencies,
    });
    return;
  }

  const models = await dependencies.loadPersonaTextModels(provider, persona.server_id);
  if (models.length === 0) {
    await repaint(interaction, {
      locale: route.locale,
      scope,
      category: "persona",
      page: "advanced",
      selectedPersonaId: personaId,
      receipt: receipt(
        route.locale,
        "error",
        "commands.model.text.no_models_title",
        "commands.model.text.no_models_description",
      ),
      dependencies,
    });
    return;
  }

  await repaint(interaction, {
    locale: route.locale,
    scope,
    category: "persona",
    page: "advanced",
    selectedPersonaId: personaId,
    view: {
      kind: "text-override-model",
      personaId,
      provider,
      models,
      start: route.action === "text-override-model-page" ? route.start : 0,
    },
    dependencies,
  });
}

async function handleTextOverrideModelModalOpen(
  interaction: GlobalRoutableInteraction,
  route: Extract<ConfigPanelRoute, { action: "text-override-open" | "text-override-provider-select" }>,
  dependencies: ConfigRouteDependencies,
  actor: ConfigActor,
): Promise<void> {
  if (!isConfigRouteAuthorized(route, actor)) {
    await interaction.reply({
      content: localizer(route.locale, "commands.config.panel.denied_detail"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const scope = await dependencies.resolveScope(interaction, false);
  const persona = scope ? findExactPersona(scope.personas, route.personaId) : null;
  if (!scope || !persona?.persona_id) {
    await interaction.reply({
      content: localizer(route.locale, "commands.config.panel.unavailable"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const savedProviders = await dependencies.loadSavedTextProviders(persona.server_id);
  if (route.action === "text-override-open" && savedProviders.length > 1) {
    await interaction.deferUpdate();
    await repaint(interaction, {
      locale: route.locale,
      scope,
      category: "persona",
      page: "advanced",
      selectedPersonaId: persona.persona_id,
      view: {
        kind: "text-override-provider",
        personaId: persona.persona_id,
        providers: savedProviders.map((saved) => saved.provider),
      },
      dependencies,
    });
    return;
  }

  const selectedProvider = interaction.isStringSelectMenu() ? interaction.values[0] : savedProviders[0]?.provider;
  const provider = savedProviders.find(
    (saved) => saved.provider.toLowerCase() === selectedProvider?.toLowerCase(),
  )?.provider;
  if (!provider) {
    await interaction.reply({
      content: localizer(route.locale, "commands.config.panel.stale_detail"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const models = await dependencies.loadPersonaTextModels(provider, persona.server_id);
  if (models.length === 0) {
    await interaction.reply({
      content: localizer(route.locale, "commands.model.text.no_models_description"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (models.length > 25) {
    await interaction.deferUpdate();
    await repaint(interaction, {
      locale: route.locale,
      scope,
      category: "persona",
      page: "advanced",
      selectedPersonaId: persona.persona_id,
      view: { kind: "text-override-model", personaId: persona.persona_id, provider, models, start: 0 },
      dependencies,
    });
    return;
  }

  await dependencies.showModal(
    interaction,
    buildPersonaTextOverrideModelModal(
      route.locale,
      persona.persona_id,
      provider,
      dependencies.createNonce(),
      models,
      persona.persona_llm?.llm_id,
    ),
  );
}

interface WriteOutcome {
  receipt: PanelReceipt;
  telemetry?: PanelAction;
  collectionSelection?: {
    family: "attribute" | "dialogue";
    selectedIndex?: number;
    pageStart?: number;
  };
}

async function runPersonaWrite(
  interaction: GlobalRoutableInteraction,
  route: ConfigPanelRoute,
  scope: ConfigScope,
  persona: TomoriState,
  dependencies: ConfigRouteDependencies,
): Promise<WriteOutcome | null> {
  const locale = route.locale;
  const key = (suffix: string) => `commands.config.panel.${suffix}`;
  const guildIdentity = scope.guildId ? dependencies.createGuildIdentity(scope.guildId, interaction) : null;
  const personaId = persona.persona_id;
  if (personaId === undefined) return null;

  switch (route.action) {
    case "image-tags-submit": {
      const modal = interaction as ModalSubmitInteraction;
      const result = await dependencies.operations.setImageTags({
        persona,
        serverDiscId: scope.serverDiscId,
        rawTags: modal.fields.getTextInputValue(buildConfigModalFieldId("image_tags", route.nonce)),
      });
      if (result.status === "success") {
        return {
          receipt: receipt(
            locale,
            "success",
            result.tags.length === 0
              ? "commands.persona.image-tags.cleared_title"
              : "commands.persona.image-tags.success_title",
            result.tags.length === 0
              ? "commands.persona.image-tags.cleared_description"
              : "commands.persona.image-tags.success_description",
            { persona_name: persona.persona_nickname, tag_list: result.tags.join(", ") },
          ),
          telemetry: "server-config.workspace.persona-image-tags.set",
        };
      }
      if (result.status === "too-many") {
        return {
          receipt: receipt(
            locale,
            "error",
            "commands.persona.image-tags.too_many_tags_title",
            "commands.persona.image-tags.too_many_tags_description",
            { max_tags: MAX_TAGS },
          ),
        };
      }
      if (result.status === "tag-too-long") {
        return {
          receipt: receipt(
            locale,
            "error",
            "commands.persona.image-tags.tag_too_long_title",
            "commands.persona.image-tags.tag_too_long_description",
            { max_length: MAX_TAG_LENGTH },
          ),
        };
      }
      if (result.status === "empty") {
        return {
          receipt: receipt(
            locale,
            "error",
            "commands.persona.image-tags.no_tags_title",
            "commands.persona.image-tags.no_tags_description",
          ),
        };
      }
      return { receipt: receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail")) };
    }

    case "character-reference-submit":
    case "character-reference-clear-confirm": {
      const attachment =
        route.action === "character-reference-submit"
          ? (dependencies.takeFileUpload(
              (interaction as ModalSubmitInteraction).id,
              buildConfigModalFieldId(CONFIG_CHARACTER_REFERENCE_FILE_FIELD, route.nonce),
            ) ?? null)
          : null;
      if (route.action === "character-reference-submit" && !attachment) {
        return {
          receipt: receipt(
            locale,
            "error",
            "commands.novelai.character-reference.invalid_image_title",
            "commands.novelai.character-reference.invalid_image_description",
          ),
        };
      }
      const result = await dependencies.operations.replaceCharacterReference({
        persona,
        serverDiscId: scope.serverDiscId,
        attachment,
      });
      if (result.status === "success") {
        return {
          receipt: receipt(
            locale,
            "success",
            result.cleared
              ? "commands.novelai.character-reference.cleared_title"
              : "commands.novelai.character-reference.success_title",
            result.cleared
              ? "commands.novelai.character-reference.cleared_persona_description"
              : "commands.novelai.character-reference.success_persona_description",
            { persona_name: persona.persona_nickname },
          ),
          telemetry: "server-config.workspace.persona-character-reference.set",
        };
      }
      if (result.status === "invalid-image") {
        return { receipt: receipt(locale, "error", result.titleKey, result.descriptionKey) };
      }
      return { receipt: receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail")) };
    }

    case "prompt-submit": {
      const modal = interaction as ModalSubmitInteraction;
      const prompt = combineModalPromptParts(
        CONFIG_PERSONA_PROMPT_PART_FIELDS.map((field) =>
          modal.fields.getTextInputValue(buildConfigModalFieldId(field, route.nonce)),
        ),
        4000,
      );
      const result = await dependencies.operations.setPrompt({ persona, serverDiscId: scope.serverDiscId, prompt });
      return result.status === "success"
        ? {
            receipt: receipt(
              locale,
              "success",
              "commands.teach.personaprompt.success_title",
              "commands.teach.personaprompt.success_description",
              { persona_name: persona.persona_nickname },
            ),
            telemetry: "server-config.workspace.persona-prompt.set",
          }
        : { receipt: receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail")) };
    }

    case "prompt-remove": {
      if (!hasPersonaPrompt(persona)) {
        return {
          receipt: receipt(
            locale,
            "warning",
            "commands.forget.personaprompt.no_prompt_title",
            "commands.forget.personaprompt.no_prompt_description",
          ),
        };
      }
      const preview = buildTextPreview(persona.persona_prompt);
      const result = await dependencies.operations.removePrompt({ persona, serverDiscId: scope.serverDiscId });
      if (result.status === "no-prompt") {
        return {
          receipt: receipt(
            locale,
            "warning",
            "commands.forget.personaprompt.no_prompt_title",
            "commands.forget.personaprompt.no_prompt_description",
          ),
        };
      }
      if (result.status !== "success") {
        return { receipt: receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail")) };
      }
      const detail = localizer(
        locale,
        preview.totalChars > 0
          ? "commands.forget.personaprompt.success_description_with_prompt"
          : "commands.forget.personaprompt.success_description",
        {
          persona_name: persona.persona_nickname,
          removed_prompt: preview.text,
        },
      );
      return {
        receipt: {
          tone: "success",
          heading: localizer(locale, "commands.forget.personaprompt.success_title"),
          detail: preview.truncated
            ? `${detail}\n-# ${localizer(locale, textPreviewFooterKey(preview) as string, textPreviewFooterVars(preview))}`
            : detail,
        },
        telemetry: "server-config.workspace.persona-prompt.remove",
      };
    }

    case "context-note-submit": {
      const modal = interaction as ModalSubmitInteraction;
      const rawNote = modal.fields
        .getTextInputValue(buildConfigModalFieldId(CONFIG_CONTEXT_NOTE_TEXT_FIELD, route.nonce))
        .trim();
      const rawDepth = modal.fields
        .getTextInputValue(buildConfigModalFieldId(CONFIG_CONTEXT_NOTE_DEPTH_FIELD, route.nonce))
        .trim();
      const result = await dependencies.operations.setContextNote({
        persona,
        serverDiscId: scope.serverDiscId,
        rawNote,
        rawDepth,
      });
      if (result.status === "invalid-depth") {
        return {
          receipt: receipt(
            locale,
            "error",
            "commands.config.context-note.set.invalid_depth_title",
            "commands.config.context-note.set.invalid_depth_description",
          ),
        };
      }
      if (result.status !== "success") {
        return { receipt: receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail")) };
      }
      const note = rawNote || null;
      const depth = note ? Number.parseInt(rawDepth, 10) : 0;
      const preview = buildTextPreview(note);
      return {
        receipt: {
          tone: "success",
          heading: localizer(
            locale,
            note
              ? "commands.config.context-note.set.success_set_title"
              : "commands.config.context-note.set.success_removed_title",
          ),
          detail: localizer(
            locale,
            note
              ? "commands.config.context-note.set.success_set_description"
              : "commands.config.context-note.set.success_removed_description",
            note
              ? { scope: persona.persona_nickname, depth, preview: preview.text }
              : { scope: persona.persona_nickname },
          ),
        },
        telemetry: "server-config.workspace.persona-context-note.set",
      };
    }

    case "humanizer-select":
    case "humanizer-submit": {
      const selectedValue =
        route.action === "humanizer-submit"
          ? (dependencies.takeSelectValue(
              (interaction as ModalSubmitInteraction).id,
              buildConfigModalFieldId(CONFIG_HUMANIZER_FIELD, route.nonce),
            ) ?? "")
          : interaction.isStringSelectMenu()
            ? (interaction.values[0] ?? "")
            : "";
      const value = selectedValue === HUMANIZER_INHERIT_VALUE ? null : Number.parseInt(selectedValue, 10);
      const result = await dependencies.operations.setHumanizerOverride({
        persona,
        serverDiscId: scope.serverDiscId,
        value,
      });
      if (result.status === "invalid-value") {
        return {
          receipt: receipt(
            locale,
            "error",
            key("invalid_input_heading"),
            "commands.config.humanizer.invalid_value_description",
            { min: HUMANIZER_MIN, max: HUMANIZER_MAX },
          ),
        };
      }
      if (result.status === "unchanged") {
        return {
          receipt: receipt(
            locale,
            "info",
            "commands.config.humanizer.already_set_title",
            "commands.config.humanizer.persona_already_set_description",
            { persona: persona.persona_nickname, value: getHumanizerLabel(locale, value) },
          ),
        };
      }
      if (result.status !== "success") {
        return { receipt: receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail")) };
      }
      return {
        receipt: receipt(
          locale,
          "success",
          "commands.config.humanizer.persona_success_title",
          "commands.config.humanizer.persona_success_description",
          {
            persona: persona.persona_nickname,
            value: getHumanizerLabel(locale, value),
            previous_value: getHumanizerLabel(locale, persona.humanizer_degree_override ?? null),
          },
        ),
        telemetry: "server-config.workspace.persona-humanizer.set",
      };
    }

    case "text-override-model-select":
    case "text-override-model-submit": {
      const selectedCodename =
        route.action === "text-override-model-submit"
          ? (dependencies.takeSelectValue(
              (interaction as ModalSubmitInteraction).id,
              buildConfigModalFieldId(CONFIG_TEXT_OVERRIDE_MODEL_FIELD, route.nonce),
            ) ?? "")
          : interaction.isStringSelectMenu()
            ? (interaction.values[0] ?? "")
            : "";
      const savedProviders = await dependencies.loadSavedTextProviders(persona.server_id);
      if (savedProviders.length === 0) {
        return {
          receipt: receipt(
            locale,
            "error",
            "commands.model.providerPicker.no_providers_title",
            "commands.model.providerPicker.no_providers_description",
          ),
        };
      }
      const provider = savedProviders.find(
        (saved) => saved.provider.toLowerCase() === route.provider.toLowerCase(),
      )?.provider;
      if (!provider) return { receipt: staleReceipt(locale) };

      const availableModels = await dependencies.loadPersonaTextModels(provider, persona.server_id);
      const selectedModel = availableModels.find((model) => model.llm_codename === selectedCodename) ?? null;
      if (!selectedModel?.llm_id) {
        return {
          receipt: receipt(
            locale,
            "error",
            "commands.model.text.invalid_model_title",
            "commands.model.text.invalid_model_description",
          ),
        };
      }
      if (selectedModel.llm_codename === "other-model") {
        return {
          receipt: receipt(
            locale,
            "info",
            "general.openrouter_model_moved_title",
            "general.openrouter_model_moved_description",
          ),
        };
      }
      const result = await dependencies.operations.setTextModelOverride({
        scope: "persona",
        personaId,
        llmId: selectedModel.llm_id,
        serverDiscId: scope.serverDiscId,
      });
      return result.status === "success"
        ? {
            receipt: receipt(
              locale,
              "success",
              "commands.model.text.success_title",
              "commands.model.text.scope_set_persona_success",
              { persona: persona.persona_nickname, model: selectedModel.llm_codename },
            ),
            telemetry: "server-config.workspace.persona-text-model.set",
          }
        : { receipt: receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail")) };
    }

    case "text-override-clear": {
      const result = await dependencies.operations.setTextModelOverride({
        scope: "persona",
        personaId,
        llmId: null,
        serverDiscId: scope.serverDiscId,
      });
      return result.status === "success"
        ? {
            receipt: receipt(
              locale,
              "success",
              "commands.config.panel.text_override_cleared_heading",
              "commands.config.panel.text_override_cleared_detail",
              { persona: persona.persona_nickname },
            ),
            telemetry: "server-config.workspace.persona-text-model.clear",
          }
        : { receipt: receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail")) };
    }

    case "sprite-add-submit":
    case "sprite-edit-submit": {
      const modal = interaction as ModalSubmitInteraction;
      const identityValues = dependencies.takeCheckboxValues(
        modal.id,
        buildConfigModalFieldId(CONFIG_SPRITE_IDENTITY_FIELD, route.nonce),
      );
      const common = {
        persona,
        serverDiscId: scope.serverDiscId,
        rawName: modal.fields.getTextInputValue(buildConfigModalFieldId(CONFIG_SPRITE_NAME_FIELD, route.nonce)),
        rawInstructions: modal.fields.getTextInputValue(
          buildConfigModalFieldId(CONFIG_SPRITE_INSTRUCTIONS_FIELD, route.nonce),
        ),
        isIdentity: identityValues?.includes(CONFIG_SPRITE_IDENTITY_OPTION_VALUE) === true,
        attachment:
          dependencies.takeFileUpload(modal.id, buildConfigModalFieldId(CONFIG_SPRITE_IMAGE_FIELD, route.nonce)) ??
          null,
      };

      if (route.action === "sprite-add-submit") {
        const result = await dependencies.spriteOperations.addSprite(common);
        if (result.status === "success") {
          return {
            receipt: receipt(
              locale,
              "success",
              result.replaced ? key("sprite_replaced_heading") : key("sprite_added_heading"),
              result.replaced ? key("sprite_replaced_detail") : key("sprite_added_detail"),
              { persona: persona.persona_nickname, sprite: result.spriteName },
            ),
            telemetry: "server-config.workspace.persona-sprite.add",
          };
        }
        if (result.status === "limit-reached") {
          return {
            receipt: receipt(locale, "warning", key("sprite_limit_heading"), key("sprite_limit_detail"), {
              persona: persona.persona_nickname,
              max_count: PERSONA_SPRITE_LIMITS.MAX_PER_PERSONA,
            }),
          };
        }
        return { receipt: spriteFailureReceipt(locale, result) };
      }

      const sprites = await dependencies.loadPersonaSprites(personaId);
      const target = resolveSpriteAtIndex(sprites, personaId, route.index, route.fp);
      if (!target) return { receipt: staleReceipt(locale) };

      const result = await dependencies.spriteOperations.editSprite({
        ...common,
        currentSpriteKey: target.sprite_key,
      });
      if (result.status === "success") {
        return {
          receipt: receipt(locale, "success", key("sprite_edited_heading"), key("sprite_edited_detail"), {
            persona: persona.persona_nickname,
            sprite: result.spriteName,
          }),
          telemetry: "server-config.workspace.persona-sprite.edit",
        };
      }
      if (result.status === "duplicate-name") {
        return {
          receipt: receipt(locale, "warning", key("sprite_duplicate_heading"), key("sprite_duplicate_detail"), {
            sprite: result.spriteName,
          }),
        };
      }
      if (result.status === "no-changes") {
        return { receipt: receipt(locale, "info", key("sprite_no_changes_heading"), key("sprite_no_changes_detail")) };
      }
      if (result.status === "not-found") return { receipt: staleReceipt(locale) };
      return { receipt: spriteFailureReceipt(locale, result) };
    }

    case "sprite-remove-confirm": {
      const sprites = await dependencies.loadPersonaSprites(personaId);
      const target = resolveSpriteAtIndex(sprites, personaId, route.index, route.fp);
      if (!target) return { receipt: staleReceipt(locale) };

      const result = await dependencies.spriteOperations.removeSprite({
        persona,
        serverDiscId: scope.serverDiscId,
        spriteKey: target.sprite_key,
      });
      if (result.status === "success") {
        return {
          receipt: receipt(locale, "success", key("sprite_removed_heading"), key("sprite_removed_detail"), {
            persona: persona.persona_nickname,
            sprite: result.spriteName,
          }),
          telemetry: "server-config.workspace.persona-sprite.remove",
        };
      }
      // A concurrent removal already deleted the row, so this is staleness rather than a failure.
      if (result.status === "not-found") return { receipt: staleReceipt(locale) };
      return { receipt: receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail")) };
    }

    case "sprite-import-submit": {
      const modal = interaction as ModalSubmitInteraction;
      const result = await dependencies.spriteOperations.importSprites({
        persona,
        serverDiscId: scope.serverDiscId,
        // Import quota is reserved per actor, matching `/persona sprites import`, while avatar
        // quota is reserved per workspace.
        quotaKey: interaction.user.id,
        attachment:
          dependencies.takeFileUpload(modal.id, buildConfigModalFieldId(CONFIG_SPRITE_ARCHIVE_FIELD, route.nonce)) ??
          null,
      });
      if (result.status === "success") {
        return {
          receipt: receipt(
            locale,
            result.failed > 0 ? "warning" : "success",
            key("sprite_imported_heading"),
            key("sprite_imported_detail"),
            {
              persona: persona.persona_nickname,
              created_count: result.created,
              replaced_count: result.replaced,
              failed_count: result.failed,
            },
          ),
          telemetry: "server-config.workspace.persona-sprite.import",
        };
      }
      if (result.status === "limit-reached") {
        return {
          receipt: receipt(locale, "warning", key("sprite_limit_heading"), key("sprite_import_limit_detail"), {
            persona: persona.persona_nickname,
            max_count: PERSONA_SPRITE_LIMITS.MAX_PER_PERSONA,
            current_count: result.currentCount,
            incoming_count: result.incomingCount,
          }),
        };
      }
      if (result.status === "invalid-entry-name" || result.status === "invalid-entry-image") {
        return {
          receipt: receipt(
            locale,
            "error",
            key("sprite_archive_invalid_heading"),
            result.status === "invalid-entry-name"
              ? key("sprite_archive_entry_name_detail")
              : key("sprite_archive_entry_image_detail"),
            { sprite: result.spriteName },
          ),
        };
      }
      if (result.status === "invalid-archive" || result.status === "invalid-file") {
        return {
          receipt: receipt(
            locale,
            "error",
            key("sprite_archive_invalid_heading"),
            key("sprite_archive_invalid_detail"),
          ),
        };
      }
      if (result.status === "file-too-large") {
        return {
          receipt: receipt(
            locale,
            "error",
            key("sprite_archive_invalid_heading"),
            key("sprite_archive_too_large_detail"),
            {
              max_size: IMPORT_LIMITS.MAX_PERSONA_IMPORT_SIZE_MB,
            },
          ),
        };
      }
      return { receipt: spriteFailureReceipt(locale, result) };
    }

    case "stm-edit-submit": {
      const modal = interaction as ModalSubmitInteraction;
      const memoryView = await dependencies.loadPersonaMemoryView(interaction, scope, persona);
      if (!memoryView.channelId) return { receipt: staleReceipt(locale) };
      const channel = interaction.channel;
      const channelName = channel && "name" in channel && typeof channel.name === "string" ? channel.name : undefined;
      const parentChannelId =
        channel && "parentId" in channel && typeof channel.parentId === "string" ? channel.parentId : undefined;

      const isCategoryMode = !(
        memoryView.stmCategories.length === 1 && memoryView.stmCategories[0]?.label.toLowerCase() === "summary"
      );
      const slugMap = buildSlugMap(memoryView.stmCategories);
      if (isCategoryMode) {
        const categories: Record<string, string> = {};
        for (const [slug] of Array.from(slugMap).slice(0, 5)) {
          const value = modal.fields.getTextInputValue(
            buildConfigModalFieldId(`${CONFIG_STM_CATEGORY_INPUT_PREFIX}${slug}`, route.nonce),
          );
          if (value.trim()) categories[slug] = value.trim().slice(0, 1500);
        }
        const result = await dependencies.operations.editStm({
          userDiscId: interaction.user.id,
          channelId: memoryView.channelId,
          serverDiscId: scope.guildId ?? "DM",
          serverName: interaction.guild?.name,
          channelName,
          parentChannelId,
          personaId: persona.persona_id as number,
          personaLineageId: persona.persona_lineage_id ?? 0,
          mode: "categories",
          categories,
        });
        return result.status === "success"
          ? {
              receipt: receipt(locale, "success", key("stm_success_heading"), key("stm_success_detail")),
              telemetry: "server-config.workspace.persona-stm.edit",
            }
          : { receipt: receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail")) };
      }

      const summarySlug = Array.from(slugMap.keys())[0];
      const summary = summarySlug
        ? modal.fields.getTextInputValue(
            buildConfigModalFieldId(`${CONFIG_STM_CATEGORY_INPUT_PREFIX}${summarySlug}`, route.nonce),
          )
        : "";
      // Summary cache updates are synchronous, so their durable persist is intentionally not awaited before repaint.
      const result = await dependencies.operations.editStm({
        userDiscId: interaction.user.id,
        channelId: memoryView.channelId,
        serverDiscId: scope.guildId ?? "DM",
        serverName: interaction.guild?.name,
        channelName,
        parentChannelId,
        personaId: persona.persona_id as number,
        personaLineageId: persona.persona_lineage_id ?? 0,
        mode: "summary",
        summary: summary.trim().slice(0, 1500),
      });
      return result.status === "success"
        ? {
            receipt: receipt(locale, "success", key("stm_success_heading"), key("stm_success_detail")),
            telemetry: "server-config.workspace.persona-stm.edit",
          }
        : { receipt: receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail")) };
    }

    case "conditioning-submit": {
      const modal = interaction as ModalSubmitInteraction;
      const memoryView = await dependencies.loadPersonaMemoryView(interaction, scope, persona);
      const presentedGroups = memoryView.conditioningGroups
        .filter(hasManageableReason)
        .slice(0, CONFIG_CONDITIONING_CHECKBOX_CAPACITY);
      if (computeConditioningRemoveFingerprint(persona.persona_id as number, presentedGroups) !== route.fp) {
        return { receipt: staleReceipt(locale) };
      }

      const checked = new Set<number>();
      const groupCount = Math.ceil(presentedGroups.length / CONFIG_CONDITIONING_CHECKBOX_GROUP_SIZE);
      let hasCheckboxEvidence = false;
      for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
        const values = dependencies.takeCheckboxValues(
          modal.id,
          buildConditioningCheckboxGroupId(groupIndex, route.nonce),
        );
        if (values === undefined) continue;
        hasCheckboxEvidence = true;
        for (const value of values) {
          const parsed = Number.parseInt(value, 10);
          if (Number.isInteger(parsed)) checked.add(parsed);
        }
      }
      if (!hasCheckboxEvidence) return { receipt: staleReceipt(locale) };

      const groupsToDelete = presentedGroups
        .filter((_group, index) => !checked.has(index))
        .map(({ conditioningType, actionKey, reasonNormalized }) => ({
          conditioningType,
          actionKey,
          reasonNormalized,
        }));
      const result = await dependencies.operations.removeConditioning({
        serverId: persona.server_id,
        personaLineageId: persona.persona_lineage_id ?? 0,
        groups: groupsToDelete,
      });
      if (result.status === "success") {
        return {
          receipt: receipt(locale, "success", key("conditioning_success_heading"), key("conditioning_success_detail"), {
            count: groupsToDelete.length,
          }),
          telemetry: "server-config.workspace.persona-conditioning.remove",
        };
      }
      return {
        receipt:
          result.status === "no-removals"
            ? receipt(locale, "info", key("conditioning_no_changes_heading"), key("conditioning_no_changes_detail"))
            : receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail")),
      };
    }

    case "attribute-add-submit": {
      const modal = interaction as ModalSubmitInteraction;
      const checkboxValues = dependencies.takeCheckboxValues(
        modal.id,
        buildConfigModalFieldId(CONFIG_ATTRIBUTE_PUBLIC_FIELD, route.nonce),
      );
      const result = await dependencies.operations.addAttributes({
        persona,
        serverDiscId: scope.serverDiscId,
        typedAttribute: modal.fields.getTextInputValue(
          buildConfigModalFieldId(CONFIG_ATTRIBUTE_INPUT_FIELD, route.nonce),
        ),
        uploadedFile: dependencies.takeFileUpload(
          modal.id,
          buildConfigModalFieldId(CONFIG_ATTRIBUTE_FILE_FIELD, route.nonce),
        ),
        isPublic: checkboxValues?.includes("public") === true || checkboxValues?.includes("true") === true,
      });
      switch (result.status) {
        case "success":
          return {
            receipt: receipt(
              locale,
              "success",
              key("attribute_add_success_heading"),
              key("attribute_add_success_detail"),
              { count: result.addedAttributes.length },
            ),
            telemetry: "server-config.workspace.persona-attribute.add",
            collectionSelection: {
              family: "attribute",
              selectedIndex: result.selectedIndex,
              pageStart:
                Math.floor(result.selectedIndex / CONFIG_PERSONA_COLLECTION_PAGE_SIZE) *
                CONFIG_PERSONA_COLLECTION_PAGE_SIZE,
            },
          };
        case "invalid-file":
          return {
            receipt: receipt(
              locale,
              "error",
              key("invalid_input_heading"),
              result.error === "invalid_format"
                ? key("attribute_file_invalid_detail")
                : result.error === "file_too_large"
                  ? key("attribute_file_too_large_detail")
                  : key("attribute_file_download_detail"),
            ),
          };
        case "no-input":
          return { receipt: receipt(locale, "error", key("invalid_input_heading"), key("attribute_no_input_detail")) };
        case "content-too-long":
          return {
            receipt: receipt(locale, "error", key("invalid_input_heading"), key("attribute_too_long_detail"), {
              max: result.maxAllowed,
            }),
          };
        case "duplicate":
          return { receipt: receipt(locale, "warning", key("no_changes_heading"), key("attribute_duplicate_detail")) };
        case "limit-exceeded":
          return {
            receipt: receipt(
              locale,
              "error",
              key("invalid_input_heading"),
              result.batch ? key("attribute_batch_limit_detail") : key("attribute_limit_detail"),
              result.batch
                ? { available: Math.max(0, result.maxAllowed - result.currentCount) }
                : { current: result.currentCount, max: result.maxAllowed },
            ),
          };
        default:
          return { receipt: receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail")) };
      }
    }

    case "attribute-edit-submit": {
      const modal = interaction as ModalSubmitInteraction;
      const attribute = persona.attribute_list?.[route.index];
      const currentIsPublic =
        persona.persona_attributes?.find((candidate) => candidate.attribute_order === route.index + 1)?.is_public ??
        false;
      if (
        attribute === undefined ||
        computeAttributeFingerprint(persona.persona_id as number, route.index, attribute, currentIsPublic) !== route.fp
      ) {
        return { receipt: staleReceipt(locale) };
      }

      const checkboxValues = dependencies.takeCheckboxValues(
        modal.id,
        buildConfigModalFieldId(CONFIG_ATTRIBUTE_PUBLIC_FIELD, route.nonce),
      );
      const editedAttribute = combineModalPromptParts(
        [
          modal.fields.getTextInputValue(buildConfigModalFieldId("attribute_part1", route.nonce)).trim(),
          modal.fields.getTextInputValue(buildConfigModalFieldId("attribute_part2", route.nonce)).trim(),
        ],
        4000,
      );
      const result = await dependencies.operations.editAttribute({
        persona,
        serverDiscId: scope.serverDiscId,
        index: route.index,
        newAttribute: editedAttribute,
        isPublic:
          checkboxValues === undefined
            ? undefined
            : checkboxValues.includes("public") || checkboxValues.includes("true"),
      });
      switch (result.status) {
        case "success":
          return {
            receipt: receipt(
              locale,
              "success",
              key("attribute_edit_success_heading"),
              key("attribute_edit_success_detail"),
            ),
            telemetry: "server-config.workspace.persona-attribute.edit",
            collectionSelection: {
              family: "attribute",
              selectedIndex: route.index,
              pageStart:
                Math.floor(route.index / CONFIG_PERSONA_COLLECTION_PAGE_SIZE) * CONFIG_PERSONA_COLLECTION_PAGE_SIZE,
            },
          };
        case "unchanged":
          return { receipt: receipt(locale, "info", key("no_changes_heading"), key("attribute_edit_success_detail")) };
        case "content-too-long":
          return {
            receipt: receipt(locale, "error", key("invalid_input_heading"), key("attribute_too_long_detail"), {
              max: result.maxAllowed,
            }),
          };
        case "duplicate":
          return { receipt: receipt(locale, "warning", key("no_changes_heading"), key("attribute_duplicate_detail")) };
        default:
          return { receipt: receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail")) };
      }
    }

    case "attribute-remove": {
      const attribute = persona.attribute_list?.[route.index];
      const currentIsPublic =
        persona.persona_attributes?.find((candidate) => candidate.attribute_order === route.index + 1)?.is_public ??
        false;
      if (
        attribute === undefined ||
        computeAttributeFingerprint(persona.persona_id as number, route.index, attribute, currentIsPublic) !== route.fp
      ) {
        return { receipt: staleReceipt(locale) };
      }
      const result = await dependencies.operations.removeAttribute({
        persona,
        serverDiscId: scope.serverDiscId,
        index: route.index,
      });
      if (result.status === "success") {
        return {
          receipt: receipt(
            locale,
            "success",
            key("attribute_remove_success_heading"),
            key("attribute_remove_success_detail"),
          ),
          telemetry: "server-config.workspace.persona-attribute.remove",
          collectionSelection: {
            family: "attribute",
            pageStart:
              Math.floor(route.index / CONFIG_PERSONA_COLLECTION_PAGE_SIZE) * CONFIG_PERSONA_COLLECTION_PAGE_SIZE,
          },
        };
      }
      return { receipt: receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail")) };
    }

    case "dialogue-add-submit": {
      const modal = interaction as ModalSubmitInteraction;
      const result = await dependencies.operations.addSampleDialogues({
        persona,
        serverDiscId: scope.serverDiscId,
        typedUserInput: modal.fields.getTextInputValue(
          buildConfigModalFieldId(CONFIG_DIALOGUE_USER_INPUT_FIELD, route.nonce),
        ),
        typedBotInput: modal.fields.getTextInputValue(
          buildConfigModalFieldId(CONFIG_DIALOGUE_BOT_INPUT_FIELD, route.nonce),
        ),
        uploadedFile: dependencies.takeFileUpload(
          modal.id,
          buildConfigModalFieldId(CONFIG_DIALOGUE_FILE_FIELD, route.nonce),
        ),
      });
      switch (result.status) {
        case "success":
          return {
            receipt: receipt(
              locale,
              "success",
              key("dialogue_add_success_heading"),
              key("dialogue_add_success_detail"),
              { count: result.addedDialogues.length },
            ),
            telemetry: "server-config.workspace.persona-dialogue.add",
            collectionSelection: {
              family: "dialogue",
              selectedIndex: result.selectedIndex,
              pageStart:
                Math.floor(result.selectedIndex / CONFIG_PERSONA_COLLECTION_PAGE_SIZE) *
                CONFIG_PERSONA_COLLECTION_PAGE_SIZE,
            },
          };
        case "invalid-file":
          return {
            receipt: receipt(
              locale,
              "error",
              key("invalid_input_heading"),
              result.error === "invalid_format"
                ? key("dialogue_file_invalid_detail")
                : result.error === "file_too_large"
                  ? key("dialogue_file_too_large_detail")
                  : key("dialogue_file_download_detail"),
            ),
          };
        case "manual-pair-required":
          return {
            receipt: receipt(locale, "error", key("invalid_input_heading"), key("dialogue_manual_pair_detail")),
          };
        case "invalid-batch":
          return {
            receipt: receipt(locale, "error", key("invalid_input_heading"), key("dialogue_batch_invalid_detail"), {
              line: result.lineNumber,
              prefix: result.invalidBotPrefix ? "{bot}:" : "{user}:",
            }),
          };
        case "no-input":
          return { receipt: receipt(locale, "error", key("invalid_input_heading"), key("dialogue_no_input_detail")) };
        case "user-too-long":
          return {
            receipt: receipt(locale, "error", key("invalid_input_heading"), key("dialogue_user_too_long_detail"), {
              max: result.maxAllowed,
            }),
          };
        case "bot-too-long":
          return {
            receipt: receipt(locale, "error", key("invalid_input_heading"), key("dialogue_bot_too_long_detail"), {
              max: result.maxAllowed,
            }),
          };
        case "duplicate":
          return { receipt: receipt(locale, "warning", key("no_changes_heading"), key("dialogue_duplicate_detail")) };
        case "limit-exceeded":
          return {
            receipt: receipt(
              locale,
              "error",
              key("invalid_input_heading"),
              result.batch ? key("dialogue_batch_limit_detail") : key("dialogue_limit_detail"),
              result.batch
                ? { available: Math.max(0, result.maxAllowed - result.currentCount) }
                : { current: result.currentCount, max: result.maxAllowed },
            ),
          };
        default:
          return { receipt: receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail")) };
      }
    }

    case "dialogue-edit-submit": {
      const modal = interaction as ModalSubmitInteraction;
      if (!(await repairDialogueState(scope, persona, dependencies))) {
        return { receipt: staleReceipt(locale) };
      }
      const input = persona.sample_dialogues_in?.[route.index];
      const output = persona.sample_dialogues_out?.[route.index];
      if (
        input === undefined ||
        output === undefined ||
        computeDialogueFingerprint(persona.persona_id as number, route.index, input, output) !== route.fp
      ) {
        return { receipt: staleReceipt(locale) };
      }
      const editedInput = combineModalPromptParts(
        [
          modal.fields.getTextInputValue(buildConfigModalFieldId("user_input_part1", route.nonce)).trim(),
          modal.fields.getTextInputValue(buildConfigModalFieldId("user_input_part2", route.nonce)).trim(),
        ],
        4000,
      );
      const editedOutput = combineModalPromptParts(
        [
          modal.fields.getTextInputValue(buildConfigModalFieldId("bot_input_part1", route.nonce)).trim(),
          modal.fields.getTextInputValue(buildConfigModalFieldId("bot_input_part2", route.nonce)).trim(),
        ],
        4000,
      );
      const result = await dependencies.operations.editSampleDialogue({
        persona,
        serverDiscId: scope.serverDiscId,
        index: route.index,
        newInput: editedInput,
        newOutput: editedOutput,
      });
      switch (result.status) {
        case "success":
          return {
            receipt: receipt(
              locale,
              "success",
              key("dialogue_edit_success_heading"),
              key("dialogue_edit_success_detail"),
            ),
            telemetry: "server-config.workspace.persona-dialogue.edit",
            collectionSelection: {
              family: "dialogue",
              selectedIndex: route.index,
              pageStart:
                Math.floor(route.index / CONFIG_PERSONA_COLLECTION_PAGE_SIZE) * CONFIG_PERSONA_COLLECTION_PAGE_SIZE,
            },
          };
        case "unchanged":
          return { receipt: receipt(locale, "info", key("no_changes_heading"), key("dialogue_edit_success_detail")) };
        case "user-too-long":
          return {
            receipt: receipt(locale, "error", key("invalid_input_heading"), key("dialogue_user_too_long_detail"), {
              max: result.maxAllowed,
            }),
          };
        case "bot-too-long":
          return {
            receipt: receipt(locale, "error", key("invalid_input_heading"), key("dialogue_bot_too_long_detail"), {
              max: result.maxAllowed,
            }),
          };
        case "duplicate":
          return { receipt: receipt(locale, "warning", key("no_changes_heading"), key("dialogue_duplicate_detail")) };
        default:
          return { receipt: receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail")) };
      }
    }

    case "dialogue-remove": {
      if (!(await repairDialogueState(scope, persona, dependencies))) {
        return { receipt: staleReceipt(locale) };
      }
      const input = persona.sample_dialogues_in?.[route.index];
      const output = persona.sample_dialogues_out?.[route.index];
      if (
        input === undefined ||
        output === undefined ||
        computeDialogueFingerprint(persona.persona_id as number, route.index, input, output) !== route.fp
      ) {
        return { receipt: staleReceipt(locale) };
      }
      const result = await dependencies.operations.removeSampleDialogue({
        persona,
        serverDiscId: scope.serverDiscId,
        index: route.index,
      });
      if (result.status === "success") {
        return {
          receipt: receipt(
            locale,
            "success",
            key("dialogue_remove_success_heading"),
            key("dialogue_remove_success_detail"),
          ),
          telemetry: "server-config.workspace.persona-dialogue.remove",
          collectionSelection: {
            family: "dialogue",
            pageStart:
              Math.floor(route.index / CONFIG_PERSONA_COLLECTION_PAGE_SIZE) * CONFIG_PERSONA_COLLECTION_PAGE_SIZE,
          },
        };
      }
      return { receipt: receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail")) };
    }

    case "rename-submit": {
      const modal = interaction as ModalSubmitInteraction;
      const newNickname = modal.fields.getTextInputValue(buildConfigModalFieldId("nickname", route.nonce));
      const result = await dependencies.operations.rename({
        persona,
        serverDiscId: scope.serverDiscId,
        newNickname,
        guildIdentity,
      });
      switch (result.status) {
        case "success":
          return {
            receipt: receipt(locale, "success", key("rename_success_heading"), key("rename_success_detail"), {
              old: result.oldNickname,
              name: result.newNickname,
            }),
            telemetry: "server-config.workspace.persona.rename",
          };
        case "trigger-write-failed":
          return {
            receipt: receipt(locale, "warning", key("rename_success_heading"), key("rename_partial_detail"), {
              old: result.oldNickname,
              name: result.newNickname,
            }),
            telemetry: "server-config.workspace.persona.rename",
          };
        case "unchanged":
          return {
            receipt: receipt(locale, "info", key("no_changes_heading"), key("rename_unchanged_detail"), {
              name: result.nickname,
            }),
          };
        case "name-conflict":
          return {
            receipt: receipt(locale, "error", key("rename_conflict_heading"), key("rename_conflict_detail"), {
              name: result.nickname,
            }),
          };
        case "invalid-length":
          return {
            receipt: receipt(locale, "error", key("invalid_input_heading"), key("rename_length_detail")),
          };
        default:
          return { receipt: receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail")) };
      }
    }

    case "naming-submit": {
      const modal = interaction as ModalSubmitInteraction;
      const field = (name: string) => modal.fields.getTextInputValue(buildConfigModalFieldId(name, route.nonce));
      const result = await dependencies.operations.setNamingHabits({
        persona,
        serverDiscId: scope.serverDiscId,
        style: route.style,
        prefix: field("prefix"),
        suffix: field("suffix"),
        addressTerm: field("term"),
      });
      if (result.status === "success") {
        return {
          receipt: receipt(locale, "success", key("naming_success_heading"), key("naming_success_detail"), {
            name: persona.persona_nickname,
          }),
          telemetry: "server-config.workspace.persona-naming.set",
        };
      }
      return {
        receipt:
          result.status === "invalid-config"
            ? receipt(locale, "error", key("naming_invalid_heading"), key("naming_invalid_detail"))
            : receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail")),
      };
    }

    case "trigger-add-submit": {
      const modal = interaction as ModalSubmitInteraction;
      const rawInput = modal.fields.getTextInputValue(buildConfigModalFieldId("triggers", route.nonce));
      const result = await dependencies.operations.addTriggers({
        persona,
        serverDiscId: scope.serverDiscId,
        rawInput,
      });
      switch (result.status) {
        case "success":
          return {
            receipt: receipt(locale, "success", key("trigger_add_success_heading"), key("trigger_add_success_detail"), {
              words: result.addedTriggers.join(", "),
              total: result.totalCount,
            }),
            telemetry: "server-config.workspace.persona-trigger.add",
          };
        case "already-exists":
          return {
            receipt: receipt(locale, "info", key("no_changes_heading"), key("trigger_add_exists_detail"), {
              words: result.attempted.join(", "),
            }),
          };
        case "limit-exceeded":
          return {
            receipt: receipt(locale, "error", key("trigger_add_limit_heading"), key("trigger_add_limit_detail"), {
              current: result.currentCount,
              max: result.maxAllowed,
            }),
          };
        case "too-short":
          return {
            receipt: receipt(locale, "error", key("invalid_input_heading"), key("trigger_add_short_detail")),
          };
        case "content-too-long":
          return {
            receipt: receipt(locale, "error", key("invalid_input_heading"), key("trigger_add_long_detail"), {
              max: result.maxLength,
            }),
          };
        case "no-triggers":
          return {
            receipt: receipt(locale, "error", key("invalid_input_heading"), key("trigger_add_empty_detail")),
          };
        default:
          return { receipt: receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail")) };
      }
    }

    case "trigger-remove-submit": {
      const modal = interaction as ModalSubmitInteraction;
      const triggerWords = persona.trigger_words ?? [];
      // Unchecked-means-remove derives its removal set from positions in the list the modal
      // presented, so a list that changed under the open modal must fail stale rather than delete a
      // different word than the one the user unchecked.
      if (computeTriggerRemoveFingerprint(persona.persona_id as number, triggerWords) !== route.fp) {
        return { receipt: staleReceipt(locale) };
      }

      const checked = new Set<number>();
      const presentedCount = Math.min(triggerWords.length, CONFIG_TRIGGER_CHECKBOX_CAPACITY);
      const groupCount = Math.ceil(presentedCount / CONFIG_TRIGGER_CHECKBOX_GROUP_SIZE);
      // An undefined group means no checkbox data reached this submit at all, which is a different
      // fact from an empty array. Unchecked-means-remove would read that absence as "the user
      // cleared every box" and delete every presented word, so a submit is acted on only when at
      // least one group actually arrived.
      let hasCheckboxEvidence = false;
      for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
        const values = dependencies.takeCheckboxValues(
          modal.id,
          buildTriggerRemoveCheckboxGroupId(groupIndex, route.nonce),
        );
        if (values === undefined) continue;
        hasCheckboxEvidence = true;
        for (const value of values) {
          const parsed = Number.parseInt(value, 10);
          if (Number.isInteger(parsed)) checked.add(parsed);
        }
      }
      if (!hasCheckboxEvidence) return { receipt: staleReceipt(locale) };

      const removedIndices = triggerWords.flatMap((_, index) =>
        index < presentedCount && !checked.has(index) ? [index] : [],
      );

      const result = await dependencies.operations.removeTriggers({
        persona,
        serverDiscId: scope.serverDiscId,
        removedIndices,
      });
      if (result.status === "success") {
        return {
          receipt: receipt(
            locale,
            "success",
            key("trigger_remove_success_heading"),
            key("trigger_remove_success_detail"),
            { words: result.removedTriggers.join(", ") },
          ),
          telemetry: "server-config.workspace.persona-trigger.remove",
        };
      }
      return {
        receipt:
          result.status === "no-removals"
            ? receipt(locale, "info", key("no_changes_heading"), key("trigger_remove_none_detail"))
            : receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail")),
      };
    }

    case "avatar-submit": {
      const modal = interaction as ModalSubmitInteraction;
      if (!scope.guildId || !guildIdentity) return null;
      const attachment = dependencies.takeAvatarUpload(modal.id, route.nonce) ?? null;
      const result = await dependencies.operations.replaceAvatar({
        persona,
        serverDiscId: scope.serverDiscId,
        guildId: scope.guildId,
        attachment,
        guildIdentity,
      });
      switch (result.status) {
        case "success":
          return {
            receipt: receipt(
              locale,
              "success",
              key("avatar_success_heading"),
              result.cleared ? key("avatar_cleared_detail") : key("avatar_success_detail"),
              { name: persona.persona_nickname },
            ),
            telemetry: "server-config.workspace.persona-avatar.set",
          };
        case "memory-critical":
          return { receipt: receipt(locale, "error", key("avatar_busy_heading"), key("avatar_busy_detail")) };
        case "quota-exceeded":
          return { receipt: receipt(locale, "error", key("avatar_quota_heading"), key("avatar_quota_detail")) };
        case "invalid-image":
          return {
            receipt: receipt(
              locale,
              "error",
              key("invalid_input_heading"),
              result.reason === "file-too-large" ? key("avatar_too_large_detail") : key("avatar_format_detail"),
            ),
          };
        case "download-failed":
          return { receipt: receipt(locale, "error", key("avatar_failed_heading"), key("avatar_download_detail")) };
        case "conversion-failed":
          return { receipt: receipt(locale, "error", key("avatar_failed_heading"), key("avatar_conversion_detail")) };
        case "guild-avatar-rate-limited":
          return {
            receipt: receipt(locale, "warning", key("avatar_rate_limited_heading"), key("avatar_rate_limited_detail")),
          };
        default:
          return { receipt: receipt(locale, "error", key("avatar_failed_heading"), key("avatar_failed_detail")) };
      }
    }

    case "promote-confirm": {
      if (!scope.guildId || !guildIdentity) return null;
      const mainPersona = scope.personas.find((candidate) => candidate.is_alter !== true) ?? null;
      const result = await dependencies.operations.promoteToMain({
        alterPersona: persona,
        mainPersona,
        serverDiscId: scope.serverDiscId,
        guildId: scope.guildId,
        guildIdentity,
      });
      if (result.status === "success") {
        const degraded = !result.nicknameSynced || (result.avatarAttempted && !result.avatarSynced);
        return {
          receipt: receipt(
            locale,
            degraded ? "warning" : "success",
            key("promote_success_heading"),
            degraded ? key("promote_partial_detail") : key("promote_success_detail"),
            { name: result.newMainNickname, old: result.formerMainNickname },
          ),
          telemetry: "server-config.workspace.persona.promote",
        };
      }
      return {
        receipt:
          result.status === "not-alter" || result.status === "no-main-persona"
            ? staleReceipt(locale)
            : receipt(locale, "error", key("write_failed_heading"), key("write_failed_detail")),
      };
    }
  }

  return null;
}

/**
 * Handles every sprite route that is not a repository write: selection, pagination, the removal
 * confirmation, and Export.
 *
 * Export is the reason this cannot fall through to the generic repaint. The panel is deferred
 * ephemerally like every panel root, so an `editReply` carrying the archive would silently make a
 * public export private. The archive therefore arrives as its own non-ephemeral `followUp` while
 * the panel repaints in place.
 *
 * @returns `handled` when the route is fully served here, `write` when it must continue to the
 *   write path.
 */
async function handleSpriteNavigation(
  interaction: GlobalRoutableInteraction,
  route: ConfigPanelRoute,
  scope: ConfigScope,
  persona: TomoriState,
  selectedPersonaId: number,
  dependencies: ConfigRouteDependencies,
  submittedValue: string | null,
): Promise<"handled" | "write"> {
  const locale = route.locale;
  const repaintSprites = (options: {
    receipt?: PanelReceipt;
    view?: ConfigPanelView;
    spritePageStart?: number;
    selectedSpriteIndex?: number;
    personaSprites?: PersonaSpriteRow[];
  }) =>
    repaint(interaction, {
      locale,
      scope,
      category: "persona",
      page: "sprites",
      selectedPersonaId,
      dependencies,
      ...options,
    });

  switch (route.action) {
    case "sprite-page":
      await repaintSprites({ spritePageStart: route.start });
      return "handled";

    case "sprite-select": {
      const sprites = await dependencies.loadPersonaSprites(selectedPersonaId);
      const selectedIndex = Number(submittedValue);
      const inRange = Number.isSafeInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < sprites.length;
      await repaintSprites({
        personaSprites: sprites,
        selectedSpriteIndex: inRange ? selectedIndex : undefined,
        spritePageStart: inRange
          ? Math.floor(selectedIndex / CONFIG_PERSONA_SPRITE_PAGE_SIZE) * CONFIG_PERSONA_SPRITE_PAGE_SIZE
          : undefined,
      });
      return "handled";
    }

    case "sprite-remove-cancel":
      await repaintSprites({});
      return "handled";

    case "sprite-remove-view": {
      const sprites = await dependencies.loadPersonaSprites(selectedPersonaId);
      const target = resolveSpriteAtIndex(sprites, selectedPersonaId, route.index, route.fp);
      if (!target) {
        await repaintSprites({ personaSprites: sprites, receipt: staleReceipt(locale) });
        return "handled";
      }
      await repaintSprites({
        personaSprites: sprites,
        selectedSpriteIndex: route.index,
        view: {
          kind: "sprite-remove-confirm",
          personaId: selectedPersonaId,
          index: route.index,
          fp: route.fp,
          nonce: dependencies.createNonce(),
        },
      });
      return "handled";
    }

    case "sprite-export": {
      const result = await dependencies.spriteOperations.exportSprites({ persona });
      if (result.status !== "success") {
        await repaintSprites({
          receipt: receipt(
            locale,
            result.status === "memory-critical" ? "error" : "warning",
            "commands.config.panel.sprite_export_failed_heading",
            result.status === "no-sprites"
              ? "commands.config.panel.sprite_export_none_detail"
              : result.status === "all-images-failed"
                ? "commands.config.panel.sprite_export_images_failed_detail"
                : "rate_limit.error_memory_critical_description",
            { persona: persona.persona_nickname },
          ),
        });
        return "handled";
      }

      await interaction.followUp({
        files: [new AttachmentBuilder(result.buffer, { name: result.filename })],
      });
      if (scope.internalServerId) {
        dependencies.recordAction({
          action: "server-config.workspace.persona-sprite.export",
          serverId: scope.internalServerId,
          userDiscId: interaction.user.id,
        });
      }
      await repaintSprites({
        receipt: receipt(
          locale,
          result.skippedCount > 0 ? "warning" : "success",
          "commands.config.panel.sprite_export_heading",
          result.skippedCount > 0
            ? "commands.config.panel.sprite_export_partial_detail"
            : "commands.config.panel.sprite_export_detail",
          {
            persona: persona.persona_nickname,
            sprite_count: result.spriteCount,
            skipped_count: result.skippedCount,
          },
        ),
      });
      return "handled";
    }

    default:
      return "write";
  }
}

export function createConfigInteractionRoute(overrides: Partial<ConfigRouteDependencies> = {}): GlobalInteractionRoute {
  const dependencies: ConfigRouteDependencies = { ...defaultDependencies, ...overrides };

  return {
    namespace: CONFIG_ROUTE_NAMESPACE,
    version: CONFIG_ROUTE_VERSION,
    async execute(_client, interaction, parsed): Promise<void> {
      const route = parseConfigPanelRoute(parsed);
      if (!route) throw new Error(`Malformed config panel route: ${interaction.customId}`);

      // Route dispatch runs against hand-rolled interaction doubles in four sibling suites that
      // predate channel selects, so probe for the guard before calling it.
      const isChannelSelectMenu =
        typeof (interaction as { isChannelSelectMenu?: unknown }).isChannelSelectMenu === "function" &&
        (interaction as { isChannelSelectMenu: () => boolean }).isChannelSelectMenu();

      const expectsStringSelect =
        route.action === "page" ||
        route.action === "persona-select" ||
        route.action === "naming-style-select" ||
        route.action === "attribute-select" ||
        route.action === "dialogue-select" ||
        route.action === "humanizer-select" ||
        route.action === "text-override-provider-select" ||
        route.action === "text-override-model-select" ||
        route.action === "channels-overrides-text-model-select" ||
        route.action === "sprite-select" ||
        CONFIG_MODEL_SELECT_ACTIONS.has(route.action) ||
        CONFIG_BEHAVIOR_SELECT_ACTIONS.has(route.action);
      const expectsChannelSelect = route.action === "channels-overrides-select";
      const expectsModal =
        route.action === "avatar-submit" ||
        route.action === "rename-submit" ||
        route.action === "naming-submit" ||
        route.action === "trigger-add-submit" ||
        route.action === "trigger-remove-submit" ||
        route.action === "attribute-add-submit" ||
        route.action === "attribute-edit-submit" ||
        route.action === "dialogue-add-submit" ||
        route.action === "stm-edit-submit" ||
        route.action === "conditioning-submit" ||
        route.action === "dialogue-edit-submit" ||
        route.action === "image-tags-submit" ||
        route.action === "character-reference-submit" ||
        route.action === "prompt-submit" ||
        route.action === "context-note-submit" ||
        route.action === "humanizer-submit" ||
        route.action === "text-override-model-submit" ||
        route.action === "sprite-add-submit" ||
        route.action === "sprite-edit-submit" ||
        route.action === "sprite-import-submit" ||
        CONFIG_MODEL_MODAL_SUBMIT_ACTIONS.has(route.action) ||
        CONFIG_BEHAVIOR_MODAL_SUBMIT_ACTIONS.has(route.action) ||
        CONFIG_BEHAVIOR_D10_MODAL_SUBMIT_ACTIONS.has(route.action) ||
        CONFIG_PERMISSION_MODAL_SUBMIT_ACTIONS.has(route.action) ||
        CONFIG_CHANNEL_MODAL_SUBMIT_ACTIONS.has(route.action);

      if (expectsStringSelect && !interaction.isStringSelectMenu()) {
        throw new Error(`Config ${route.action} route requires a String Select interaction`);
      }
      if (expectsChannelSelect && !isChannelSelectMenu) {
        throw new Error(`Config ${route.action} route requires a Channel Select interaction`);
      }
      if (expectsModal && !interaction.isModalSubmit()) {
        throw new Error(`Config ${route.action} route requires a modal submission`);
      }
      if (!expectsStringSelect && !expectsChannelSelect && !expectsModal && !interaction.isButton()) {
        throw new Error(`Config ${route.action} route requires a button interaction`);
      }

      // The actor comes from the interaction rather than the workspace, so a forged custom ID is
      // rejected before any repository read.
      const actor = resolveConfigActor(interaction);

      const submittedValue = interaction.isStringSelectMenu()
        ? (interaction.values[0] ?? null)
        : isChannelSelectMenu
          ? ((interaction as ChannelSelectMenuInteraction).values[0] ?? null)
          : null;
      if ((route.action === "attribute-select" || route.action === "dialogue-select") && submittedValue === "add") {
        await handleCollectionAddSelection(interaction, route, dependencies, actor);
        return;
      }
      if (route.action === "sprite-select" && submittedValue === "add") {
        await handleSpriteAddSelection(interaction, route, dependencies, actor);
        return;
      }
      if (route.action === "text-override-open" || route.action === "text-override-provider-select") {
        await handleTextOverrideModelModalOpen(interaction, route, dependencies, actor);
        return;
      }

      if (CONFIG_MODEL_MODAL_OPEN_ACTIONS.has(route.action)) {
        await handleConfigModelModalOpen(interaction, route, dependencies, actor);
        return;
      }

      if (CONFIG_BEHAVIOR_MODAL_OPEN_ACTIONS.has(route.action)) {
        await handleConfigBehaviorModalOpen(interaction, route, dependencies, actor);
        return;
      }

      if (CONFIG_BEHAVIOR_D10_MODAL_OPEN_ACTIONS.has(route.action)) {
        await handleConfigBehaviorD10ModalOpen(interaction, route, dependencies, actor);
        return;
      }

      if (CONFIG_PERMISSION_MODAL_OPEN_ACTIONS.has(route.action)) {
        await handleConfigPermissionModalOpen(interaction, route, dependencies, actor);
        return;
      }

      if (CONFIG_CHANNEL_MODAL_OPEN_ACTIONS.has(route.action)) {
        await handleConfigChannelModalOpen(interaction, route, dependencies, actor);
        return;
      }

      if (MODAL_OPEN_ACTIONS.has(route.action)) {
        await handleModalOpen(interaction, route, dependencies, actor);
        return;
      }

      const scope = await beginPanelInteraction({
        acknowledge: () => interaction.deferUpdate(),
        authorize: () => isConfigRouteAuthorized(route, actor),
        onDenied: async () => {
          const landing = resolveConfigLanding(actor);
          const fallbackScope = await dependencies.resolveScope(interaction, false);
          if (!fallbackScope) {
            await interaction.editReply(terminalPayload(route.locale, "commands.config.panel.unavailable"));
            return;
          }
          await repaint(interaction, {
            locale: route.locale,
            scope: fallbackScope,
            category: landing.category,
            page: landing.page,
            selectedPersonaId: resolveSelectedPersona(fallbackScope.personas, null)?.persona_id ?? null,
            receipt: deniedReceipt(route.locale),
            dependencies,
          });
        },
        load: () => dependencies.resolveScope(interaction, route.action === "retry" || route.action === "refresh"),
        onMissing: () => interaction.editReply(terminalPayload(route.locale, "commands.config.panel.unavailable")),
      });
      if (!scope) return;

      if (
        await handleConfigModelRoutes({
          interaction,
          route,
          scope,
          dependencies,
          selectedValue: submittedValue,
        })
      ) {
        return;
      }

      if (
        await handleConfigBehaviorRoutes({
          interaction,
          route,
          scope,
          dependencies,
        })
      ) {
        return;
      }

      if (
        await handleConfigBehaviorD10Routes({
          interaction,
          route,
          scope,
          dependencies,
        })
      ) {
        return;
      }

      if (
        await handleConfigPermissionRoutes({
          interaction,
          route,
          scope,
          dependencies,
        })
      ) {
        return;
      }

      if (
        await handleConfigChannelRoutes({
          interaction,
          route,
          scope,
          dependencies,
        })
      ) {
        return;
      }

      if (route.action === "server-memory-open" || route.action === "personal-memory-open") {
        const selectedPersona = resolveSelectedPersona(scope.personas, route.personaId);
        const selectedLineageId = selectedPersona?.persona_lineage_id ?? 0;
        if (route.action === "server-memory-open") {
          await interaction.followUp(
            await dependencies.openServerMemoryPanel(interaction, route.locale, selectedLineageId),
          );
        } else {
          await interaction.followUp(
            await dependencies.openPersonalMemoryPanel(interaction, route.locale, selectedLineageId),
          );
        }
        return;
      }

      if (
        !(await authorizeCollectionOperation(interaction, scope, collectionOperationForRoute(route, submittedValue)))
      ) {
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "persona",
          page: "general",
          selectedPersonaId:
            resolveSelectedPersona(scope.personas, personaLocation(route).personaId)?.persona_id ?? null,
          receipt: deniedReceipt(route.locale),
          dependencies,
        });
        return;
      }

      const { personaId, explicitStart } = personaLocation(route);
      // A String Select's custom ID names the selection that produced it; the new choice arrives in
      // the submitted values, so reading the route here would make every select a no-op.
      const selectedValue = submittedValue;

      let category: ConfigCategory = "category" in route ? route.category : "persona";
      let page: ConfigPage = "page" in route ? route.page : "general";
      if (route.action === "stm-edit-submit" || route.action === "conditioning-submit") {
        category = "persona";
        page = "memories";
      }
      if (route.action === "trigger-add-submit" || route.action === "trigger-remove-submit") {
        category = "persona";
        page = "triggers";
      }
      if (
        route.action === "image-tags-submit" ||
        route.action === "character-reference-submit" ||
        route.action === "character-reference-clear-view" ||
        route.action === "character-reference-clear-confirm" ||
        route.action === "character-reference-clear-cancel"
      ) {
        category = "persona";
        page = "appearance";
      } else if (PERSONA_ADVANCED_ACTION_BY_ROUTE[route.action]) {
        category = "persona";
        page = "advanced";
      }
      if (SPRITE_ACTIONS.has(route.action)) {
        category = "persona";
        page = "sprites";
      }
      if (route.action === "page" && selectedValue) {
        const candidate = selectedValue as ConfigPage;
        if (visibleConfigPages(route.category, actor).includes(candidate)) page = candidate;
        category = route.category;
      }

      let namingStyle: AddressingStyle | undefined = "style" in route ? route.style : undefined;
      if (route.action === "naming-style-select") {
        namingStyle = parseAddressingStyleValue(selectedValue) ?? "neutral";
      }

      let requestedPersonaId = personaId;
      if (route.action === "persona-select" && selectedValue) {
        const candidate = Number(selectedValue);
        if (Number.isSafeInteger(candidate) && scope.personas.some((p) => p.persona_id === candidate)) {
          requestedPersonaId = candidate;
        }
      }

      const persona = resolveSelectedPersona(scope.personas, requestedPersonaId);
      const selectedPersonaId = persona?.persona_id;

      if (route.action === "character-reference-clear-view" && persona && selectedPersonaId !== undefined) {
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "persona",
          page: "appearance",
          selectedPersonaId,
          view: {
            kind: "character-reference-clear-confirm",
            personaId: selectedPersonaId,
            nonce: dependencies.createNonce(),
          },
          dependencies,
        });
        return;
      }

      if (SPRITE_ACTIONS.has(route.action) && persona && selectedPersonaId !== undefined) {
        const spriteOutcome = await handleSpriteNavigation(
          interaction,
          route,
          scope,
          persona,
          selectedPersonaId,
          dependencies,
          submittedValue,
        );
        if (spriteOutcome === "handled") return;
      }

      if (route.action === "text-override-model-page" && persona) {
        await handleTextOverrideChoice(interaction, route, scope, persona, dependencies, submittedValue);
        return;
      }

      let selectedAttributeIndex: number | undefined;
      let attributePageStart: number | undefined;
      let selectedDialogueIndex: number | undefined;
      let dialoguePageStart: number | undefined;

      if (route.action === "attribute-page") {
        attributePageStart = route.start;
      }
      if (route.action === "dialogue-page") {
        dialoguePageStart = route.start;
      }
      if (route.action === "attribute-select" && selectedValue) {
        const target = findExactPersona(scope.personas, requestedPersonaId);
        const selectedIndex = Number(selectedValue);
        if (
          target &&
          Number.isSafeInteger(selectedIndex) &&
          selectedIndex >= 0 &&
          selectedIndex < (target.attribute_list?.length ?? 0)
        ) {
          selectedAttributeIndex = selectedIndex;
          attributePageStart =
            Math.floor(selectedIndex / CONFIG_PERSONA_COLLECTION_PAGE_SIZE) * CONFIG_PERSONA_COLLECTION_PAGE_SIZE;
        }
      }

      if (route.action === "dialogue-select" && selectedValue) {
        const target = findExactPersona(scope.personas, requestedPersonaId);
        if (target && Number.isSafeInteger(Number(selectedValue))) {
          const selectedIndex = Number(selectedValue);
          const dialogueLengthsMatch =
            (target.sample_dialogues_in?.length ?? 0) === (target.sample_dialogues_out?.length ?? 0);
          if (
            !dialogueLengthsMatch ||
            (selectedIndex >= 0 &&
              selectedIndex <
                Math.min(target.sample_dialogues_in?.length ?? 0, target.sample_dialogues_out?.length ?? 0))
          ) {
            if (!(await repairDialogueState(scope, target, dependencies))) {
              await repaint(interaction, {
                locale: route.locale,
                scope,
                category: "persona",
                page: "general",
                selectedPersonaId: target.persona_id ?? null,
                receipt: staleReceipt(route.locale),
                dependencies,
              });
              return;
            }
            const repairedLength = Math.min(
              target.sample_dialogues_in?.length ?? 0,
              target.sample_dialogues_out?.length ?? 0,
            );
            if (selectedIndex >= 0 && selectedIndex < repairedLength) {
              selectedDialogueIndex = selectedIndex;
              dialoguePageStart =
                Math.floor(selectedIndex / CONFIG_PERSONA_COLLECTION_PAGE_SIZE) * CONFIG_PERSONA_COLLECTION_PAGE_SIZE;
            }
          }
        }
      }

      if (route.action === "promote-view") {
        const target = findExactPersona(scope.personas, requestedPersonaId);
        await repaint(interaction, {
          locale: route.locale,
          scope,
          category: "persona",
          page: "general",
          selectedPersonaId: target?.persona_id ?? persona?.persona_id ?? null,
          dependencies,
          ...(target?.is_alter === true && target.persona_id
            ? {
                view: {
                  kind: "promote-confirm" as const,
                  personaId: target.persona_id,
                  nonce: dependencies.createNonce(),
                },
              }
            : { receipt: staleReceipt(route.locale) }),
        });
        return;
      }

      const writeTarget = findExactPersona(scope.personas, requestedPersonaId);
      if (writeTarget) {
        const outcome = await runPersonaWrite(interaction, route, scope, writeTarget, dependencies);
        if (outcome) {
          // Repaint from a fresh read rather than the pre-write scope, so the panel can never show a
          // value the write did not actually produce.
          const refreshed = (await dependencies.resolveScope(interaction, true)) ?? scope;
          if (outcome.telemetry && refreshed.internalServerId) {
            dependencies.recordAction({
              action: outcome.telemetry,
              serverId: refreshed.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(interaction, {
            locale: route.locale,
            scope: refreshed,
            category,
            page,
            selectedPersonaId:
              resolveSelectedPersona(refreshed.personas, writeTarget.persona_id ?? null)?.persona_id ?? null,
            namingStyle,
            receipt: outcome.receipt,
            selectedAttributeIndex:
              outcome.collectionSelection?.family === "attribute"
                ? outcome.collectionSelection.selectedIndex
                : undefined,
            attributePageStart:
              outcome.collectionSelection?.family === "attribute" ? outcome.collectionSelection.pageStart : undefined,
            selectedDialogueIndex:
              outcome.collectionSelection?.family === "dialogue"
                ? outcome.collectionSelection.selectedIndex
                : undefined,
            dialoguePageStart:
              outcome.collectionSelection?.family === "dialogue" ? outcome.collectionSelection.pageStart : undefined,
            dependencies,
          });
          return;
        }
      }

      await repaint(interaction, {
        locale: route.locale,
        scope,
        category,
        page,
        selectedPersonaId: persona?.persona_id ?? null,
        personaSelectStart: explicitStart,
        namingStyle,
        selectedAttributeIndex,
        attributePageStart,
        selectedDialogueIndex,
        dialoguePageStart,
        dependencies,
      });
    },
  };
}

export const configInteractionRoute = createConfigInteractionRoute();

/**
 * Opens the panel from the bare `/config` root.
 *
 * The opening destination comes from `resolveConfigLanding` rather than the landing constants, so the
 * page the panel opens on is always one this actor may also navigate back to after a denial.
 */
export async function executeConfigCommand(
  interaction: ChatInputCommandInteraction,
  locale: string,
  dependenciesOverride: Partial<ConfigRouteDependencies> = {},
): Promise<void> {
  const dependencies: ConfigRouteDependencies = { ...defaultDependencies, ...dependenciesOverride };
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const scope = await dependencies.resolveScope(interaction, false);
  if (!scope) {
    await interaction.editReply(terminalPayload(locale, "commands.config.panel.unavailable"));
    return;
  }

  const landing = resolveConfigLanding(scope.actor);
  await repaint(interaction, {
    locale,
    scope,
    category: landing.category,
    page: landing.page,
    selectedPersonaId: resolveSelectedPersona(scope.personas, null)?.persona_id ?? null,
    dependencies,
  });
}
