import { type ChatInputCommandInteraction, type Client, MessageFlags } from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import type { SummaryEmbedOptions } from "@/types/discord/embed";
import { sql } from "@/utils/db/client";
import { llmProviderRepo } from "@/utils/db/repositories";
import { toolRepository } from "@/utils/db/repositories/ToolRepository";
import { presetRepository } from "@/utils/db/repositories/PresetRepository";
import { replyPaginatedStatusPages } from "@/utils/discord/ui/statusComponents";
import { commandRegistry } from "@/utils/discord/commandRegistry";
import { isNoticeEmbedVisible } from "@/utils/discord/toolProgressNotice";
import { DEFAULT_SYSTEM_PROMPT } from "@/utils/text/contextBuilder";
import { formatBooleanLocalized } from "@/utils/text/processors/formatters";
import { ColorCode } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";
import { formatMcpServers } from "@/utils/metrics/mcpStatus";
import { formatSavedProviderConfigs } from "@/utils/metrics/providerStats";
import { formatMatrixLinks, type MatrixLinkStatusRow } from "@/utils/metrics/status/channelFormatters";
import { formatHiddenNoticeEmbeds, formatOptionalApiKeys } from "@/utils/metrics/status/providerConfigFormatters";
import {
  formatActiveStPresetValue,
  formatCustomEndpoints,
  formatRotationPoolValue,
  formatStPresetNodeSummary,
  getCooldownTypeLabel,
  MAX_PROMPT_PREVIEW,
} from "@/utils/metrics/status/sharedFormatters";
import { CooldownType } from "@/types/db/schema";
import { resolveDeliberateToolContextTurns } from "@/utils/tools/deliberateToolMode";

interface OptApiKeyStatusRow {
  service_name: string;
}

