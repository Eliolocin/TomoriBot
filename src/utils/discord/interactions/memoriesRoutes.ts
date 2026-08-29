import {
  type APIAttachment,
  type ButtonInteraction,
  ComponentType,
  MessageFlags,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type InteractionEditReplyOptions,
} from "discord.js";
import type { ServerMemoryRow, TomoriState } from "@/types/db/schema";
import type { PanelReadStatus, PanelReceipt } from "@/types/discord/panel";
import type { PanelAction } from "@/constants/panelActions";
import { getShortTermMemoriesForServer, preWarmServerStmEntries } from "@/utils/cache/shortTermMemoryCache";
import { getCachedTomoriState, invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { getCachedUserRow } from "@/utils/cache/userCache";
import { personaRepository, serverMemoryRepository, serverRepository, userRepository } from "@/utils/db/repositories";
import type { GlobalInteractionRoute, GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import { beginPanelInteraction, performPanelAction } from "@/utils/discord/interactions/panelController";
import {
  MEMORIES_ROUTE_NAMESPACE,
  MEMORIES_ROUTE_VERSION,
  parseMemoriesPanelRoute,
  type MemoriesCategory,
} from "@/utils/discord/memoriesPanelCatalog";
import {
  buildAddServerMemoryModal,
  buildEditServerMemoryModal,
  buildMemoriesPanelPayload,
  buildServerMemoryModalFieldId,
  parseServerMemoryTags,
  personaRepresentativeForLineage,
  type MemoriesPanelPayload,
} from "@/utils/discord/ui/memoriesPanel";
import { resolvePersonaAvatarPublicUrl } from "@/utils/storage/avatarStorage";
import { buildPanelContainer } from "@/utils/discord/ui/panel";
import { showRoutedRawModal, takeRawModalFileUpload } from "@/utils/discord/ui/modals";
import { createNonce } from "@/utils/discord/panelRouteTokens";
import {
  dedupeCaseInsensitive,
  getNonEmptyNumberedLines,
  readTxtUpload,
  type TxtUploadReadResult,
} from "@/utils/teach/batchUploadUtils";
import { getMemoryLimits, validateMemoryContent } from "@/utils/misc/memoryLimits";
import { recordPanelActionStat } from "@/utils/stats/panelActionMetrics";
import { log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";

interface MemoriesScope {
  serverId: number;
  workspaceId: string;
  guildId: string | null;
  userDiscId: string;
  userId: number;
  canManage: boolean;
  isBlacklisted: boolean;
  memteachingEnabled: boolean;
  personas: TomoriState[];
  readStatus: PanelReadStatus;
}

interface ServerMemoryAddInput {
  serverId: number;
  personaId: number;
  personaLineageId: number;
  taughtByUserId: number;
  workspaceId: string;
  isBlacklisted: boolean;
  canManage: boolean;
  memteachingEnabled: boolean;
  content: string;
  tags: string[];
}

interface ServerMemoryAddBatchInput {
  serverId: number;
  personaId: number;
  personaLineageId: number;
  taughtByUserId: number;
  workspaceId: string;
  isBlacklisted: boolean;
  canManage: boolean;
  memteachingEnabled: boolean;
  contents: string[];
  tags: string[];
}

interface ServerMemoryEditInput {
  serverId: number;
  personaLineageId: number;
  taughtByUserId: number;
  memoryId: number;
  workspaceId: string;
  isBlacklisted: boolean;
  canManage: boolean;
  memteachingEnabled: boolean;
  content: string;
  tags: string[];
}

interface ServerMemoryRemoveInput {
  serverId: number;
  personaLineageId: number;
  taughtByUserId: number;
  memoryId: number;
  workspaceId: string;
  isBlacklisted: boolean;
  canManage: boolean;
  memteachingEnabled: boolean;
}

type ServerMemoryAddResult =
  | { status: "blacklisted" }
  | { status: "teaching-disabled" }
  | { status: "empty-content" }
  | { status: "content-too-long" }
  | { status: "limit-reached" }
  | { status: "write-failed" }
  | { status: "success"; row: ServerMemoryRow };

type ServerMemoryAddBatchResult =
  | { status: "blacklisted" }
  | { status: "teaching-disabled" }
  | { status: "empty-content" }
  | { status: "content-too-long" }
  | { status: "all-duplicates" }
  | { status: "batch-limit-reached"; available: number; requested: number }
  | { status: "write-failed" }
  | { status: "success"; added: number; skipped: number };

type ServerMemoryEditResult =
  | { status: "blacklisted" }
  | { status: "teaching-disabled" }
  | { status: "empty-content" }
  | { status: "content-too-long" }
  | { status: "not-found" }
  | { status: "unchanged"; row: ServerMemoryRow }
  | { status: "write-failed" }
  | { status: "success"; row: ServerMemoryRow };

type ServerMemoryRemoveResult =
  | { status: "teaching-disabled" }
  | { status: "not-found" }
  | { status: "write-failed" }
  | { status: "success"; row: ServerMemoryRow };

export interface ServerMemoriesOperations {
  add(input: ServerMemoryAddInput): Promise<ServerMemoryAddResult>;
  addBatch(input: ServerMemoryAddBatchInput): Promise<ServerMemoryAddBatchResult>;
  edit(input: ServerMemoryEditInput): Promise<ServerMemoryEditResult>;
  remove(input: ServerMemoryRemoveInput): Promise<ServerMemoryRemoveResult>;
}

export const serverMemoriesOperations: ServerMemoriesOperations = {
  async add({
    serverId,
    personaId,
    personaLineageId,
    taughtByUserId,
    workspaceId,
    isBlacklisted,
    canManage,
    memteachingEnabled,
    content,
    tags,
  }) {
    if (isBlacklisted && !canManage) {
      return { status: "blacklisted" };
    }
    if (!memteachingEnabled && !canManage) {
      return { status: "teaching-disabled" };
    }
    const trimmed = content.trim();
    if (!trimmed) {
      return { status: "empty-content" };
    }
    const validation = validateMemoryContent(trimmed);
    if (!validation.isValid) {
      return { status: "content-too-long" };
    }
    const limitCheck = await serverMemoryRepository.checkServerMemoryLimit(serverId, personaLineageId);
    if (!limitCheck.isValid) {
      return { status: "limit-reached" };
    }
    const inserted = await serverMemoryRepository.add(
      serverId,
      personaId,
      personaLineageId,
      taughtByUserId,
      trimmed,
      tags,
      workspaceId,
    );
    if (!inserted) {
      return { status: "write-failed" };
    }
    return { status: "success", row: inserted };
  },

  async addBatch({
    serverId,
    personaId,
    personaLineageId,
    taughtByUserId,
    workspaceId,
    isBlacklisted,
    canManage,
    memteachingEnabled,
    contents,
    tags,
  }) {
    if (isBlacklisted && !canManage) {
      return { status: "blacklisted" };
    }
    if (!memteachingEnabled && !canManage) {
      return { status: "teaching-disabled" };
    }

    const trimmed = dedupeCaseInsensitive(contents.map((entry) => entry.trim()).filter((entry) => entry.length > 0));
    if (trimmed.length === 0) {
      return { status: "empty-content" };
    }
    if (trimmed.some((entry) => !validateMemoryContent(entry).isValid)) {
      return { status: "content-too-long" };
    }

    const existing = await serverMemoryRepository.loadServerMemoryContents(serverId, personaLineageId);
    const existingContents = new Set(existing.map((c) => c.trim().toLowerCase()));
    const toInsert = trimmed.filter((entry) => !existingContents.has(entry.toLowerCase()));
    if (toInsert.length === 0) {
      return { status: "all-duplicates" };
    }

    const limitCheck = await serverMemoryRepository.checkServerMemoryLimit(serverId, personaLineageId);
    const currentCount = limitCheck.currentCount ?? existing.length;
    const maxAllowed = limitCheck.maxAllowed ?? getMemoryLimits().maxServerMemories;
    const available = Math.max(0, maxAllowed - currentCount);
    if (toInsert.length > available) {
      return { status: "batch-limit-reached", available, requested: toInsert.length };
    }

    const ok = await serverMemoryRepository.addBatch(
      serverId,
      personaId,
      personaLineageId,
      taughtByUserId,
      toInsert,
      tags,
    );
    if (!ok) {
      return { status: "write-failed" };
    }
    invalidateTomoriStateCache(workspaceId);
    return { status: "success", added: toInsert.length, skipped: trimmed.length - toInsert.length };
  },

  async edit({
    serverId,
    personaLineageId,
    taughtByUserId,
    memoryId,
    workspaceId,
    isBlacklisted,
    canManage,
    memteachingEnabled,
    content,
    tags,
  }) {
    if (isBlacklisted && !canManage) {
      return { status: "blacklisted" };
    }
    if (!memteachingEnabled && !canManage) {
      return { status: "teaching-disabled" };
    }
    const trimmed = content.trim();
    if (!trimmed) {
      return { status: "empty-content" };
    }
    const validation = validateMemoryContent(trimmed);
    if (!validation.isValid) {
      return { status: "content-too-long" };
    }
    const ownerFilter = canManage ? undefined : taughtByUserId;
    const freshlyLoaded = await serverMemoryRepository.loadServerMemoriesScoped(
      serverId,
      personaLineageId,
      ownerFilter,
    );
    const target = freshlyLoaded.find((m) => m.server_memory_id === memoryId);
    if (!target) {
      return { status: "not-found" };
    }
    const existingTags = target.tags ?? [];
    const tagsUnchanged = tags.length === existingTags.length && tags.every((t, i) => t === existingTags[i]);
    if (trimmed === target.content.trim() && tagsUnchanged) {
      return { status: "unchanged", row: target };
    }
    const ok = await serverMemoryRepository.edit(memoryId, trimmed, tags);
    if (!ok) {
      return { status: "write-failed" };
    }
    invalidateTomoriStateCache(workspaceId);
    return { status: "success", row: { ...target, content: trimmed, tags } };
  },

  async remove({ serverId, personaLineageId, taughtByUserId, memoryId, workspaceId, canManage, memteachingEnabled }) {
    if (!memteachingEnabled && !canManage) {
      return { status: "teaching-disabled" };
    }
    const ownerFilter = canManage ? undefined : taughtByUserId;
    const freshlyLoaded = await serverMemoryRepository.loadServerMemoriesScoped(
      serverId,
      personaLineageId,
      ownerFilter,
    );
    const target = freshlyLoaded.find((m) => m.server_memory_id === memoryId);
    if (!target) {
      return { status: "not-found" };
    }
    const ok = await serverMemoryRepository.remove(memoryId);
    if (!ok) {
      return { status: "write-failed" };
    }
    invalidateTomoriStateCache(workspaceId);
    return { status: "success", row: target };
  },
};

export interface MemoriesRouteDependencies {
  resolveScope(
    interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
    forceRefresh?: boolean,
  ): Promise<MemoriesScope | null>;
  loadMemories(serverId: number, lineageId: number, userId?: number): Promise<ServerMemoryRow[]>;
  getEligibleLineageIds(serverId: number, userId?: number): Promise<Set<number>>;
  getPersonaAvatarUrl(
    interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
    persona: TomoriState,
  ): Promise<string | null>;
  getStmCount(workspaceId: string): Promise<number>;
  preWarmServerStm(workspaceId: string): Promise<void>;
  operations: ServerMemoriesOperations;
  recordAction(input: { action: PanelAction; serverId: number; userDiscId: string }): void;
  createNonce(): string;
  showAddModal(
    interaction: StringSelectMenuInteraction | ButtonInteraction,
    locale: string,
    lineageId: number,
    nonce: string,
  ): Promise<void>;
  takeFileUpload(interactionId: string, nonce: string): APIAttachment | undefined;
  readUploadedText(attachment: APIAttachment): Promise<TxtUploadReadResult>;
  showEditModal(
    interaction: ButtonInteraction,
    locale: string,
    lineageId: number,
    memory: ServerMemoryRow,
    nonce: string,
  ): Promise<void>;
}

const ERROR_RECEIPT_KEYS = new Set([
  "blacklisted_error",
  "teaching_disabled_error",
  "empty_content",
  "content_too_long",
  "limit_reached",
  "write_failed",
  "batch_file_invalid",
  "batch_file_too_large",
  "batch_all_duplicates",
  "batch_limit_reached",
]);

function receipt(locale: string, key: string, variables?: Record<string, string | number>): PanelReceipt {
  return {
    tone: ERROR_RECEIPT_KEYS.has(key) ? "error" : "success",
    heading: localizer(locale, `commands.memories.${key}_heading`),
    detail: localizer(locale, `commands.memories.${key}_detail`, variables),
  };
}

function changedStateReceipt(locale: string): PanelReceipt {
  return {
    tone: "info",
    heading: localizer(locale, "commands.memories.changed_state_heading"),
    detail: localizer(locale, "commands.memories.changed_state_detail"),
  };
}

function noChangesReceipt(locale: string): PanelReceipt {
  return {
    tone: "info",
    heading: localizer(locale, "commands.memories.no_changes_heading"),
    detail: localizer(locale, "commands.memories.no_changes_detail"),
  };
}

function terminalPayload(locale: string, key: string): InteractionEditReplyOptions {
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

async function resolveScope(
  interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
  _forceRefresh = false,
): Promise<MemoriesScope | null> {
  const userDiscId = interaction.user.id;
  const workspaceId = interaction.guildId ?? interaction.user.id;
  try {
    const userRow = await getCachedUserRow(userDiscId);
    const registeredUser = userRow ?? (await userRepository.register(userDiscId, interaction.user.username));
    if (!registeredUser?.user_id) return null;

    const canManage = !interaction.guildId || (interaction.memberPermissions?.has("ManageGuild") ?? false);
    const isBlacklisted = interaction.guildId
      ? ((await userRepository.isBlacklisted(interaction.guildId, userDiscId)) ?? false)
      : false;

    const tomoriState = await getCachedTomoriState(workspaceId);
    const internalServerId = tomoriState?.server_id ?? (await serverRepository.loadServerIdByDiscId(workspaceId));
    if (!internalServerId) return null;

    const memteachingEnabled = tomoriState?.config.server_memteaching_enabled ?? false;

    let personas: TomoriState[] = [];
    try {
      const allPersonas = await personaRepository.loadAllForServer(workspaceId);
      personas = allPersonas.filter(
        (p) => p.persona_lineage_id !== undefined && p.persona_lineage_id !== null && p.persona_lineage_id !== 0,
      );
    } catch (error) {
      log.warn("Failed to load personas for memories scope", { workspaceId, error });
    }

    return {
      serverId: internalServerId,
      workspaceId,
      guildId: interaction.guildId ?? null,
      userDiscId,
      userId: registeredUser.user_id,
      canManage,
      isBlacklisted,
      memteachingEnabled,
      personas,
      readStatus: "fresh",
    };
  } catch (error) {
    log.error("Failed to resolve scope for memories", error);
    return null;
  }
}

async function loadMemories(serverId: number, lineageId: number, userId?: number): Promise<ServerMemoryRow[]> {
  return serverMemoryRepository.loadServerMemoriesScoped(serverId, lineageId, userId);
}

async function getEligibleLineageIds(serverId: number, userId?: number): Promise<Set<number>> {
  return serverMemoryRepository.lineageIdsWithServerMemories(serverId, userId);
}

/**
 * Avatar URL for one persona, or null when none is fetchable.
 *
 * A main persona has no stored avatar: it speaks as the bot, so its face is the bot's per-guild
 * member avatar, which only the client knows. A local-path alter avatar resolves to null rather
 * than a data URI, because a Components V2 Thumbnail can only load a URL Discord can fetch.
 */
async function getPersonaAvatarUrl(
  interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
  persona: TomoriState,
): Promise<string | null> {
  if (persona.is_alter) {
    return resolvePersonaAvatarPublicUrl(persona.webhook_avatar_url);
  }
  const avatarOptions = { size: 256, extension: "png", forceStatic: true } as const;
  return (
    interaction.guild?.members.me?.displayAvatarURL(avatarOptions) ??
    interaction.client.user?.displayAvatarURL(avatarOptions) ??
    resolvePersonaAvatarPublicUrl(persona.webhook_avatar_url)
  );
}

async function preWarmServerStm(workspaceId: string): Promise<void> {
  await preWarmServerStmEntries(workspaceId);
}

async function getStmCount(workspaceId: string): Promise<number> {
  await preWarmServerStmEntries(workspaceId);
  return getShortTermMemoriesForServer(workspaceId).length;
}

async function repaint(
  interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
  locale: string,
  scope: MemoriesScope,
  category: MemoriesCategory,
  selectedLineageId: number,
  memories: ServerMemoryRow[],
  page: Parameters<typeof buildMemoriesPanelPayload>[0]["page"],
  panelReceipt?: PanelReceipt,
  dependencies: MemoriesRouteDependencies = defaultDependencies,
): Promise<void> {
  const ownerFilter = scope.canManage ? undefined : scope.userId;
  let stmCount: number | undefined;
  if (category === "stm") {
    if (scope.canManage) {
      await dependencies.preWarmServerStm(scope.workspaceId);
      stmCount = await dependencies.getStmCount(scope.workspaceId);
    }
  }

  const eligibleLineageIds =
    category === "memories" ? await dependencies.getEligibleLineageIds(scope.serverId, ownerFilter) : undefined;

  const representative =
    category === "memories" ? personaRepresentativeForLineage(scope.personas, selectedLineageId) : null;
  const selectedPersonaAvatarUrl = representative
    ? await dependencies.getPersonaAvatarUrl(interaction, representative)
    : undefined;

  await interaction.editReply(
    buildMemoriesPanelPayload({
      locale,
      category,
      selectedLineageId,
      personas: scope.personas,
      eligibleLineageIds,
      selectedPersonaAvatarUrl,
      memories,
      stmCount,
      canManage: scope.canManage,
      readStatus: scope.readStatus,
      page,
      receipt: panelReceipt,
    }),
  );
}

const defaultDependencies: MemoriesRouteDependencies = {
  resolveScope,
  loadMemories,
  getEligibleLineageIds,
  getPersonaAvatarUrl,
  getStmCount,
  preWarmServerStm,
  operations: serverMemoriesOperations,
  recordAction: (input) => {
    void recordPanelActionStat(input);
  },
  createNonce,
  showAddModal: (interaction, locale, lineageId, nonce) =>
    showRoutedRawModal(interaction, buildAddServerMemoryModal(locale, lineageId, nonce)),
  takeFileUpload: (interactionId, nonce) =>
    takeRawModalFileUpload(interactionId, buildServerMemoryModalFieldId("file", nonce)),
  readUploadedText: readTxtUpload,
  showEditModal: (interaction, locale, lineageId, memory, nonce) =>
    showRoutedRawModal(
      interaction,
      buildEditServerMemoryModal(
        locale,
        lineageId,
        memory.server_memory_id ?? 0,
        memory.content,
        memory.tags ?? [],
        nonce,
      ),
    ),
};

export async function buildInitialMemoriesPanel(
  interaction: ChatInputCommandInteraction,
  locale: string,
  dependencies: MemoriesRouteDependencies = defaultDependencies,
): Promise<MemoriesPanelPayload> {
  const scope = await dependencies.resolveScope(interaction);
  if (!scope) {
    return buildMemoriesPanelPayload({
      locale,
      category: "memories",
      selectedLineageId: 0,
      personas: [],
      memories: [],
      canManage: !interaction.guildId || (interaction.memberPermissions?.has("ManageGuild") ?? false),
      readStatus: "unavailable",
      page: { kind: "main" },
    });
  }

  const selectedLineageId = scope.personas[0]?.persona_lineage_id ?? 0;
  const ownerFilter = scope.canManage ? undefined : scope.userId;
  const memories = selectedLineageId
    ? await dependencies.loadMemories(scope.serverId, selectedLineageId, ownerFilter)
    : [];
  const eligibleLineageIds = await dependencies.getEligibleLineageIds(scope.serverId, ownerFilter);
  const representative = personaRepresentativeForLineage(scope.personas, selectedLineageId);
  const selectedPersonaAvatarUrl = representative
    ? await dependencies.getPersonaAvatarUrl(interaction, representative)
    : undefined;

  return buildMemoriesPanelPayload({
    locale,
    category: "memories",
    selectedLineageId,
    personas: scope.personas,
    eligibleLineageIds,
    selectedPersonaAvatarUrl,
    memories,
    canManage: scope.canManage,
    readStatus: scope.readStatus,
    page: { kind: "main" },
  });
}

export function createMemoriesInteractionRoute(
  overrides: Partial<MemoriesRouteDependencies> = {},
): GlobalInteractionRoute {
  const dependencies: MemoriesRouteDependencies = {
    ...defaultDependencies,
    ...overrides,
  };

  return {
    namespace: MEMORIES_ROUTE_NAMESPACE,
    version: MEMORIES_ROUTE_VERSION,
    async execute(_client, interaction, parsed): Promise<void> {
      const route = parseMemoriesPanelRoute(parsed);
      if (!route) throw new Error(`Malformed memories panel route: ${interaction.customId}`);

      // Modals and modal-opening select choices handle their own acknowledgement
      if (route.action === "select") {
        if (!interaction.isStringSelectMenu()) {
          throw new Error("Memories select route requires StringSelectMenu interaction");
        }
        const selectedValue = interaction.values[0];
        if (selectedValue === "action:add") {
          const cachedScope = await dependencies.resolveScope(interaction, false);
          if (!cachedScope) {
            await interaction.reply({
              content: localizer(route.locale, "commands.memories.unavailable"),
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          if (cachedScope.isBlacklisted && !cachedScope.canManage) {
            await interaction.reply({
              content: localizer(route.locale, "commands.memories.blacklisted_error_detail"),
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          if (!cachedScope.memteachingEnabled && !cachedScope.canManage) {
            await interaction.reply({
              content: localizer(route.locale, "commands.memories.teaching_disabled_error_detail"),
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          const nonce = dependencies.createNonce();
          await dependencies.showAddModal(interaction, route.locale, route.lineageId, nonce);
          return;
        }
      }

      if (route.action === "edit-open") {
        if (!interaction.isButton()) {
          throw new Error("Memories edit-open route requires Button interaction");
        }
        const cachedScope = await dependencies.resolveScope(interaction, false);
        if (!cachedScope) {
          await interaction.reply({
            content: localizer(route.locale, "commands.memories.unavailable"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (cachedScope.isBlacklisted && !cachedScope.canManage) {
          await interaction.reply({
            content: localizer(route.locale, "commands.memories.blacklisted_error_detail"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const ownerFilter = cachedScope.canManage ? undefined : cachedScope.userId;
        const memories = await dependencies.loadMemories(cachedScope.serverId, route.lineageId, ownerFilter);
        const memory = memories.find((m) => m.server_memory_id === route.memoryId);
        if (!memory) {
          await interaction.deferUpdate();
          await repaint(
            interaction,
            route.locale,
            cachedScope,
            "memories",
            route.lineageId,
            memories,
            { kind: "main" },
            changedStateReceipt(route.locale),
            dependencies,
          );
          return;
        }
        const nonce = dependencies.createNonce();
        await dependencies.showEditModal(interaction, route.locale, route.lineageId, memory, nonce);
        return;
      }

      const initialScope = await beginPanelInteraction({
        acknowledge: () => interaction.deferUpdate(),
        authorize: () => true,
        onDenied: () => Promise.resolve(),
        load: () => dependencies.resolveScope(interaction, route.action === "retry" || route.action === "refresh"),
        onMissing: () => interaction.editReply(terminalPayload(route.locale, "commands.memories.unavailable")),
      });
      if (!initialScope) return;
      let scope = initialScope;
      const ownerFilter = scope.canManage ? undefined : scope.userId;

      if (route.action === "category") {
        const lineageId = route.category === "memories" ? (scope.personas[0]?.persona_lineage_id ?? 0) : 0;
        const memories =
          route.category === "memories" && lineageId
            ? await dependencies.loadMemories(scope.serverId, lineageId, ownerFilter)
            : [];
        await repaint(
          interaction,
          route.locale,
          scope,
          route.category,
          lineageId,
          memories,
          { kind: "main" },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "persona-select") {
        if (!interaction.isStringSelectMenu()) {
          throw new Error("Memories persona-select route requires StringSelectMenu interaction");
        }
        const selectedLineage = Number(interaction.values[0]);
        const validLineage = scope.personas.some((p) => p.persona_lineage_id === selectedLineage)
          ? selectedLineage
          : (scope.personas[0]?.persona_lineage_id ?? 0);
        const memories = validLineage ? await dependencies.loadMemories(scope.serverId, validLineage, ownerFilter) : [];
        await repaint(
          interaction,
          route.locale,
          scope,
          "memories",
          validLineage,
          memories,
          { kind: "main" },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "select") {
        const memoryId = Number((interaction as StringSelectMenuInteraction).values[0]);
        const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, ownerFilter);
        await repaint(
          interaction,
          route.locale,
          scope,
          "memories",
          route.lineageId,
          memories,
          { kind: "main", selectedMemoryId: memoryId, rangeIndex: route.rangeIndex },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "range-open") {
        const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, ownerFilter);
        await repaint(
          interaction,
          route.locale,
          scope,
          "memories",
          route.lineageId,
          memories,
          { kind: "range-chooser", chooserPage: 0 },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "range-page") {
        const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, ownerFilter);
        await repaint(
          interaction,
          route.locale,
          scope,
          "memories",
          route.lineageId,
          memories,
          { kind: "range-chooser", chooserPage: route.chooserPage },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "range-cancel") {
        const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, ownerFilter);
        await repaint(
          interaction,
          route.locale,
          scope,
          "memories",
          route.lineageId,
          memories,
          { kind: "main" },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "range") {
        const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, ownerFilter);
        await repaint(
          interaction,
          route.locale,
          scope,
          "memories",
          route.lineageId,
          memories,
          { kind: "main", rangeIndex: route.rangeIndex },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "add-submit") {
        const modal = interaction as ModalSubmitInteraction;
        let content = "";
        try {
          content = modal.fields.getTextInputValue(buildServerMemoryModalFieldId("content", route.nonce));
        } catch {
          // Optional when file is uploaded
        }
        let tagsRaw = "";
        try {
          tagsRaw = modal.fields.getTextInputValue(buildServerMemoryModalFieldId("tags", route.nonce));
        } catch {
          // Field optional
        }
        const tags = parseServerMemoryTags(tagsRaw);
        const uploadedFile = dependencies.takeFileUpload(interaction.id, route.nonce);

        const representative = personaRepresentativeForLineage(scope.personas, route.lineageId);
        const personaId = representative?.persona_id;

        if (!personaId) {
          const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, ownerFilter);
          await repaint(
            interaction,
            route.locale,
            scope,
            "memories",
            route.lineageId,
            memories,
            { kind: "main" },
            receipt(route.locale, "write_failed"),
            dependencies,
          );
          return;
        }

        if (uploadedFile) {
          const upload = await dependencies.readUploadedText(uploadedFile);
          if (!upload.isValid || !upload.text) {
            const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, ownerFilter);
            await repaint(
              interaction,
              route.locale,
              scope,
              "memories",
              route.lineageId,
              memories,
              { kind: "main" },
              receipt(route.locale, upload.error === "file_too_large" ? "batch_file_too_large" : "batch_file_invalid"),
              dependencies,
            );
            return;
          }

          const uploaded = getNonEmptyNumberedLines(upload.text).map((line) => line.content);
          const typed = content.trim();
          const batchAction = await performPanelAction(
            () =>
              dependencies.operations.addBatch({
                serverId: scope.serverId,
                personaId,
                personaLineageId: route.lineageId,
                taughtByUserId: scope.userId,
                workspaceId: scope.workspaceId,
                isBlacklisted: scope.isBlacklisted,
                canManage: scope.canManage,
                memteachingEnabled: scope.memteachingEnabled,
                contents: typed ? [typed, ...uploaded] : uploaded,
                tags,
              }),
            () => dependencies.resolveScope(interaction, true),
          );
          const batchResult = batchAction.result;
          scope = batchAction.state ?? scope;
          const currentOwnerFilter = scope.canManage ? undefined : scope.userId;
          const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, currentOwnerFilter);

          if (batchResult.status === "success") {
            dependencies.recordAction({
              action: "memories.workspace.memory.add",
              serverId: scope.serverId,
              userDiscId: interaction.user.id,
            });
            await repaint(
              interaction,
              route.locale,
              scope,
              "memories",
              route.lineageId,
              memories,
              { kind: "main" },
              receipt(route.locale, "batch_added", {
                added: batchResult.added,
                skipped: batchResult.skipped,
              }),
              dependencies,
            );
            return;
          }

          const batchReceiptByStatus: Record<string, string> = {
            blacklisted: "blacklisted_error",
            "teaching-disabled": "teaching_disabled_error",
            "empty-content": "empty_content",
            "content-too-long": "content_too_long",
            "all-duplicates": "batch_all_duplicates",
            "batch-limit-reached": "batch_limit_reached",
            "write-failed": "write_failed",
          };
          await repaint(
            interaction,
            route.locale,
            scope,
            "memories",
            route.lineageId,
            memories,
            { kind: "main" },
            receipt(route.locale, batchReceiptByStatus[batchResult.status] ?? "write_failed", {
              max: getMemoryLimits().maxServerMemories,
              available: batchResult.status === "batch-limit-reached" ? batchResult.available : 0,
              requested: batchResult.status === "batch-limit-reached" ? batchResult.requested : 0,
            }),
            dependencies,
          );
          return;
        }

        const action = await performPanelAction(
          () =>
            dependencies.operations.add({
              serverId: scope.serverId,
              personaId,
              personaLineageId: route.lineageId,
              taughtByUserId: scope.userId,
              workspaceId: scope.workspaceId,
              isBlacklisted: scope.isBlacklisted,
              canManage: scope.canManage,
              memteachingEnabled: scope.memteachingEnabled,
              content,
              tags,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;
        const currentOwnerFilter = scope.canManage ? undefined : scope.userId;
        const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, currentOwnerFilter);

        if (result.status === "success") {
          dependencies.recordAction({
            action: "memories.workspace.memory.add",
            serverId: scope.serverId,
            userDiscId: interaction.user.id,
          });
          await repaint(
            interaction,
            route.locale,
            scope,
            "memories",
            route.lineageId,
            memories,
            { kind: "main", selectedMemoryId: result.row.server_memory_id },
            receipt(route.locale, "added", { memory: result.row.content }),
            dependencies,
          );
          return;
        }

        const receiptByStatus: Record<string, string> = {
          blacklisted: "blacklisted_error",
          "teaching-disabled": "teaching_disabled_error",
          "empty-content": "empty_content",
          "content-too-long": "content_too_long",
          "limit-reached": "limit_reached",
          "write-failed": "write_failed",
        };
        await repaint(
          interaction,
          route.locale,
          scope,
          "memories",
          route.lineageId,
          memories,
          { kind: "main" },
          receipt(route.locale, receiptByStatus[result.status] ?? "write_failed", {
            max: getMemoryLimits().maxServerMemories,
          }),
          dependencies,
        );
        return;
      }

      if (route.action === "edit-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const content = modal.fields.getTextInputValue(buildServerMemoryModalFieldId("content", route.nonce));
        let tagsRaw = "";
        try {
          tagsRaw = modal.fields.getTextInputValue(buildServerMemoryModalFieldId("tags", route.nonce));
        } catch {
          // Field optional
        }
        const tags = parseServerMemoryTags(tagsRaw);

        const action = await performPanelAction(
          () =>
            dependencies.operations.edit({
              serverId: scope.serverId,
              personaLineageId: route.lineageId,
              taughtByUserId: scope.userId,
              memoryId: route.memoryId,
              workspaceId: scope.workspaceId,
              isBlacklisted: scope.isBlacklisted,
              canManage: scope.canManage,
              memteachingEnabled: scope.memteachingEnabled,
              content,
              tags,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;
        const currentOwnerFilter = scope.canManage ? undefined : scope.userId;
        const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, currentOwnerFilter);

        if (result.status === "success") {
          dependencies.recordAction({
            action: "memories.workspace.memory.edit",
            serverId: scope.serverId,
            userDiscId: interaction.user.id,
          });
          await repaint(
            interaction,
            route.locale,
            scope,
            "memories",
            route.lineageId,
            memories,
            { kind: "main", selectedMemoryId: result.row.server_memory_id },
            receipt(route.locale, "edited", { memory: result.row.content }),
            dependencies,
          );
          return;
        }

        if (result.status === "unchanged") {
          await repaint(
            interaction,
            route.locale,
            scope,
            "memories",
            route.lineageId,
            memories,
            { kind: "main", selectedMemoryId: route.memoryId },
            noChangesReceipt(route.locale),
            dependencies,
          );
          return;
        }

        if (result.status === "not-found") {
          await repaint(
            interaction,
            route.locale,
            scope,
            "memories",
            route.lineageId,
            memories,
            { kind: "main" },
            changedStateReceipt(route.locale),
            dependencies,
          );
          return;
        }

        const receiptByStatus: Record<string, string> = {
          blacklisted: "blacklisted_error",
          "teaching-disabled": "teaching_disabled_error",
          "empty-content": "empty_content",
          "content-too-long": "content_too_long",
          "write-failed": "write_failed",
        };
        await repaint(
          interaction,
          route.locale,
          scope,
          "memories",
          route.lineageId,
          memories,
          { kind: "main", selectedMemoryId: route.memoryId },
          receipt(route.locale, receiptByStatus[result.status] ?? "write_failed", {
            max: getMemoryLimits().maxServerMemories,
          }),
          dependencies,
        );
        return;
      }

      if (route.action === "remove-prompt") {
        const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, ownerFilter);
        const target = memories.find((m) => m.server_memory_id === route.memoryId);
        await repaint(
          interaction,
          route.locale,
          scope,
          "memories",
          route.lineageId,
          memories,
          target ? { kind: "remove", memoryId: route.memoryId } : { kind: "main" },
          target ? undefined : changedStateReceipt(route.locale),
          dependencies,
        );
        return;
      }

      if (route.action === "remove-cancel") {
        const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, ownerFilter);
        await repaint(
          interaction,
          route.locale,
          scope,
          "memories",
          route.lineageId,
          memories,
          { kind: "main", selectedMemoryId: route.memoryId },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "remove-confirm") {
        const action = await performPanelAction(
          () =>
            dependencies.operations.remove({
              serverId: scope.serverId,
              personaLineageId: route.lineageId,
              taughtByUserId: scope.userId,
              memoryId: route.memoryId,
              workspaceId: scope.workspaceId,
              isBlacklisted: scope.isBlacklisted,
              canManage: scope.canManage,
              memteachingEnabled: scope.memteachingEnabled,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;
        const currentOwnerFilter = scope.canManage ? undefined : scope.userId;
        const memories = await dependencies.loadMemories(scope.serverId, route.lineageId, currentOwnerFilter);

        if (result.status === "success") {
          dependencies.recordAction({
            action: "memories.workspace.memory.remove",
            serverId: scope.serverId,
            userDiscId: interaction.user.id,
          });
          await repaint(
            interaction,
            route.locale,
            scope,
            "memories",
            route.lineageId,
            memories,
            { kind: "main" },
            receipt(route.locale, "removed", { memory: result.row.content }),
            dependencies,
          );
          return;
        }

        await repaint(
          interaction,
          route.locale,
          scope,
          "memories",
          route.lineageId,
          memories,
          { kind: "main" },
          result.status === "not-found"
            ? changedStateReceipt(route.locale)
            : receipt(route.locale, result.status === "teaching-disabled" ? "teaching_disabled_error" : "write_failed"),
          dependencies,
        );
        return;
      }

      if (route.action === "retry" || route.action === "refresh") {
        const lineageId = route.lineageId ?? scope.personas[0]?.persona_lineage_id ?? 0;
        const memories =
          route.category === "memories" && lineageId
            ? await dependencies.loadMemories(scope.serverId, lineageId, ownerFilter)
            : [];
        await repaint(
          interaction,
          route.locale,
          scope,
          route.category,
          lineageId,
          memories,
          { kind: "main" },
          undefined,
          dependencies,
        );
        return;
      }
    },
  };
}

export const memoriesInteractionRoute = createMemoriesInteractionRoute();
