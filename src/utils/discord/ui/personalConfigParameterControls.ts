import {
  ButtonStyle,
  ComponentType,
  type ActionRowData,
  type ButtonComponentData,
  type ComponentInContainerData,
  type StringSelectMenuComponentData,
  type TextDisplayComponentData,
} from "discord.js";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";

/**
 * Renders a stored sampler value at the precision its owner typed.
 *
 * The sampler columns are Postgres `real`, so a value typed as `0.6` reads back widened to a double
 * as 0.6000000238418579. Printed raw that exceeds the 10-character limit on the modal Text Inputs
 * carrying it, which Discord rejects as 50035 with no partial render, and it overflows the
 * 65-character panel line budget. binary32 holds about 7.2 decimal digits, so 7 significant digits
 * recovers the stored decimal without truncating a value someone genuinely typed. The integer
 * columns, Top K and Maximum Output Tokens, cannot pick up the artifact and are passed through.
 */
export function formatStoredParameterValue(value: number): string {
  return String(Number(value.toPrecision(7)));
}

export interface ProviderParameterOption {
  value: string;
  label: string;
  default?: boolean;
}

export interface ProviderParameterBlockCopy {
  providerLabel: string;
  providerSelectPlaceholder: string;
  samplingLabel: string;
  temperatureLabel: string;
  minPLabel: string;
  topPLabel: string;
  topKLabel: string;
  generationLabel: string;
  frequencyLabel: string;
  presenceLabel: string;
  maxOutputLabel: string;
  thinkingLabel: string;
  editSamplingLabel: string;
  editGenerationLabel: string;
}

export interface ProviderParameterBlockValues {
  providerDisplayName: string;
  temperature: string;
  minP: string;
  topP: string;
  topK: string;
  frequency: string;
  presence: string;
  maxOutput: string;
  thinking: string;
}

export interface ProviderParameterBlockRoutes {
  providerSelect: string;
  editSampling: string;
  editGeneration: string;
}

export interface ProviderParameterBlockInput {
  providerOptions: readonly ProviderParameterOption[];
  copy: ProviderParameterBlockCopy;
  values: ProviderParameterBlockValues;
  routes: ProviderParameterBlockRoutes;
  writesDisabled: boolean;
}

function buildSummary(
  copy: ProviderParameterBlockCopy,
  values: ProviderParameterBlockValues,
): TextDisplayComponentData {
  return {
    type: ComponentType.TextDisplay,
    content: `> ${copy.samplingLabel}: ${copy.temperatureLabel} \`${values.temperature}\` · ${copy.minPLabel} \`${values.minP}\`
> ${copy.topPLabel} \`${values.topP}\` · ${copy.topKLabel} \`${values.topK}\`
> ${copy.generationLabel}: ${copy.frequencyLabel} \`${values.frequency}\` · ${copy.presenceLabel} \`${values.presence}\`
> ${copy.maxOutputLabel} \`${values.maxOutput}\` · ${copy.thinkingLabel} \`${values.thinking}\``,
  };
}

function buildEditorButtons(
  copy: ProviderParameterBlockCopy,
  routes: ProviderParameterBlockRoutes,
  writesDisabled: boolean,
): ActionRowData<ButtonComponentData> {
  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: routes.editSampling,
        label: copy.editSamplingLabel,
        disabled: writesDisabled,
      },
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: routes.editGeneration,
        label: copy.editGenerationLabel,
        disabled: writesDisabled,
      },
    ],
  };
}

export function buildProviderParameterBlock(input: ProviderParameterBlockInput): ComponentInContainerData[] {
  if (input.providerOptions.length === 0) return [];

  const providerComponent: ComponentInContainerData =
    input.providerOptions.length > 1
      ? ({
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.StringSelect,
              customId: input.routes.providerSelect,
              placeholder: safeSelectOptionText(input.copy.providerSelectPlaceholder, 100),
              options: input.providerOptions.map((option) => ({
                ...option,
                label: safeSelectOptionText(option.label, 100),
              })),
              disabled: input.writesDisabled,
            },
          ],
        } satisfies ActionRowData<StringSelectMenuComponentData>)
      : {
          type: ComponentType.TextDisplay,
          content: `> ${input.copy.providerLabel}: \`${input.values.providerDisplayName}\``,
        };

  return [
    providerComponent,
    buildSummary(input.copy, input.values),
    buildEditorButtons(input.copy, input.routes, input.writesDisabled),
  ];
}
