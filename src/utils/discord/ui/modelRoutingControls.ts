import {
  ComponentType,
  type ActionRowData,
  type SelectMenuComponentOptionData,
  type StringSelectMenuComponentData,
} from "discord.js";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import { getProviderDisplayName } from "@/utils/provider/providerInfoRegistry";

export interface ModelRoutingControlInput {
  capabilityLabel: string;
  activeModelName: string | null;
  activeProvider: string | null;
  eligibleProviders: readonly string[];
  customId: string;
  serverDefaultValue: string;
  serverDefaultLabel: string;
  serverDefaultDisplay: string;
  providerOverflowValue: string;
  providerOverflowLabel: string;
  directProviderLimit: number;
  encodeProviderValue(provider: string): string;
  disabled: boolean;
}

export function buildModelRoutingControl(
  input: ModelRoutingControlInput,
): ActionRowData<StringSelectMenuComponentData> {
  const activeModel = input.activeModelName
    ? `~${input.activeModelName}${input.activeProvider ? ` (${getProviderDisplayName(input.activeProvider)})` : ""}`
    : input.serverDefaultDisplay;
  const options: SelectMenuComponentOptionData[] = [
    {
      value: input.serverDefaultValue,
      label: safeSelectOptionText(input.serverDefaultLabel, 100),
    },
  ];

  if (input.eligibleProviders.length <= input.directProviderLimit) {
    options.push(
      ...input.eligibleProviders.map((provider) => ({
        value: input.encodeProviderValue(provider),
        label: safeSelectOptionText(getProviderDisplayName(provider), 100),
      })),
    );
  } else {
    options.push({
      value: input.providerOverflowValue,
      label: safeSelectOptionText(input.providerOverflowLabel, 100),
    });
  }

  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.StringSelect,
        customId: input.customId,
        placeholder: safeSelectOptionText(`${input.capabilityLabel}: ${activeModel}`, 150),
        options,
        disabled: input.disabled,
      },
    ],
  };
}
