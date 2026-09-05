import { createHash } from "node:crypto";
import {
  ButtonStyle,
  ComponentType,
  type ActionRowData,
  type ButtonComponentData,
  type ComponentInContainerData,
  type StringSelectMenuComponentData,
} from "discord.js";
import type { PanelReadStatus } from "@/types/discord/panel";
import type { VoiceSampleRow } from "@/types/db/schema";
import {
  CONFIG_ROUTE_NAMESPACE,
  CONFIG_ROUTE_VERSION,
  buildConfigRouteId,
  buildConfigRouteSegments,
} from "@/utils/discord/configPanelCatalog";
import { buildPaginationRow, buildStateControlRow } from "@/utils/discord/ui/panel";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import { localizer } from "@/utils/text/localizer";
import {
  buildTextPreview,
  textPreviewFooterKey,
  textPreviewFooterVars,
  CV2_TEXT_PREVIEW_BUDGET,
} from "@/utils/text/textPreview";

export const CONFIG_VOICE_SAMPLE_PAGE_SIZE = 25;

export interface ConfigVoicesView {
  turboEnabled: boolean;
  cfgWeight: number;
  exaggeration: number;
  samples: readonly VoiceSampleRow[]; // the page slice, already sliced by the caller
  totalSampleCount: number; // full library size, for the hidden-count line
  start: number; // pagination offset of this slice
  selectedIndex: number | null;
  removeConfirm?: { index: number; fp: string; refCount: number; nonce?: string };
}

export function computeVoiceSampleFingerprint(sample: VoiceSampleRow): string {
  return createHash("sha256")
    .update(`vsample:${sample.sample_id ?? ""}:${sample.name}:${sample.file_path}:${sample.ref_text ?? ""}`)
    .digest("base64url")
    .slice(0, 8);
}

export function encodeVoiceSampleOptionValue(index: number, fp: string): string {
  return `${index}:${fp}`;
}

export function decodeVoiceSampleOptionValue(value: string): { index: number; fp: string } | null {
  const separator = value.indexOf(":");
  if (separator < 0) return null;
  const rawIndex = value.slice(0, separator);
  const fp = value.slice(separator + 1);
  const index = Number.parseInt(rawIndex, 10);
  if (!Number.isInteger(index) || index < 0 || !/^[A-Za-z0-9_-]{8}$/.test(fp)) {
    return null;
  }
  return { index, fp };
}

export const decodeVoiceSampleSelectValue = decodeVoiceSampleOptionValue;

function heading(locale: string, titleKey: string, descriptionKey: string): ComponentInContainerData {
  return {
    type: ComponentType.TextDisplay,
    content: `### ${localizer(locale, titleKey)}\n${localizer(locale, descriptionKey)}`,
  };
}

