import { type ChatInputCommandInteraction, MessageFlags } from "discord.js";
import type { CustomEndpointRow, UserRow, UserSavedProviderConfigRow } from "@/types/db/schema";
import type { SummaryEmbedOptions } from "@/types/discord/embed";
import { llmProviderRepo, personalMemoryRepository, serverScheduleRepository } from "@/utils/db/repositories";
import { replyPaginatedStatusPages } from "@/utils/discord/ui/statusComponents";
import { ColorCode } from "@/utils/misc/logger";
import { getMemoryLimits } from "@/utils/misc/memoryLimits";
import { formatBooleanLocalized } from "@/utils/text/processors/formatters";
import {
  formatCustomEndpoints,
  formatNumberedList,
  getPrivacyLevelLabel,
  MAX_PROMPT_PREVIEW,
  MEMORY_TRUNCATE_LENGTH,
} from "@/utils/metrics/status/sharedFormatters";
import { formatUserSavedProviders } from "@/utils/metrics/providerStats";
import { localizer } from "@/utils/text/localizer";
import { PrivacyLevel } from "@/types/db/schema";

export async function showPersonalStatus(
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  const limits = getMemoryLimits();
  let globalPersonalMemoryList: string[] = [];
  let userSavedProviderConfigs: UserSavedProviderConfigRow[] = [];
  let userCustomEndpoints: CustomEndpointRow[] = [];
  if (userData.user_id) {
    [globalPersonalMemoryList, userSavedProviderConfigs, userCustomEndpoints] = await Promise.all([
      personalMemoryRepository
        .loadForUserLineage(userData.user_id, 0, false)
        .then((rows) => rows.map((row) => row.content)),
      llmProviderRepo.loadUserSavedProviderConfigs(userData.user_id),
      llmProviderRepo.loadCustomEndpointsForUser(userData.user_id),
    ]);
  }

  const globalPersonalMemoriesValue = formatNumberedList(globalPersonalMemoryList, locale, MEMORY_TRUNCATE_LENGTH);
  const globalPersonalMemoriesCount = globalPersonalMemoryList.length;

  const reminderCount = await serverScheduleRepository.getUserReminderCount(interaction.user.id);
  const rawImpersonationPrompt = userData.impersonation_prompt?.trim() ?? null;
  const impersonationPromptValue = rawImpersonationPrompt
    ? `\`\`\`\n${
        rawImpersonationPrompt.length > MAX_PROMPT_PREVIEW
          ? `${rawImpersonationPrompt.slice(0, MAX_PROMPT_PREVIEW)}...`
          : rawImpersonationPrompt
      }\n\`\`\``
    : localizer(locale, "commands.tool.status.field_impersonation_prompt_not_set");

  const userSavedProvidersValue = formatUserSavedProviders(userSavedProviderConfigs, locale);
  const userCustomEndpointsValue = formatCustomEndpoints(userCustomEndpoints, locale);

  const personalPage: SummaryEmbedOptions = {
    titleKey: "commands.tool.status.personal_title",
    descriptionKey: "commands.tool.status.personal_description",
    color: ColorCode.INFO,
    footerKey: "commands.tool.status.export_footer_global_personal_memories",
    fields: [
      {
        nameKey: "commands.tool.status.field_user_nickname",
        value: userData.user_nickname ?? userData.user_disc_id,
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_language_pref",
        value: userData.language_pref,
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_privacy",
        value: getPrivacyLevelLabel(locale, userData.privacy_level ?? PrivacyLevel.MINIMAL),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_impersonation_prompt",
        value: impersonationPromptValue,
        inline: false,
      },
      {
        nameKey: "commands.tool.status.field_reminders_count",
        value: String(reminderCount),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_personal_dtm",
        value: localizer(locale, `commands.personal.deliberatetriggermode.${userData.personal_dtm ?? "follow"}_option`),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_personal_deliberate_tool_mode",
        value: localizer(
          locale,
          `commands.personal.deliberatetoolmode.${userData.personal_deliberate_tool_mode ?? "follow"}_option`,
        ),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_crossserver_stm",
        value: formatBooleanLocalized(userData.shortterm_cache_crossserver_opt_in ?? false, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_physical_appearance_tags",
        value:
          (userData.physical_appearance_tags?.length ?? 0) > 0
            ? `${userData.physical_appearance_tags.length} tags`
            : localizer(locale, "commands.choices.none"),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_nai_char_ref",
        value: formatBooleanLocalized(!!userData.nai_char_ref_url, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_global_personal_memories_with_count",
        nameVars: {
          current: globalPersonalMemoriesCount,
          max: limits.maxPersonalMemories,
        },
        value: globalPersonalMemoriesValue,
        inline: false,
      },
    ],
  };

  const personalProvidersPage: SummaryEmbedOptions = {
    titleKey: "commands.tool.status.personal_page2_title",
    descriptionKey: "commands.tool.status.personal_page2_description",
    color: ColorCode.INFO,
    fields: [
      {
        nameKey: "commands.tool.status.field_personal_providers_with_count",
        nameVars: { count: userSavedProviderConfigs.length },
        value: userSavedProvidersValue,
        inline: false,
      },
      {
        nameKey: "commands.tool.status.field_personal_custom_endpoints_with_count",
        nameVars: { count: userCustomEndpoints.length },
        value: userCustomEndpointsValue,
        inline: false,
      },
    ],
  };

  await replyPaginatedStatusPages(interaction, locale, [personalPage, personalProvidersPage], MessageFlags.Ephemeral);
}
