import {
  ComponentType,
  MessageFlags,
  type APIAttachment,
  type ChatInputCommandInteraction,
  type InteractionReplyOptions,
  type InteractionEditReplyOptions,
} from "discord.js";
import type {
  LlmRow,
  NaiPresetRow,
  AutochatPersonaOverride,
  PersonaSpriteRow,
  RandomTriggerRow,
  ServerStmConfigRow,
  StmCategoryRow,
  ServerSpeechConfigRow,
  VoiceSampleRow,
  TomoriState,
} from "@/types/db/schema";
import type { ToolNoticeKey } from "@/constants/toolNotices";
import type { DeliberateToolTriggerMap } from "@/utils/tools/deliberateToolMode";
import type { WorkaroundConfigState } from "@/utils/discord/workaroundConfigMapping";
import type { PanelReadStatus, PanelReceipt } from "@/types/discord/panel";
import type { GuildMcpConfigReadResult } from "@/utils/cache/guildMcpConfigCache";
import type { AddressingStyle } from "@/types/personaNaming";
import type { ConditioningGroup } from "@/utils/db/repositories/ConditioningMemoryRepository";
import type { ShortTermMemoryEntry } from "@/utils/cache/shortTermMemoryCache";
import type {
  ConfigCatalogModelCapability,
  ConfigCategory,
  ConfigModelCapability,
  ConfigPage,
} from "@/utils/discord/configPanelCatalog";
import type { LoadConfigCapabilityEndpoints } from "@/utils/discord/interactions/configModelLoaders";
import type {
  BlocklistChannelTarget,
  ChannelOverrideChannelTarget,
  ChecklistChannelTarget,
} from "@/utils/discord/channelChecklistManager";
import type { ChannelContextNote } from "@/utils/cache/channelContextNoteCacheStore";
import type { ChannelPromptOverride } from "@/utils/cache/channelPromptCacheStore";
import {
  resolvePersonaAdvancedActionState,
  type ConfigActor,
} from "@/utils/discord/interactions/configPermissionPolicy";
import type { ConfigPersonaOperations, GuildIdentityPort } from "@/utils/discord/interactions/configPersonaOperations";
import type { ConfigSpriteOperations } from "@/utils/discord/interactions/configSpriteOperations";
import type { ConfigModelOperations } from "@/utils/discord/interactions/configModelOperations";
import type {
  VoiceSampleAddDependencies,
  VoiceSampleAddInput,
  VoiceSampleAddResult,
} from "@/utils/speech/voiceSampleAddOperation";
import { deliverGuardedPanel, validateAndFallbackPanelPayload } from "@/utils/discord/interactions/panelController";
import type { ConfigFallbackOption } from "@/utils/discord/ui/configModelModals";
import type { ConfigModelChoice } from "@/utils/discord/interactions/configModelOperations";
import type {
  ConfigFallbacksView,
  ConfigImageGenerationView,
  ConfigParametersView,
  ConfigSwitchModelsProviderPage,
  ConfigEndpointPage,
  ConfigSwitchModelsView,
} from "@/utils/discord/ui/configModelsPanel";
import type { ConfigVoicesView } from "@/utils/discord/ui/configVoicesPanel";
import type { ConfigVoicesLoaderDependencies } from "@/utils/discord/interactions/configVoicesLoader";
import type { ConfigPersonaVoiceView } from "@/utils/discord/interactions/configPersonaVoiceLoader";
import type { ConfigPersonaVoiceRemoteView } from "@/utils/discord/ui/configVoicePanel";
import type { ElevenLabsVoiceCatalogResult } from "@/utils/audio/elevenLabsVoiceCatalog";
import type { SpeechEndpointResult } from "@/utils/provider/speechEndpointResolver";
import type { GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import { type PersonaPanelAvatarData, withPersonaPanelAvatar } from "@/utils/discord/personaPanelAvatar";
import type { PersonaPanelCharacterReferenceData } from "@/utils/discord/personaPanelCharacterReference";
import { buildConfigPanelPayload, type ConfigPanelView } from "@/utils/discord/ui/configPanel";
import type { RawModalPayload } from "@/utils/discord/ui/configModals";
import { buildPanelContainer } from "@/utils/discord/ui/panel";
import type { RecordPanelActionInput } from "@/utils/stats/panelActionMetrics";
import { localizer } from "@/utils/text/localizer";
import { HUMANIZER_DEFAULT } from "@/utils/discord/humanizerOptions";
import { DEFAULT_MESSAGE_FETCH_LIMIT } from "@/utils/discord/messageFetchLimit";
import type { McpConfigOperations } from "@/utils/mcp/mcpConfigOperations";

export interface ConfigScope {
  /** Guild snowflake in a guild, DM recipient snowflake otherwise: the workspace key every absorbed command already uses. */
  serverDiscId: string;
  guildId: string | null;
  /** `servers` primary key, needed by telemetry and never the snowflake. */
  internalServerId: number | null;
  userId: number;
  actor: ConfigActor;
  personas: TomoriState[];
  readStatus: PanelReadStatus;
  mcpRead?: GuildMcpConfigReadResult;
}

export interface ConfigPersonaMemoryView {
  serverMemoryCount: number;
  personalMemoryCount: number;
  channelId: string | null;
  stmEntry?: ShortTermMemoryEntry;
  stmCategories: StmCategoryRow[];
  conditioningGroups: ConditioningGroup[];
}

export interface ConfigBehaviorGeneralView {
  systemPrompt: string | null;
  contextNote: string | null;
  contextNoteDepth: number;
  humanizerDegree: number;
  messageFetchLimit: number;
  timezoneOffset: number;
}

export interface ConfigBehaviorTriggerView {
  randomTriggers: Array<RandomTriggerRow & { trigger_id: number }>;
  cascadeLimit: number;
  matchLimit: number;
  deliberateTriggerMode: boolean;
  alwaysReplyEnabled: boolean;
  cooldownType: number;
  cooldownLength: number;
}

export interface ConfigBehaviorExperimentalView {
  deliberateToolMode: boolean;
  deliberateToolContextTurns: number;
  deliberateToolTriggers: DeliberateToolTriggerMap;
  sendLimit: number;
  selfDebugEnabled: boolean;
  workarounds: WorkaroundConfigState;
}

export interface ConfigBehaviorNoticesView {
  hiddenNoticeKeys: ToolNoticeKey[];
  speechTranscriptsEnabled: boolean;
}

export interface ConfigBehaviorMemoryView {
  memoryTaggingEnabled: boolean;
  channelMemoryEnabled: boolean;
  stmConfig: ServerStmConfigRow | null;
  stmCategories: StmCategoryRow[];
}

export interface ConfigBehaviorView {
  general: ConfigBehaviorGeneralView;
  trigger: ConfigBehaviorTriggerView;
  experimental?: ConfigBehaviorExperimentalView;
  notices?: ConfigBehaviorNoticesView;
  memory?: ConfigBehaviorMemoryView;
}

export interface ConfigPermissionsCapabilitiesView {
  toolUseEnabled: boolean;
  includeElevenLabs: boolean;
  definitionStates: Readonly<Record<string, boolean>>;
}

export interface ConfigPermissionsPrivacyView {
  stmPrivacyBypass: boolean;
}

export interface ConfigPermissionsView {
  capabilities: ConfigPermissionsCapabilitiesView;
  privacy: ConfigPermissionsPrivacyView;
}

export interface ConfigChannelsDestinationsView {
  thoughtLogChannelId: string | null;
  welcomeChannelId: string | null;
  welcomePrompt: string | null;
  welcomePersonaId: number | null;
}

export interface ConfigChannelsAutoTriggerView {
  enabledChannels: ChecklistChannelTarget[];
  personaOverrides: AutochatPersonaOverride[];
  threshold: number;
  maxThreshold: number;
}

export interface ConfigChannelsRulesView {
  privateChannels: ChecklistChannelTarget[];
  roleplayChannels: ChecklistChannelTarget[];
  crossChannelBlocklist: BlocklistChannelTarget[];
}

export interface ConfigChannelsOverridesView {
  selectedChannelId: string | null;
  prompt: ChannelPromptOverride | null;
  contextNote: ChannelContextNote | null;
  textModelOverride: LlmRow | null;
}

export interface ConfigChannelsView {
  destinations: ConfigChannelsDestinationsView;
  autoTrigger: ConfigChannelsAutoTriggerView;
  rules: ConfigChannelsRulesView;
  availableTextChannels: ChecklistChannelTarget[];
  availableBlocklistChannels: BlocklistChannelTarget[];
  availableOverrideChannels: ChannelOverrideChannelTarget[];
  overrides: ConfigChannelsOverridesView;
}

export interface ConfigRouteDependencies {
  resolveScope(
    interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
    forceRefresh?: boolean,
  ): Promise<ConfigScope | null>;
  getPersonaAvatarData(
    interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
    persona: TomoriState,
  ): Promise<PersonaPanelAvatarData>;
  getPersonaAvatarReferenceData(reference: string, attachmentName: string): Promise<PersonaPanelAvatarData>;
  getPersonaCharacterReferenceData(
    reference: string,
    personaId: number,
    attachmentName: string,
  ): Promise<PersonaPanelCharacterReferenceData>;
  loadPersonaMemoryView(
    interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
    scope: ConfigScope,
    persona: TomoriState,
  ): Promise<ConfigPersonaMemoryView>;
  loadPersonaVoiceView(state: TomoriState): Promise<ConfigPersonaVoiceView>;
  resolveActiveSpeechEndpoint(serverId: number): Promise<SpeechEndpointResult | null>;
  fetchElevenLabsVoiceCatalog(apiKey: string): Promise<ElevenLabsVoiceCatalogResult>;
  setPersonaVoiceConfig(
    personaId: number,
    voice: {
      speech_voice_sample_id: number | null;
      speech_voice_id: string | null;
      speech_voice_name: string | null;
      speech_voice_design_prompt: string | null;
    },
  ): Promise<boolean>;
  invalidatePersonaVoiceCache(serverDiscId: string): void;
  loadServerHumanizerDegree(serverId: number): Promise<number | null>;
  loadPersonaSprites(personaId: number): Promise<PersonaSpriteRow[]>;
  loadSavedTextProviders(serverId: number): Promise<Array<{ provider: string }>>;
  loadPersonaTextModels(provider: string, serverId: number): Promise<LlmRow[]>;
  openServerMemoryPanel(
    interaction: GlobalRoutableInteraction,
    locale: string,
    lineageId: number,
  ): Promise<InteractionReplyOptions>;
  openPersonalMemoryPanel(
    interaction: GlobalRoutableInteraction,
    locale: string,
    lineageId: number,
  ): Promise<InteractionReplyOptions>;
  operations: ConfigPersonaOperations;
  spriteOperations: ConfigSpriteOperations;
  modelOperations: ConfigModelOperations;
  loadCapabilityEndpoints: LoadConfigCapabilityEndpoints;
  loadSwitchModelsView(
    state: TomoriState,
    providerPage: { capability: ConfigCatalogModelCapability; start: number } | undefined,
    endpointPage?: ConfigEndpointPage,
    loadCapabilityEndpoints?: LoadConfigCapabilityEndpoints,
  ): Promise<ConfigSwitchModelsView>;
  loadParametersView(
    state: TomoriState,
    requestedProvider: string | undefined,
    logitBiasPageStart: number,
    naiPresetPageStart?: number,
    workspaceKind?: "guild" | "dm",
  ): Promise<ConfigParametersView>;
  loadNaiPresets(target: "kayra" | "erato"): Promise<NaiPresetRow[]>;
  loadFallbacksView(
    state: TomoriState,
    locale: string,
    expandedProvider: string | null,
    entryStart: number,
  ): Promise<ConfigFallbacksView>;
  loadImageGenerationView(state: TomoriState, locale: string): ConfigImageGenerationView;
  loadVoicesView(
    state: TomoriState,
    requestedStart?: number,
    loaderDependencies?: ConfigVoicesLoaderDependencies,
  ): Promise<ConfigVoicesView>;
  loadVoiceSamples(serverId: number): Promise<VoiceSampleRow[]>;
  countVoiceSampleRefs(serverId: number, sampleId: number): Promise<number>;
  removeVoiceSample(input: {
    serverId: number;
    serverDiscId: string;
    sampleId: number;
    filePath: string;
  }): Promise<{ storedFileRemoved: boolean }>;
  loadSpeechConfig(serverId: number): Promise<ServerSpeechConfigRow | null>;
  updateSpeechConfig(serverId: number, patch: Partial<ServerSpeechConfigRow>): Promise<boolean>;
  invalidateSpeechConfigCache(serverDiscId: string): void;
  addVoiceSample: (input: VoiceSampleAddInput, deps?: VoiceSampleAddDependencies) => Promise<VoiceSampleAddResult>;
  voiceSampleAddDependencies?: VoiceSampleAddDependencies;
  loadBehaviorView?(state: TomoriState): Promise<ConfigBehaviorView>;
  loadPermissionsView(state: TomoriState): Promise<ConfigPermissionsView>;
  loadChannelsView(
    interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
    selectedChannelId?: string,
  ): Promise<ConfigChannelsView>;
  loadMcpRead(serverId: number, forceRefresh?: boolean): Promise<GuildMcpConfigReadResult>;
  mcpOperations: Pick<McpConfigOperations, "add" | "setEnabled" | "remove">;
  loadModelChoices(
    state: TomoriState,
    capability: ConfigCatalogModelCapability,
    provider: string,
  ): Promise<ConfigModelChoice[]>;
  loadFallbackOptions(state: TomoriState, provider: string): Promise<ConfigFallbackOption[]>;
  loadModelProviders(state: TomoriState, capability: ConfigModelCapability): Promise<string[]>;
  createGuildIdentity(guildId: string, interaction: GlobalRoutableInteraction): GuildIdentityPort;
  recordAction(input: RecordPanelActionInput): void;
  createNonce(): string;
  showModal(interaction: GlobalRoutableInteraction, payload: RawModalPayload): Promise<void>;
  takeFileUpload(interactionId: string, fieldId: string): APIAttachment | undefined;
  takeAvatarUpload(interactionId: string, nonce: string): APIAttachment | undefined;
  takeCheckboxValues(interactionId: string, fieldId: string): string[] | undefined;
  takeSelectValue(interactionId: string, fieldId: string): string | undefined;
  takeChannelSelectValue(interactionId: string, fieldId: string): string | undefined;
}

export function asEphemeralComponentsV2FollowUp(
  payload: InteractionReplyOptions | InteractionEditReplyOptions,
): InteractionReplyOptions {
  return {
    ...payload,
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
  } as InteractionReplyOptions;
}

export function terminalPayload(locale: string, key: string): InteractionEditReplyOptions {
  return validateAndFallbackPanelPayload(
    {
      components: [
        buildPanelContainer([
          {
            type: ComponentType.TextDisplay,
            content: localizer(locale, key),
          },
        ]),
      ],
      attachments: [],
      flags: MessageFlags.IsComponentsV2,
    },
    locale,
  );
}

export function deniedReceipt(locale: string): PanelReceipt {
  return {
    tone: "error",
    heading: localizer(locale, "commands.config.panel.denied_heading"),
    detail: localizer(locale, "commands.config.panel.denied_detail"),
  };
}

export function staleReceipt(locale: string): PanelReceipt {
  return {
    tone: "warning",
    heading: localizer(locale, "commands.config.panel.stale_heading"),
    detail: localizer(locale, "commands.config.panel.stale_detail"),
  };
}

/**
 * Resolves the persona a route names against the workspace as it stands right now.
 *
 * A route ID outlives the row it points at, so a persona deleted or moved between servers must fall
 * back to the current main persona rather than reaching a persona in another workspace.
 */
export function resolveSelectedPersona(
  personas: readonly TomoriState[],
  requestedId: number | null,
): TomoriState | null {
  const requested = requestedId === null ? null : personas.find((persona) => persona.persona_id === requestedId);
  if (requested) return requested;
  return personas.find((persona) => persona.is_alter !== true) ?? personas[0] ?? null;
}

export interface ConfigRepaintOptions {
  locale: string;
  scope: ConfigScope;
  category: ConfigCategory;
  page: ConfigPage;
  selectedPersonaId: number | null;
  personaSelectStart?: number;
  attributePageStart?: number;
  selectedAttributeIndex?: number;
  dialoguePageStart?: number;
  selectedDialogueIndex?: number;
  namingStyle?: AddressingStyle;
  receipt?: PanelReceipt;
  view?: ConfigPanelView;
  personaMemoryView?: ConfigPersonaMemoryView;
  serverHumanizerDegree?: number | null;
  personaSprites?: PersonaSpriteRow[];
  spritePageStart?: number;
  selectedSpriteIndex?: number;
  personaVoiceView?: ConfigPersonaVoiceView;
  personaVoiceRemoteView?: ConfigPersonaVoiceRemoteView;
  personaVoicePageStart?: number;
  modelProviderPage?: ConfigSwitchModelsProviderPage;
  endpointPage?: ConfigEndpointPage;
  behaviorView?: ConfigBehaviorView;
  permissionsView?: ConfigPermissionsView;
  channelsView?: ConfigChannelsView;
  mcpRead?: GuildMcpConfigReadResult;
  mcpPage?: import("@/utils/discord/ui/mcpsPanel").McpsPanelPage;
  channelsSelectedChannelId?: string | null;
  channelsAutoTriggerRangeIndex?: number;
  channelsPrivateRangeIndex?: number;
  channelsRoleplayRangeIndex?: number;
  channelsBlocklistRangeIndex?: number;
  randomTriggerPageStart?: number;
  randomTriggerRemoveMode?: boolean;
  parametersProvider?: string;
  logitBiasPageStart?: number;
  naiPresetPageStart?: number;
  fallbackExpandedProvider?: string | null;
  fallbackEntryStart?: number;
  voicesView?: ConfigVoicesView;
  voiceSamplePageStart?: number;
  selectedVoiceSampleIndex?: number;
  dependencies: ConfigRouteDependencies;
}

export async function repaint(
  interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
  options: ConfigRepaintOptions,
): Promise<void> {
  const { locale, scope, category, page, selectedPersonaId, dependencies } = options;

  let avatar: PersonaPanelAvatarData | undefined;
  let spriteAvatar: PersonaPanelAvatarData | undefined;
  let characterReference: PersonaPanelCharacterReferenceData | undefined;
  let personaMemoryView = options.personaMemoryView;
  let serverHumanizerDegree = options.serverHumanizerDegree;
  let personaSprites = options.personaSprites;
  let personaVoiceView = options.personaVoiceView;
  if (category === "persona") {
    const persona = scope.personas.find((candidate) => candidate.persona_id === selectedPersonaId);
    if (persona) {
      [avatar, personaMemoryView, serverHumanizerDegree, personaSprites] = await Promise.all([
        dependencies.getPersonaAvatarData(interaction, persona),
        page === "memories" && !personaMemoryView
          ? dependencies.loadPersonaMemoryView(interaction, scope, persona)
          : Promise.resolve(personaMemoryView),
        page === "advanced" && serverHumanizerDegree === undefined
          ? dependencies.loadServerHumanizerDegree(persona.server_id)
          : Promise.resolve(serverHumanizerDegree),
        page === "sprites" && personaSprites === undefined && persona.persona_id !== undefined
          ? dependencies.loadPersonaSprites(persona.persona_id)
          : Promise.resolve(personaSprites),
      ]);
      if (page === "sprites" && options.selectedSpriteIndex !== undefined) {
        const sprite = personaSprites?.[options.selectedSpriteIndex];
        if (sprite) {
          spriteAvatar = await dependencies.getPersonaAvatarReferenceData(
            sprite.avatar_url,
            `persona_sprite_${persona.persona_id}_${sprite.sprite_id ?? options.selectedSpriteIndex}.png`,
          );
        }
      }
      if (
        page === "appearance" &&
        !options.view &&
        resolvePersonaAdvancedActionState("character-reference", scope.actor) !== "omitted" &&
        persona.persona_id !== undefined &&
        persona.nai_char_ref_url
      ) {
        characterReference = await dependencies.getPersonaCharacterReferenceData(
          persona.nai_char_ref_url,
          persona.persona_id,
          `persona_char_ref_${persona.persona_id}.png`,
        );
      }
      if (page === "voice" && !personaVoiceView) {
        personaVoiceView = await dependencies.loadPersonaVoiceView(persona);
      }
    }
  }

  let switchModelsView: ConfigSwitchModelsView | undefined;
  let modelParametersView: ConfigParametersView | undefined;
  let modelFallbacksView: ConfigFallbacksView | undefined;
  let imageGenerationView: ConfigImageGenerationView | undefined;
  let voicesView = options.voicesView;
  let behaviorView = options.behaviorView;
  let mcpRead = options.mcpRead;
  if (category === "models") {
    // Server model state lives on the assembled workspace config every persona row carries, so any
    // persona in the workspace is an equally authoritative source for it.
    const state = scope.personas[0];
    if (state) {
      if (page === "switch") {
        switchModelsView = await dependencies.loadSwitchModelsView(
          state,
          options.modelProviderPage,
          options.endpointPage,
          dependencies.loadCapabilityEndpoints,
        );
      } else if (page === "parameters") {
        modelParametersView = await dependencies.loadParametersView(
          state,
          options.parametersProvider,
          options.logitBiasPageStart ?? 0,
          options.naiPresetPageStart ?? 0,
          scope.guildId ? "guild" : "dm",
        );
      } else if (page === "fallbacks") {
        modelFallbacksView = await dependencies.loadFallbacksView(
          state,
          locale,
          options.fallbackExpandedProvider ?? null,
          options.fallbackEntryStart ?? 0,
        );
      } else if (page === "image") {
        imageGenerationView = dependencies.loadImageGenerationView(state, locale);
      } else if (page === "voices" && !voicesView) {
        voicesView = await dependencies.loadVoicesView(state, options.voiceSamplePageStart ?? 0);
        if (options.selectedVoiceSampleIndex !== undefined) {
          voicesView = { ...voicesView, selectedIndex: options.selectedVoiceSampleIndex };
        }
      }
    }
  }

  let permissionsView = options.permissionsView;
  if ((category === "plugins" || (category === "channels" && page === "rules")) && !permissionsView) {
    const state = scope.personas[0];
    if (state) permissionsView = await dependencies.loadPermissionsView(state);
  }

  if (category === "plugins" && page === "mcp-servers" && !mcpRead) {
    const state = scope.personas[0];
    if (state) mcpRead = await dependencies.loadMcpRead(state.server_id);
  }

  let channelsView = options.channelsView;
  if (category === "channels" && !channelsView) {
    channelsView = await dependencies.loadChannelsView(
      interaction,
      page === "overrides" ? (options.channelsSelectedChannelId ?? undefined) : undefined,
    );
  }

  if ((category === "behavior" || (category === "plugins" && page === "context-additions")) && !behaviorView) {
    const state = scope.personas[0];
    if (state) {
      behaviorView = dependencies.loadBehaviorView
        ? await dependencies.loadBehaviorView(state)
        : {
            general: {
              systemPrompt: state.config.system_prompt ?? null,
              contextNote: state.config.context_note ?? null,
              contextNoteDepth: state.config.context_note_depth ?? 0,
              humanizerDegree: state.config.humanizer_degree ?? HUMANIZER_DEFAULT,
              messageFetchLimit: state.config.message_fetch_limit ?? DEFAULT_MESSAGE_FETCH_LIMIT,
              timezoneOffset: state.config.timezone_offset ?? 0,
            },
            trigger: {
              randomTriggers: [],
              cascadeLimit: state.config.cascade_limit ?? 3,
              matchLimit: state.config.match_limit ?? 3,
              deliberateTriggerMode: state.config.deliberate_trigger_mode ?? false,
              alwaysReplyEnabled: state.config.always_reply_enabled ?? false,
              cooldownType: state.config.cooldown_type ?? 0,
              cooldownLength: state.config.cooldown_length ?? 5,
            },
            experimental: {
              deliberateToolMode: state.config.deliberate_tool_mode ?? false,
              deliberateToolContextTurns: 0,
              deliberateToolTriggers: {},
              sendLimit: state.config.send_message_limit ?? 0,
              selfDebugEnabled: state.config.self_debug_enabled ?? false,
              workarounds: {
                verbatim_tool_calling_enabled: state.config.verbatim_tool_calling_enabled ?? false,
              },
            },
          };
    }
  }

  await deliverGuardedPanel(
    interaction,
    withPersonaPanelAvatar(
      buildConfigPanelPayload({
        locale,
        actor: scope.actor,
        category,
        page,
        personas: scope.personas,
        selectedPersonaId,
        selectedPersonaAvatarUrl: avatar?.url,
        selectedPersonaCharacterReferenceUrl: characterReference?.url,
        selectedSpriteAvatarUrl: spriteAvatar?.url,
        personaSelectStart: options.personaSelectStart,
        attributePageStart: options.attributePageStart,
        selectedAttributeIndex: options.selectedAttributeIndex,
        dialoguePageStart: options.dialoguePageStart,
        selectedDialogueIndex: options.selectedDialogueIndex,
        personaMemoryView,
        serverHumanizerDegree,
        personaSprites,
        spritePageStart: options.spritePageStart,
        selectedSpriteIndex: options.selectedSpriteIndex,
        personaVoiceView,
        personaVoiceRemoteView: options.personaVoiceRemoteView,
        personaVoicePageStart: options.personaVoicePageStart,
        attributeMemteachingEnabled: scope.personas[0]?.config?.attribute_memteaching_enabled === true,
        sampledialogueMemteachingEnabled: scope.personas[0]?.config?.sampledialogue_memteaching_enabled === true,
        namingStyle: options.namingStyle,
        readStatus: scope.readStatus,
        receipt: options.receipt,
        view: options.view,
        switchModelsView,
        modelParametersView,
        modelFallbacksView,
        imageGenerationView,
        voicesView,
        randomTriggerPageStart: options.randomTriggerPageStart,
        randomTriggerRemoveMode: options.randomTriggerRemoveMode,
        behaviorView,
        permissionsView,
        channelsView,
        channelsSelectedChannelId: options.channelsSelectedChannelId,
        mcpRead,
        mcpPage: options.mcpPage,
        channelsAutoTriggerRangeIndex: options.channelsAutoTriggerRangeIndex,
        channelsPrivateRangeIndex: options.channelsPrivateRangeIndex,
        channelsRoleplayRangeIndex: options.channelsRoleplayRangeIndex,
        channelsBlocklistRangeIndex: options.channelsBlocklistRangeIndex,
      }),
      [avatar, spriteAvatar, characterReference].filter((item): item is PersonaPanelAvatarData => item !== undefined),
    ),
    { locale },
  );
}
