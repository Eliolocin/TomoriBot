import {
  ButtonStyle,
  ComponentType,
  type ActionRowData,
  type ButtonComponentData,
  type ComponentInContainerData,
  type SelectMenuComponentOptionData,
  type StringSelectMenuComponentData,
} from "discord.js";
import type { LogitBiasEntry } from "@/types/provider/logitBias";
import type { PanelReadStatus } from "@/types/discord/panel";
import type { SavedProviderConfigRow } from "@/types/db/schema";
import {
  CONFIG_CLEARABLE_MODEL_CAPABILITIES,
  CONFIG_LOGIT_BIAS_PAGE_SIZE,
  CONFIG_MODEL_CAPABILITY_ORDER,
  CONFIG_MODEL_CLEAR_VALUE,
  CONFIG_MODEL_PAGE_SIZE,
  CONFIG_ROUTE_NAMESPACE,
  CONFIG_ROUTE_VERSION,
  buildConfigRouteId,
  buildConfigRouteSegments,
  type ConfigModelCapability,
  type ConfigPage,
} from "@/utils/discord/configPanelCatalog";
import type { ConfigModelChoice } from "@/utils/discord/interactions/configModelOperations";
import { buildPaginationRow, buildStateControlRow, withLinePrefix } from "@/utils/discord/ui/panel";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import {
  buildProviderParameterBlock,
  formatStoredParameterValue,
} from "@/utils/discord/ui/personalConfigParameterControls";
import { getProviderDisplayName } from "@/utils/provider/providerInfoRegistry";
import { formatStopStringForDisplay } from "@/utils/provider/stopStringConfig";
import { localizer } from "@/utils/text/localizer";

const MODEL_CAPABILITY_LOCALE_KEYS: Record<ConfigModelCapability, string> = {
  text: "commands.config.panel.capability_text",
  vision: "commands.config.panel.capability_vision",
  embedding: "commands.config.panel.capability_embedding",
  image: "commands.config.panel.capability_image",
  "nai-image": "commands.config.panel.capability_nai_image",
  video: "commands.config.panel.capability_video",
};

/** One server-default slot as the panel renders it. */
interface ConfigModelSlotView {
  capability: ConfigModelCapability;
  currentModelName: string | null;
  currentProvider: string | null;
  eligibleProviders: string[];
  providerPageStart: number;
}

export interface ConfigSwitchModelsView {
  slots: ConfigModelSlotView[];
  channelOverrideCount: number;
  personaOverrideCount: number;
}

export interface ConfigParametersView {
  textProviders: string[];
  selectedProvider: string | null;
  selectedConfig: SavedProviderConfigRow | null;
  stopStrings: string[];
  speakerPatternEnabled: boolean;
  logitBiasEntries: LogitBiasEntry[];
  logitBiasPageStart: number;
}

interface ConfigFallbackSlotView {
  label: string | null;
}

export interface ConfigFallbacksView {
  slots: ConfigFallbackSlotView[];
  providerEntries: Array<{ value: string; label: string }>;
  randomizerEnabled: boolean;
  hasFallbacks: boolean;
}

export interface ConfigImageGenerationView {
  positiveTags: string[];
  negativeTags: string[];
  sampler: string;
  steps: string;
  scale: string;
  noiseSchedule: string;
  cfgRescale: string;
}

/** Drilldown state for one capability's model catalog, mirroring the Persona Text-override shape. */
export interface ConfigModelListView {
  capability: ConfigModelCapability;
  provider: string;
  models: ConfigModelChoice[];
  start: number;
  currentModelId: number | null;
}

export interface ConfigModelsPageInput {
  locale: string;
  page: ConfigPage;
  readStatus: PanelReadStatus;
  switchView?: ConfigSwitchModelsView;
  parametersView?: ConfigParametersView;
  fallbacksView?: ConfigFallbacksView;
  imageView?: ConfigImageGenerationView;
  modelListView?: ConfigModelListView;
}

function heading(locale: string, titleKey: string, descriptionKey: string): ComponentInContainerData {
  return {
    type: ComponentType.TextDisplay,
    content: `### ${localizer(locale, titleKey)}\n${localizer(locale, descriptionKey)}`,
  };
}

