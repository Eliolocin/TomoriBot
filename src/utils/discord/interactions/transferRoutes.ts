import {
  MessageFlags,
  type ButtonInteraction,
  type Client,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import {
  personalConfigExportDataSchema,
  workspaceConfigExportDataSchema,
  type ImportResult,
  type MemoryBucket,
  type MemoryItem,
} from "@/types/db/dataExport";
import { getCachedAllPersonas } from "@/utils/cache/tomoriStateCache";
import { importRepository, personalMemoryRepository, userRepository } from "@/utils/db/repositories";
import type { PersonalConfigSection, WorkspaceConfigSection } from "@/utils/db/repositories/ImportRepository";
import { isWorkspaceTransferAuthorized } from "@/utils/discord/interactions/transferAuthorization";
import type { GlobalInteractionRoute, GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import {
  claimTransferSnapshot,
  consumeTransferSnapshot,
  readTransferSnapshot,
  releaseTransferSnapshotClaim,
  updateTransferSnapshotState,
  type TransferSnapshotClaimResult,
  type TransferSnapshotReadResult,
  type TransferSnapshotRecord,
  type TransferSnapshotStatePatch,
} from "@/utils/discord/interactions/transferSnapshotStore";
import {
  TRANSFER_ROUTE_NAMESPACE,
  TRANSFER_ROUTE_VERSION,
  parseTransferPanelRoute,
  type TransferPanelRoute,
} from "@/utils/discord/transferCatalog";
import { readMemoryBundleBuckets } from "@/utils/discord/transferMemoryBundle";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import {
  MEMORY_BUCKETS_PER_PAGE,
  MEMORY_DESTINATIONS_PER_PAGE,
  MEMORY_SKIP_VALUE,
  buildMemoryMappingPayload,
  buildMemoryReplaceConfirmationPayload,
  buildConfigSectionCheckboxGroupId,
  buildConfigSectionChecklistModal,
  buildTransferNoticePayload,
  formatConfigSectionLabels,
  getPresentedConfigSections,
  type ConfigTransferKind,
  type MemoryTransferDestination,
  type MemoryTransferKind,
  type MemoryTransferMapping,
} from "@/utils/discord/ui/transferPanel";
import { deliverGuardedPanel } from "@/utils/discord/interactions/panelController";
import { showRoutedRawModal, takeRawModalCheckboxGroupValues } from "@/utils/discord/ui/modals";
import { ColorCode } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";

type WorkspaceMemoryImportMapping = { bucketName: string; personaId: number; memories: MemoryItem[] };
type PersonalMemoryImportMapping = {
  bucketName: string;
  personaLineageId: number;
  memories: MemoryItem[];
};

export interface WorkspaceMemoryImportInput {
  destinationKey: string;
  actorDiscId: string;
  strategy: "merge" | "replace";
  mappings: ReadonlyArray<WorkspaceMemoryImportMapping>;
}

export interface PersonalMemoryImportInput {
  destinationKey: string;
  strategy: "merge" | "replace";
  mappings: ReadonlyArray<PersonalMemoryImportMapping>;
}

export interface TransferRouteDependencies {
  readSnapshot(
    nonce: string,
    actorDiscId: string,
    ownership: TransferSnapshotRecord["ownership"],
    destinationKey: string,
  ): TransferSnapshotReadResult;
  consumeSnapshot(
    nonce: string,
    actorDiscId: string,
    ownership: TransferSnapshotRecord["ownership"],
    destinationKey: string,
  ): TransferSnapshotReadResult;
  updateSnapshotState(
    nonce: string,
    actorDiscId: string,
    ownership: TransferSnapshotRecord["ownership"],
    destinationKey: string,
    patch: TransferSnapshotStatePatch,
  ): TransferSnapshotReadResult;
  claimSnapshot(
    nonce: string,
    actorDiscId: string,
    ownership: TransferSnapshotRecord["ownership"],
    destinationKey: string,
  ): TransferSnapshotClaimResult;
  releaseSnapshotClaim(
    nonce: string,
    actorDiscId: string,
    ownership: TransferSnapshotRecord["ownership"],
    destinationKey: string,
  ): TransferSnapshotReadResult;
  showConfigChecklistModal(
    interaction: ButtonInteraction,
    locale: string,
    kind: ConfigTransferKind,
    detectedSections: readonly string[],
    nonce: string,
  ): Promise<void>;
  takeConfigSectionValues(interactionId: string, fieldId: string): string[] | undefined;
  getWorkspaceMemoryDestinations(guildId: string): Promise<MemoryTransferDestination[]>;
  getPersonalMemoryDestinations(userDiscId: string, locale: string): Promise<MemoryTransferDestination[]>;
  applyConfigImport(
    snapshot: TransferSnapshotRecord,
    selectedSections: readonly string[],
    destinationKey: string,
  ): Promise<ImportResult>;
  applyWorkspaceMemoryImport(input: WorkspaceMemoryImportInput): Promise<ImportResult>;
  applyPersonalMemoryImport(input: PersonalMemoryImportInput): Promise<ImportResult>;
}

const WORKSPACE_CONFIG_SECTION_NAMES = new Set(Object.keys(workspaceConfigExportDataSchema.shape));
const PERSONAL_CONFIG_SECTION_NAMES = new Set(Object.keys(personalConfigExportDataSchema.shape));

// The submitted values arrive from a client-rendered modal, so every section reaching the repository is narrowed
// against the schema that owns it rather than trusted for being present in the snapshot.
function isWorkspaceConfigSection(section: string): section is WorkspaceConfigSection {
  return WORKSPACE_CONFIG_SECTION_NAMES.has(section);
}

function isPersonalConfigSection(section: string): section is PersonalConfigSection {
  return PERSONAL_CONFIG_SECTION_NAMES.has(section);
}

async function defaultApplyConfigImport(
  snapshot: TransferSnapshotRecord,
  selectedSections: readonly string[],
  destinationKey: string,
): Promise<ImportResult> {
  if (snapshot.kind === "workspace_config") {
    const parsed = workspaceConfigExportDataSchema.safeParse(snapshot.exportResult.payload);
    if (!parsed.success) return { success: false, error: "commands.data.import.error_invalid_config" };
    return importRepository.importWorkspaceConfig(
      destinationKey,
      parsed.data,
      selectedSections.filter(isWorkspaceConfigSection),
    );
  }

  const parsed = personalConfigExportDataSchema.safeParse(snapshot.exportResult.payload);
  if (!parsed.success) return { success: false, error: "commands.data.import.error_invalid_config" };
  return importRepository.importPersonalConfig(
    destinationKey,
    parsed.data,
    selectedSections.filter(isPersonalConfigSection),
  );
}

export type ConfigSectionSelectionResult =
  | { status: "ok"; sections: string[] }
  | { status: "refused"; reason: "invalid-selection" | "empty-selection" };

export function resolveSelectedConfigSections(
  snapshot: TransferSnapshotRecord,
  submittedValues: readonly string[],
): ConfigSectionSelectionResult {
  const detectedSections = new Set(snapshot.exportResult.detectedSections);
  if (submittedValues.some((value) => typeof value !== "string" || !detectedSections.has(value))) {
    return { status: "refused", reason: "invalid-selection" };
  }
  if (submittedValues.length === 0) return { status: "refused", reason: "empty-selection" };
  return { status: "ok", sections: [...submittedValues] };
}

type MemoryMappingPlanEntry = {
  bucketName: string;
  destinationLineageId: number | "skip";
};

export type MemoryMappingPlanResult =
  | { status: "ok"; plan: MemoryMappingPlanEntry[] }
  | {
      status: "refused";
      reason: "unresolved" | "duplicate-destination" | "all-skipped" | "invalid-binding";
      bucketName?: string;
      destinationLineageId?: number;
    };

export function resolveMemoryMappingPlan(
  buckets: readonly MemoryBucket[],
  mapping: MemoryTransferMapping,
): MemoryMappingPlanResult {
  const plan: MemoryMappingPlanEntry[] = [];
  const usedDestinations = new Set<number>();
  let skippedCount = 0;

  for (const bucket of buckets) {
    if (!Object.hasOwn(mapping, bucket.name)) {
      return { status: "refused", reason: "unresolved", bucketName: bucket.name };
    }

    const destinationLineageId = mapping[bucket.name];
    if (destinationLineageId === "skip") {
      skippedCount++;
      plan.push({ bucketName: bucket.name, destinationLineageId });
      continue;
    }
    if (!Number.isSafeInteger(destinationLineageId) || destinationLineageId < 0) {
      return { status: "refused", reason: "invalid-binding", bucketName: bucket.name };
    }
    if (usedDestinations.has(destinationLineageId)) {
      return { status: "refused", reason: "duplicate-destination", bucketName: bucket.name, destinationLineageId };
    }

    usedDestinations.add(destinationLineageId);
    plan.push({ bucketName: bucket.name, destinationLineageId });
  }

  if (skippedCount === buckets.length) return { status: "refused", reason: "all-skipped" };
  return { status: "ok", plan };
}

type MemoryImportMappingsResult =
  | { status: "ok"; kind: "workspace_memories"; mappings: WorkspaceMemoryImportMapping[] }
  | { status: "ok"; kind: "personal_memories"; mappings: PersonalMemoryImportMapping[] }
  | { status: "refused" };

/**
 * Binds every confirmed bucket to the key the repository call for its kind takes. A workspace destination carries
 * the persona the destination list offered, because that list is what the user saw and mapped against; a personal
 * destination is already the lineage. A bucket whose destination is missing, or a workspace destination that is
 * not one of the offered personas, refuses the whole write rather than importing part of the bundle.
 */
export function buildMemoryImportMappings(
  kind: MemoryTransferKind,
  buckets: readonly MemoryBucket[],
  plan: readonly MemoryMappingPlanEntry[],
  destinations: readonly MemoryTransferDestination[],
): MemoryImportMappingsResult {
  const bucketsByName = new Map(buckets.map((bucket) => [bucket.name, bucket]));
  const destinationsByLineage = new Map(destinations.map((destination) => [destination.lineageId, destination]));
  const workspaceMappings: WorkspaceMemoryImportMapping[] = [];
  const personalMappings: PersonalMemoryImportMapping[] = [];

  for (const entry of plan) {
    if (entry.destinationLineageId === "skip") continue;

    const bucket = bucketsByName.get(entry.bucketName);
    if (!bucket) return { status: "refused" };

    if (kind === "personal_memories") {
      personalMappings.push({
        bucketName: bucket.name,
        personaLineageId: entry.destinationLineageId,
        memories: bucket.memories,
      });
      continue;
    }

    const destination = destinationsByLineage.get(entry.destinationLineageId);
    if (!destination || destination.ownership !== "workspace") return { status: "refused" };
    workspaceMappings.push({ bucketName: bucket.name, personaId: destination.personaId, memories: bucket.memories });
  }

  return kind === "personal_memories"
    ? { status: "ok", kind: "personal_memories", mappings: personalMappings }
    : { status: "ok", kind: "workspace_memories", mappings: workspaceMappings };
}

async function defaultGetWorkspaceMemoryDestinations(guildId: string): Promise<MemoryTransferDestination[]> {
  const personas = await getCachedAllPersonas(guildId);
  const seenLineages = new Set<number>();
  const destinations: MemoryTransferDestination[] = [];
  for (const persona of personas) {
    const lineageId = persona.persona_lineage_id;
    const personaId = persona.persona_id;
    if (!Number.isSafeInteger(lineageId) || lineageId < 0 || seenLineages.has(lineageId)) continue;
    // A persona the write cannot address is left out rather than offered as a destination that then refuses.
    if (typeof personaId !== "number" || !Number.isSafeInteger(personaId) || personaId <= 0) continue;
    seenLineages.add(lineageId);
    destinations.push({ ownership: "workspace", lineageId, personaId, label: persona.persona_nickname });
  }
  return destinations;
}

async function defaultGetPersonalMemoryDestinations(
  userDiscId: string,
  locale: string,
): Promise<MemoryTransferDestination[]> {
  const userId = (await userRepository.loadByDiscordId(userDiscId))?.user_id;
  if (typeof userId !== "number" || !Number.isSafeInteger(userId)) return [];

  const lineages = await personalMemoryRepository.destinationLineages(userId);
  return [
    {
      ownership: "personal",
      lineageId: 0,
      label: localizer(locale, "commands.transfer.memory_destination_global_label"),
    },
    ...lineages.map((lineage, index) => ({
      ownership: "personal" as const,
      lineageId: lineage.lineageId,
      // A lineage with no matching persona row still needs a recognizable slot, so it takes the same ordinal
      // fallback the exporter uses when it has no nickname to show either.
      label:
        lineage.nickname ??
        localizer(locale, "commands.transfer.memory_destination_persona_label", { index: index + 1 }),
    })),
  ];
}

function replyInteraction(interaction: GlobalRoutableInteraction): ButtonInteraction | ModalSubmitInteraction {
  // replyInfoEmbed's signature predates select-menu callers. Its body uses only
  // members shared by select menus: guild, user, deferred, replied, id, webhook, and reply methods.
  return interaction as unknown as ButtonInteraction | ModalSubmitInteraction;
}

async function replyTransferInfo(
  interaction: GlobalRoutableInteraction,
  locale: string,
  titleKey: string,
  descriptionKey: string,
  color: ColorCode,
  descriptionVars?: Record<string, string | number>,
): Promise<void> {
  await replyInfoEmbed(replyInteraction(interaction), locale, {
    titleKey,
    descriptionKey,
    descriptionVars,
    color,
    flags: MessageFlags.Ephemeral,
  });
}

function assertInteractionKind(route: TransferPanelRoute["action"], interaction: GlobalRoutableInteraction): void {
  if (route === "config-apply") {
    if (!interaction.isModalSubmit()) {
      throw new Error("Transfer config-apply route requires a modal submission");
    }
    return;
  }

  if (route === "memory-map" || route === "memory-bucket-select") {
    if (!interaction.isStringSelectMenu()) {
      throw new Error(`Transfer ${route} route requires a string select interaction`);
    }
    return;
  }

  if (!interaction.isButton()) {
    throw new Error(`Transfer ${route} route requires a button interaction`);
  }
}

type SnapshotCandidate = {
  ownership: TransferSnapshotRecord["ownership"];
  destinationKey: string;
};

function findSnapshot(
  dependencies: TransferRouteDependencies,
  interaction: GlobalRoutableInteraction,
  nonce: string,
):
  | { status: "missing" }
  | { status: "forbidden" }
  | { status: "ok"; snapshot: TransferSnapshotRecord; candidate: SnapshotCandidate } {
  const actorDiscId = interaction.user.id;
  const candidates: SnapshotCandidate[] = [
    { ownership: "personal", destinationKey: actorDiscId },
    { ownership: "workspace", destinationKey: interaction.guildId ?? actorDiscId },
  ];
  let sawForbidden = false;

  for (const candidate of candidates) {
    const result = dependencies.readSnapshot(nonce, actorDiscId, candidate.ownership, candidate.destinationKey);
    if (result.status === "ok") return { ...result, candidate };
    if (result.status === "forbidden") sawForbidden = true;
  }

  return sawForbidden ? { status: "forbidden" } : { status: "missing" };
}

type MemoryRouteSnapshot = {
  snapshot: TransferSnapshotRecord;
  buckets: MemoryBucket[];
  kind: MemoryTransferKind;
  strategy: "merge" | "replace";
};

type MemoryPanelContext = MemoryRouteSnapshot & {
  destinations: MemoryTransferDestination[];
};

async function requireMemorySnapshot(
  interaction: GlobalRoutableInteraction,
  locale: string,
  snapshot: TransferSnapshotRecord,
): Promise<MemoryRouteSnapshot | null> {
  if (snapshot.kind !== "workspace_memories" && snapshot.kind !== "personal_memories") {
    await replyTransferInfo(
      interaction,
      locale,
      "commands.transfer.unavailable_title",
      "commands.transfer.unavailable_description",
      ColorCode.INFO,
    );
    return null;
  }

  if (!snapshot.strategy) {
    await replyTransferInfo(
      interaction,
      locale,
      "commands.transfer.memory_strategy_required_title",
      "commands.transfer.memory_strategy_required_description",
      ColorCode.WARN,
    );
    return null;
  }

  const buckets = readMemoryBundleBuckets(snapshot.exportResult.payload);
  if (!buckets || buckets.length === 0) {
    await replyTransferInfo(
      interaction,
      locale,
      "commands.transfer.memory_bundle_invalid_title",
      "commands.transfer.memory_bundle_invalid_description",
      ColorCode.WARN,
    );
    return null;
  }
  return { snapshot, buckets, kind: snapshot.kind, strategy: snapshot.strategy };
}

async function loadMemoryPanelContext(
  dependencies: TransferRouteDependencies,
  interaction: GlobalRoutableInteraction,
  locale: string,
  snapshot: TransferSnapshotRecord,
): Promise<MemoryPanelContext | null> {
  const memorySnapshot = await requireMemorySnapshot(interaction, locale, snapshot);
  if (!memorySnapshot) return null;
  const destinations = await loadMemoryDestinations(dependencies, interaction, locale, snapshot);
  if (!destinations) return null;
  return { ...memorySnapshot, destinations };
}

async function loadMemoryDestinations(
  dependencies: TransferRouteDependencies,
  interaction: GlobalRoutableInteraction,
  locale: string,
  snapshot: TransferSnapshotRecord,
): Promise<MemoryTransferDestination[] | null> {
  // The snapshot's own destination key addresses the workspace, so a DM-backed workspace lists its personas rather
  // than answering nothing for want of a guild. A personal import addresses the importing account instead.
  const destinations =
    snapshot.ownership === "personal"
      ? await dependencies.getPersonalMemoryDestinations(snapshot.destinationKey, locale)
      : await dependencies.getWorkspaceMemoryDestinations(snapshot.destinationKey);

  if (destinations.length === 0) {
    await replyTransferInfo(
      interaction,
      locale,
      "commands.transfer.memory_destinations_unavailable_title",
      "commands.transfer.memory_destinations_unavailable_description",
      ColorCode.WARN,
    );
    return null;
  }
  return destinations;
}

function parseMemoryIndex(value: string | undefined): number | null {
  if (!value || !/^(?:0|[1-9]\d*)$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function memoryPageCount(totalCount: number, pageSize: number): number {
  return Math.max(1, Math.ceil(totalCount / pageSize));
}

function isMemoryPageInRange(page: number, pageCount: number): boolean {
  return Number.isSafeInteger(page) && page >= 0 && page < pageCount;
}

async function replyMemoryStateFailure(
  interaction: GlobalRoutableInteraction,
  locale: string,
  result: TransferSnapshotReadResult,
): Promise<TransferSnapshotRecord | null> {
  if (result.status === "ok") return result.snapshot;
  await replyTransferInfo(
    interaction,
    locale,
    result.status === "missing"
      ? "commands.transfer.snapshot_expired_title"
      : "commands.transfer.permission_denied_title",
    result.status === "missing"
      ? "commands.transfer.snapshot_expired_description"
      : "commands.transfer.permission_denied_description",
    result.status === "missing" ? ColorCode.WARN : ColorCode.ERROR,
  );
  return null;
}

async function renderMemoryMapping(
  interaction: GlobalRoutableInteraction,
  locale: string,
  nonce: string,
  context: MemoryPanelContext,
  selectedBucketIndex: number,
  bucketPage: number,
  destPage: number,
): Promise<void> {
  await deliverGuardedPanel(
    interaction,
    buildMemoryMappingPayload({
      locale,
      nonce,
      buckets: context.buckets,
      destinations: context.destinations,
      mapping: context.snapshot.mapping ?? {},
      selectedBucketIndex,
      bucketPage,
      destPage,
      strategy: context.strategy,
    }),
    { method: "update", locale },
  );
}

export function createTransferInteractionRoute(
  overrides: Partial<TransferRouteDependencies> = {},
): GlobalInteractionRoute {
  const dependencies: TransferRouteDependencies = {
    readSnapshot: readTransferSnapshot,
    consumeSnapshot: consumeTransferSnapshot,
    updateSnapshotState: updateTransferSnapshotState,
    claimSnapshot: claimTransferSnapshot,
    releaseSnapshotClaim: releaseTransferSnapshotClaim,
    showConfigChecklistModal: (interaction, locale, kind, detectedSections, nonce) =>
      showRoutedRawModal(interaction, buildConfigSectionChecklistModal({ locale, kind, detectedSections, nonce })),
    takeConfigSectionValues: takeRawModalCheckboxGroupValues,
    getWorkspaceMemoryDestinations: defaultGetWorkspaceMemoryDestinations,
    getPersonalMemoryDestinations: defaultGetPersonalMemoryDestinations,
    applyConfigImport: defaultApplyConfigImport,
    applyWorkspaceMemoryImport: (input) =>
      importRepository.importWorkspaceMemoryBundle(
        input.destinationKey,
        input.actorDiscId,
        input.mappings,
        input.strategy,
      ),
    applyPersonalMemoryImport: (input) =>
      importRepository.importPersonalMemoryBundle(input.destinationKey, input.mappings, input.strategy),
    ...overrides,
  };

  return {
    namespace: TRANSFER_ROUTE_NAMESPACE,
    version: TRANSFER_ROUTE_VERSION,
    async execute(_client: Client, interaction: GlobalRoutableInteraction, parsed): Promise<void> {
      const route = parseTransferPanelRoute(parsed);
      if (!route) {
        throw new Error(`Malformed transfer route: ${interaction.customId}`);
      }

      assertInteractionKind(route.action, interaction);

      const snapshotResult = findSnapshot(dependencies, interaction, route.nonce);
      if (snapshotResult.status === "missing") {
        await replyTransferInfo(
          interaction,
          route.locale,
          "commands.transfer.snapshot_expired_title",
          "commands.transfer.snapshot_expired_description",
          ColorCode.WARN,
        );
        return;
      }
      if (snapshotResult.status === "forbidden") {
        await replyTransferInfo(
          interaction,
          route.locale,
          "commands.transfer.permission_denied_title",
          "commands.transfer.permission_denied_description",
          ColorCode.ERROR,
        );
        return;
      }

      const { snapshot, candidate } = snapshotResult;
      if (snapshot.ownership === "workspace" && !isWorkspaceTransferAuthorized(interaction)) {
        await replyTransferInfo(
          interaction,
          route.locale,
          "commands.transfer.permission_denied_title",
          "commands.transfer.permission_denied_description",
          ColorCode.ERROR,
        );
        return;
      }

      if (route.action === "memory-strategy") {
        if (snapshot.kind !== "workspace_memories" && snapshot.kind !== "personal_memories") {
          await replyTransferInfo(
            interaction,
            route.locale,
            "commands.transfer.unavailable_title",
            "commands.transfer.unavailable_description",
            ColorCode.INFO,
          );
          return;
        }

        const updated = dependencies.updateSnapshotState(
          route.nonce,
          interaction.user.id,
          candidate.ownership,
          candidate.destinationKey,
          { strategy: route.strategy },
        );
        if (updated.status === "missing") {
          await replyTransferInfo(
            interaction,
            route.locale,
            "commands.transfer.snapshot_expired_title",
            "commands.transfer.snapshot_expired_description",
            ColorCode.WARN,
          );
          return;
        }
        if (updated.status === "forbidden") {
          await replyTransferInfo(
            interaction,
            route.locale,
            "commands.transfer.permission_denied_title",
            "commands.transfer.permission_denied_description",
            ColorCode.ERROR,
          );
          return;
        }

        // The strategy is what the mapping surface renders, so choosing one opens it in place of the preview. The
        // controls that reach this action exist only on the preview, which is why a placeholder here left the whole
        // mapping flow unreachable.
        const memorySnapshot = await requireMemorySnapshot(interaction, route.locale, updated.snapshot);
        if (!memorySnapshot) return;
        const destinations = await loadMemoryDestinations(dependencies, interaction, route.locale, updated.snapshot);
        if (!destinations) return;

        const storedBucketIndex = updated.snapshot.selectedBucket
          ? memorySnapshot.buckets.findIndex((bucket) => bucket.name === updated.snapshot.selectedBucket)
          : 0;
        const selectedBucketIndex = storedBucketIndex >= 0 ? storedBucketIndex : 0;
        await renderMemoryMapping(
          interaction,
          route.locale,
          route.nonce,
          { ...memorySnapshot, destinations },
          selectedBucketIndex,
          Math.floor(selectedBucketIndex / MEMORY_BUCKETS_PER_PAGE),
          0,
        );
        return;
      }

      if (route.action === "memory-bucket-select") {
        const memorySnapshot = await requireMemorySnapshot(interaction, route.locale, snapshot);
        if (!memorySnapshot) return;
        const bucketPages = memoryPageCount(memorySnapshot.buckets.length, MEMORY_BUCKETS_PER_PAGE);
        if (!isMemoryPageInRange(route.bucketPage, bucketPages)) {
          await replyTransferInfo(
            interaction,
            route.locale,
            "commands.transfer.memory_page_invalid_title",
            "commands.transfer.memory_page_invalid_description",
            ColorCode.WARN,
          );
          return;
        }

        const select = interaction as StringSelectMenuInteraction;
        const bucketIndex = select.values.length === 1 ? parseMemoryIndex(select.values[0]) : null;
        const bucketStart = route.bucketPage * MEMORY_BUCKETS_PER_PAGE;
        const bucket = bucketIndex === null ? undefined : memorySnapshot.buckets[bucketIndex];
        if (
          bucketIndex === null ||
          !bucket ||
          bucketIndex < bucketStart ||
          bucketIndex >= Math.min(bucketStart + MEMORY_BUCKETS_PER_PAGE, memorySnapshot.buckets.length)
        ) {
          await replyTransferInfo(
            interaction,
            route.locale,
            "commands.transfer.memory_selection_invalid_title",
            "commands.transfer.memory_selection_invalid_description",
            ColorCode.WARN,
          );
          return;
        }

        const destinations = await loadMemoryDestinations(dependencies, interaction, route.locale, snapshot);
        if (!destinations) return;
        const context: MemoryPanelContext = { ...memorySnapshot, destinations };
        const updated = dependencies.updateSnapshotState(
          route.nonce,
          interaction.user.id,
          candidate.ownership,
          candidate.destinationKey,
          { selectedBucket: bucket.name, mapping: { ...(snapshot.mapping ?? {}) } },
        );
        const updatedSnapshot = await replyMemoryStateFailure(interaction, route.locale, updated);
        if (!updatedSnapshot) return;
        await renderMemoryMapping(
          interaction,
          route.locale,
          route.nonce,
          { ...context, snapshot: updatedSnapshot },
          bucketIndex,
          route.bucketPage,
          0,
        );
        return;
      }

      if (route.action === "memory-bucket-page") {
        const context = await loadMemoryPanelContext(dependencies, interaction, route.locale, snapshot);
        if (!context) return;
        const bucketPages = memoryPageCount(context.buckets.length, MEMORY_BUCKETS_PER_PAGE);
        if (!isMemoryPageInRange(route.bucketPage, bucketPages)) {
          await replyTransferInfo(
            interaction,
            route.locale,
            "commands.transfer.memory_page_invalid_title",
            "commands.transfer.memory_page_invalid_description",
            ColorCode.WARN,
          );
          return;
        }

        const storedBucketIndex = snapshot.selectedBucket
          ? context.buckets.findIndex((bucket) => bucket.name === snapshot.selectedBucket)
          : 0;
        const selectedBucketIndex = storedBucketIndex >= 0 ? storedBucketIndex : 0;
        const selectedBucket = context.buckets[selectedBucketIndex];
        if (!selectedBucket) return;
        const updated = dependencies.updateSnapshotState(
          route.nonce,
          interaction.user.id,
          candidate.ownership,
          candidate.destinationKey,
          { selectedBucket: selectedBucket.name, mapping: { ...(snapshot.mapping ?? {}) } },
        );
        const updatedSnapshot = await replyMemoryStateFailure(interaction, route.locale, updated);
        if (!updatedSnapshot) return;
        await renderMemoryMapping(
          interaction,
          route.locale,
          route.nonce,
          { ...context, snapshot: updatedSnapshot },
          selectedBucketIndex,
          route.bucketPage,
          0,
        );
        return;
      }

      if (route.action === "memory-map") {
        const memorySnapshot = await requireMemorySnapshot(interaction, route.locale, snapshot);
        if (!memorySnapshot) return;
        const bucket = memorySnapshot.buckets[route.bucketIndex];
        if (!bucket) {
          await replyTransferInfo(
            interaction,
            route.locale,
            "commands.transfer.memory_bucket_index_invalid_title",
            "commands.transfer.memory_bucket_index_invalid_description",
            ColorCode.WARN,
          );
          return;
        }
        const destinations = await loadMemoryDestinations(dependencies, interaction, route.locale, snapshot);
        if (!destinations) return;
        const context: MemoryPanelContext = { ...memorySnapshot, destinations };
        const destinationPages = memoryPageCount(context.destinations.length, MEMORY_DESTINATIONS_PER_PAGE);
        if (!isMemoryPageInRange(route.destPage, destinationPages)) {
          await replyTransferInfo(
            interaction,
            route.locale,
            "commands.transfer.memory_page_invalid_title",
            "commands.transfer.memory_page_invalid_description",
            ColorCode.WARN,
          );
          return;
        }

        const select = interaction as StringSelectMenuInteraction;
        const selectedValue = select.values.length === 1 ? select.values[0] : undefined;
        const selectedDestinationIndex = selectedValue === MEMORY_SKIP_VALUE ? null : parseMemoryIndex(selectedValue);
        const destinationStart = route.destPage * MEMORY_DESTINATIONS_PER_PAGE;
        const destinationOnPage =
          selectedDestinationIndex !== null &&
          context.destinations
            .slice(destinationStart, destinationStart + MEMORY_DESTINATIONS_PER_PAGE)
            .some((destination) => destination.lineageId === selectedDestinationIndex);
        if (selectedValue !== MEMORY_SKIP_VALUE && !destinationOnPage) {
          await replyTransferInfo(
            interaction,
            route.locale,
            "commands.transfer.memory_selection_invalid_title",
            "commands.transfer.memory_selection_invalid_description",
            ColorCode.WARN,
          );
          return;
        }

        const selectedMapping = selectedValue === MEMORY_SKIP_VALUE ? MEMORY_SKIP_VALUE : selectedDestinationIndex;
        if (selectedMapping === null || selectedMapping === undefined) {
          await replyTransferInfo(
            interaction,
            route.locale,
            "commands.transfer.memory_selection_invalid_title",
            "commands.transfer.memory_selection_invalid_description",
            ColorCode.WARN,
          );
          return;
        }
        const updated = dependencies.updateSnapshotState(
          route.nonce,
          interaction.user.id,
          candidate.ownership,
          candidate.destinationKey,
          {
            selectedBucket: bucket.name,
            mapping: { ...(snapshot.mapping ?? {}), [bucket.name]: selectedMapping },
          },
        );
        const updatedSnapshot = await replyMemoryStateFailure(interaction, route.locale, updated);
        if (!updatedSnapshot) return;
        await renderMemoryMapping(
          interaction,
          route.locale,
          route.nonce,
          { ...context, snapshot: updatedSnapshot },
          route.bucketIndex,
          Math.floor(route.bucketIndex / MEMORY_BUCKETS_PER_PAGE),
          route.destPage,
        );
        return;
      }

      if (route.action === "memory-map-page") {
        const memorySnapshot = await requireMemorySnapshot(interaction, route.locale, snapshot);
        if (!memorySnapshot) return;
        const bucket = memorySnapshot.buckets[route.bucketIndex];
        if (!bucket) {
          await replyTransferInfo(
            interaction,
            route.locale,
            "commands.transfer.memory_bucket_index_invalid_title",
            "commands.transfer.memory_bucket_index_invalid_description",
            ColorCode.WARN,
          );
          return;
        }
        const destinations = await loadMemoryDestinations(dependencies, interaction, route.locale, snapshot);
        if (!destinations) return;
        const context: MemoryPanelContext = { ...memorySnapshot, destinations };
        const destinationPages = memoryPageCount(context.destinations.length, MEMORY_DESTINATIONS_PER_PAGE);
        if (!isMemoryPageInRange(route.destPage, destinationPages)) {
          await replyTransferInfo(
            interaction,
            route.locale,
            "commands.transfer.memory_page_invalid_title",
            "commands.transfer.memory_page_invalid_description",
            ColorCode.WARN,
          );
          return;
        }

        const updated = dependencies.updateSnapshotState(
          route.nonce,
          interaction.user.id,
          candidate.ownership,
          candidate.destinationKey,
          { selectedBucket: bucket.name, mapping: { ...(snapshot.mapping ?? {}) } },
        );
        const updatedSnapshot = await replyMemoryStateFailure(interaction, route.locale, updated);
        if (!updatedSnapshot) return;
        await renderMemoryMapping(
          interaction,
          route.locale,
          route.nonce,
          { ...context, snapshot: updatedSnapshot },
          route.bucketIndex,
          Math.floor(route.bucketIndex / MEMORY_BUCKETS_PER_PAGE),
          route.destPage,
        );
        return;
      }

      if (route.action === "memory-confirm" || route.action === "memory-replace-confirm") {
        const memorySnapshot = await requireMemorySnapshot(interaction, route.locale, snapshot);
        if (!memorySnapshot) return;
        const plan = resolveMemoryMappingPlan(memorySnapshot.buckets, snapshot.mapping ?? {});
        if (plan.status === "refused") {
          const messageKeys =
            plan.reason === "unresolved"
              ? {
                  title: "commands.transfer.memory_mapping_unresolved_title",
                  description: "commands.transfer.memory_mapping_unresolved_description",
                }
              : plan.reason === "duplicate-destination"
                ? {
                    title: "commands.transfer.memory_mapping_duplicate_title",
                    description: "commands.transfer.memory_mapping_duplicate_description",
                  }
                : plan.reason === "all-skipped"
                  ? {
                      title: "commands.transfer.memory_mapping_all_skipped_title",
                      description: "commands.transfer.memory_mapping_all_skipped_description",
                    }
                  : {
                      title: "commands.transfer.memory_mapping_invalid_title",
                      description: "commands.transfer.memory_mapping_invalid_description",
                    };
          await replyTransferInfo(
            interaction,
            route.locale,
            messageKeys.title,
            messageKeys.description,
            ColorCode.WARN,
          );
          return;
        }

        const destinations = await loadMemoryDestinations(dependencies, interaction, route.locale, snapshot);
        if (!destinations) return;

        if (memorySnapshot.strategy === "replace" && route.action === "memory-confirm") {
          // The mapping panel's Confirm only ever opens the destructive preview. It is deliberately not the control
          // that writes, so a repeated or duplicated click on it re-renders the preview instead of committing the
          // Replace the preview exists to gate.
          const updated = dependencies.updateSnapshotState(
            route.nonce,
            interaction.user.id,
            candidate.ownership,
            candidate.destinationKey,
            { replaceConfirmed: true },
          );
          if (!(await replyMemoryStateFailure(interaction, route.locale, updated))) return;

          await deliverGuardedPanel(
            interaction,
            buildMemoryReplaceConfirmationPayload({
              locale: route.locale,
              nonce: route.nonce,
              buckets: memorySnapshot.buckets,
              destinations,
              mapping: snapshot.mapping ?? {},
            }),
            { method: "update", locale: route.locale },
          );
          return;
        }

        // Only the destructive preview renders the confirm control, so reaching it without the recorded preview, or
        // on a snapshot whose strategy is no longer the Replace that preview described, means a forged or stale
        // control rather than a reader who was shown what Replace clears.
        if (
          (route.action === "memory-replace-confirm" && memorySnapshot.strategy !== "replace") ||
          (memorySnapshot.strategy === "replace" && snapshot.replaceConfirmed !== true)
        ) {
          await replyTransferInfo(
            interaction,
            route.locale,
            "commands.transfer.memory_replace_confirmation_stale_title",
            "commands.transfer.memory_replace_confirmation_stale_description",
            ColorCode.WARN,
          );
          return;
        }

        const built = buildMemoryImportMappings(memorySnapshot.kind, memorySnapshot.buckets, plan.plan, destinations);
        if (built.status === "refused") {
          await replyTransferInfo(
            interaction,
            route.locale,
            "commands.transfer.memory_mapping_invalid_title",
            "commands.transfer.memory_mapping_invalid_description",
            ColorCode.WARN,
          );
          return;
        }

        // The claim is taken before anything is awaited, so a duplicate confirmation arriving during the write
        // cannot also pass validation and import the same memories a second time.
        const claimed = dependencies.claimSnapshot(
          route.nonce,
          interaction.user.id,
          candidate.ownership,
          candidate.destinationKey,
        );
        if (claimed.status === "in-flight") {
          await replyTransferInfo(
            interaction,
            route.locale,
            "commands.transfer.memory_import_in_progress_title",
            "commands.transfer.memory_import_in_progress_description",
            ColorCode.WARN,
          );
          return;
        }
        if (claimed.status !== "claimed") {
          await replyMemoryStateFailure(interaction, route.locale, claimed);
          return;
        }

        let snapshotConsumed = false;
        try {
          // Acknowledge as an update before the transaction, so the receipt replaces the panel it was confirmed on.
          // A plain defer would open a new ephemeral and leave the mapping controls on screen.
          await interaction.deferUpdate();

          const importResult =
            built.kind === "workspace_memories"
              ? await dependencies.applyWorkspaceMemoryImport({
                  destinationKey: candidate.destinationKey,
                  actorDiscId: interaction.user.id,
                  strategy: memorySnapshot.strategy,
                  mappings: built.mappings,
                })
              : await dependencies.applyPersonalMemoryImport({
                  destinationKey: candidate.destinationKey,
                  strategy: memorySnapshot.strategy,
                  mappings: built.mappings,
                });

          if (!importResult.success) {
            // Each bundle write is one transaction, so a failed result left no partially imported destination
            // behind. The snapshot is deliberately left unconsumed: a failed apply is not a reason to destroy the
            // pending import.
            await deliverGuardedPanel(
              interaction,
              buildTransferNoticePayload({
                locale: route.locale,
                titleKey: "commands.transfer.memory_import_failed_title",
                descriptionKey: importResult.error ?? "commands.transfer.memory_import_failed_description",
                color: ColorCode.ERROR,
              }),
              { locale: route.locale },
            );
            return;
          }

          // The write is committed, so the snapshot is consumed whether or not this read still finds it.
          dependencies.consumeSnapshot(route.nonce, interaction.user.id, candidate.ownership, candidate.destinationKey);
          snapshotConsumed = true;

          await deliverGuardedPanel(
            interaction,
            buildTransferNoticePayload({
              locale: route.locale,
              titleKey: "commands.transfer.memory_import_success_title",
              descriptionKey: "commands.transfer.memory_import_success_description",
              descriptionVars: {
                strategy: localizer(
                  route.locale,
                  memorySnapshot.strategy === "merge"
                    ? "commands.transfer.memory_merge_label"
                    : "commands.transfer.memory_replace_label",
                ),
                inserted: importResult.itemsImported?.memoriesInserted ?? 0,
                skipped: importResult.itemsImported?.memoriesSkipped ?? 0,
                deleted: importResult.itemsImported?.memoriesDeleted ?? 0,
              },
              color: ColorCode.SUCCESS,
            }),
            { locale: route.locale },
          );
        } finally {
          // A write that did not commit releases its claim, so a failed import stays retryable. A committed one has
          // already consumed the snapshot, which this release then simply fails to find.
          if (!snapshotConsumed) {
            dependencies.releaseSnapshotClaim(
              route.nonce,
              interaction.user.id,
              candidate.ownership,
              candidate.destinationKey,
            );
          }
        }
        return;
      }

      if (route.action === "cancel") {
        // Cancelling a write that is already running cannot stop its transaction, and it would delete the snapshot
        // that the failed write needs to stay retryable.
        if (snapshot.writeClaimed) {
          await replyTransferInfo(
            interaction,
            route.locale,
            "commands.transfer.memory_import_in_progress_title",
            "commands.transfer.memory_import_in_progress_description",
            ColorCode.WARN,
          );
          return;
        }

        const consumed = dependencies.consumeSnapshot(
          route.nonce,
          interaction.user.id,
          candidate.ownership,
          candidate.destinationKey,
        );
        if (consumed.status === "missing") {
          await replyTransferInfo(
            interaction,
            route.locale,
            "commands.transfer.snapshot_expired_title",
            "commands.transfer.snapshot_expired_description",
            ColorCode.WARN,
          );
          return;
        }
        if (consumed.status === "forbidden") {
          await replyTransferInfo(
            interaction,
            route.locale,
            "commands.transfer.permission_denied_title",
            "commands.transfer.permission_denied_description",
            ColorCode.ERROR,
          );
          return;
        }

        // A terminal outcome replaces the panel it was clicked on, so no stale controls are left behind.
        await deliverGuardedPanel(
          interaction,
          buildTransferNoticePayload({
            locale: route.locale,
            titleKey: "commands.transfer.cancelled_title",
            descriptionKey: "commands.transfer.cancelled_description",
            color: ColorCode.INFO,
          }),
          { method: "update", locale: route.locale },
        );
        return;
      }

      if (route.action === "config-continue") {
        if (snapshot.kind !== "workspace_config" && snapshot.kind !== "personal_config") {
          await replyTransferInfo(
            interaction,
            route.locale,
            "commands.transfer.unavailable_title",
            "commands.transfer.unavailable_description",
            ColorCode.INFO,
          );
          return;
        }

        const presentedSections = getPresentedConfigSections(snapshot.kind, snapshot.exportResult.detectedSections);
        if (presentedSections.length === 0) {
          await replyTransferInfo(
            interaction,
            route.locale,
            "commands.transfer.config_no_importable_sections_title",
            "commands.transfer.config_no_importable_sections_description",
            ColorCode.INFO,
          );
          return;
        }

        await dependencies.showConfigChecklistModal(
          interaction as ButtonInteraction,
          route.locale,
          snapshot.kind,
          presentedSections,
          route.nonce,
        );
        return;
      }

      if (route.action === "config-apply") {
        if (snapshot.kind !== "workspace_config" && snapshot.kind !== "personal_config") {
          await replyTransferInfo(
            interaction,
            route.locale,
            "commands.transfer.unavailable_title",
            "commands.transfer.unavailable_description",
            ColorCode.INFO,
          );
          return;
        }

        const modal = interaction as ModalSubmitInteraction;
        const submittedValues = dependencies.takeConfigSectionValues(
          modal.id,
          buildConfigSectionCheckboxGroupId(route.nonce),
        );
        if (submittedValues === undefined) {
          await replyTransferInfo(
            interaction,
            route.locale,
            "commands.transfer.config_selection_stale_title",
            "commands.transfer.config_selection_stale_description",
            ColorCode.WARN,
          );
          return;
        }

        const selection = resolveSelectedConfigSections(snapshot, submittedValues);
        if (selection.status === "refused") {
          const messageKeys =
            selection.reason === "empty-selection"
              ? {
                  title: "commands.transfer.config_selection_empty_title",
                  description: "commands.transfer.config_selection_empty_description",
                }
              : {
                  title: "commands.transfer.config_selection_invalid_title",
                  description: "commands.transfer.config_selection_invalid_description",
                };
          await replyTransferInfo(
            interaction,
            route.locale,
            messageKeys.title,
            messageKeys.description,
            ColorCode.WARN,
          );
          return;
        }

        // Acknowledge as an update before the transaction, so the receipt can replace the checklist's parent panel.
        // A plain defer would open a new ephemeral message and leave the panel, and its buttons, on screen.
        await interaction.deferUpdate();

        const importResult = await dependencies.applyConfigImport(
          snapshot,
          selection.sections,
          candidate.destinationKey,
        );
        if (!importResult.success) {
          // The import is one transaction, so a failed result left no partially applied section behind. The snapshot
          // is deliberately left unconsumed: a failed apply is not a reason to destroy the pending import.
          await deliverGuardedPanel(
            interaction,
            buildTransferNoticePayload({
              locale: route.locale,
              titleKey: "commands.transfer.config_import_failed_title",
              descriptionKey: importResult.error ?? "commands.transfer.config_import_failed_description",
              color: ColorCode.ERROR,
            }),
            { locale: route.locale },
          );
          return;
        }

        // The write is committed, so the snapshot is consumed whether or not this read still finds it. Consuming
        // before the write would destroy a pending import that then failed to apply.
        dependencies.consumeSnapshot(route.nonce, interaction.user.id, candidate.ownership, candidate.destinationKey);

        await deliverGuardedPanel(
          interaction,
          buildTransferNoticePayload({
            locale: route.locale,
            titleKey: "commands.transfer.config_import_success_title",
            descriptionKey: "commands.transfer.config_import_success_description",
            descriptionVars: {
              sections: formatConfigSectionLabels(route.locale, selection.sections),
              fields: importResult.itemsImported?.configFieldsCount ?? 0,
            },
            color: ColorCode.SUCCESS,
          }),
          { locale: route.locale },
        );
        return;
      }

      return;
    },
  };
}

export const transferInteractionRoute = createTransferInteractionRoute();
