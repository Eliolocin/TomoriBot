import { ButtonStyle, ComponentType, MessageFlags } from "discord.js";
import {
  V2_CONFIG_EXCLUSIONS,
  type V2_CONFIG_SECTION_SCHEMAS,
  type MemoryBucket,
  personalConfigExportDataSchema,
  workspaceConfigExportDataSchema,
} from "@/types/db/dataExport";
import {
  buildTransferRouteId,
  TRANSFER_ROUTE_NAMESPACE,
  TRANSFER_ROUTE_VERSION,
} from "@/utils/discord/transferCatalog";
import { validateAndFallbackPanelPayload } from "@/utils/discord/ui/interactionCore";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import { buildPaginationRow, buildPanelContainer } from "@/utils/discord/ui/panel";
import { neutralizeFenceRuns, truncateDiscordText } from "@/utils/text/discordTextLimits";
import { localizer } from "@/utils/text/localizer";
import type { RawDiscordComponent } from "@/types/discord/rawApiTypes";
import type { ComponentsV2MessagePayload } from "@/utils/discord/ui/componentsV2Limits";

export type ConfigTransferKind = "workspace_config" | "personal_config";
export type MemoryTransferKind = "workspace_memories" | "personal_memories";
export type MemoryTransferMapping = Readonly<Record<string, number | "skip">>;

export interface MemoryTransferDestination {
  lineageId: number;
  label: string;
}

type ConfigSectionName = keyof typeof V2_CONFIG_SECTION_SCHEMAS;

const SECTION_LOCALE_KEYS: Record<ConfigSectionName, { label: string; description: string }> = {
  chat: {
    label: "commands.transfer.section_chat_label",
    description: "commands.transfer.section_chat_description",
  },
  triggers: {
    label: "commands.transfer.section_triggers_label",
    description: "commands.transfer.section_triggers_description",
  },
  capabilities: {
    label: "commands.transfer.section_capabilities_label",
    description: "commands.transfer.section_capabilities_description",
  },
  memory: {
    label: "commands.transfer.section_memory_label",
    description: "commands.transfer.section_memory_description",
  },
  media: {
    label: "commands.transfer.section_media_label",
    description: "commands.transfer.section_media_description",
  },
  speech: {
    label: "commands.transfer.section_speech_label",
    description: "commands.transfer.section_speech_description",
  },
  access: {
    label: "commands.transfer.section_access_label",
    description: "commands.transfer.section_access_description",
  },
  profile: {
    label: "commands.transfer.section_profile_label",
    description: "commands.transfer.section_profile_description",
  },
  privacy: {
    label: "commands.transfer.section_privacy_label",
    description: "commands.transfer.section_privacy_description",
  },
  appearance: {
    label: "commands.transfer.section_appearance_label",
    description: "commands.transfer.section_appearance_description",
  },
  response_modes: {
    label: "commands.transfer.section_response_modes_label",
    description: "commands.transfer.section_response_modes_description",
  },
};

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu;
const CONFIG_SECTION_CHECKBOX_GROUP_PREFIX = "transfer-config-sections";

function safeUserText(value: string, maxLength: number): string {
  return truncateDiscordText(neutralizeFenceRuns(value.replace(LONE_SURROGATE, "\uFFFD")), maxLength);
}

function configSectionNames(kind: ConfigTransferKind): ConfigSectionName[] {
  const shape =
    kind === "workspace_config" ? workspaceConfigExportDataSchema.shape : personalConfigExportDataSchema.shape;
  return Object.keys(shape) as ConfigSectionName[];
}

export function getPresentedConfigSections(
  kind: ConfigTransferKind,
  detectedSections: readonly string[],
): ConfigSectionName[] {
  const permitted = new Set(configSectionNames(kind));
  const seen = new Set<ConfigSectionName>();
  const sections: ConfigSectionName[] = [];

  for (const section of detectedSections) {
    if (!permitted.has(section as ConfigSectionName)) continue;
    const typedSection = section as ConfigSectionName;
    if (seen.has(typedSection)) continue;
    seen.add(typedSection);
    sections.push(typedSection);
  }

  return sections;
}

function sectionLabel(locale: string, section: ConfigSectionName): string {
  return safeSelectOptionText(localizer(locale, SECTION_LOCALE_KEYS[section].label), 100);
}

function sectionDescription(locale: string, section: ConfigSectionName): string {
  return safeSelectOptionText(localizer(locale, SECTION_LOCALE_KEYS[section].description), 100);
}

