import { TOOL_NOTICE_DEFINITIONS } from "@/constants/toolNotices";
import { getProviderDisplayName } from "@/utils/provider/providerInfoRegistry";
import { localizer } from "@/utils/text/localizer";
import { formatConfiguredEntryNames } from "@/utils/metrics/providerStats";

function getOptionalApiServiceDisplayName(serviceName: string, locale: string): string {
  switch (serviceName) {
    case "brave-search":
      return localizer(locale, "commands.status.optional_api_service_brave");
    case "elevenlabs":
      return localizer(locale, "commands.status.optional_api_service_elevenlabs");
    default:
      return getProviderDisplayName(serviceName);
  }
}

export function formatOptionalApiKeys(serviceNames: string[], locale: string): string {
  const labels = [...new Set(serviceNames.map((serviceName) => getOptionalApiServiceDisplayName(serviceName, locale)))];
  return formatConfiguredEntryNames(labels, locale);
}

function getHiddenNoticeLabels(hiddenKeys: readonly string[], locale: string): string[] {
  return hiddenKeys
    .map((key) => {
      const definition = TOOL_NOTICE_DEFINITIONS.find((entry) => entry.key === key);
      return definition ? localizer(locale, definition.labelKey) : key;
    })
    .sort((left, right) => left.localeCompare(right));
}

export function formatHiddenNoticeEmbeds(hiddenKeys: readonly string[], locale: string): string {
  return formatConfiguredEntryNames(getHiddenNoticeLabels(hiddenKeys, locale), locale);
}
