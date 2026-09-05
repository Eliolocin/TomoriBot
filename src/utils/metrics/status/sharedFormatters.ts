import { SUPPORTED_PARAM_STATUS_FIELD_KEYS, SUPPORTED_PARAM_VALUES } from "@/constants/supportedParams";
import type {
  CustomEndpointRow,
  FallbackEntry,
  LlmRow,
  StPresetNodeRow,
  StPresetRow,
  AssembledServerConfig,
} from "@/types/db/schema";
import { CooldownType, PrivacyLevel, type TomoriState } from "@/types/db/schema";
import { formatLlmDisplayLabel } from "@/utils/provider/modelDisplay";
import { getThinkingLevelLocalizerKey } from "@/utils/provider/thinkingControl";
import { localizer } from "@/utils/text/localizer";

export const MAX_ITEMS_DISPLAY = 5; // Max channel/member items before switching to count-only
export const MEMORY_TRUNCATE_LENGTH = 100; // Max chars per memory snippet
export const ATTRIBUTE_TRUNCATE_LENGTH = 200; // Max chars per attribute snippet
export const DIALOGUE_TRUNCATE_LENGTH = 140; // Max chars per sample dialogue side
export const MAX_PROMPT_PREVIEW = Number.parseInt(process.env.SYSPROMPT_SHOW_MAX_PREVIEW || "3800", 10); // Max chars shown for system/persona prompts

/**
 * Returns a user-friendly label for a privacy level.
 */
export function getPrivacyLevelLabel(locale: string, level: PrivacyLevel): string {
  switch (level) {
    case PrivacyLevel.MINIMAL:
      return localizer(locale, "commands.personal.privacy.choice_minimal");
    case PrivacyLevel.PARTIAL:
      return localizer(locale, "commands.personal.privacy.choice_partial");
    case PrivacyLevel.FULL:
      return localizer(locale, "commands.personal.privacy.choice_full");
    default:
      return localizer(locale, "commands.personal.privacy.choice_minimal");
  }
}

/**
 * Returns a localized label for a CooldownType value.
 * Reuses the choice labels defined in commands.server.cooldown.
 */
export function getCooldownTypeLabel(locale: string, type: CooldownType): string {
  switch (type) {
    case CooldownType.OFF:
      return localizer(locale, "commands.server.cooldown.triggers.type.choice_off");
    case CooldownType.PER_USER:
      return localizer(locale, "commands.server.cooldown.triggers.type.choice_per_user");
    case CooldownType.PER_CHANNEL:
      return localizer(locale, "commands.server.cooldown.triggers.type.choice_per_channel");
    case CooldownType.SERVER_WIDE:
      return localizer(locale, "commands.server.cooldown.triggers.type.choice_server_wide");
    case CooldownType.STRICT_SERVER_WIDE:
      return localizer(locale, "commands.server.cooldown.triggers.type.choice_strict_server_wide");
    default:
      return localizer(locale, "commands.server.cooldown.triggers.type.choice_off");
  }
}

export function getThinkingLevelLabel(locale: string, value: string | null | undefined): string {
  return localizer(locale, getThinkingLevelLocalizerKey(value));
}

export function truncateText(input: string, maxLength: number): string {
  return input.length > maxLength ? `${input.substring(0, maxLength)}...` : input;
}

export function formatQuotaLimitValue(locale: string, limit: number): string {
  return limit === 0 ? localizer(locale, "commands.status.field_quota_unlimited") : String(limit);
}

export function formatOmittedSamplingParams(
  disabledParams: AssembledServerConfig["llm_disabled_params"] | null | undefined,
  locale: string,
): string {
  const omittedParams = SUPPORTED_PARAM_VALUES.filter((param) => disabledParams?.includes(param));
  if (omittedParams.length === 0) {
    return localizer(locale, "commands.choices.none");
  }

  return omittedParams.map((param) => `\`${localizer(locale, SUPPORTED_PARAM_STATUS_FIELD_KEYS[param])}\``).join(", ");
}

/**
 * Formats an array of strings as a numbered list, truncating each item.
 * All items are included (nothing omitted).
 * @param truncateLength - Max chars per item before truncation
 * @returns Formatted numbered list, or localized "None" if empty
 */
export function formatNumberedList(items: string[], locale: string, truncateLength: number): string {
  if (items.length === 0) {
    return localizer(locale, "commands.choices.none");
  }
  return items
    .map((item, index) => {
      return `${index + 1}. ${truncateText(item, truncateLength)}`;
    })
    .join("\n");
}

/**
 * Formats an array of strings as a bullet list, truncating each item.
 * All items are included (nothing omitted).
 * @param truncateLength - Max chars per item before truncation
 * @returns Formatted bullet list, or localized "None" if empty
 */
