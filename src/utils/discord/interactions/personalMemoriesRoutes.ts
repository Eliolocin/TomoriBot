import {
  ComponentType,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type InteractionEditReplyOptions,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { APIAttachment } from "discord.js";
import { PrivacyLevel, type PersonalMemoryRow, type TomoriState } from "@/types/db/schema";
import type { PanelReadStatus, PanelReceipt } from "@/types/discord/panel";
import {
  clearShortTermMemoryForUser,
  getShortTermMemoriesForUser,
  preWarmUserStmEntries,
} from "@/utils/cache/shortTermMemoryCache";
import { getCachedUserRow, invalidateUserCache } from "@/utils/cache/userCache";
import { personaRepository, personalMemoryRepository, serverRepository, userRepository } from "@/utils/db/repositories";
import type { GlobalInteractionRoute, GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import { beginPanelInteraction, performPanelAction } from "@/utils/discord/interactions/panelController";
import { createNonce } from "@/utils/discord/panelRouteTokens";
import {
  PERSONAL_MEMORIES_ROUTE_NAMESPACE,
  PERSONAL_MEMORIES_ROUTE_VERSION,
  parsePersonalMemoriesPanelRoute,
  type PersonalMemoriesCategory,
} from "@/utils/discord/personalMemoriesPanelCatalog";
import {
  buildAddPersonalMemoryModal,
  buildEditPersonalMemoryModal,
  buildPersonalMemoriesPanelPayload,
  buildPersonalMemoryModalFieldId,
  MAX_PERSONAL_MEMORY_PAGE_SIZE,
  parsePersonalMemoryTags,
} from "@/utils/discord/ui/personalMemoriesPanel";
import { personaRepresentativeForLineage } from "@/utils/persona/lineage";
import {
  type PersonaPanelAvatarData,
  resolvePersonaPanelAvatar,
  withPersonaPanelAvatar,
} from "@/utils/discord/personaPanelAvatar";
import { showRoutedRawModal, takeRawModalFileUpload } from "@/utils/discord/ui/modals";
import { buildPanelContainer } from "@/utils/discord/ui/panel";
import { getMemoryLimits, validateMemoryContent } from "@/utils/misc/memoryLimits";
import {
  dedupeCaseInsensitive,
  getNonEmptyNumberedLines,
  readTxtUpload,
  type TxtUploadReadResult,
} from "@/utils/teach/batchUploadUtils";
import { log } from "@/utils/misc/logger";
import { recordPanelActionStat, type RecordPanelActionInput } from "@/utils/stats/panelActionMetrics";
import { localizer } from "@/utils/text/localizer";

const memoryLimits = getMemoryLimits();

function rangeIndexAfterRemoval<T>(
  records: readonly T[],
  removedId: number,
  getId: (record: T) => number,
  remainingCount: number,
  pageSize: number,
): number | undefined {
  const removedIndex = records.findIndex((record) => getId(record) === removedId);
  if (removedIndex < 0) return undefined;
  return Math.min(Math.floor(removedIndex / pageSize), Math.max(0, Math.ceil(remainingCount / pageSize) - 1));
}

interface PersonalMemoriesScope {
  userId: number;
  userDiscId: string;
  guildId: string | null;
  workspaceId: string;
  internalServerId: number | null;
  privacyLevel: PrivacyLevel;
  personas: TomoriState[];
  readStatus: PanelReadStatus;
}

export interface PersonalMemoriesOperations {
  add(input: {
    userId: number;
    userDiscId: string;
    personaLineageId: number;
    content: string;
    tags: string[];
  }): Promise<
    | { status: "success"; row: PersonalMemoryRow }
    | { status: "privacy-blocked" | "empty-content" | "content-too-long" | "limit-reached" | "write-failed" }
  >;
  addBatch(input: {
    userId: number;
    userDiscId: string;
    personaLineageId: number;
    contents: string[];
    tags: string[];
  }): Promise<
    | { status: "success"; added: number; skipped: number }
    | { status: "privacy-blocked" | "empty-content" | "content-too-long" | "write-failed" }
    | { status: "batch-limit-reached"; available: number; requested: number }
    | { status: "all-duplicates" }
  >;
  edit(input: {
    userId: number;
    userDiscId: string;
    personaLineageId: number;
    memoryId: number;
    content: string;
    tags: string[];
  }): Promise<
    | { status: "success"; row: PersonalMemoryRow }
    | { status: "unchanged" | "not-found" | "privacy-blocked" | "empty-content" | "content-too-long" | "write-failed" }
  >;
  remove(input: {
    userId: number;
    userDiscId: string;
    personaLineageId: number;
    memoryId: number;
  }): Promise<{ status: "success"; row: PersonalMemoryRow } | { status: "not-found" | "write-failed" }>;
  clearStm(userDiscId: string): Promise<void>;
}

export interface PersonalMemoriesRouteDependencies {
  resolveScope(
    interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
    forceRefresh?: boolean,
  ): Promise<PersonalMemoriesScope | null>;
  loadMemories(userId: number, lineageId: number): Promise<PersonalMemoryRow[]>;
  getMemoryCountsByLineage(userId: number): Promise<Map<number, number>>;
  getPersonaAvatarData(
    interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
    persona: TomoriState,
  ): Promise<PersonaPanelAvatarData>;
  getStmCount(userDiscId: string): Promise<number>;
  operations: PersonalMemoriesOperations;
  recordAction(input: RecordPanelActionInput): void;
  createNonce(): string;
  showAddModal(
    interaction: StringSelectMenuInteraction | ButtonInteraction,
    locale: string,
    category: PersonalMemoriesCategory,
    lineageId: number,
    nonce: string,
  ): Promise<void>;
  showEditModal(
    interaction: ButtonInteraction,
    locale: string,
    category: PersonalMemoriesCategory,
    lineageId: number,
    memory: PersonalMemoryRow,
    nonce: string,
  ): Promise<void>;
  takeFileUpload(interactionId: string, nonce: string): APIAttachment | undefined;
  // Injected because it performs network I/O, which is the same reason every other external effect
  // on this interface is injected.
  readUploadedText(attachment: APIAttachment): Promise<TxtUploadReadResult>;
}

export const personalMemoriesOperations: PersonalMemoriesOperations = {
  async add({ userId, userDiscId, personaLineageId, content, tags }) {
    const privacyLevel = await userRepository.getPrivacyLevel(userDiscId);
    if (privacyLevel === PrivacyLevel.FULL) {
      return { status: "privacy-blocked" };
    }
    const trimmed = content.trim();
    if (!trimmed) {
      return { status: "empty-content" };
    }
    const validation = validateMemoryContent(trimmed);
    if (!validation.isValid) {
      return { status: "content-too-long" };
    }
    const limitCheck = await personalMemoryRepository.checkPersonalMemoryLimit(userId, personaLineageId, true);
    if (!limitCheck.isValid) {
      return { status: "limit-reached" };
    }
    const inserted = await personalMemoryRepository.add(userId, personaLineageId, trimmed, tags);
    if (!inserted) {
      return { status: "write-failed" };
    }
    invalidateUserCache(userDiscId);
    return { status: "success", row: inserted };
  },

  async addBatch({ userId, userDiscId, personaLineageId, contents, tags }) {
    const privacyLevel = await userRepository.getPrivacyLevel(userDiscId);
    if (privacyLevel === PrivacyLevel.FULL) {
      return { status: "privacy-blocked" };
    }

    const trimmed = dedupeCaseInsensitive(contents.map((entry) => entry.trim()).filter((entry) => entry.length > 0));
    if (trimmed.length === 0) {
      return { status: "empty-content" };
    }
    if (trimmed.some((entry) => !validateMemoryContent(entry).isValid)) {
      return { status: "content-too-long" };
    }

    // Lineage 0 is the account-global bucket, and a lineage-scoped read still counts global rows
    // toward the limit, which is the same predicate the single-insert path uses.
    const existing = await personalMemoryRepository.loadForUserLineage(userId, personaLineageId, true);
    const existingContents = new Set(existing.map((row) => row.content.trim().toLowerCase()));
    const toInsert = trimmed.filter((entry) => !existingContents.has(entry.toLowerCase()));
    if (toInsert.length === 0) {
      return { status: "all-duplicates" };
    }

    const limitCheck = await personalMemoryRepository.checkPersonalMemoryLimit(userId, personaLineageId, true);
    const currentCount = limitCheck.currentCount ?? existing.length;
    const maxAllowed = limitCheck.maxAllowed ?? memoryLimits.maxPersonalMemories;
    const available = Math.max(0, maxAllowed - currentCount);
    if (toInsert.length > available) {
      return { status: "batch-limit-reached", available, requested: toInsert.length };
    }

    const inserted = await personalMemoryRepository.addBatch(userId, personaLineageId, toInsert, tags);
    if (!inserted) {
      return { status: "write-failed" };
    }
    invalidateUserCache(userDiscId);
    return { status: "success", added: toInsert.length, skipped: trimmed.length - toInsert.length };
  },

  async edit({ userId, userDiscId, personaLineageId, memoryId, content, tags }) {
    const privacyLevel = await userRepository.getPrivacyLevel(userDiscId);
    if (privacyLevel === PrivacyLevel.FULL) {
      return { status: "privacy-blocked" };
    }
    const trimmed = content.trim();
    if (!trimmed) {
      return { status: "empty-content" };
    }
    const validation = validateMemoryContent(trimmed);
    if (!validation.isValid) {
      return { status: "content-too-long" };
    }
    // Owner scoping check: confirm memoryId belongs to current user & lineage
    const freshlyLoaded = await personalMemoryRepository.loadForUserLineage(userId, personaLineageId, false);
    const target = freshlyLoaded.find((m) => m.personal_memory_id === memoryId);
    if (!target) {
      return { status: "not-found" };
    }
    const existingTags = target.tags ?? [];
    const tagsUnchanged = tags.length === existingTags.length && tags.every((t, i) => t === existingTags[i]);
    if (trimmed === target.content.trim() && tagsUnchanged) {
      return { status: "unchanged", row: target };
    }
    const ok = await personalMemoryRepository.edit(memoryId, trimmed, tags);
    if (!ok) {
      return { status: "write-failed" };
    }
    invalidateUserCache(userDiscId);
    return { status: "success", row: { ...target, content: trimmed, tags } };
  },

  async remove({ userId, userDiscId, personaLineageId, memoryId }) {
    // Owner scoping check: confirm memoryId belongs to current user & lineage
    const freshlyLoaded = await personalMemoryRepository.loadForUserLineage(userId, personaLineageId, false);
    const target = freshlyLoaded.find((m) => m.personal_memory_id === memoryId);
    if (!target) {
      return { status: "not-found" };
    }
    const ok = await personalMemoryRepository.remove(memoryId);
    if (!ok) {
      return { status: "write-failed" };
    }
    invalidateUserCache(userDiscId);
    return { status: "success", row: target };
  },

  async clearStm(userDiscId: string) {
    clearShortTermMemoryForUser(userDiscId);
  },
};

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
    attachments: [],
    flags: MessageFlags.IsComponentsV2,
  };
}