export function buildConfigVoicesBody(input: {
  locale: string;
  readStatus: PanelReadStatus;
  view?: ConfigVoicesView;
}): ComponentInContainerData[] {
  const { locale, readStatus } = input;
  const writesDisabled = readStatus !== "fresh";
  const view: ConfigVoicesView = input.view ?? {
    turboEnabled: false,
    cfgWeight: 0.5,
    exaggeration: 0.5,
    samples: [],
    totalSampleCount: 0,
    start: 0,
    selectedIndex: null,
  };

  const components: ComponentInContainerData[] = [];

  components.push(
    heading(locale, "commands.config.panel.voices.page.title", "commands.config.panel.voices.page.description"),
  );

  const turboStatus = view.turboEnabled
    ? localizer(locale, "commands.config.panel.voices.page.status_enabled")
    : localizer(locale, "commands.config.panel.voices.page.status_disabled");

  components.push({
    type: ComponentType.TextDisplay,
    content: `**${localizer(locale, "commands.config.panel.voices.page.parameters_title")}**
> ${localizer(locale, "commands.config.panel.voices.page.parameters_turbo_label")}: ${turboStatus}
> ${localizer(locale, "commands.config.panel.voices.page.parameters_cfg_label")}: ${view.cfgWeight}
> ${localizer(locale, "commands.config.panel.voices.page.parameters_exaggeration_label")}: ${view.exaggeration}

${
  view.turboEnabled
    ? localizer(locale, "commands.config.panel.voices.parameters.turbo_notice")
    : localizer(locale, "commands.config.panel.voices.parameters.standard_notice")
}`,
  });

  components.push(
    buildStateControlRow(
      [
        {
          value: false,
          label: localizer(locale, "commands.config.panel.off_button"),
          customId: buildConfigRouteId({ action: "tts-turbo-set", locale, enabled: false }),
        },
        {
          value: true,
          label: localizer(locale, "commands.config.panel.on_button"),
          customId: buildConfigRouteId({ action: "tts-turbo-set", locale, enabled: true }),
        },
      ],
      view.turboEnabled,
      writesDisabled,
    ),
  );

  components.push({
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildConfigRouteId({ action: "tts-parameters-open", locale }),
        label: localizer(locale, "commands.config.panel.voices.page.parameters_button"),
        disabled: writesDisabled,
      },
    ],
  } satisfies ActionRowData<ButtonComponentData>);

  // When view.removeConfirm is set, replace items 5 through 8 with a confirm view showing the reference count and
  // a confirm/cancel pair (vsample-rem-conf, vsample-rem-cancel).
  if (view.removeConfirm) {
    const confirm = view.removeConfirm;
    const targetSample = view.samples.find((_, i) => view.start + i === confirm.index);
    const targetName = targetSample ? targetSample.name : "";

    components.push(
      {
        type: ComponentType.TextDisplay,
        content: `### ${localizer(locale, "commands.config.panel.voices.page.confirm_title")}\n${localizer(locale, "commands.config.panel.voices.page.confirm_description", { name: targetName, refs: confirm.refCount })}`,
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Danger,
            customId: buildConfigRouteId({
              action: "voice-sample-remove-confirm",
              locale,
              index: confirm.index,
              fp: confirm.fp,
              nonce: confirm.nonce ?? "00000000",
            }),
            label: localizer(locale, "commands.config.panel.voices.page.confirm_remove_button"),
            disabled: writesDisabled,
          },
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildConfigRouteId({ action: "voice-sample-remove-cancel", locale }),
            label: localizer(locale, "commands.config.panel.voices.page.cancel_remove_button"),
          },
        ],
      } satisfies ActionRowData<ButtonComponentData>,
    );

    return components;
  }

  const hiddenCount = Math.max(0, view.totalSampleCount - view.samples.length);

  let libraryBody: string;
  if (view.samples.length === 0) {
    libraryBody = localizer(locale, "commands.config.panel.voices.page.empty_library");
  } else {
    const sampleLines: string[] = [];
    for (const sample of view.samples) {
      const namePreview = buildTextPreview(sample.name, 60);
      let line = `• **${namePreview.text}**`;
      if (sample.duration_ms > 0) {
        line += ` (${(sample.duration_ms / 1000).toFixed(1)}s)`;
      }
      if (sample.ref_text) {
        const refPreview = buildTextPreview(sample.ref_text, 100);
        line += `\n> ${refPreview.text}`;
      }
      sampleLines.push(line);
    }
    libraryBody = sampleLines.join("\n");
    if (hiddenCount > 0) {
      libraryBody += `\n${localizer(locale, "commands.config.panel.voices.page.hidden_count", {
        count: hiddenCount,
      })}`;
    }
  }

  const libraryPreview = buildTextPreview(libraryBody, CV2_TEXT_PREVIEW_BUDGET);
  const libraryFooterKey = textPreviewFooterKey(libraryPreview);
  const finalLibraryText = libraryFooterKey
    ? `${libraryPreview.text}\n-# ${localizer(locale, libraryFooterKey, textPreviewFooterVars(libraryPreview))}`
    : libraryPreview.text;

  components.push({
    type: ComponentType.TextDisplay,
    content: `**${localizer(locale, "commands.config.panel.voices.page.library_header")}**\n${finalLibraryText}`,
  });

  const selectOptions =
    view.samples.length > 0
      ? view.samples.map((sample, offset) => {
          const absoluteIndex = view.start + offset;
          const fp = computeVoiceSampleFingerprint(sample);
          return {
            label: safeSelectOptionText(sample.name, 100),
            value: encodeVoiceSampleOptionValue(absoluteIndex, fp),
            description: sample.ref_text
              ? safeSelectOptionText(sample.ref_text.trim(), 100)
              : sample.duration_ms > 0
                ? `${(sample.duration_ms / 1000).toFixed(1)}s`
                : undefined,
            default: view.selectedIndex !== null && view.selectedIndex === absoluteIndex,
          };
        })
      : [
          {
            label: safeSelectOptionText(
              localizer(locale, "commands.config.panel.voices.page.empty_select_option"),
              100,
            ),
            value: "none",
          },
        ];

  components.push({
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.StringSelect,
        customId: buildConfigRouteId({
          action: "voice-sample-select",
          locale,
          start: view.start,
        }),
        placeholder: safeSelectOptionText(
          localizer(locale, "commands.config.panel.voices.page.sample_select_placeholder"),
          150,
        ),
        options: selectOptions,
        disabled: writesDisabled || view.samples.length === 0,
      },
    ],
  } satisfies ActionRowData<StringSelectMenuComponentData>);

  const rangeCount = Math.max(1, Math.ceil(view.totalSampleCount / CONFIG_VOICE_SAMPLE_PAGE_SIZE));
  const rangeIndex = Math.min(Math.max(0, Math.floor(view.start / CONFIG_VOICE_SAMPLE_PAGE_SIZE)), rangeCount - 1);

  const paginationRow = buildPaginationRow({
    locale,
    rangeIndex,
    rangeCount,
    namespace: CONFIG_ROUTE_NAMESPACE,
    version: CONFIG_ROUTE_VERSION,
    buildSegments: {
      page: (targetRangeIndex) =>
        buildConfigRouteSegments({
          action: "voice-sample-page",
          locale,
          start: targetRangeIndex * CONFIG_VOICE_SAMPLE_PAGE_SIZE,
        }),
    },
    disabled: writesDisabled,
  });

  if (paginationRow) {
    components.push(paginationRow);
  }

  const isSelected =
    view.selectedIndex !== null &&
    view.selectedIndex !== undefined &&
    view.samples.some((_, i) => view.start + i === view.selectedIndex);

  const selectedSample = isSelected ? view.samples.find((_, i) => view.start + i === view.selectedIndex) : undefined;

  const removeFp = selectedSample ? computeVoiceSampleFingerprint(selectedSample) : "00000000";
  const removeIndex = isSelected ? (view.selectedIndex as number) : 0;

  components.push({
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildConfigRouteId({ action: "voice-sample-add-open", locale }),
        label: localizer(locale, "commands.config.panel.voices.page.add_button"),
        disabled: writesDisabled,
      },
      {
        type: ComponentType.Button,
        style: ButtonStyle.Danger,
        customId: buildConfigRouteId({
          action: "voice-sample-remove-view",
          locale,
          index: removeIndex,
          fp: removeFp,
        }),
        label: localizer(locale, "commands.config.panel.voices.page.remove_button"),
        disabled: writesDisabled || !isSelected,
      },
    ],
  } satisfies ActionRowData<ButtonComponentData>);

  return components;
}