function configKindLabelKey(kind: ConfigTransferKind): string {
  return kind === "workspace_config"
    ? "commands.transfer.workspace_config_label"
    : "commands.transfer.personal_config_label";
}

function formatDroppedFields(locale: string, droppedFields: readonly string[]): string {
  if (droppedFields.length === 0) {
    return safeUserText(localizer(locale, "commands.transfer.excluded_fields_none"), 300);
  }

  return droppedFields
    .map((field) => {
      const exclusion = Object.hasOwn(V2_CONFIG_EXCLUSIONS, field)
        ? V2_CONFIG_EXCLUSIONS[field as keyof typeof V2_CONFIG_EXCLUSIONS]
        : undefined;
      const reason = exclusion?.reason ?? localizer(locale, "commands.transfer.excluded_field_unknown_reason");
      return `${safeUserText(field, 100)}: ${safeUserText(reason, 150)}`;
    })
    .join("\n");
}

export function buildConfigTransferPreviewPayload(input: {
  locale: string;
  kind: ConfigTransferKind;
  detectedSections: readonly string[];
  droppedFields: readonly string[];
  nonce: string;
}): ComponentsV2MessagePayload & { attachments: readonly [] } {
  const sections = getPresentedConfigSections(input.kind, input.detectedSections);
  const sectionList =
    sections.length > 0
      ? sections.map((section) => `• ${sectionLabel(input.locale, section)}`).join("\n")
      : localizer(input.locale, "commands.transfer.detected_sections_none");
  const sectionContent = `${safeUserText(
    localizer(input.locale, "commands.transfer.detected_sections_heading"),
    100,
  )}\n${safeUserText(sectionList, 1500)}`;
  const droppedContent = `${safeUserText(
    localizer(input.locale, "commands.transfer.excluded_fields_heading"),
    100,
  )}\n${safeUserText(formatDroppedFields(input.locale, input.droppedFields), 1500)}`;
  const description = safeUserText(
    localizer(input.locale, "commands.transfer.config_preview_description", {
      ownership: localizer(input.locale, configKindLabelKey(input.kind)),
    }),
    500,
  );
  const content = safeUserText(
    [
      `### ${safeUserText(localizer(input.locale, "commands.transfer.config_preview_title"), 100)}`,
      description,
      sectionContent,
      droppedContent,
    ].join("\n\n"),
    3900,
  );

  return validateAndFallbackPanelPayload(
    {
      components: [
        buildPanelContainer([
          { type: ComponentType.TextDisplay, content },
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Secondary,
                customId: buildTransferRouteId({ action: "config-continue", locale: input.locale, nonce: input.nonce }),
                label: safeSelectOptionText(localizer(input.locale, "commands.transfer.continue_label"), 80),
              },
              {
                type: ComponentType.Button,
                style: ButtonStyle.Secondary,
                customId: buildTransferRouteId({ action: "cancel", locale: input.locale, nonce: input.nonce }),
                label: safeSelectOptionText(localizer(input.locale, "commands.transfer.cancel_label"), 80),
              },
            ],
          },
        ]),
      ],
      attachments: [],
      flags: MessageFlags.IsComponentsV2,
    },
    input.locale,
  );
}

export function buildConfigSectionCheckboxGroupId(nonce: string): string {
  return `${CONFIG_SECTION_CHECKBOX_GROUP_PREFIX}_${nonce}`;
}

export function buildConfigSectionChecklistModal(input: {
  locale: string;
  kind: ConfigTransferKind;
  detectedSections: readonly string[];
  nonce: string;
}): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  const sections = getPresentedConfigSections(input.kind, input.detectedSections);
  if (sections.length === 0) {
    throw new Error("Cannot build a config checklist modal without importable sections");
  }
  return {
    custom_id: buildTransferRouteId({ action: "config-apply", locale: input.locale, nonce: input.nonce }),
    title: safeSelectOptionText(localizer(input.locale, "commands.transfer.section_checklist_modal_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(input.locale, "commands.transfer.section_checklist_label"), 45),
        description: safeSelectOptionText(
          localizer(input.locale, "commands.transfer.section_checklist_description"),
          100,
        ),
        component: {
          type: 22,
          custom_id: buildConfigSectionCheckboxGroupId(input.nonce),
          min_values: 0,
          max_values: sections.length,
          required: false,
          options: sections.map((section) => ({
            label: sectionLabel(input.locale, section),
            value: section,
            description: sectionDescription(input.locale, section),
            default: true,
          })),
        },
      },
    ],
  };
}

