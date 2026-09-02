import { createHash } from "node:crypto";
import {
  ButtonStyle,
  ComponentType,
  type ActionRowData,
  type ButtonComponentData,
  type ComponentInContainerData,
  type ContainerComponentData,
  type TextDisplayComponentData,
} from "discord.js";
import type { PanelReceipt } from "@/types/discord/panel";
import { buildInteractionRouteId } from "@/utils/discord/interactions/routeRegistry";
import { localizer } from "@/utils/text/localizer";

const PANEL_ACCENT_BY_TONE = {
  success: 0x57f287,
  warning: 0xfee75c,
  error: 0xed4245,
  info: 0x65c6c5,
} as const;

export interface PaginationRouteSegments {
  page: (rangeIndex: number) => string[];
}

/**
 * Applies a Discord line marker to every line of `text`.
 *
 * `-#` and `>` are per-line markers, so a wrapped string behind a single leading marker renders
 * only its first line styled. Panel prose carries its own line breaks to keep the container as
 * narrow as the selects, which makes multi-line the normal case rather than the exception.
 */
export function withLinePrefix(prefix: string, text: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

export function buildPanelContainer(
  components: ComponentInContainerData[],
): ContainerComponentData<ComponentInContainerData> {
  return {
    type: ComponentType.Container,
    accentColor: PANEL_ACCENT_BY_TONE.info,
    components,
  };
}

export function buildOptionalThumbnailSection(
  heading: TextDisplayComponentData,
  thumbnailUrl?: string | null,
): ComponentInContainerData {
  return thumbnailUrl
    ? {
        type: ComponentType.Section,
        components: [heading],
        accessory: { type: ComponentType.Thumbnail, media: { url: thumbnailUrl } },
      }
    : heading;
}

export function buildPanelReceiptContainer(receipt: PanelReceipt): ContainerComponentData<ComponentInContainerData> {
  return {
    type: ComponentType.Container,
    accentColor: PANEL_ACCENT_BY_TONE[receipt.tone],
    components: [
      {
        type: ComponentType.TextDisplay,
        content: `### ${receipt.heading}\n> ${receipt.detail}${receipt.metadata ? `\n-# ${receipt.metadata}` : ""}`,
      },
    ],
  };
}

export function buildCategoryButtonRow<TCategory extends string>(
  categories: readonly { id: TCategory; label: string; customId: string }[],
  activeCategory: TCategory,
  disabled = false,
): ActionRowData<ButtonComponentData> {
  return {
    type: ComponentType.ActionRow,
    components: categories.map((cat) => ({
      type: ComponentType.Button,
      style: cat.id === activeCategory ? ButtonStyle.Primary : ButtonStyle.Secondary,
      customId: cat.customId,
      label: cat.label,
      disabled,
    })),
  };
}

export interface StateControlChoice<TValue> {
  value: TValue;
  label: string;
  customId: string;
  available?: boolean;
}

export function buildStateControlRow<TValue>(
  choices: readonly StateControlChoice<TValue>[],
  selectedValue: TValue,
  writesDisabled = false,
): ActionRowData<ButtonComponentData> {
  return {
    type: ComponentType.ActionRow,
    components: choices.map((choice) => {
      const isSelected = choice.value === selectedValue;
      const isAvailable = choice.available !== false;
      return {
        type: ComponentType.Button,
        style: isSelected ? ButtonStyle.Primary : ButtonStyle.Secondary,
        customId: choice.customId,
        label: choice.label,
        disabled: writesDisabled || isSelected || !isAvailable,
      };
    }),
  };
}

export interface PaginationRowOptions {
  locale: string;
  rangeIndex: number;
  rangeCount: number;
  namespace: string;
  version: string;
  buildSegments: PaginationRouteSegments;
  disabled?: boolean;
}

function buildPaginationIndicatorId(pageRouteId: string): string {
  const digest = createHash("sha256").update(`pagination-indicator:${pageRouteId}`).digest("base64url");
  return `pagination-indicator-${digest}`;
}

export function buildPaginationRow(options: PaginationRowOptions): ActionRowData<ButtonComponentData> | null {
  if (options.rangeCount <= 1) return null;

  const rangeIndex = Math.min(Math.max(options.rangeIndex, 0), options.rangeCount - 1);
  const buildCustomId = (targetRangeIndex: number) =>
    buildInteractionRouteId(options.namespace, options.version, ...options.buildSegments.page(targetRangeIndex));
  const indicatorCustomId = buildPaginationIndicatorId(buildCustomId(rangeIndex));

  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildCustomId(Math.max(0, rangeIndex - 1)),
        label: localizer(options.locale, "general.pagination.previous"),
        disabled: options.disabled || rangeIndex === 0,
      },
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: indicatorCustomId,
        label: localizer(options.locale, "general.pagination.page_info", {
          current: rangeIndex + 1,
          total: options.rangeCount,
        }),
        disabled: true,
      },
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildCustomId(Math.min(options.rangeCount - 1, rangeIndex + 1)),
        label: localizer(options.locale, "general.pagination.next"),
        disabled: options.disabled || rangeIndex === options.rangeCount - 1,
      },
    ],
  };
}
