import { TextInputStyle, MessageFlags, EmbedBuilder } from "discord.js";
import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import type { SetupConfig, UserRow } from "../../types/db/schema";
import type { SelectOption, RadioGroupOption } from "../../types/discord/modal";
import { setupConfigSchema } from "../../types/db/schema";
import { localizer, getDefaultBotName } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import { replyInfoEmbed, replySummaryEmbed, promptWithRawModal } from "../../utils/discord/interactionHelper";
import { commandRegistry } from "@/utils/discord/commandRegistry";
import { ProviderFactory } from "../../utils/provider/providerFactory";
import { getProviderDisplayName } from "@/utils/provider/providerInfoRegistry";
import { encryptApiKey } from "../../utils/security/crypto";
import { configRepository, llmModelRepo, personaRepository, serverRepository } from "@/utils/db/repositories";

import { invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { getCachedPresetAvatar, getPresetAvatarBuffer } from "@/utils/image/avatarHelper";
import { lazySyncGuildEmojis } from "@/utils/cache/emojiLazySync";
import { lazySyncGuildStickers } from "@/utils/cache/stickerLazySync";
import { formatLlmDisplayLabel } from "@/utils/provider/modelDisplay";
import { isCustomProvider } from "@/utils/provider/customProviderUtils";

import type { HumanizerDegree } from "@/types/db/schema";

const SETUP_API_KEY_MAX_LENGTH = 500;
const SETUP_TIMEZONE_MAX_LENGTH = 6;
const SETUP_CUSTOM_ENDPOINT_PROVIDER = "__custom_endpoint__";
const SETUP_USER_BYOK_PROVIDER = "__user_byok__";

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("setup").setDescription(localizer("en-US", "commands.config.setup.description"));

/**
 * Execute the setup command - guides users through the initial setup of TomoriBot for their server
 */
export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.channel) {
    await interaction.reply({
      content: localizer(userData.language_pref, "general.errors.operation_failed_description"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const isDMChannel = interaction.channel.isDMBased();
  const serverId = isDMChannel ? interaction.user.id : interaction.guild?.id;
  // Use guild locale when available so server-level triggers/localized defaults match the guild language
  const serverLocale = interaction.guildLocale ?? locale;
  // Analytics-only locale capture (static); do not use for functionality
  const registrationLocale = interaction.guildLocale ?? locale ?? null;

  if (!serverId) {
    await interaction.reply({
      content: localizer(userData.language_pref, "general.errors.critical_error_description"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    // Check if a main persona (is_alter=false) exists for this server.
    //    Previous check used personaRepository.loadState() which returns ANY persona (main or alter),
    //    causing a deadlock when the main persona was missing but alters remained:
    //    - Other commands require a main persona → "Initial Setup Required"
    //    - Setup found an alter → "Already Set Up"
    //    Now we specifically check for a main persona to break this deadlock.
    const existingInternalServerId = await serverRepository.loadServerIdByDiscId(serverId);

    if (existingInternalServerId) {
      const hasMain = await personaRepository.hasMainPersona(existingInternalServerId);

      if (hasMain) {
        const existingTomoriState = await personaRepository.loadState(serverId);

        // Main persona row exists AND state is fully valid: server is healthy, block re-setup.
        //    If personaRepository.loadState returns null despite the row existing, the server is in a broken
        //    state (missing split config rows or deleted LLM). Fall through to cleanup so the
        //    user isn't permanently locked out by a setup guard that uses a weaker health check
        //    than the commands that actually require a healthy state.
        if (existingTomoriState) {
          const providerAddMention = commandRegistry.getCommandMention("provider", "add");
          const modelTextMention = commandRegistry.getCommandMention("model", "text");
          const userByokToggleMention = commandRegistry.getCommandMention("server", "user-byok", "toggle");
          const helpPersonalProviderMention = commandRegistry.getCommandMention("help");
          const currentModelValue =
            existingTomoriState.config.llm_id && existingTomoriState.llm
              ? formatLlmDisplayLabel(
                  existingTomoriState.llm,
                  existingTomoriState.config.custom_model_name,
                  existingTomoriState.config.other_model_codename,
                )
              : existingTomoriState.config.user_byok_mode
                ? localizer(locale, "commands.choices.none_user_byok")
                : localizer(locale, "commands.choices.none");

          await replySummaryEmbed(interaction, locale, {
            titleKey: "commands.config.setup.already_setup_title",
            descriptionKey: "commands.config.setup.already_setup_summary_description",
            color: ColorCode.WARN,
            fields: [
              {
                nameKey: "commands.config.setup.current_provider_field",
                value: currentModelValue,
              },
              {
                nameKey: "commands.config.setup.current_byok_field",
                value: localizer(
                  locale,
                  existingTomoriState.config.user_byok_mode
                    ? "commands.config.setup.current_byok_enabled_value"
                    : "commands.config.setup.current_byok_disabled_value",
                  {
                    toggle_command: userByokToggleMention,
                  },
                ),
              },
              {
                nameKey: "commands.config.setup.already_setup_next_steps_field",
                value: localizer(locale, "commands.config.setup.already_setup_next_steps_value", {
                  provider_add_command: providerAddMention,
                  model_text_command: modelTextMention,
                  byok_toggle_command: userByokToggleMention,
                  help_personal_provider: helpPersonalProviderMention,
                }),
              },
            ],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        // Main persona row exists but personaRepository.loadState returned null: broken state
        //     (e.g. config row deleted, or llm_id points to a removed model).
        //     Do NOT nuke personas here: alters may be perfectly healthy and only the config
        //     row or model reference is missing. Guide the user to targeted repair commands.
        log.warn(
          `[Setup] Server ${serverId} has a main persona row but state validation failed — surfacing repair guidance`,
        );
        const modelTextMention = commandRegistry.getCommandMention("model", "text");
        const providerAddMention = commandRegistry.getCommandMention("provider", "add");
        await replyInfoEmbed(interaction, locale, {
          titleKey: "commands.config.setup.broken_state_title",
          descriptionKey: "commands.config.setup.broken_state_description",
          descriptionVars: {
            model_text_command: modelTextMention,
            provider_add_command: providerAddMention,
          },
          color: ColorCode.ERROR,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // No main persona row: orphaned alters or empty server entry.
      //     Wipe every config-table row to clear orphaned data; alter rows in `personas`
      //     are preserved since serverRepository.setup only inserts a new main persona (is_alter=false).
      log.warn(`[Setup] Server ${serverId} has no main persona — clearing config, preserving alters`);
      await configRepository.resetAllServerConfigs(existingInternalServerId);

      // Invalidate cache so stale persona data is not served
      invalidateTomoriStateCache(serverId);

      log.info(`[Setup] Cleared stale config for server ${serverId}, preserving alters, proceeding with fresh setup`);
    }

    const [uniqueProviders, presetOptions, freeProviders] = await Promise.all([
      llmModelRepo.loadUniqueProviders(),
      configRepository.loadPresetOptionsByLocale(locale, 100),
      llmModelRepo.loadProvidersWithFreeModels(),
    ]);

    if (!uniqueProviders || uniqueProviders.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.unknown_error_title",
        descriptionKey: "No LLM providers found in database",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!presetOptions || presetOptions.length === 0) {
      await interaction.reply({
        content: localizer(locale, "commands.config.setup.no_presets_found"),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const freeSuffix = localizer(locale, "commands.provider.add.free_suffix");
    const providerSelectOptions: SelectOption[] = uniqueProviders
      .filter((provider) => provider.toLowerCase() !== "custom" && !isCustomProvider(provider))
      .map((provider) => {
        const isFree = freeProviders.has(provider.toLowerCase());
        let label = isFree ? `${getProviderDisplayName(provider)} (${freeSuffix})` : getProviderDisplayName(provider);
        if (label.length > 100) label = label.substring(0, 100);
        return {
          label,
          value: provider,
          description: undefined,
        };
      });
    providerSelectOptions.push({
      label: localizer(locale, "commands.config.setup.api_provider_custom_endpoint_label"),
      value: SETUP_CUSTOM_ENDPOINT_PROVIDER,
      description: localizer(locale, "commands.config.setup.api_provider_custom_endpoint_description"),
    });
    if (!isDMChannel) {
      providerSelectOptions.push({
        label: localizer(locale, "commands.config.setup.api_provider_user_byok_label"),
        value: SETUP_USER_BYOK_PROVIDER,
        description: localizer(locale, "commands.config.setup.api_provider_user_byok_description"),
      });
    }

    const presetSelectOptions: SelectOption[] = presetOptions.map((preset) => ({
      label: preset.name,
      value: preset.name,
      description: preset.description,
    }));

    const humanizerSelectOptions: RadioGroupOption[] = [
      {
        label: localizer(locale, "commands.config.setup.humanizer_option_none_label"),
        value: "0",
        description: localizer(locale, "commands.config.setup.humanizer_option_none_desc"),
      },
      {
        label: localizer(locale, "commands.config.setup.humanizer_option_light_label"),
        value: "1",
        description: localizer(locale, "commands.config.setup.humanizer_option_light_desc"),
      },
      {
        label: localizer(locale, "commands.config.setup.humanizer_option_default_label"),
        value: "2",
        description: localizer(locale, "commands.config.setup.humanizer_option_default_desc"),
      },
      {
        label: localizer(locale, "commands.config.setup.humanizer_option_heavy_label"),
        value: "3",
        description: localizer(locale, "commands.config.setup.humanizer_option_heavy_desc"),
      },
    ];

    const modalResult = await promptWithRawModal(
      interaction,
      locale,
      {
        modalCustomId: "tomori_setup_modal",
        modalTitleKey: "commands.config.setup.modal_title",
        components: [
          {
            customId: "api_provider",
            labelKey: "commands.config.setup.api_provider_label",
            descriptionKey: "commands.config.setup.api_provider_description",
            placeholder: "commands.config.setup.api_provider_placeholder",
            required: true,
            options: providerSelectOptions,
          },
          {
            customId: "api_key",
            labelKey: "commands.config.setup.api_key_label",
            descriptionKey: "commands.config.setup.api_key_description",
            placeholder: "commands.config.setup.api_key_placeholder",
            style: TextInputStyle.Short,
            required: false,
            maxLength: SETUP_API_KEY_MAX_LENGTH,
          },
          {
            customId: "preset_name",
            labelKey: "commands.config.setup.preset_label",
            descriptionKey: "commands.config.setup.preset_description",
            placeholder: "commands.config.setup.preset_placeholder",
            required: true,
            options: presetSelectOptions,
          },
          {
            kind: "radioGroup" as const,
            customId: "humanizer_degree",
            labelKey: "commands.config.setup.humanizer_label",
            descriptionKey: "commands.config.setup.humanizer_description",
            required: true,
            options: humanizerSelectOptions,
          },
          {
            customId: "timezone_offset",
            labelKey: "commands.config.setup.timezone_label",
            descriptionKey: "commands.config.setup.timezone_description",
            style: TextInputStyle.Short,
            placeholder: "commands.config.setup.timezone_placeholder",
            required: false, // Optional - defaults to 0 (UTC) if not provided
            maxLength: SETUP_TIMEZONE_MAX_LENGTH,
          },
        ],
      },
      MessageFlags.Ephemeral, // Auto-defer with ephemeral flag
    );

    if (modalResult.outcome !== "submit") {
      log.info(`Setup modal ${modalResult.outcome} for user ${userData.user_id}`);
      return;
    }

    try {
      // biome-ignore lint/style/noNonNullAssertion: Modal submission outcome "submit" guarantees these values exist
      const modalSubmitInteraction = modalResult.interaction!;

      // Extract values with validation - modal submission can have missing values due to Component Type 18 handling

      const apiProvider = modalResult.values?.api_provider;
      const apiKey = modalResult.values?.api_key;
      const presetName = modalResult.values?.preset_name;
      const humanizerDegreeStr = modalResult.values?.humanizer_degree;
      const timezoneOffsetStr = modalResult.values?.timezone_offset;

      if (!apiProvider || !presetName || !humanizerDegreeStr) {
        log.error("Missing required modal values:", {
          apiProvider: apiProvider || "MISSING",
          apiKey: apiKey ? "PROVIDED" : "OPTIONAL_OR_MISSING",
          presetName: presetName || "MISSING",
          humanizerDegree: humanizerDegreeStr || "MISSING",
          allValuesKeys: modalResult.values ? Object.keys(modalResult.values) : "NO_VALUES",
          allValuesStringified: modalResult.values ? JSON.stringify(modalResult.values, null, 2) : "NO_VALUES",
        });
        await replyInfoEmbed(modalSubmitInteraction, locale, {
          titleKey: "general.errors.operation_failed_title",
          descriptionKey: "commands.config.setup.modal_values_missing",
          color: ColorCode.ERROR,
        });
        return;
      }

      const isCustomEndpointSetup = apiProvider === SETUP_CUSTOM_ENDPOINT_PROVIDER;
      const isUserByokSetup = !isDMChannel && apiProvider === SETUP_USER_BYOK_PROVIDER;
      const normalizedProvider =
        isUserByokSetup || isCustomEndpointSetup
          ? null
          : (uniqueProviders.find((provider) => provider.toLowerCase() === apiProvider.toLowerCase()) ?? null);

      if (!apiProvider || (!isUserByokSetup && !isCustomEndpointSetup && !normalizedProvider)) {
        await replyInfoEmbed(modalSubmitInteraction, locale, {
          titleKey: "general.errors.operation_failed_title",
          descriptionKey: "commands.config.setup.provider_invalid",
          color: ColorCode.ERROR,
        });
        return;
      }

      let encryptedKey: Buffer | null = null;
      let keyVersion = 1;

      if (isUserByokSetup) {
        log.info("User BYOK bootstrap selected - skipping server provider credential setup");
      } else if (isCustomEndpointSetup) {
        log.info("Deferred custom-endpoint bootstrap selected - skipping immediate server provider credential setup");
      } else {
        if (!apiKey || apiKey.length < 10) {
          await replyInfoEmbed(modalSubmitInteraction, locale, {
            titleKey: "general.errors.operation_failed_title",
            descriptionKey: "commands.config.setup.api_key_invalid",
            color: ColorCode.ERROR,
          });
          return;
        }

        await replyInfoEmbed(modalSubmitInteraction, locale, {
          titleKey: "commands.config.setup.api_key_validating",
          description: localizer(locale, "commands.config.setup.api_key_validating_description"),
          color: ColorCode.INFO,
        });

        try {
          const provider = await ProviderFactory.getProviderByName(normalizedProvider as string);

          const validationResult = await provider.validateApiKey(apiKey);
          if (!validationResult.valid) {
            let errorDescription = "API key validation failed";

            if (validationResult.error) {
              try {
                const formattedError = provider.formatErrorDescription(validationResult.error, locale);
                if (formattedError) {
                  errorDescription = formattedError;
                } else {
                  errorDescription = `Error Code ${validationResult.error.code}: ${validationResult.error.message}`;
                }
              } catch (formatError) {
                log.warn("Failed to format provider error description", formatError);
                errorDescription = `Error Code ${validationResult.error.code}: ${validationResult.error.message}`;
              }
            }

            await replyInfoEmbed(modalSubmitInteraction, locale, {
              titleKey: "general.errors.operation_failed_title",
              description: errorDescription, // Use formatted error description
              color: ColorCode.ERROR,
            });
            return;
          }
        } catch (providerError) {
          log.error(`Error validating API key for provider ${normalizedProvider}`, providerError as Error);
          await replyInfoEmbed(modalSubmitInteraction, locale, {
            titleKey: "general.errors.operation_failed_title",
            descriptionKey: "commands.config.setup.api_key_invalid_api",
            color: ColorCode.ERROR,
          });
          return;
        }

        const encryptionResult = await encryptApiKey(apiKey);
        encryptedKey = encryptionResult.encrypted;
        keyVersion = encryptionResult.version;
      }

      const selectedPresetOption = presetOptions.find((p) => p.name.toLowerCase() === presetName.trim().toLowerCase());

      if (!selectedPresetOption) {
        await replyInfoEmbed(modalSubmitInteraction, locale, {
          titleKey: "general.errors.operation_failed_title",
          descriptionKey: "commands.config.setup.preset_invalid",
          descriptionVars: {
            available: presetOptions.map((p) => p.name).join(", "),
          },
          color: ColorCode.ERROR,
        });
        return;
      }

      const presetRow = await configRepository.loadPresetByName(selectedPresetOption.name);

      if (!presetRow) {
        await replyInfoEmbed(modalSubmitInteraction, locale, {
          titleKey: "general.errors.operation_failed_title",
          descriptionKey: "commands.config.setup.preset_not_found",
          color: ColorCode.ERROR,
        });
        return;
      }

      const selectedPresetId = presetRow.persona_preset_id;
      log.info(`Selected preset ID: ${selectedPresetId} (${selectedPresetOption.name})`);

      const parsedHumanizer = Number.parseInt(humanizerDegreeStr, 10);

      if (Number.isNaN(parsedHumanizer)) {
        await replyInfoEmbed(modalSubmitInteraction, locale, {
          titleKey: "general.errors.operation_failed_title",
          descriptionKey: "commands.config.setup.humanizer_invalid",
          color: ColorCode.ERROR,
        });
        return;
      }

      if (parsedHumanizer < 0 || parsedHumanizer > 3) {
        await replyInfoEmbed(modalSubmitInteraction, locale, {
          titleKey: "general.errors.operation_failed_title",
          descriptionKey: "commands.config.setup.humanizer_invalid",
          color: ColorCode.ERROR,
        });
        return;
      }

      const humanizerDegree = parsedHumanizer as HumanizerDegree;
      log.info(`Selected humanizer degree: ${humanizerDegree}`);

      let timezoneOffset = 0; // Default to UTC
      if (timezoneOffsetStr?.trim()) {
        const parsedOffset = Number.parseFloat(timezoneOffsetStr.trim());

        if (Number.isNaN(parsedOffset)) {
          await replyInfoEmbed(modalSubmitInteraction, locale, {
            titleKey: "general.errors.operation_failed_title",
            descriptionKey: "commands.config.setup.timezone_invalid_format",
            descriptionVars: {
              provided: timezoneOffsetStr,
            },
            color: ColorCode.ERROR,
          });
          return;
        }

        if (parsedOffset < -12 || parsedOffset > 14) {
          await replyInfoEmbed(modalSubmitInteraction, locale, {
            titleKey: "general.errors.operation_failed_title",
            descriptionKey: "commands.config.setup.timezone_out_of_range",
            descriptionVars: {
              provided: parsedOffset.toString(),
              min: "-12",
              max: "14",
            },
            color: ColorCode.ERROR,
          });
          return;
        }

        // Round to integer (in case user provided decimal like 5.5)
        timezoneOffset = Math.round(parsedOffset);
      }

      const setupConfig: SetupConfig = {
        serverId: serverId,
        encryptedApiKey: encryptedKey,
        keyVersion: keyVersion, // Add encryption key version
        provider: normalizedProvider, // Use the case-normalized provider name
        presetId: selectedPresetId,
        humanizer: humanizerDegree, // Use the selected humanizer degree
        tomoriName: getDefaultBotName(serverLocale), // Use server locale for default persona name
        timezoneOffset: timezoneOffset, // Add timezone offset to config
        locale: serverLocale, // Persist guild locale for server analytics/triggers; DM falls back to user locale
        registrationLocale, // Analytics-only locale for servers
        userByokMode: isUserByokSetup,
        deferredCustomEndpointSetup: isCustomEndpointSetup,
      };

      try {
        setupConfigSchema.parse(setupConfig);
      } catch (error) {
        log.error("Setup config validation failed:", error);
        await replyInfoEmbed(modalSubmitInteraction, locale, {
          titleKey: "general.errors.operation_failed_title",
          descriptionKey: "commands.config.setup.config_invalid",
          color: ColorCode.ERROR,
        });
        return;
      }

      try {
        await serverRepository.setup(interaction.guild, setupConfig);
      } catch (error) {
        log.error("Server setup failed:", error);
        await replyInfoEmbed(modalSubmitInteraction, locale, {
          titleKey: "general.errors.operation_failed_title",
          descriptionKey: "commands.config.setup.setup_failed_description",
          color: ColorCode.ERROR,
        });
        return;
      }

      // NovelAI auto-disable: flip emoji and sticker usage off immediately after setup.
      // The schema defaults both to true, but NovelAI's token budget makes them
      // counterproductive: they consume context without the model being able to use them.
      // The user is notified in the success embed and can re-enable via /capabilities manage.
      // Reuse one freshly loaded state for capability updates and expression sync
      // so setup does not repeat the cache lookup for the internal server ID.
      const newTomoriState = await personaRepository.loadState(serverId);

      if (normalizedProvider === "novelai" && newTomoriState) {
        try {
          await configRepository.updateCapabilitiesConfig(newTomoriState.server_id, {
            emoji_usage_enabled: false,
            sticker_usage_enabled: false,
          });
          log.info(`[Setup] Auto-disabled emoji/sticker usage for NovelAI server ${serverId}`);
        } catch (disableError) {
          // Non-critical, so log but don't fail setup
          log.warn(`[Setup] Failed to auto-disable emoji/sticker for NovelAI: ${disableError}`);
        }
      }

      // Force sync emojis and stickers for guild context (skip for DMs)
      // This populates the database with all current emojis/stickers from Discord
      // Ensures emoji/sticker conversion works immediately without requiring an extra message
      if (!isDMChannel && interaction.guild) {
        try {
          if (newTomoriState) {
            log.info(`[Setup] Force syncing emojis/stickers for guild ${interaction.guild.name}`);

            // Force sync both emojis and stickers (ignore 24hr cache)
            await Promise.all([
              lazySyncGuildEmojis(interaction.guild, newTomoriState.server_id, true),
              lazySyncGuildStickers(interaction.guild, newTomoriState.server_id, true),
            ]);

            log.success(`[Setup] Successfully synced expressions for guild ${interaction.guild.name}`);
          } else {
            log.warn(`[Setup] Failed to load TomoriState after setup for guild ${interaction.guild.id}`);
          }
        } catch (syncError) {
          // Log error but don't fail setup - expressions will sync on first message anyway
          log.warn(`[Setup] Failed to sync expressions during setup (will sync on first message): ${syncError}`);
        }
      }

      let avatarUpdateFailed = false;

      // Only attempt avatar update in guilds (not available in DMs)
      if (!isDMChannel && interaction.guild) {
        try {
          const cachedAvatar = getCachedPresetAvatar(selectedPresetId);
          const presetAvatarBuffer = cachedAvatar ? null : await getPresetAvatarBuffer(presetRow);

          const avatarValue =
            cachedAvatar ??
            (presetAvatarBuffer ? `data:image/png;base64,${presetAvatarBuffer.toString("base64")}` : null);

          const endpoint = `https://discord.com/api/v10/guilds/${interaction.guild.id}/members/@me`;
          const response = await fetch(endpoint, {
            method: "PATCH",
            headers: {
              Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ avatar: avatarValue }),
          });

          if (response.ok) {
            const actionDescription = avatarValue
              ? `Set preset avatar for "${selectedPresetOption.name}"`
              : "Reset guild avatar to bot default";
            log.info(`${actionDescription} for guild ${interaction.guild.id} during setup`);
            // Stamp the applied avatar hash so the background fan-out reconciler
            // skips this freshly-set-up server until the catalog art changes again.
            await personaRepository.markServerMainAvatarSynced(interaction.guild.id);
          } else {
            avatarUpdateFailed = true;
            log.warn(`Failed to update guild avatar during setup: ${response.status} ${response.statusText}`);
          }
        } catch (avatarError) {
          // Log avatar error but don't fail the setup
          avatarUpdateFailed = true;
          log.warn(`Failed to update avatar during setup: ${avatarError}`);
        }
      }

      const providerDisplayName = normalizedProvider ? getProviderDisplayName(normalizedProvider) : "";
      const personaName = selectedPresetOption.name;

      let configuredModelName: string | null = null;
      if (normalizedProvider) {
        const defaultModel = await llmModelRepo.loadDefaultModel(normalizedProvider);
        if (defaultModel) {
          configuredModelName = defaultModel.llm_codename;
        }
      }

      const helpFeaturesMention = commandRegistry.getCommandMention("help");
      const successFields: Array<{ nameKey: string; value: string }> = [];

      if (isDMChannel) {
        successFields.push({
          nameKey: "commands.config.setup.dm_context_explanation_title",
          value: localizer(locale, "commands.config.setup.dm_context_explanation"),
        });
      }

      successFields.push({
        nameKey: "commands.config.setup.next_steps_title",
        value: localizer(
          locale,
          isDMChannel ? "commands.config.setup.next_steps_value_dm" : "commands.config.setup.next_steps_value",
        ),
      });

      successFields.push({
        nameKey: "commands.config.setup.learn_more_title",
        value: localizer(locale, "commands.config.setup.learn_more_value", {
          helpFeatures: helpFeaturesMention,
        }),
      });

      // Provider/mode-specific notes go into a conditional yellow "A Few Things to Note" embed,
      //    rendered only when at least one applies. Each note is a bold top-level bullet (label) with
      //    an indented detail sub-bullet, so nothing shows for a plain paid-provider setup.
      const headsUpNotes: Array<{ label: string; detail: string }> = [];

      if (normalizedProvider === "novelai") {
        headsUpNotes.push({
          label: localizer(locale, "commands.config.setup.novelai_expressions_warning_field"),
          detail: localizer(locale, "commands.config.setup.novelai_expressions_warning_value"),
        });
      }

      if (normalizedProvider === "zai" || normalizedProvider === "zaicoding") {
        headsUpNotes.push({
          label: localizer(locale, "commands.config.setup.zai_tos_warning_field"),
          detail: localizer(locale, "commands.config.setup.zai_tos_warning_value"),
        });
      }

      if (isUserByokSetup) {
        const userByokToggleMention = commandRegistry.getCommandMention("server", "user-byok", "toggle");
        const helpPersonalProviderMention = commandRegistry.getCommandMention("help");
        headsUpNotes.push({
          label: localizer(locale, "commands.config.setup.byok_bootstrap_field"),
          detail: localizer(locale, "commands.config.setup.byok_bootstrap_value", {
            toggle_command: userByokToggleMention,
            help_personal_provider: helpPersonalProviderMention,
          }),
        });
      }

      if (isCustomEndpointSetup) {
        const customModelsAddMention = commandRegistry.getCommandMention("provider", "custom-endpoint", "add");
        const modelTextMention = commandRegistry.getCommandMention("model", "text");
        const helpCustomModelsMention = commandRegistry.getCommandMention("help");
        const helpSpeechMention = commandRegistry.getCommandMention("help");
        const helpTranscriptionMention = commandRegistry.getCommandMention("help");
        headsUpNotes.push({
          label: localizer(locale, "commands.config.setup.custom_endpoint_bootstrap_field"),
          detail: localizer(locale, "commands.config.setup.custom_endpoint_bootstrap_value", {
            custom_models_add_command: customModelsAddMention,
            model_text_command: modelTextMention,
            help_custom_models_command: helpCustomModelsMention,
            help_speech_command: helpSpeechMention,
            help_transcription_command: helpTranscriptionMention,
          }),
        });
      }

      const headsUpEmbed =
        headsUpNotes.length > 0
          ? new EmbedBuilder()
              .setColor(ColorCode.WARN)
              .setTitle(localizer(locale, "commands.config.setup.heads_up_title"))
              .setDescription(headsUpNotes.map((note) => `- **${note.label}**\n  - ${note.detail}`).join("\n"))
          : null;

      const successDescriptionKey = isUserByokSetup
        ? isDMChannel
          ? "commands.config.setup.success_desc_dm"
          : "commands.config.setup.success_desc_byok"
        : isCustomEndpointSetup
          ? "commands.config.setup.success_desc_custom_endpoint"
          : configuredModelName
            ? isDMChannel
              ? "commands.config.setup.success_desc_dm_with_model"
              : "commands.config.setup.success_desc_with_model"
            : isDMChannel
              ? "commands.config.setup.success_desc_dm"
              : "commands.config.setup.success_desc";

      await replySummaryEmbed(modalSubmitInteraction, locale, {
        titleKey: "commands.config.setup.success_title",
        descriptionKey: successDescriptionKey,
        descriptionVars: {
          model_name: configuredModelName ?? "",
          provider: providerDisplayName,
          persona: personaName,
        },
        color: avatarUpdateFailed || isDMChannel ? ColorCode.WARN : ColorCode.SUCCESS,
        fields: successFields,
        appendEmbeds: headsUpEmbed ? [headsUpEmbed] : undefined,
        footerKey: isDMChannel
          ? "commands.persona.default.avatar_update_skipped_dm"
          : avatarUpdateFailed
            ? "commands.persona.default.avatar_update_failed"
            : undefined,
      });
    } catch (modalError) {
      log.error("Error during modal submission processing:", modalError);

      const modalSubmitInteraction = modalResult.interaction;
      if (modalSubmitInteraction) {
        try {
          await replyInfoEmbed(modalSubmitInteraction, locale, {
            titleKey: "general.errors.unknown_error_title",
            descriptionKey: "general.errors.unknown_error_description",
            color: ColorCode.ERROR,
          });
        } catch (replyError) {
          log.error("Failed to send modal error reply:", replyError);
        }
      }
    }
  } catch (error) {
    // Top-level error handler for non-modal errors (before modal is shown)
    log.error("Error during setup process:", error);
    if (!interaction.replied && !interaction.deferred) {
      try {
        await replyInfoEmbed(interaction, locale, {
          titleKey: "general.errors.unknown_error_title",
          descriptionKey: "general.errors.unknown_error_description",
          color: ColorCode.ERROR,
        });
      } catch (replyError) {
        log.error("Failed to send setup error reply:", replyError);
      }
    }
  }
}