function buildModelListBody(input: ConfigModelsPageInput, view: ConfigModelListView): ComponentInContainerData[] {
  const { locale } = input;
  const writesDisabled = input.readStatus !== "fresh";
  const capabilityLabel = localizer(locale, MODEL_CAPABILITY_LOCALE_KEYS[view.capability]);
  const clearable = CONFIG_CLEARABLE_MODEL_CAPABILITIES.has(view.capability);
  // A clearable slot spends one of Discord's 25 option slots on its None entry, and that entry is
  // re-prepended to every page, so its page size has to shrink or the last model of each page would
  // be sliced away with no page able to reach it.
  const pageSize = CONFIG_MODEL_PAGE_SIZE - (clearable ? 1 : 0);
  const pageCount = Math.max(1, Math.ceil(view.models.length / pageSize));
  const rangeIndex = Math.min(Math.max(Math.floor(view.start / pageSize), 0), pageCount - 1);
  const start = rangeIndex * pageSize;

  const options: SelectMenuComponentOptionData[] = [];
  if (clearable) {
    options.push({
      label: safeSelectOptionText(localizer(locale, "commands.config.panel.model_clear_option"), 100),
      value: CONFIG_MODEL_CLEAR_VALUE,
    });
  }
  options.push(
    ...view.models.slice(start, start + pageSize).map((model) => ({
      label: safeSelectOptionText(model.name, 100),
      value: String(model.id),
      description: model.description ? safeSelectOptionText(model.description, 100) : undefined,
      default: model.id === view.currentModelId,
    })),
  );

  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.TextDisplay,
      content: `**${capabilityLabel}**\n${localizer(locale, "commands.config.panel.model_pick_description", {
        provider: getProviderDisplayName(view.provider),
      })}`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          customId: buildConfigRouteId({
            action: "model-select",
            locale,
            capability: view.capability,
            provider: view.provider,
          }),
          placeholder: localizer(locale, "commands.config.panel.model_select_placeholder"),
          options,
          disabled: writesDisabled,
        },
      ],
    },
  ];

  const paginationRow = buildPaginationRow({
    locale,
    rangeIndex,
    rangeCount: pageCount,
    namespace: CONFIG_ROUTE_NAMESPACE,
    version: CONFIG_ROUTE_VERSION,
    buildSegments: {
      page: (targetRangeIndex) =>
        buildConfigRouteSegments({
          action: "model-page",
          locale,
          capability: view.capability,
          provider: view.provider,
          start: targetRangeIndex * pageSize,
        }),
    },
    disabled: writesDisabled,
  });
  if (paginationRow) components.push(paginationRow);

  components.push({
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildConfigRouteId({ action: "model-cancel", locale, capability: view.capability }),
        label: localizer(locale, "commands.config.panel.cancel_button"),
      },
    ],
  } satisfies ActionRowData<ButtonComponentData>);

  return components;
}

function buildSwitchModelsBody(input: ConfigModelsPageInput): ComponentInContainerData[] {
  const { locale } = input;
  const view = input.switchView;
  const writesDisabled = input.readStatus !== "fresh";
  const components: ComponentInContainerData[] = [
    heading(locale, "commands.config.panel.switch_models_title", "commands.config.panel.switch_models_description"),
  ];
  if (!view) return components;

  if (input.modelListView) {
    components.push(...buildModelListBody(input, input.modelListView));
    return components;
  }

  for (const capability of CONFIG_MODEL_CAPABILITY_ORDER) {
    const slot = view.slots.find((candidate) => candidate.capability === capability);
    if (!slot) continue;
    const capabilityLabel = localizer(locale, MODEL_CAPABILITY_LOCALE_KEYS[capability]);
    const current = slot.currentModelName
      ? `${slot.currentModelName}${slot.currentProvider ? ` (${getProviderDisplayName(slot.currentProvider)})` : ""}`
      : localizer(locale, "commands.config.panel.none_label");

    const pageCount = Math.max(1, Math.ceil(slot.eligibleProviders.length / CONFIG_MODEL_PAGE_SIZE));
    const rangeIndex = Math.min(
      Math.max(Math.floor(slot.providerPageStart / CONFIG_MODEL_PAGE_SIZE), 0),
      pageCount - 1,
    );
    const start = rangeIndex * CONFIG_MODEL_PAGE_SIZE;
    const visibleProviders = slot.eligibleProviders.slice(start, start + CONFIG_MODEL_PAGE_SIZE);

    components.push({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          customId: buildConfigRouteId({ action: "model-provider-select", locale, capability }),
          placeholder: safeSelectOptionText(`${capabilityLabel}: ${current}`, 150),
          options:
            visibleProviders.length > 0
              ? visibleProviders.map((provider) => ({
                  label: safeSelectOptionText(getProviderDisplayName(provider), 100),
                  value: provider,
                }))
              : [
                  {
                    label: safeSelectOptionText(localizer(locale, "commands.config.panel.no_providers_option"), 100),
                    value: "none",
                  },
                ],
          // A slot with no eligible provider has nothing to pick, so its select is inert rather
          // than absent: the placeholder is what keeps the current assignment readable.
          disabled: writesDisabled || visibleProviders.length === 0,
        },
      ],
    });

    const paginationRow = buildPaginationRow({
      locale,
      rangeIndex,
      rangeCount: pageCount,
      namespace: CONFIG_ROUTE_NAMESPACE,
      version: CONFIG_ROUTE_VERSION,
      buildSegments: {
        page: (targetRangeIndex) =>
          buildConfigRouteSegments({
            action: "model-provider-page",
            locale,
            capability,
            start: targetRangeIndex * CONFIG_MODEL_PAGE_SIZE,
          }),
      },
      disabled: writesDisabled,
    });
    if (paginationRow) components.push(paginationRow);
  }

  // Only Text carries narrower scopes, so the summary names those two editors rather than implying
  // that the other five slots support overrides at all.
  components.push({
    type: ComponentType.TextDisplay,
    content: `**${localizer(locale, "commands.config.panel.text_overrides_title")}**
${localizer(locale, "commands.config.panel.text_overrides_description")}
> ${localizer(locale, "commands.config.panel.channel_overrides_label")}: ${view.channelOverrideCount}
${withLinePrefix("-# ", localizer(locale, "commands.config.panel.channel_overrides_hint"))}
> ${localizer(locale, "commands.config.panel.persona_overrides_label")}: ${view.personaOverrideCount}
${withLinePrefix("-# ", localizer(locale, "commands.config.panel.persona_overrides_hint"))}`,
  });

  return components;
}