async function resolveScope(
  interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
  _forceRefresh = false,
): Promise<PersonalMemoriesScope | null> {
  const userDiscId = interaction.user.id;
  try {
    const userRow = await getCachedUserRow(userDiscId);
    const registeredUser = userRow ?? (await userRepository.register(userDiscId, interaction.user.username));
    if (!registeredUser?.user_id) return null;

    const privacyLevel = await userRepository.getPrivacyLevel(userDiscId);
    const workspaceId = interaction.guildId ?? interaction.user.id;
    const internalServerId = await serverRepository.loadServerIdByDiscId(workspaceId);

    let personas: TomoriState[] = [];
    try {
      const allPersonas = await personaRepository.loadAllForServer(workspaceId);
      personas = allPersonas.filter(
        (p) => p.persona_lineage_id !== undefined && p.persona_lineage_id !== null && p.persona_lineage_id !== 0,
      );
    } catch (error) {
      log.warn("Failed to load personas for personal memories scope", { workspaceId, error });
    }

    return {
      userId: registeredUser.user_id,
      userDiscId,
      guildId: interaction.guildId ?? null,
      workspaceId,
      internalServerId: internalServerId ?? null,
      privacyLevel,
      personas,
      readStatus: "fresh",
    };
  } catch (error) {
    log.error("Failed to resolve scope for personal memories", error);
    return null;
  }
}

