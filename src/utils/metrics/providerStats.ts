import type { SavedProviderConfigRow, UserSavedProviderConfigRow } from "@/types/db/schema";
import { getProviderDisplayName } from "@/utils/provider/providerInfoRegistry";
import { localizer } from "@/utils/text/localizer";

const STATUS_BULLET_TRUNCATE_LENGTH = 48;

function truncateText(input: string, maxLength: number): string {
  return input.length > maxLength ? `${input.substring(0, maxLength)}...` : input;
}

function formatBulletList(items: string[], locale: string, truncateLength: number): string {
  if (items.length === 0) {
    return localizer(locale, "commands.choices.none");
  }
  return items.map((item) => `• ${truncateText(item, truncateLength)}`).join("\n");
}

export function formatConfiguredEntryNames(items: string[], locale: string): string {
  if (items.length === 0) {
    return localizer(locale, "commands.choices.none");
  }

  return formatBulletList(items, locale, STATUS_BULLET_TRUNCATE_LENGTH);
}

export function formatSavedProviderConfigs(savedConfigs: SavedProviderConfigRow[], locale: string): string {
  const providerLabels = [...new Set(savedConfigs.map((config) => getProviderDisplayName(config.provider)))];
  return formatConfiguredEntryNames(providerLabels, locale);
}

export function formatUserSavedProviders(configs: UserSavedProviderConfigRow[], locale: string): string {
  if (configs.length === 0) {
    return localizer(locale, "commands.choices.none");
  }

  return configs
    .map((config, index) => {
      const providerLabel = getProviderDisplayName(config.provider);
      const capabilities =
        config.enabled_capabilities.length > 0
          ? config.enabled_capabilities.join(", ")
          : localizer(locale, "commands.status.personal_provider_no_capabilities");
      const keyLabel = config.api_key
        ? localizer(locale, "commands.status.mcp_server_auth_present")
        : localizer(locale, "commands.status.mcp_server_auth_absent");
      return `${index + 1}. **${providerLabel}** · ${capabilities} · ${keyLabel}`;
    })
    .join("\n");
}
