import {
  ComponentType,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type InteractionEditReplyOptions,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { FallbackModelRef, PrivacyLevel, TomoriState, UserSavedProviderConfigRow } from "@/types/db/schema";
import type { PanelReceipt } from "@/types/discord/panel";
import type { UserPersonaNamingPreference } from "@/types/personaNaming";
import type { PersonalSpotlightStatus } from "@/utils/db/repositories/UserRepository";
import type { GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import type { PersonalConfigScope } from "@/utils/discord/interactions/personalConfigLoaders";
import type { PersonalConfigOperations } from "@/utils/discord/interactions/personalConfigOperations";
import {
  type PersonalConfigCategory,
  type PersonalConfigManagedCapability,
  type PersonalConfigPage,
  type PersonalConfigPanelRoute,
  SPOTLIGHT_PERSONA_PAGE_SIZE,
  decodeSpotlightMask,
} from "@/utils/discord/personalConfigPanelCatalog";
import { buildPanelContainer } from "@/utils/discord/ui/panel";
import {
  buildPersonalConfigPanelPayload,
  type PersonalConfigModelDisplayInfo,
  type PersonalConfigPanelView,
  type PersonalConfigSpotlightDisplayInfo,
} from "@/utils/discord/ui/personalConfigPanel";
import type { RecordPanelActionInput } from "@/utils/stats/panelActionMetrics";
import { localizer } from "@/utils/text/localizer";

export interface PersonalConfigRouteDependencies {
  resolveScope(
    interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
    forceRefresh?: boolean,
  ): Promise<PersonalConfigScope | null>;
  loadPersonaNamingPreference(userId: number, lineageId: number): Promise<UserPersonaNamingPreference | null>;
  getMemoryCount(userId: number): Promise<number>;
  getStmCount(userDiscId: string): Promise<number>;
  loadUserSavedProviders(userId: number): Promise<UserSavedProviderConfigRow[]>;
  loadPersonalModelDisplayInfo(
    userId: number,
    savedProviders: UserSavedProviderConfigRow[],
    selectedCap: PersonalConfigManagedCapability,
    selectedParamsProvider?: string,
    selectedFallbacksProvider?: string,
  ): Promise<PersonalConfigModelDisplayInfo>;
  loadAvailableModelsForCapability(
    userId: number,
    provider: string,
    capability: PersonalConfigManagedCapability,
  ): Promise<Array<{ id: number; name: string; description?: string }>>;
  loadActiveSpotlights(serverId: number, userId: number): Promise<PersonalSpotlightStatus[]>;
  loadGuildPersonas(guildId: string): Promise<Array<{ id: number; name: string; isAlter: boolean }>>;
  loadTomoriState(guildId: string): Promise<TomoriState | null>;
  loadServerTriggerBehavior(
    guildId: string,
  ): Promise<{ deliberate_trigger_mode: boolean; deliberate_tool_mode: boolean } | null>;
  operations: PersonalConfigOperations;
  recordAction(input: RecordPanelActionInput): void;
  createNonce(): string;
  showLanguageModal(
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    currentLanguage: string,
  ): Promise<void>;
  showTimezoneModal(
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    currentOffset: number | null,
  ): Promise<void>;
  showNamingModal(
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    current: { nickname: string | null; prefix: string | null; suffix: string | null },
  ): Promise<void>;
  showPersonaNamingModal(
    interaction: ButtonInteraction,
    locale: string,
    lineageId: number,
    nonce: string,
    current: { nickname: string | null; prefix: string | null; suffix: string | null },
  ): Promise<void>;
  showAboutModal(
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    current: { genderIdentity: string | null; pronouns: string | null; addressingStyle: string | null },
  ): Promise<void>;
  showAppearanceModal(
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    currentTags: string[],
  ): Promise<void>;
  showPrivacyLevelModal(
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    currentLevel: PrivacyLevel,
  ): Promise<void>;
  showQuickToggleModal(
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    savedProviders: UserSavedProviderConfigRow[],
  ): Promise<void>;
  showModelSelectModal(
    interaction: StringSelectMenuInteraction | ButtonInteraction,
    locale: string,
    nonce: string,
    capability: PersonalConfigManagedCapability,
    provider: string,
    availableModels: Array<{ id: number; name: string; description?: string }>,
    currentModelId: number | null,
  ): Promise<void>;
  showParameters1Modal(
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    provider: string,
    currentConfig: UserSavedProviderConfigRow | null,
  ): Promise<void>;
  showParameters2Modal(
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    provider: string,
    currentConfig: UserSavedProviderConfigRow | null,
  ): Promise<void>;
  showFallbacksModal(
    // Reached from the Fallbacks provider select as well as the range chooser's buttons, and a
    // modal is a valid acknowledgement for either.
    interaction: ButtonInteraction | StringSelectMenuInteraction,
    locale: string,
    nonce: string,
    provider: string,
    availableOptions: Array<{ refKey: string; label: string }>,
    currentRefs: FallbackModelRef[],
  ): Promise<void>;
  showImpersonationModal(
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    currentPrompt: string | null,
  ): Promise<void>;
  showSpotlightStep1Modal(interaction: ButtonInteraction, locale: string, nonce: string): Promise<void>;
  showSpotlightSetModal(
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    channelId: string,
    hours: number,
    blockIdx: number,
    fp: string,
    personas: Array<{ id: number; name: string; isAlter: boolean }>,
  ): Promise<void>;
  showSpotlightAutoTriggerModal(
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    channelId: string,
    hours: number,
    blockIdx: number,
    mask: string,
    fp: string,
    selectedPersonas: Array<{ id: number; name: string; isAlter: boolean }>,
  ): Promise<void>;
  showSpotlightRemoveModal(
    interaction: ButtonInteraction,
    locale: string,
    nonce: string,
    start: number,
    fp: string,
    activeSpotlights: PersonalSpotlightStatus[],
    personas: Array<{ id: number; name: string; isAlter: boolean }>,
    guildChannels: Map<string, { name: string }> | undefined,
  ): Promise<void>;
}

export function terminalPayload(locale: string, key: string): InteractionEditReplyOptions {
  return {
    components: [
      buildPanelContainer([
        {
          type: ComponentType.TextDisplay,
          content: localizer(locale, key),
        },
      ]),
    ],
    flags: MessageFlags.IsComponentsV2,
  };
}

export function noChangesReceipt(locale: string): PanelReceipt {
  return {
    tone: "info",
    heading: localizer(locale, "commands.personal.config.no_changes_heading"),
    detail: localizer(locale, "commands.personal.config.no_changes_detail"),
  };
}

// The positional signature placed dependencies at position 8, which forced call sites
// targeting later presentation fields to pad preceding positions with undefined.
export interface PersonalConfigRepaintOptions {
  locale: string;
  scope: PersonalConfigScope;
  category: PersonalConfigCategory;
  page: PersonalConfigPage;
  selectedLineageId?: number;
  panelReceipt?: PanelReceipt;
  dependencies: PersonalConfigRouteDependencies;
  selectedCapability?: PersonalConfigManagedCapability;
  selectedParametersProvider?: string;
  selectedFallbacksProvider?: string;
  view?: PersonalConfigPanelView;
}

export async function repaint(
  interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
  options: PersonalConfigRepaintOptions,
): Promise<void> {
  const {
    locale,
    scope,
    category,
    page,
    selectedLineageId,
    panelReceipt,
    dependencies,
    selectedCapability,
    selectedParametersProvider,
    selectedFallbacksProvider,
    view,
  } = options;
  let personaPref: UserPersonaNamingPreference | null = null;
  if (category === "profile" && page === "persona") {
    const currentLineage = selectedLineageId ?? scope.personas[0]?.persona_lineage_id;
    if (currentLineage) {
      personaPref = await dependencies.loadPersonaNamingPreference(scope.userId, currentLineage);
    }
  }

  const memoryCount = category === "privacy" ? await dependencies.getMemoryCount(scope.userId) : 0;
  const stmCount = category === "privacy" ? await dependencies.getStmCount(scope.userDiscId) : 0;

  let savedProviders: UserSavedProviderConfigRow[] | undefined;
  let modelDisplayInfo: PersonalConfigModelDisplayInfo | undefined;
  if (category === "models") {
    savedProviders = await dependencies.loadUserSavedProviders(scope.userId);
    modelDisplayInfo = await dependencies.loadPersonalModelDisplayInfo(
      scope.userId,
      savedProviders,
      selectedCapability ?? "text",
      selectedParametersProvider,
      selectedFallbacksProvider,
    );
  }

  let spotlightDisplayInfo: PersonalConfigSpotlightDisplayInfo | undefined;
  if (category === "advanced" && page === "spotlight" && scope.guildId && scope.internalServerId) {
    const activeSpotlights = await dependencies.loadActiveSpotlights(scope.internalServerId, scope.userId);
    const personas = await dependencies.loadGuildPersonas(scope.guildId);
    spotlightDisplayInfo = { activeSpotlights, personas };
  }

  let serverTriggerBehavior: { deliberate_trigger_mode: boolean; deliberate_tool_mode: boolean } | null = null;
  if (category === "advanced" && page === "response-modes" && scope.guildId) {
    try {
      serverTriggerBehavior = await dependencies.loadServerTriggerBehavior(scope.guildId);
    } catch {
      serverTriggerBehavior = null;
    }
  }

  await interaction.editReply(
    buildPersonalConfigPanelPayload({
      locale,
      category,
      page,
      user: scope.user,
      resolvedNickname: scope.resolvedNickname,
      personas: scope.personas,
      guildId: scope.guildId,
      selectedLineageId,
      personaNamingPreference: personaPref,
      memoryCount,
      stmCount,
      readStatus: scope.readStatus,
      receipt: panelReceipt,
      savedProviders,
      selectedCapability,
      selectedParametersProvider,
      selectedFallbacksProvider,
      modelDisplayInfo,
      spotlightDisplayInfo,
      serverTriggerBehavior,
      view,
    }),
  );
}

export type SpotlightPersona = { id: number; name: string; isAlter: boolean };

/**
 * Resolves a block-relative selection bitmask back to personas. Returns null when the mask cannot
 * belong to the block it names, which is how a collection that shrank under an open continuation
 * fails stale instead of silently retargeting a different persona.
 */
export function resolveSpotlightBlockSelection(
  personas: readonly SpotlightPersona[],
  blockIdx: number,
  mask: string,
): { block: SpotlightPersona[]; selected: SpotlightPersona[] } | null {
  const bits = decodeSpotlightMask(mask);
  if (bits === null) return null;
  const blockStart = blockIdx * SPOTLIGHT_PERSONA_PAGE_SIZE;
  const block = personas.slice(blockStart, blockStart + SPOTLIGHT_PERSONA_PAGE_SIZE);
  if (block.length === 0 || bits >> BigInt(block.length) !== 0n) return null;
  return { block, selected: block.filter((_, index) => (bits & (1n << BigInt(index))) !== 0n) };
}

export interface PersonalConfigPreDeferContext {
  interaction: GlobalRoutableInteraction;
  route: PersonalConfigPanelRoute;
  dependencies: PersonalConfigRouteDependencies;
}

export interface PersonalConfigPostDeferContext {
  interaction: GlobalRoutableInteraction;
  route: PersonalConfigPanelRoute;
  dependencies: PersonalConfigRouteDependencies;
  // An accessor pair rather than a plain field: 22 post-defer write sites reassign the scope a
  // refreshed read returned, then repaint from it, so every handler must observe the same live value.
  get scope(): PersonalConfigScope;
  set scope(value: PersonalConfigScope);
}