async function loadMemories(userId: number, lineageId: number): Promise<PersonalMemoryRow[]> {
  const rows = await personalMemoryRepository.loadForUserLineage(userId, lineageId, false);
  return lineageId === 0 ? rows : rows.filter((m) => m.persona_lineage_id === lineageId);
}

function getMemoryCountsByLineage(userId: number): Promise<Map<number, number>> {
  return personalMemoryRepository.memoryCountsByLineage(userId);
}

async function getStmCount(userDiscId: string): Promise<number> {
  await preWarmUserStmEntries(userDiscId);
  return getShortTermMemoriesForUser(userDiscId).length;
}

// Enumerated rather than substring-matched: an inferred tone silently renders the wrong accent
// colour for any key whose name happens to omit the sentinel words, which is how "empty_content"
// once shipped a green success bar on a rejected submission.
const ERROR_RECEIPT_KEYS = new Set([
  "privacy_blocked_error",
  "empty_content",
  "content_too_long",
  "limit_reached",
  "write_failed",
  // The first two reach receipt() through a ternary rather than a string literal, so listing them
  // here is also what makes the composed-key guard test see them.
  "batch_file_invalid",
  "batch_file_too_large",
  "batch_all_duplicates",
  "batch_limit_reached",
]);

function receipt(locale: string, key: string, variables?: Record<string, string | number>): PanelReceipt {
  return {
    tone: ERROR_RECEIPT_KEYS.has(key) ? "error" : "success",
    heading: localizer(locale, `commands.personal.memories.${key}_heading`),
    detail: localizer(locale, `commands.personal.memories.${key}_detail`, variables),
  };
}