function formatStopStringSummary(locale: string, stopStrings: readonly string[]): string {
  if (stopStrings.length === 0) return localizer(locale, "commands.config.panel.none_label");
  const visible = stopStrings.slice(0, 8).map((stop) => `\`${formatStopStringForDisplay(stop)}\``);
  if (stopStrings.length > visible.length) {
    visible.push(
      localizer(locale, "commands.config.panel.stop_more_summary", { count: stopStrings.length - visible.length }),
    );
  }
  return visible.join(", ");
}

function formatLogitBiasSummary(locale: string, entries: readonly LogitBiasEntry[]): string {
  if (entries.length === 0) return localizer(locale, "commands.config.panel.none_label");
  const visible = entries.slice(0, 6).map((entry) => `\`${entry.text}\` ${entry.value}`);
  if (entries.length > visible.length) {
    visible.push(
      localizer(locale, "commands.config.panel.logit_more_summary", { count: entries.length - visible.length }),
    );
  }
  return visible.join(", ");
}

function buildParametersBody(input: ConfigModelsPageInput): ComponentInContainerData[] {
  const { locale } = input;
  const view = input.parametersView;
  const writesDisabled = input.readStatus !== "fresh";
  const components: ComponentInContainerData[] = [
    heading(locale, "commands.config.panel.parameters_title", "commands.config.panel.parameters_description"),
  ];
  if (!view) return components;
  const logitBiasPageCount = Math.max(1, Math.ceil(view.logitBiasEntries.length / CONFIG_LOGIT_BIAS_PAGE_SIZE));

  if (!view.selectedProvider) {
    components.push({
      type: ComponentType.TextDisplay,
      content: localizer(locale, "commands.config.panel.parameters_no_providers"),
    });
  } else {
    const config = view.selectedConfig;
    const formatValue = (value: number | null | undefined): string =>
      value === null || value === undefined
        ? localizer(locale, "commands.config.panel.none_label")
        : formatStoredParameterValue(value);
    components.push(
      ...buildProviderParameterBlock({
        // With exactly one saved provider the block renders a static line instead of an inert
        // one-option select, which is what an empty option list asks it for.
        providerOptions:
          view.textProviders.length > 1
            ? view.textProviders.map((provider) => ({
                value: provider,
                label: getProviderDisplayName(provider),
                default: provider === view.selectedProvider,
              }))
            : [],
        copy: {
          providerLabel: localizer(locale, "commands.config.panel.provider_label"),
          providerSelectPlaceholder: localizer(locale, "commands.config.panel.parameters_provider_placeholder"),
          samplingLabel: localizer(locale, "commands.config.panel.sampling_label"),
          temperatureLabel: localizer(locale, "commands.config.panel.param_temperature_label"),
          minPLabel: localizer(locale, "commands.config.panel.param_min_p_label"),
          topPLabel: localizer(locale, "commands.config.panel.param_top_p_label"),
          topKLabel: localizer(locale, "commands.config.panel.param_top_k_label"),
          generationLabel: localizer(locale, "commands.config.panel.generation_label"),
          frequencyLabel: localizer(locale, "commands.config.panel.param_frequency_label"),
          presenceLabel: localizer(locale, "commands.config.panel.param_presence_label"),
          maxOutputLabel: localizer(locale, "commands.config.panel.param_max_output_label"),
          thinkingLabel: localizer(locale, "commands.config.panel.param_thinking_label"),
          editSamplingLabel: localizer(locale, "commands.config.panel.edit_sampling_button"),
          editGenerationLabel: localizer(locale, "commands.config.panel.edit_generation_button"),
        },
        values: {
          providerDisplayName: getProviderDisplayName(view.selectedProvider),
          temperature: formatValue(config?.llm_temperature),
          minP: formatValue(config?.llm_min_p),
          topP: formatValue(config?.llm_top_p),
          topK: formatValue(config?.llm_top_k),
          frequency: formatValue(config?.llm_frequency_penalty),
          presence: formatValue(config?.llm_presence_penalty),
          maxOutput: formatValue(config?.llm_max_output_tokens),
          thinking: config?.thinking_level ?? localizer(locale, "commands.config.panel.none_label"),
        },
        routes: {
          providerSelect: buildConfigRouteId({ action: "parameters-provider-select", locale }),
          editSampling: buildConfigRouteId({ action: "sampling-open", locale, provider: view.selectedProvider }),
          editGeneration: buildConfigRouteId({ action: "generation-open", locale, provider: view.selectedProvider }),
        },
        writesDisabled,
      }),
    );
  }

  components.push(
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.stop_strings_title")}**
${localizer(locale, "commands.config.panel.stop_strings_description")}
> ${formatStopStringSummary(locale, view.stopStrings)}`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "stop-add-open", locale }),
          label: localizer(locale, "commands.config.panel.stop_add_button"),
          disabled: writesDisabled,
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "stop-manage-open", locale }),
          label: localizer(locale, "commands.config.panel.stop_manage_button"),
          disabled: writesDisabled,
        },
      ],
    } satisfies ActionRowData<ButtonComponentData>,
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.logit_bias_title")}**
${localizer(locale, "commands.config.panel.logit_bias_description")}
> ${formatLogitBiasSummary(locale, view.logitBiasEntries)}`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "logit-add-open", locale }),
          label: localizer(locale, "commands.config.panel.logit_add_button"),
          disabled: writesDisabled,
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "logit-upload-open", locale }),
          label: localizer(locale, "commands.config.panel.logit_upload_button"),
          disabled: writesDisabled,
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "logit-manage-open", locale, start: view.logitBiasPageStart }),
          label: localizer(locale, "commands.config.panel.logit_manage_button"),
          disabled: writesDisabled || view.logitBiasEntries.length === 0 || logitBiasPageCount > 1,
        },
      ],
    } satisfies ActionRowData<ButtonComponentData>,
  );

  // One modal can only present a page of entries, so past that the page is chosen before the modal
  // opens rather than by a prev/next row, which cannot reach the page it is parked on.
  if (logitBiasPageCount > 1) {
    components.push({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          customId: buildConfigRouteId({ action: "logit-manage-select", locale }),
          placeholder: localizer(locale, "commands.config.panel.logit_page_placeholder"),
          options: Array.from({ length: Math.min(logitBiasPageCount, CONFIG_MODEL_PAGE_SIZE) }, (_page, index) => {
            const start = index * CONFIG_LOGIT_BIAS_PAGE_SIZE;
            const end = Math.min(start + CONFIG_LOGIT_BIAS_PAGE_SIZE, view.logitBiasEntries.length);
            return {
              label: safeSelectOptionText(
                localizer(locale, "commands.config.panel.logit_page_option", { first: start + 1, last: end }),
                100,
              ),
              value: String(start),
            };
          }),
          disabled: writesDisabled,
        },
      ],
    });
  }

  return components;
}