export const MEMORY_BUCKETS_PER_PAGE = 25;
// The skip option occupies one destination slot, so a destination page holds 24 personas against Discord's
// 25-option select ceiling.
export const MEMORY_DESTINATIONS_PER_PAGE = 24;
export const MEMORY_SKIP_VALUE = "skip";

function memoryBucketLabel(bucket: MemoryBucket): string {
  return safeSelectOptionText(safeUserText(bucket.label, 100), 100);
}

function memoryDestinationLabel(destination: MemoryTransferDestination): string {
  return safeSelectOptionText(safeUserText(destination.label, 100), 100);
}

function memoryBucketCount(locale: string, count: number): string {
  return safeUserText(localizer(locale, "commands.transfer.memory_bucket_count", { count }), 100);
}

function memoryStrategyLabel(locale: string, strategy: "merge" | "replace"): string {
  return safeUserText(
    localizer(
      locale,
      strategy === "merge" ? "commands.transfer.memory_merge_label" : "commands.transfer.memory_replace_label",
    ),
    80,
  );
}

function buildMemoryPayload(
  locale: string,
  components: Parameters<typeof buildPanelContainer>[0],
): ComponentsV2MessagePayload & { attachments: readonly [] } {
  return validateAndFallbackPanelPayload(
    {
      components: [buildPanelContainer(components)],
      attachments: [],
      flags: MessageFlags.IsComponentsV2,
    },
    locale,
  );
}

function memoryPageCount(totalCount: number, pageSize: number): number {
  return Math.max(1, Math.ceil(totalCount / pageSize));
}

function validateMemoryPage(page: number, pageCount: number, axis: string): void {
  if (!Number.isInteger(page) || page < 0 || page >= pageCount) {
    throw new Error(`Cannot build memory transfer payload with an invalid ${axis} page`);
  }
}

function memorySummaryLine(
  locale: string,
  bucket: MemoryBucket,
  destinations: readonly MemoryTransferDestination[],
  mapping: MemoryTransferMapping,
): string {
  const mappedValue = mapping[bucket.name];
  const destination =
    typeof mappedValue === "number" ? destinations.find((item) => item.lineageId === mappedValue) : undefined;
  const marker =
    mappedValue === "skip"
      ? localizer(locale, "commands.transfer.memory_mapping_skipped")
      : destination
        ? memoryDestinationLabel(destination)
        : localizer(locale, "commands.transfer.memory_mapping_unset");
  return `${safeUserText(bucket.label, 80)} -> ${safeUserText(marker, 100)}`;
}

export function buildMemoryTransferPreviewPayload(input: {
  locale: string;
  kind: MemoryTransferKind;
  buckets: readonly MemoryBucket[];
  nonce: string;
}): ComponentsV2MessagePayload & { attachments: readonly [] } {
  if (input.buckets.length === 0) {
    throw new Error("Cannot build a memory transfer preview without buckets");
  }

  const bucketSummary = input.buckets
    .map((bucket) => `${safeUserText(bucket.label, 100)}: ${memoryBucketCount(input.locale, bucket.memories.length)}`)
    .join("\n");
  const content = [
    `### ${safeUserText(localizer(input.locale, "commands.transfer.memory_preview_title"), 100)}`,
    safeUserText(
      localizer(input.locale, "commands.transfer.memory_preview_description", {
        ownership: localizer(
          input.locale,
          input.kind === "workspace_memories"
            ? "commands.transfer.workspace_memories_label"
            : "commands.transfer.personal_memories_label",
        ),
      }),
      500,
    ),
    bucketSummary,
  ].join("\n\n");

  return buildMemoryPayload(input.locale, [
    { type: ComponentType.TextDisplay, content },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildTransferRouteId({
            action: "memory-strategy",
            locale: input.locale,
            nonce: input.nonce,
            strategy: "merge",
          }),
          label: safeSelectOptionText(localizer(input.locale, "commands.transfer.memory_merge_label"), 80),
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Danger,
          customId: buildTransferRouteId({
            action: "memory-strategy",
            locale: input.locale,
            nonce: input.nonce,
            strategy: "replace",
          }),
          label: safeSelectOptionText(localizer(input.locale, "commands.transfer.memory_replace_label"), 80),
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildTransferRouteId({ action: "cancel", locale: input.locale, nonce: input.nonce }),
          label: safeSelectOptionText(localizer(input.locale, "commands.transfer.cancel_label"), 80),
        },
      ],
    },
  ]);
}