function changedStateReceipt(locale: string): PanelReceipt {
  return {
    tone: "info",
    heading: localizer(locale, "commands.personal.memories.changed_state_heading"),
    detail: localizer(locale, "commands.personal.memories.changed_state_detail"),
  };
}

function noChangesReceipt(locale: string): PanelReceipt {
  return {
    tone: "info",
    heading: localizer(locale, "commands.personal.memories.no_changes_heading"),
    detail: localizer(locale, "commands.personal.memories.no_changes_detail"),
  };
}

async function repaint(
  interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
  locale: string,
  scope: PersonalMemoriesScope,
  category: PersonalMemoriesCategory,
  selectedLineageId: number,
  memories: PersonalMemoryRow[],
  page: Parameters<typeof buildPersonalMemoriesPanelPayload>[0]["page"],
  panelReceipt?: PanelReceipt,
  dependencies: PersonalMemoriesRouteDependencies = defaultDependencies,
): Promise<void> {
  const stmCount = category === "global" ? await dependencies.getStmCount(scope.userDiscId) : 0;
  const memoryCountsByLineage =
    category === "persona" ? await dependencies.getMemoryCountsByLineage(scope.userId) : undefined;
  const representative =
    category === "persona" ? personaRepresentativeForLineage(scope.personas, selectedLineageId) : null;
  const selectedPersonaAvatar = representative
    ? await dependencies.getPersonaAvatarData(interaction, representative)
    : undefined;
  await interaction.editReply(
    withPersonaPanelAvatar(
      buildPersonalMemoriesPanelPayload({
        locale,
        category,
        selectedLineageId,
        personas: scope.personas,
        memories,
        memoryCountsByLineage,
        selectedPersonaAvatarUrl: selectedPersonaAvatar?.url,
        stmCount,
        privacyLevel: scope.privacyLevel,
        readStatus: scope.readStatus,
        page,
        receipt: panelReceipt,
      }),
      selectedPersonaAvatar,
    ),
  );
}

