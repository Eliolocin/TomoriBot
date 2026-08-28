import {
  ButtonStyle,
  ComponentType,
  type ActionRowData,
  type ButtonComponentData,
  type ComponentInContainerData,
  type ContainerComponentData,
} from "discord.js";
import type { PanelReceipt } from "@/types/discord/panel";
import { resolveRangeChooser } from "@/utils/discord/interactions/panelController";
import { buildInteractionRouteId } from "@/utils/discord/interactions/routeRegistry";
import { localizer } from "@/utils/text/localizer";

const PANEL_ACCENT_BY_TONE = {
  success: 0x57f287,
  warning: 0xfee75c,
  error: 0xed4245,
  info: 0x65c6c5,
} as const;

const RANGE_BUTTONS_PER_ROW = 5;

export interface RangeChooserRouteSegments {
  range: (rangeIndex: number) => string[];
  previous?: (targetChooserPage: number) => string[];
  next?: (targetChooserPage: number) => string[];
  cancel?: () => string[];
}

interface RangeChooserComponentsBase {
  locale: string;
  totalCount: number;
  pageSize: number;
  chooserPage?: number;
  namespace: string;
  version: string;
}

/**
 * Route identity is required rather than optional: a chooser rendered without it emits IDs that
 * collide across every list in the same namespace. `baseSegments` covers the common
 * identity-then-action-then-value layout, while `buildSegments` exists because `/moderation` already
 * routes as `range:<locale>:<category>:...`, which that layout cannot express.
 */
export type RangeChooserComponentsOptions = RangeChooserComponentsBase &
  (
    | { baseSegments: string[]; buildSegments?: never }
    | { buildSegments: RangeChooserRouteSegments; baseSegments?: never }
  );

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

export function buildRangeChooserComponents(options: RangeChooserComponentsOptions): ComponentInContainerData[] {
  const resolved = resolveRangeChooser({
    totalCount: options.totalCount,
    pageSize: options.pageSize,
    chooserPage: options.chooserPage,
  });

  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.TextDisplay,
      content: `### ${localizer(options.locale, "general.pagination.select_page_title")}`,
    },
    {
      type: ComponentType.TextDisplay,
      content: localizer(options.locale, "general.pagination.select_page_description", {
        totalItems: options.totalCount,
        totalPages: resolved.rangeCount,
      }),
    },
  ];

  const rangeButtons: ButtonComponentData[] = resolved.ranges.map((range) => ({
    type: ComponentType.Button,
    style: ButtonStyle.Primary,
    customId: buildInteractionRouteId(
      options.namespace,
      options.version,
      ...(options.buildSegments?.range
        ? options.buildSegments.range(range.rangeIndex)
        : [...(options.baseSegments ?? []), "range", String(range.rangeIndex)]),
    ),
    label: `${range.start}-${range.end}`,
  }));

  for (let offset = 0; offset < rangeButtons.length; offset += RANGE_BUTTONS_PER_ROW) {
    components.push({
      type: ComponentType.ActionRow,
      components: rangeButtons.slice(offset, offset + RANGE_BUTTONS_PER_ROW),
    } satisfies ActionRowData<ButtonComponentData>);
  }

  const cancelButton: ButtonComponentData = {
    type: ComponentType.Button,
    style: ButtonStyle.Danger,
    customId: buildInteractionRouteId(
      options.namespace,
      options.version,
      ...(options.buildSegments?.cancel ? options.buildSegments.cancel() : [...(options.baseSegments ?? []), "cancel"]),
    ),
    label: localizer(options.locale, "general.pagination.cancel"),
  };

  if (resolved.chooserPageCount > 1) {
    components.push({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildInteractionRouteId(
            options.namespace,
            options.version,
            ...(options.buildSegments?.previous
              ? options.buildSegments.previous(Math.max(0, resolved.chooserPage - 1))
              : [...(options.baseSegments ?? []), "previous", String(Math.max(0, resolved.chooserPage - 1))]),
          ),
          label: localizer(options.locale, "general.pagination.previous"),
          disabled: resolved.chooserPage === 0,
        },
        cancelButton,
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildInteractionRouteId(
            options.namespace,
            options.version,
            ...(options.buildSegments?.next
              ? options.buildSegments.next(resolved.chooserPage + 1)
              : [...(options.baseSegments ?? []), "next", String(resolved.chooserPage + 1)]),
          ),
          label: localizer(options.locale, "general.pagination.next"),
          disabled: resolved.chooserPage >= resolved.chooserPageCount - 1,
        },
      ],
    } satisfies ActionRowData<ButtonComponentData>);
  } else {
    components.push({
      type: ComponentType.ActionRow,
      components: [cancelButton],
    } satisfies ActionRowData<ButtonComponentData>);
  }

  return components;
}