export function buildMemoryMappingPayload(input: {
  locale: string;
  nonce: string;
  buckets: readonly MemoryBucket[];
  destinations: readonly MemoryTransferDestination[];
  mapping: MemoryTransferMapping;
  selectedBucketIndex: number;
  bucketPage: number;
  destPage: number;
  strategy: "merge" | "replace";
}): ComponentsV2MessagePayload & { attachments: readonly [] } {
  if (input.buckets.length === 0) throw new Error("Cannot build a memory mapping payload without buckets");
  if (input.destinations.length === 0) throw new Error("Cannot build a memory mapping payload without destinations");
  if (
    !Number.isInteger(input.selectedBucketIndex) ||
    input.selectedBucketIndex < 0 ||
    input.selectedBucketIndex >= input.buckets.length
  ) {
    throw new Error("Cannot build a memory mapping payload with an invalid bucket index");
  }

  const bucketPages = memoryPageCount(input.buckets.length, MEMORY_BUCKETS_PER_PAGE);
  const destinationPages = memoryPageCount(input.destinations.length, MEMORY_DESTINATIONS_PER_PAGE);
  validateMemoryPage(input.bucketPage, bucketPages, "bucket");
  validateMemoryPage(input.destPage, destinationPages, "destination");

  const selectedBucket = input.buckets[input.selectedBucketIndex];
  if (!selectedBucket) throw new Error("Cannot build a memory mapping payload without a selected bucket");
  const mappingSummary = input.buckets
    .map((bucket) => memorySummaryLine(input.locale, bucket, input.destinations, input.mapping))
    .join("\n");
  const bucketStart = input.bucketPage * MEMORY_BUCKETS_PER_PAGE;
  const bucketOptions = input.buckets
    .slice(bucketStart, bucketStart + MEMORY_BUCKETS_PER_PAGE)
    .map((bucket, pageIndex) => ({
      label: memoryBucketLabel(bucket),
      value: String(bucketStart + pageIndex),
      description: memoryBucketCount(input.locale, bucket.memories.length),
      default: bucketStart + pageIndex === input.selectedBucketIndex,
    }));
  if (bucketOptions.length === 0) throw new Error("Cannot build a memory mapping payload with no bucket options");

  const destinationStart = input.destPage * MEMORY_DESTINATIONS_PER_PAGE;
  const destinationOptions = input.destinations
    .slice(destinationStart, destinationStart + MEMORY_DESTINATIONS_PER_PAGE)
    .map((destination) => ({
      label: memoryDestinationLabel(destination),
      value: String(destination.lineageId),
      description: safeSelectOptionText(
        localizer(input.locale, "commands.transfer.memory_destination_option_description"),
        100,
      ),
      default: input.mapping[selectedBucket.name] === destination.lineageId,
    }));
  destinationOptions.push({
    label: safeSelectOptionText(localizer(input.locale, "commands.transfer.memory_skip_option_label"), 100),
    value: MEMORY_SKIP_VALUE,
    description: safeSelectOptionText(localizer(input.locale, "commands.transfer.memory_skip_option_description"), 100),
    default: input.mapping[selectedBucket.name] === MEMORY_SKIP_VALUE,
  });
  if (destinationOptions.length === 0)
    throw new Error("Cannot build a memory mapping payload with no destination options");

  const bucketPagination = buildPaginationRow({
    locale: input.locale,
    rangeIndex: input.bucketPage,
    rangeCount: bucketPages,
    namespace: TRANSFER_ROUTE_NAMESPACE,
    version: TRANSFER_ROUTE_VERSION,
    buildSegments: {
      page: (page) => {
        const routeId = buildTransferRouteId({
          action: "memory-bucket-page",
          locale: input.locale,
          nonce: input.nonce,
          bucketPage: page,
        });
        return routeId.split(":").slice(2);
      },
    },
  });
  const destinationPagination = buildPaginationRow({
    locale: input.locale,
    rangeIndex: input.destPage,
    rangeCount: destinationPages,
    namespace: TRANSFER_ROUTE_NAMESPACE,
    version: TRANSFER_ROUTE_VERSION,
    buildSegments: {
      page: (page) => {
        const routeId = buildTransferRouteId({
          action: "memory-map-page",
          locale: input.locale,
          nonce: input.nonce,
          bucketIndex: input.selectedBucketIndex,
          destPage: page,
        });
        return routeId.split(":").slice(2);
      },
    },
  });

  const components: Parameters<typeof buildPanelContainer>[0] = [
    {
      type: ComponentType.TextDisplay,
      content: [
        `### ${safeUserText(localizer(input.locale, "commands.transfer.memory_mapping_title"), 100)}`,
        safeUserText(
          localizer(input.locale, "commands.transfer.memory_mapping_strategy", {
            strategy: memoryStrategyLabel(input.locale, input.strategy),
          }),
          200,
        ),
        mappingSummary,
      ].join("\n\n"),
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          customId: buildTransferRouteId({
            action: "memory-bucket-select",
            locale: input.locale,
            nonce: input.nonce,
            bucketPage: input.bucketPage,
          }),
          placeholder: safeSelectOptionText(
            localizer(input.locale, "commands.transfer.memory_bucket_select_placeholder"),
            150,
          ),
          minValues: 1,
          maxValues: 1,
          options: bucketOptions,
        },
      ],
    },
  ];
  if (bucketPagination) components.push(bucketPagination);
  components.push({
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.StringSelect,
        customId: buildTransferRouteId({
          action: "memory-map",
          locale: input.locale,
          nonce: input.nonce,
          bucketIndex: input.selectedBucketIndex,
          destPage: input.destPage,
        }),
        placeholder: safeSelectOptionText(
          localizer(input.locale, "commands.transfer.memory_destination_select_placeholder"),
          150,
        ),
        minValues: 1,
        maxValues: 1,
        options: destinationOptions,
      },
    ],
  });
  if (destinationPagination) components.push(destinationPagination);
  components.push({
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: input.strategy === "replace" ? ButtonStyle.Danger : ButtonStyle.Secondary,
        customId: buildTransferRouteId({ action: "memory-confirm", locale: input.locale, nonce: input.nonce }),
        label: safeSelectOptionText(localizer(input.locale, "commands.transfer.memory_confirm_label"), 80),
      },
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildTransferRouteId({ action: "cancel", locale: input.locale, nonce: input.nonce }),
        label: safeSelectOptionText(localizer(input.locale, "commands.transfer.cancel_label"), 80),
      },
    ],
  });

  return buildMemoryPayload(input.locale, components);
}