const defaultDependencies: PersonalMemoriesRouteDependencies = {
  resolveScope,
  loadMemories,
  getMemoryCountsByLineage,
  getPersonaAvatarData: resolvePersonaPanelAvatar,
  getStmCount,
  operations: personalMemoriesOperations,
  recordAction: (input) => {
    void recordPanelActionStat(input);
  },
  createNonce,
  showAddModal: (interaction, locale, category, lineageId, nonce) =>
    showRoutedRawModal(interaction, buildAddPersonalMemoryModal(locale, category, lineageId, nonce)),
  takeFileUpload: (interactionId, nonce) =>
    takeRawModalFileUpload(interactionId, buildPersonalMemoryModalFieldId("file", nonce)),
  readUploadedText: readTxtUpload,
  showEditModal: (interaction, locale, category, lineageId, memory, nonce) =>
    showRoutedRawModal(
      interaction,
      buildEditPersonalMemoryModal(
        locale,
        category,
        lineageId,
        memory.personal_memory_id ?? 0,
        memory.content,
        memory.tags ?? [],
        nonce,
      ),
    ),
};

export function createPersonalMemoriesInteractionRoute(
  overrides: Partial<PersonalMemoriesRouteDependencies> = {},
): GlobalInteractionRoute {
  const dependencies: PersonalMemoriesRouteDependencies = {
    ...defaultDependencies,
    ...overrides,
  };

  return {
    namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
    version: PERSONAL_MEMORIES_ROUTE_VERSION,
    async execute(_client, interaction, parsed): Promise<void> {
      const route = parsePersonalMemoriesPanelRoute(parsed);
      if (!route) throw new Error(`Malformed personal memories panel route: ${interaction.customId}`);

      // Modals and modal-opening select choices handle their own acknowledgement
      if (route.action === "select") {
        if (!interaction.isStringSelectMenu()) {
          throw new Error("Personal memories select route requires StringSelectMenu interaction");
        }
        const selectedValue = interaction.values[0];
        if (selectedValue === "action:add") {
          const cachedScope = await dependencies.resolveScope(interaction, false);
          if (cachedScope && cachedScope.privacyLevel === PrivacyLevel.FULL) {
            await interaction.reply({
              content: localizer(route.locale, "commands.personal.memories.privacy_blocked_error_detail"),
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          const nonce = dependencies.createNonce();
          await dependencies.showAddModal(interaction, route.locale, route.category, route.lineageId, nonce);
          return;
        }
      }

      if (route.action === "edit-open") {
        if (!interaction.isButton()) {
          throw new Error("Personal memories edit-open route requires Button interaction");
        }
        const cachedScope = await dependencies.resolveScope(interaction, false);
        if (cachedScope && cachedScope.privacyLevel === PrivacyLevel.FULL) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.memories.privacy_blocked_error_detail"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (!cachedScope) {
          await interaction.reply({
            content: localizer(route.locale, "commands.personal.memories.unavailable"),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const memories = await dependencies.loadMemories(cachedScope.userId, route.lineageId);
        const memory = memories.find((m) => m.personal_memory_id === route.memoryId);
        if (!memory) {
          await interaction.deferUpdate();
          await repaint(
            interaction,
            route.locale,
            cachedScope,
            route.category,
            route.lineageId,
            memories,
            { kind: "main" },
            changedStateReceipt(route.locale),
            dependencies,
          );
          return;
        }
        const nonce = dependencies.createNonce();
        await dependencies.showEditModal(interaction, route.locale, route.category, route.lineageId, memory, nonce);
        return;
      }

      const initialScope = await beginPanelInteraction({
        acknowledge: () => interaction.deferUpdate(),
        authorize: () => true,
        onDenied: () => Promise.resolve(),
        load: () => dependencies.resolveScope(interaction, route.action === "retry" || route.action === "refresh"),
        onMissing: () => interaction.editReply(terminalPayload(route.locale, "commands.personal.memories.unavailable")),
      });
      if (!initialScope) return;
      let scope = initialScope;

      if (route.action === "category") {
        const lineageId = route.category === "persona" ? (scope.personas[0]?.persona_lineage_id ?? 0) : 0;
        const memories = await dependencies.loadMemories(scope.userId, lineageId);
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
        const selectedLineage = Number((interaction as StringSelectMenuInteraction).values[0]);
        const validLineage = scope.personas.some((p) => p.persona_lineage_id === selectedLineage)
          ? selectedLineage
          : (scope.personas[0]?.persona_lineage_id ?? 0);
        const memories = await dependencies.loadMemories(scope.userId, validLineage);
        await repaint(
          interaction,
          route.locale,
          scope,
          "persona",
          validLineage,
          memories,
          { kind: "main" },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "persona-page") {
        const validLineage = scope.personas.some((persona) => persona.persona_lineage_id === route.lineageId)
          ? route.lineageId
          : (scope.personas[0]?.persona_lineage_id ?? 0);
        const memories = await dependencies.loadMemories(scope.userId, validLineage);
        await repaint(
          interaction,
          route.locale,
          scope,
          "persona",
          validLineage,
          memories,
          { kind: "main", personaRangeIndex: route.rangeIndex },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "select") {
        const selectedValue = (interaction as StringSelectMenuInteraction).values[0];
        const memoryId = Number(selectedValue);
        const memories = await dependencies.loadMemories(scope.userId, route.lineageId);
        await repaint(
          interaction,
          route.locale,
          scope,
          route.category,
          route.lineageId,
          memories,
          { kind: "main", selectedMemoryId: memoryId, rangeIndex: route.rangeIndex },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "range-open") {
        const memories = await dependencies.loadMemories(scope.userId, route.lineageId);
        await repaint(
          interaction,
          route.locale,
          scope,
          route.category,
          route.lineageId,
          memories,
          { kind: "main", rangeIndex: 0 },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "range") {
        const memories = await dependencies.loadMemories(scope.userId, route.lineageId);
        await repaint(
          interaction,
          route.locale,
          scope,
          route.category,
          route.lineageId,
          memories,
          { kind: "main", rangeIndex: route.rangeIndex },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "range-page") {
        const memories = await dependencies.loadMemories(scope.userId, route.lineageId);
        await repaint(
          interaction,
          route.locale,
          scope,
          route.category,
          route.lineageId,
          memories,
          { kind: "main", rangeIndex: route.chooserPage },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "range-cancel") {
        const memories = await dependencies.loadMemories(scope.userId, route.lineageId);
        await repaint(
          interaction,
          route.locale,
          scope,
          route.category,
          route.lineageId,
          memories,
          { kind: "main" },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "add-submit") {
        const modal = interaction as ModalSubmitInteraction;
        let content = "";
        try {
          content = modal.fields.getTextInputValue(buildPersonalMemoryModalFieldId("content", route.nonce));
        } catch {
          // Optional once the file field can supply the memories instead.
        }
        let tagsRaw = "";
        try {
          tagsRaw = modal.fields.getTextInputValue(buildPersonalMemoryModalFieldId("tags", route.nonce));
        } catch {
          // Field optional
        }
        const tags = parsePersonalMemoryTags(tagsRaw);
        const uploadedFile = dependencies.takeFileUpload(interaction.id, route.nonce);

        if (uploadedFile) {
          const upload = await dependencies.readUploadedText(uploadedFile);
          if (!upload.isValid || !upload.text) {
            const memories = await dependencies.loadMemories(scope.userId, route.lineageId);
            await repaint(
              interaction,
              route.locale,
              scope,
              route.category,
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
                userId: scope.userId,
                userDiscId: scope.userDiscId,
                personaLineageId: route.lineageId,
                contents: typed ? [typed, ...uploaded] : uploaded,
                tags,
              }),
            () => dependencies.resolveScope(interaction, true),
          );
          const batchResult = batchAction.result;
          scope = batchAction.state ?? scope;
          const memories = await dependencies.loadMemories(scope.userId, route.lineageId);

          if (batchResult.status === "success") {
            if (scope.internalServerId) {
              dependencies.recordAction({
                action: "personal-memories.personal.memory.add",
                serverId: scope.internalServerId,
                userDiscId: interaction.user.id,
              });
            }
            await repaint(
              interaction,
              route.locale,
              scope,
              route.category,
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
            "privacy-blocked": "privacy_blocked_error",
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
            route.category,
            route.lineageId,
            memories,
            { kind: "main" },
            receipt(route.locale, batchReceiptByStatus[batchResult.status] ?? "write_failed", {
              max: memoryLimits.maxPersonalMemories,
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
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              personaLineageId: route.lineageId,
              content,
              tags,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;
        const memories = await dependencies.loadMemories(scope.userId, route.lineageId);

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-memories.personal.memory.add",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(
            interaction,
            route.locale,
            scope,
            route.category,
            route.lineageId,
            memories,
            { kind: "main", selectedMemoryId: result.row.personal_memory_id },
            receipt(route.locale, "added", { memory: result.row.content }),
            dependencies,
          );
          return;
        }

        const receiptByStatus: Record<string, string> = {
          "privacy-blocked": "privacy_blocked_error",
          "empty-content": "empty_content",
          "content-too-long": "content_too_long",
          "limit-reached": "limit_reached",
          "write-failed": "write_failed",
        };
        await repaint(
          interaction,
          route.locale,
          scope,
          route.category,
          route.lineageId,
          memories,
          { kind: "main" },
          receipt(route.locale, receiptByStatus[result.status] ?? "write_failed", {
            max: memoryLimits.maxPersonalMemories,
          }),
          dependencies,
        );
        return;
      }

      if (route.action === "edit-submit") {
        const modal = interaction as ModalSubmitInteraction;
        const content = modal.fields.getTextInputValue(buildPersonalMemoryModalFieldId("content", route.nonce));
        let tagsRaw = "";
        try {
          tagsRaw = modal.fields.getTextInputValue(buildPersonalMemoryModalFieldId("tags", route.nonce));
        } catch {
          // Field optional
        }
        const tags = parsePersonalMemoryTags(tagsRaw);

        const action = await performPanelAction(
          () =>
            dependencies.operations.edit({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              personaLineageId: route.lineageId,
              memoryId: route.memoryId,
              content,
              tags,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;
        const memories = await dependencies.loadMemories(scope.userId, route.lineageId);

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-memories.personal.memory.edit",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          await repaint(
            interaction,
            route.locale,
            scope,
            route.category,
            route.lineageId,
            memories,
            { kind: "main", selectedMemoryId: result.row.personal_memory_id },
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
            route.category,
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
            route.category,
            route.lineageId,
            memories,
            { kind: "main" },
            changedStateReceipt(route.locale),
            dependencies,
          );
          return;
        }

        const receiptByStatus: Record<string, string> = {
          "privacy-blocked": "privacy_blocked_error",
          "empty-content": "empty_content",
          "content-too-long": "content_too_long",
          "write-failed": "write_failed",
        };
        await repaint(
          interaction,
          route.locale,
          scope,
          route.category,
          route.lineageId,
          memories,
          { kind: "main", selectedMemoryId: route.memoryId },
          receipt(route.locale, receiptByStatus[result.status] ?? "write_failed", {
            max: memoryLimits.maxPersonalMemories,
          }),
          dependencies,
        );
        return;
      }

      if (route.action === "remove-prompt") {
        const memories = await dependencies.loadMemories(scope.userId, route.lineageId);
        const target = memories.find((m) => m.personal_memory_id === route.memoryId);
        await repaint(
          interaction,
          route.locale,
          scope,
          route.category,
          route.lineageId,
          memories,
          target ? { kind: "remove", memoryId: route.memoryId } : { kind: "main" },
          target ? undefined : changedStateReceipt(route.locale),
          dependencies,
        );
        return;
      }

      if (route.action === "remove-cancel") {
        const memories = await dependencies.loadMemories(scope.userId, route.lineageId);
        await repaint(
          interaction,
          route.locale,
          scope,
          route.category,
          route.lineageId,
          memories,
          { kind: "main", selectedMemoryId: route.memoryId },
          undefined,
          dependencies,
        );
        return;
      }

      if (route.action === "remove-confirm") {
        const memoriesBeforeRemoval = [...(await dependencies.loadMemories(scope.userId, route.lineageId))];
        const action = await performPanelAction(
          () =>
            dependencies.operations.remove({
              userId: scope.userId,
              userDiscId: scope.userDiscId,
              personaLineageId: route.lineageId,
              memoryId: route.memoryId,
            }),
          () => dependencies.resolveScope(interaction, true),
        );
        const result = action.result;
        scope = action.state ?? scope;
        const memories = await dependencies.loadMemories(scope.userId, route.lineageId);

        if (result.status === "success") {
          if (scope.internalServerId) {
            dependencies.recordAction({
              action: "personal-memories.personal.memory.remove",
              serverId: scope.internalServerId,
              userDiscId: interaction.user.id,
            });
          }
          const rangeIndex =
            rangeIndexAfterRemoval(
              memoriesBeforeRemoval,
              route.memoryId,
              (memory) => memory.personal_memory_id ?? 0,
              memories.length,
              MAX_PERSONAL_MEMORY_PAGE_SIZE,
            ) ?? 0;
          await repaint(
            interaction,
            route.locale,
            scope,
            route.category,
            route.lineageId,
            memories,
            { kind: "main", rangeIndex },
            receipt(route.locale, "removed", { memory: result.row.content }),
            dependencies,
          );
          return;
        }

        await repaint(
          interaction,
          route.locale,
          scope,
          route.category,
          route.lineageId,
          memories,
          { kind: "main" },
          result.status === "not-found" ? changedStateReceipt(route.locale) : receipt(route.locale, "write_failed"),
          dependencies,
        );
        return;
      }

      if (route.action === "stm-clear") {
        await dependencies.operations.clearStm(scope.userDiscId);
        if (scope.internalServerId) {
          dependencies.recordAction({
            action: "personal-memories.personal.stm.clear",
            serverId: scope.internalServerId,
            userDiscId: interaction.user.id,
          });
        }
        const memories = await dependencies.loadMemories(scope.userId, route.lineageId);
        await repaint(
          interaction,
          route.locale,
          scope,
          route.category,
          route.lineageId,
          memories,
          { kind: "main" },
          receipt(route.locale, "stm_cleared"),
          dependencies,
        );
        return;
      }

      if (route.action === "retry" || route.action === "refresh") {
        const memories = await dependencies.loadMemories(scope.userId, route.lineageId);
        await repaint(
          interaction,
          route.locale,
          scope,
          route.category,
          route.lineageId,
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

export const personalMemoriesInteractionRoute = createPersonalMemoriesInteractionRoute();

export type PersonalMemoriesPanelPayloadOrTerminal =
  | ReturnType<typeof buildPersonalMemoriesPanelPayload>
  | InteractionEditReplyOptions;

export async function buildInitialPersonalMemoriesPanel(
  interaction: ChatInputCommandInteraction,
  locale: string,
  dependenciesOverride?: Partial<PersonalMemoriesRouteDependencies>,
): Promise<PersonalMemoriesPanelPayloadOrTerminal> {
  const dependencies: PersonalMemoriesRouteDependencies = {
    ...defaultDependencies,
    ...dependenciesOverride,
  };
  const scope = await dependencies.resolveScope(interaction);
  if (!scope) {
    return terminalPayload(locale, "commands.personal.memories.unavailable") as PersonalMemoriesPanelPayloadOrTerminal;
  }
  const memories = await dependencies.loadMemories(scope.userId, 0);
  const stmCount = await dependencies.getStmCount(scope.userDiscId);
  return withPersonaPanelAvatar(
    buildPersonalMemoriesPanelPayload({
      locale,
      category: "global",
      selectedLineageId: 0,
      personas: scope.personas,
      memories,
      stmCount,
      privacyLevel: scope.privacyLevel,
      readStatus: scope.readStatus,
      page: { kind: "main" },
    }),
  );
}
