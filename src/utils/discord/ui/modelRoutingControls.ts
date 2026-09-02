import {
  ComponentType,
  type ActionRowData,
  type SelectMenuComponentOptionData,
  type StringSelectMenuComponentData,
} from "discord.js";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import { getProviderDisplayName } from "@/utils/provider/providerInfoRegistry";
import { localizer } from "@/utils/text/localizer";

export interface ProviderSelectEntry {
  value: string;
  label: string;
}

export interface ProviderPageEntriesInput {
  providers: readonly string[];
  expandedProvider: string | null;
  expandedOptionCount: number;
  pageSize: number;
  locale: string;
  encodeProviderValue(provider: string): string;
  encodePageValue(provider: string, start: number): string;
}

export interface ProviderPageEntriesResult {
  entries: ProviderSelectEntry[];
  expandedStartIndex: number;
  /** Pages the expanded provider contributed, or 0 when nothing expanded. */
  expandedPageCount: number;
}

/**
 * Expands one provider into a value per page of its option list.
 *
 * A modal select holds 25 options, so a provider with more models than that needs one entry per
 * page: the shared pagination row disables the position it is parked on, so a row driving the
 * modal directly can never open its own current page and those options stay unreachable.
 *
 * `expandedStartIndex` is the index of the first expanded entry, which lets the caller scroll the
 * provider selector to the page holding them instead of stranding the expansion off-screen.
 */
export function buildProviderPageEntries(input: ProviderPageEntriesInput): ProviderPageEntriesResult {
  const expanded = input.expandedProvider && input.expandedOptionCount > input.pageSize ? input.expandedProvider : null;
  const pageCount = expanded ? Math.ceil(input.expandedOptionCount / input.pageSize) : 0;

  const entries: ProviderSelectEntry[] = [];
  let expandedStartIndex = 0;

  for (const provider of input.providers) {
    if (expanded && provider.toLowerCase() === expanded.toLowerCase()) {
      expandedStartIndex = entries.length;
      for (let page = 0; page < pageCount; page += 1) {
        entries.push({
          value: input.encodePageValue(provider, page * input.pageSize),
          label: safeSelectOptionText(
            localizer(input.locale, "commands.personal.config.provider_page_label", {
              provider: getProviderDisplayName(provider),
              page: page + 1,
            }),
            100,
          ),
        });
      }
      continue;
    }
    entries.push({
      value: input.encodeProviderValue(provider),
      label: safeSelectOptionText(getProviderDisplayName(provider), 100),
    });
  }

  return { entries, expandedStartIndex, expandedPageCount: pageCount };
}

export interface ModelRoutingControlInput {
  capabilityLabel: string;
  activeModelName: string | null;
  activeProvider: string | null;
  /** Provider names to map into options. Ignored when `providerEntries` is supplied. */
  eligibleProviders?: readonly string[];
  /** Pre-built provider options, letting one provider contribute a page entry per option slice. */
  providerEntries?: readonly ProviderSelectEntry[];
  customId: string;
  serverDefaultValue: string;
  serverDefaultLabel: string;
  serverDefaultDisplay: string;
  /** Replaces the current-value placeholder, for a state the active model alone cannot describe. */
  placeholderOverride?: string;
  providerOverflowValue?: string;
  providerOverflowLabel?: string;
  directProviderLimit?: number;
  encodeProviderValue?(provider: string): string;
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

  if (
    input.providerOverflowValue &&
    input.directProviderLimit !== undefined &&
    (input.eligibleProviders?.length ?? 0) > input.directProviderLimit
  ) {
    options.push({
      value: input.providerOverflowValue,
      label: safeSelectOptionText(input.providerOverflowLabel ?? "", 100),
    });
  } else if (input.providerEntries) {
    options.push(
      ...input.providerEntries.map((entry) => ({
        value: entry.value,
        label: safeSelectOptionText(entry.label, 100),
      })),
    );
  } else {
    options.push(
      ...(input.eligibleProviders ?? []).map((provider) => ({
        value: input.encodeProviderValue?.(provider) ?? provider,
        label: safeSelectOptionText(getProviderDisplayName(provider), 100),
      })),
    );
  }

  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.StringSelect,
        customId: input.customId,
        placeholder: safeSelectOptionText(input.placeholderOverride ?? `${input.capabilityLabel}: ${activeModel}`, 150),
        options,
        disabled: input.disabled,
      },
    ],
  };
}