export function buildMemoryReplaceConfirmationPayload(input: {
  locale: string;
  nonce: string;
  buckets: readonly MemoryBucket[];
  destinations: readonly MemoryTransferDestination[];
  mapping: MemoryTransferMapping;
}): ComponentsV2MessagePayload & { attachments: readonly [] } {
  const clearedLineages = new Set<number>();
  for (const bucket of input.buckets) {
    const value = input.mapping[bucket.name];
    if (typeof value === "number") clearedLineages.add(value);
  }
  const clearedDestinations = [...clearedLineages].map((lineageId) => {
    const destination = input.destinations.find((item) => item.lineageId === lineageId);
    return destination ? memoryDestinationLabel(destination) : String(lineageId);
  });
  const skippedBuckets = input.buckets
    .filter((bucket) => input.mapping[bucket.name] === MEMORY_SKIP_VALUE)
    .map((bucket) =>
      safeUserText(
        localizer(input.locale, "commands.transfer.memory_skip_confirmation_line", {
          bucket: safeUserText(bucket.label, 100),
        }),
        250,
      ),
    );
  const content = [
    `### ${safeUserText(localizer(input.locale, "commands.transfer.memory_replace_confirmation_title"), 100)}`,
    safeUserText(localizer(input.locale, "commands.transfer.memory_replace_confirmation_description"), 500),
    `${safeUserText(localizer(input.locale, "commands.transfer.memory_cleared_destinations_heading"), 100)}\n${clearedDestinations.join("\n")}`,
    `${safeUserText(localizer(input.locale, "commands.transfer.memory_skipped_buckets_heading"), 100)}\n${skippedBuckets.join("\n")}`,
  ].join("\n\n");

  return buildMemoryPayload(input.locale, [
    { type: ComponentType.TextDisplay, content },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Danger,
          customId: buildTransferRouteId({ action: "memory-confirm", locale: input.locale, nonce: input.nonce }),
          label: safeSelectOptionText(localizer(input.locale, "commands.transfer.memory_replace_confirm_label"), 80),
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildTransferRouteId({ action: "cancel", locale: input.locale, nonce: input.nonce }),
          label: safeSelectOptionText(localizer(input.locale, "commands.transfer.cancel_label"), 80),
        },
      ],
    },
  ]);
}