export function formatBulletList(items: string[], locale: string, truncateLength: number): string {
  if (items.length === 0) {
    return localizer(locale, "commands.choices.none");
  }
  return items
    .map((item) => {
      return `• ${truncateText(item, truncateLength)}`;
    })
    .join("\n");
}

/**
 * Formats sample dialogue pairs as a numbered list with truncation on each side.
 * @param truncateLength - Max chars per dialogue side before truncation
 * @returns Formatted list, or localized "None" if empty
 */
export function formatSampleDialogues(
  dialoguesIn: string[],
  dialoguesOut: string[],
  locale: string,
  truncateLength: number,
): string {
  const pairCount = Math.max(dialoguesIn.length, dialoguesOut.length);
  if (pairCount === 0) {
    return localizer(locale, "commands.choices.none");
  }

  return Array.from({ length: pairCount }, (_, index) => {
    const input = truncateText(dialoguesIn[index] ?? localizer(locale, "commands.choices.none"), truncateLength);
    const output = truncateText(dialoguesOut[index] ?? localizer(locale, "commands.choices.none"), truncateLength);
    return `${index + 1}. ${input} -> ${output}`;
  }).join("\n");
}

export function formatFallbackChain(
  fallbackChain: FallbackEntry[] | undefined,
  fallbackLlms: LlmRow[] | undefined,
  locale: string,
  customModelName?: string | null,
  otherModelCodename?: string | null,
): string {
  const hasChain = (fallbackChain?.length ?? 0) > 0;
  const hasLegacy = (fallbackLlms?.length ?? 0) > 0;

  if (!hasChain && !hasLegacy) {
    return localizer(locale, "commands.choices.none");
  }

  if (hasChain && fallbackChain) {
    return fallbackChain
      .map((entry, index) => {
        const label =
          entry.kind === "llm"
            ? formatLlmDisplayLabel(entry.model, customModelName, otherModelCodename)
            : `\`${truncateText(entry.endpoint.model_name || entry.endpoint.label, 48)}\` (${localizer(locale, "commands.status.custom_endpoint_capability_label", { capability: entry.endpoint.capability })})`;
        return `${index + 1}. ${label}`;
      })
      .join("\n");
  }

  return (fallbackLlms ?? [])
    .map((m, i) => `${i + 1}. ${formatLlmDisplayLabel(m, customModelName, otherModelCodename)}`)
    .join("\n");
}

/**
 * Formats the list of server or user custom endpoints as a numbered list.
 * URL is never shown per privacy rules; shows label, capability, api_style, and auth status.
 * @returns Formatted list, or localized "None" if empty
 */
export function formatCustomEndpoints(endpoints: CustomEndpointRow[], locale: string): string {
  if (endpoints.length === 0) {
    return localizer(locale, "commands.choices.none");
  }

  return endpoints
    .map((ep, index) => {
      const authLabel = ep.requires_auth
        ? localizer(locale, "commands.status.mcp_server_auth_present")
        : localizer(locale, "commands.status.mcp_server_auth_absent");
      return `${index + 1}. **${truncateText(ep.model_name || ep.label, 32)}** · ${ep.capability} · ${ep.api_style} · ${authLabel}`;
    })
    .join("\n");
}

export function formatRotationPoolValue(keys: TomoriState["rotation_keys"], locale: string): string {
  const rotationKeys = keys ?? [];
  const totalEntries = rotationKeys.length;
  const additionalKeys = rotationKeys.filter((key) => !key.is_main_key_pointer).length;
  const enabledEntries = rotationKeys.filter((key) => key.is_enabled).length;
  const disabledEntries = totalEntries - enabledEntries;

  return totalEntries === 0
    ? localizer(locale, "commands.choices.none")
    : localizer(locale, "commands.status.field_api_key_rotation_pool_value", {
        total: totalEntries,
        additional: additionalKeys,
        enabled: enabledEntries,
        disabled: disabledEntries,
      });
}

export function formatActiveStPresetValue(activePreset: StPresetRow | null, locale: string): string {
  return activePreset?.preset_name ?? localizer(locale, "commands.choices.none");
}

export function formatStPresetNodeSummary(toggleableNodes: StPresetNodeRow[], locale: string): string {
  if (toggleableNodes.length === 0) {
    return localizer(locale, "commands.choices.none");
  }

  const enabledCount = toggleableNodes.filter((node) => node.is_enabled).length;
  return localizer(locale, "commands.status.field_st_preset_nodes_value", {
    enabled: enabledCount,
    total: toggleableNodes.length,
  });
}