function buildFallbacksBody(input: ConfigModelsPageInput): ComponentInContainerData[] {
  const { locale } = input;
  const view = input.fallbacksView;
  const writesDisabled = input.readStatus !== "fresh";
  const components: ComponentInContainerData[] = [
    heading(locale, "commands.config.panel.fallbacks_title", "commands.config.panel.fallbacks_description"),
  ];
  if (!view) return components;

  const noneLabel = localizer(locale, "commands.config.panel.none_label");
  const slotLines = view.slots.map((slot, index) => `> ${index + 1}. ${slot.label ?? noneLabel}`).join("\n");

  components.push({
    type: ComponentType.TextDisplay,
    content: `${localizer(locale, "commands.config.panel.fallback_order_description")}\n${slotLines}`,
  });

  const providerSelectRow: ActionRowData<StringSelectMenuComponentData> = {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.StringSelect,
        customId: buildConfigRouteId({ action: "fallback-provider-select", locale }),
        placeholder: localizer(locale, "commands.config.panel.fallback_provider_placeholder"),
        options:
          view.providerEntries.length > 0
            ? view.providerEntries.map((entry) => ({
                label: safeSelectOptionText(entry.label, 100),
                value: entry.value,
              }))
            : [
                {
                  label: safeSelectOptionText(localizer(locale, "commands.config.panel.no_providers_option"), 100),
                  value: "none",
                },
              ],
        disabled: writesDisabled || view.providerEntries.length === 0,
      },
    ],
  };
  components.push(providerSelectRow);

  components.push({
    type: ComponentType.TextDisplay,
    content: `**${localizer(locale, "commands.config.panel.randomizer_title")}**
${localizer(locale, "commands.config.panel.randomizer_description")}
> ${localizer(
      locale,
      view.randomizerEnabled
        ? "commands.config.panel.randomizer_state_on"
        : "commands.config.panel.randomizer_state_off",
    )}${
      view.hasFallbacks
        ? ""
        : `\n${withLinePrefix("-# ", localizer(locale, "commands.config.panel.randomizer_requires_fallback"))}`
    }`,
  });

  components.push(
    buildStateControlRow(
      [
        {
          value: false,
          label: localizer(locale, "commands.config.options.disable"),
          customId: buildConfigRouteId({ action: "randomizer-set", locale, enabled: false }),
        },
        {
          value: true,
          label: localizer(locale, "commands.config.options.enable"),
          customId: buildConfigRouteId({ action: "randomizer-set", locale, enabled: true }),
          // Enabling with an empty chain would be a silent no-op, so the precondition shows as an
          // unavailable choice rather than as a button that reports a refusal after the fact.
          available: view.hasFallbacks,
        },
      ],
      view.randomizerEnabled,
      writesDisabled,
    ),
  );

  return components;
}