export async function showServerConfigStatus(
  client: Client,
  interaction: ChatInputCommandInteraction,
  tomoriState: TomoriState,
  locale: string,
): Promise<void> {
  const config = tomoriState.config;
  const [optApiKeyRows, savedProviderConfigs, guildMcpServers, matrixLinks, stPresets, serverCustomEndpoints] =
    await Promise.all([
      sql<OptApiKeyStatusRow[]>`
      SELECT service_name FROM opt_api_keys
      WHERE server_id = ${tomoriState.server_id}
      ORDER BY service_name ASC
    `,
      llmProviderRepo.loadSavedProviderConfigs(tomoriState.server_id),
      toolRepository.loadMcpServers(tomoriState.server_id),
      sql<MatrixLinkStatusRow[]>`
      SELECT channel_disc_id FROM matrix_channel_links
      WHERE server_id = ${tomoriState.server_id}
      ORDER BY created_at ASC
    `,
      presetRepository.loadPresetsForServer(tomoriState.server_id),
      llmProviderRepo.loadCustomEndpointsForServer(tomoriState.server_id),
    ]);

  const activeStPreset = stPresets.find((preset) => preset.is_active) ?? null;
  const activeStPresetNodes =
    activeStPreset?.preset_id != null ? await presetRepository.loadToggleableNodes(activeStPreset.preset_id) : [];

  const timezoneOffset = config.timezone_offset;
  const timezoneSign = timezoneOffset >= 0 ? "+" : "-";
  const timezoneHours = Math.abs(timezoneOffset).toString().padStart(2, "0");
  const timezoneValue = `UTC${timezoneSign}${timezoneHours}:00`;
  const cooldownType = config.cooldown_type ?? CooldownType.OFF;
  const cooldownTypeLabel = getCooldownTypeLabel(locale, cooldownType);
  const cooldownLengthValue =
    cooldownType === CooldownType.OFF
      ? localizer(locale, "commands.choices.disabled")
      : localizer(locale, "commands.tool.status.field_cooldown_length_value", {
          seconds: config.cooldown_length,
        });
  const autochThresholdMax =
    config.autoch_threshold_max > 0
      ? Math.max(config.autoch_threshold_max, config.autoch_threshold)
      : config.autoch_threshold;
  const autochModeValue =
    config.autoch_threshold === 0
      ? localizer(locale, "commands.choices.always")
      : autochThresholdMax > config.autoch_threshold
        ? `${config.autoch_threshold}-${autochThresholdMax}`
        : String(config.autoch_threshold);
  const serverUserByokToggleMention = commandRegistry.getCommandMention("server", "user-byok", "toggle");
  const userByokValue = localizer(
    locale,
    config.user_byok_mode
      ? "commands.tool.status.field_user_byok_enabled"
      : "commands.tool.status.field_user_byok_disabled",
    { toggle_command: serverUserByokToggleMention },
  );

  const rawSystemPrompt = config.system_prompt ?? null;
  const systemPromptText = rawSystemPrompt
    ? rawSystemPrompt.length > MAX_PROMPT_PREVIEW
      ? `${rawSystemPrompt.slice(0, MAX_PROMPT_PREVIEW)}...`
      : rawSystemPrompt
    : DEFAULT_SYSTEM_PROMPT.trim();
  const systemPromptValue = `\`\`\`\n${systemPromptText}\n\`\`\``;
  const rawContextNote = config.context_note ?? null;
  const contextNoteValue = rawContextNote
    ? `\`\`\`\n${
        rawContextNote.length > MAX_PROMPT_PREVIEW
          ? `${rawContextNote.slice(0, MAX_PROMPT_PREVIEW)}...`
          : rawContextNote
      }\n\`\`\``
    : localizer(locale, "commands.tool.status.field_context_note_not_set");

  const optApiKeyServiceNames = optApiKeyRows.map((row) => row.service_name);
  const braveApiKeySet = optApiKeyServiceNames.includes("brave-search");
  const rotationKeys = tomoriState.rotation_keys ?? [];
  const rotationStatusValue =
    rotationKeys.length >= 2
      ? localizer(locale, "commands.choices.enabled")
      : localizer(locale, "commands.choices.disabled");
  const rotationPoolValue = formatRotationPoolValue(tomoriState.rotation_keys, locale);
  const optionalApiKeyCount = new Set(optApiKeyServiceNames.map((serviceName) => serviceName.toLowerCase())).size;
  const optionalApiKeysValue = formatOptionalApiKeys(optApiKeyServiceNames, locale);
  const savedProviderConfigCount = new Set(
    savedProviderConfigs.map((savedConfig) => savedConfig.provider.toLowerCase()),
  ).size;
  const savedProviderConfigsValue = formatSavedProviderConfigs(savedProviderConfigs, locale);
  const hiddenNoticeKeys = config.tool_notice_hidden_keys ?? [];
  const hiddenNoticeEmbedsValue = formatHiddenNoticeEmbeds(hiddenNoticeKeys, locale);
  const stPresetLibraryValue = localizer(locale, "commands.tool.status.field_st_preset_library_value", {
    count: stPresets.length,
  });
  const activeStPresetValue = formatActiveStPresetValue(activeStPreset, locale);
  const stPresetNodeSummaryValue = formatStPresetNodeSummary(activeStPresetNodes, locale);
  const mcpServersValue = formatMcpServers(guildMcpServers, locale);
  const serverCustomEndpointsValue = formatCustomEndpoints(serverCustomEndpoints, locale);
  const matrixLinksValue = await formatMatrixLinks(client, matrixLinks, locale);

  const configPage1: SummaryEmbedOptions = {
    titleKey: "commands.tool.status.server_page2_title",
    descriptionKey: "commands.tool.status.server_page2_description",
    color: ColorCode.INFO,
    fields: [
      {
        nameKey: "commands.tool.status.field_timezone",
        value: timezoneValue,
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_message_fetch_limit",
        value: String(config.message_fetch_limit),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_cascade_limit",
        value: String(config.cascade_limit),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_send_message_limit",
        value:
          (config.send_message_limit ?? 0) > 0
            ? String(config.send_message_limit)
            : localizer(locale, "commands.choices.disabled"),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_always_reply",
        value: config.always_reply_enabled
          ? localizer(locale, "commands.choices.enabled")
          : localizer(locale, "commands.choices.disabled"),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_match_limit",
        value: String(config.match_limit),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_cooldown_type",
        value: cooldownTypeLabel,
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_cooldown_length",
        value: cooldownLengthValue,
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_autoch_threshold",
        value: autochModeValue,
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_deliberate_trigger",
        value: formatBooleanLocalized(config.deliberate_trigger_mode ?? false, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_deliberate_tool_mode",
        value: formatBooleanLocalized(config.deliberate_tool_mode ?? false, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_deliberate_tool_context_turns",
        value: resolveDeliberateToolContextTurns(config.deliberate_tool_context_turns).toString(),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_user_byok",
        value: userByokValue,
        inline: false,
      },
    ],
  };

  const configPage2: SummaryEmbedOptions = {
    titleKey: "commands.tool.status.server_page4_title",
    descriptionKey: "commands.tool.status.server_page4_description",
    color: ColorCode.INFO,
    fields: [
      {
        nameKey: "commands.tool.status.field_personalization",
        value: formatBooleanLocalized(config.personal_memories_enabled, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_self_teach",
        value: formatBooleanLocalized(config.self_teaching_enabled, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_image_generation",
        value: formatBooleanLocalized(config.imagegen_enabled, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_videogen",
        value: formatBooleanLocalized(config.videogen_enabled, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_web_search",
        value: formatBooleanLocalized(config.web_search_enabled, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_manage_message",
        value: formatBooleanLocalized(config.manage_message_enabled, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_emoji_usage",
        value: formatBooleanLocalized(config.emoji_usage_enabled, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_sticker_usage",
        value: formatBooleanLocalized(config.sticker_usage_enabled, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_api_key_set",
        value: formatBooleanLocalized(!!config.api_key, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_brave_api_key_set",
        value: formatBooleanLocalized(braveApiKeySet, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_server_memteaching",
        value: formatBooleanLocalized(config.server_memteaching_enabled, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_attribute_memteaching",
        value: formatBooleanLocalized(config.attribute_memteaching_enabled, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_sampledialogue_memteaching",
        value: formatBooleanLocalized(config.sampledialogue_memteaching_enabled, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_hide_impersonation",
        value: formatBooleanLocalized(!isNoticeEmbedVisible(config, "impersonation_notice"), locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_hide_respond_embed",
        value: formatBooleanLocalized(!isNoticeEmbedVisible(config, "respond_embed"), locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_self_debug",
        value: formatBooleanLocalized(config.self_debug_enabled, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_model_randomizer",
        value: formatBooleanLocalized(config.model_randomizer_enabled, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_uncensor_injection",
        value: formatBooleanLocalized(config.uncensor_injection_enabled, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_uncensor_unicode",
        value: formatBooleanLocalized(config.uncensor_unicode_space_enabled, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_uncensor_sanitize",
        value: formatBooleanLocalized(config.uncensor_sanitize_enabled, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_tool_use",
        value: formatBooleanLocalized(config.tool_use_enabled ?? true, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_verbatim_tool_calling",
        value: formatBooleanLocalized(config.verbatim_tool_calling_enabled ?? false, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_prompt_snapshot",
        value: formatBooleanLocalized(config.prompt_snapshot_enabled ?? false, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_short_term_memory",
        value: formatBooleanLocalized(config.short_term_memory_enabled ?? true, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_user_info_updates",
        value: formatBooleanLocalized(config.user_info_updates_enabled ?? true, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_stm_privacy_bypass",
        value: formatBooleanLocalized(config.stm_privacy_bypass ?? false, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_voice_messages",
        value: formatBooleanLocalized(config.voice_message_enabled ?? true, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_voice_transcript_mode",
        value: formatBooleanLocalized(config.voice_transcript_chat_mode ?? true, locale),
        inline: true,
      },
    ],
  };

  const configPage3: SummaryEmbedOptions = {
    titleKey: "commands.tool.status.server_page5_title",
    descriptionKey: "commands.tool.status.server_page5_description",
    color: ColorCode.INFO,
    footerKey: "commands.tool.status.export_footer_server_config",
    fields: [
      {
        nameKey: "commands.tool.status.field_system_prompt",
        value: systemPromptValue,
        inline: false,
      },
      {
        nameKey: "commands.tool.status.field_context_note",
        value: contextNoteValue,
        inline: false,
      },
      {
        nameKey: "commands.tool.status.field_context_note_depth",
        value: String(config.context_note_depth ?? 0),
        inline: true,
      },
    ],
  };

  const configPage4: SummaryEmbedOptions = {
    titleKey: "commands.tool.status.server_page9_title",
    descriptionKey: "commands.tool.status.server_page9_description",
    color: ColorCode.INFO,
    fields: [
      {
        nameKey: "commands.tool.status.field_api_key_rotation_status",
        value: rotationStatusValue,
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_api_key_rotation_pool",
        value: rotationPoolValue,
        inline: false,
      },
      {
        nameKey: "commands.tool.status.field_optional_api_keys_with_count",
        nameVars: { count: optionalApiKeyCount },
        value: optionalApiKeysValue,
        inline: false,
      },
      {
        nameKey: "commands.tool.status.field_saved_provider_configs_with_count",
        nameVars: { count: savedProviderConfigCount },
        value: savedProviderConfigsValue,
        inline: false,
      },
      {
        nameKey: "commands.tool.status.field_server_custom_endpoints_with_count",
        nameVars: { count: serverCustomEndpoints.length },
        value: serverCustomEndpointsValue,
        inline: false,
      },
      {
        nameKey: "commands.tool.status.field_mcp_servers_with_count",
        nameVars: { count: guildMcpServers.length },
        value: mcpServersValue,
        inline: false,
      },
      {
        nameKey: "commands.tool.status.field_matrix_links_with_count",
        nameVars: { count: matrixLinks.length },
        value: matrixLinksValue,
        inline: false,
      },
      {
        nameKey: "commands.tool.status.field_hidden_notice_embeds_with_count",
        nameVars: { count: hiddenNoticeKeys.length },
        value: hiddenNoticeEmbedsValue,
        inline: false,
      },
      {
        nameKey: "commands.tool.status.field_st_preset_active",
        value: activeStPresetValue,
        inline: false,
      },
      {
        nameKey: "commands.tool.status.field_st_preset_library",
        value: stPresetLibraryValue,
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_st_preset_nodes",
        value: stPresetNodeSummaryValue,
        inline: true,
      },
    ],
  };

  await replyPaginatedStatusPages(
    interaction,
    locale,
    [configPage1, configPage2, configPage3, configPage4],
    MessageFlags.Ephemeral,
  );
}