function renderTagBlock(tags: readonly string[]): string {
  return ["```markdown", tags.join(", ").replaceAll("```", "`​``") || " ", "```"].join("\n");
}

function buildImageGenerationBody(input: ConfigModelsPageInput): ComponentInContainerData[] {
  const { locale } = input;
  const view = input.imageView;
  const writesDisabled = input.readStatus !== "fresh";
  const components: ComponentInContainerData[] = [
    heading(locale, "commands.config.panel.image_gen_title", "commands.config.panel.image_gen_description"),
  ];
  if (!view) return components;

  components.push(
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.image_defaults_title")}**
${localizer(locale, "commands.config.panel.image_defaults_description")}
${localizer(locale, "commands.config.panel.image_positive_label")}:
${renderTagBlock(view.positiveTags)}
${localizer(locale, "commands.config.panel.image_negative_label")}:
${renderTagBlock(view.negativeTags)}`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "image-tags-default-open", locale, negative: false }),
          label: localizer(locale, "commands.config.panel.edit_positive_button"),
          disabled: writesDisabled,
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "image-tags-default-open", locale, negative: true }),
          label: localizer(locale, "commands.config.panel.edit_negative_button"),
          disabled: writesDisabled,
        },
      ],
    } satisfies ActionRowData<ButtonComponentData>,
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.nai_parameters_title")}**
${localizer(locale, "commands.config.panel.nai_parameters_description")}
> ${localizer(locale, "commands.config.panel.nai_sampler_label")}: ${view.sampler}
> ${localizer(locale, "commands.config.panel.nai_steps_label")}: ${view.steps}
> ${localizer(locale, "commands.config.panel.nai_scale_label")}: ${view.scale}
> ${localizer(locale, "commands.config.panel.nai_noise_label")}: ${view.noiseSchedule}
> ${localizer(locale, "commands.config.panel.nai_rescale_label")}: ${view.cfgRescale}`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "nai-parameters-open", locale }),
          label: localizer(locale, "commands.config.panel.edit_nai_button"),
          disabled: writesDisabled,
        },
      ],
    } satisfies ActionRowData<ButtonComponentData>,
  );

  return components;
}

export function buildConfigModelsBody(input: ConfigModelsPageInput): ComponentInContainerData[] {
  switch (input.page) {
    case "switch":
      return buildSwitchModelsBody(input);
    case "parameters":
      return buildParametersBody(input);
    case "fallbacks":
      return buildFallbacksBody(input);
    case "image":
      return buildImageGenerationBody(input);
    default:
      return [];
  }
}
