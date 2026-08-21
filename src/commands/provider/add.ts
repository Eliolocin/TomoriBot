import {
  MessageFlags,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type Client,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import { llmModelRepo, llmProviderRepo } from "@/utils/db/repositories";

import { getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import { commandRegistry } from "@/utils/discord/commandRegistry";
import { localizer } from "@/utils/text/localizer";
import { log, ColorCode } from "@/utils/misc/logger";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { promptWithRawModal } from "@/utils/discord/ui/modals";
import type { ErrorContext, UserRow } from "@/types/db/schema";
import type { ModalComponent, SelectOption } from "@/types/discord/modal";
import { ProviderFactory } from "@/utils/provider/providerFactory";
import { isCustomProvider } from "@/utils/provider/customProviderUtils";
import { getProviderAddChoiceDescriptionKey, getProviderDisplayName } from "@/utils/provider/providerInfoRegistry";
import { encryptApiKey } from "@/utils/security/crypto";
import { buildSavedProviderConfigFromExistingOrDefaults } from "@/utils/provider/savedProviderConfig";
import { activateServerTextModelFromSavedConfig } from "@/utils/provider/providerActivation";

const MODAL_CUSTOM_ID = "config_provider_add_modal";
const PROVIDER_SELECT_ID = "provider_select";
const API_KEY_INPUT_ID = "api_key_input";

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("add").setDescription(localizer("en-US", "commands.provider.add.description"));

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.channel) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.channel_only_title",
      descriptionKey: "general.errors.channel_only_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const serverId = interaction.guild?.id ?? interaction.user.id;
  const tomoriState = await getCachedTomoriState(serverId);
  if (!tomoriState) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.tomori_not_setup_title",
      descriptionKey: "general.errors.tomori_not_setup_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const [rawProviders, freeProviders] = await Promise.all([
    llmModelRepo.loadUniqueProviders(),
    llmModelRepo.loadProvidersWithFreeModels(),
  ]);
  const uniqueProviders = (rawProviders ?? []).filter(
    (provider) => provider.toLowerCase() !== "custom" && !isCustomProvider(provider),
  );
  if (!uniqueProviders.length) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.provider.api-key.set.no_providers_title",
      descriptionKey: "commands.provider.api-key.set.no_providers_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const savedProviders = await llmProviderRepo.loadSavedProviderConfigs(tomoriState.server_id);
  const savedProviderNames = new Set(savedProviders.map((cfg) => cfg.provider.toLowerCase()));

  const freeSuffix = localizer(locale, "commands.provider.add.free_suffix");
  const alreadyExistingSuffix = localizer(locale, "commands.provider.add.already_existing_suffix");

  const providerSelectOptions: SelectOption[] = uniqueProviders.map((provider) => {
    const normalizedProvider = provider.toLowerCase();
    const isExisting = savedProviderNames.has(provider.toLowerCase());
    const isFree = freeProviders.has(normalizedProvider);
    const baseName = getProviderDisplayName(provider);
    let label = [baseName, isFree && `(${freeSuffix})`, isExisting && `(${alreadyExistingSuffix})`]
      .filter(Boolean)
      .join(" ");
    if (label.length > 100) label = label.substring(0, 100);
    const descriptionKey = getProviderAddChoiceDescriptionKey(normalizedProvider);
    return {
      label,
      value: normalizedProvider,
      description: isExisting
        ? localizer(locale, "commands.provider.add.already_existing_description")
        : descriptionKey
          ? localizer(locale, descriptionKey)
          : undefined,
    };
  });
  providerSelectOptions.push({
    label: getProviderDisplayName("custom"),
    value: "custom",
    description: localizer(locale, "commands.provider.add.custom_deprecated_description"),
  });

  let modalSubmitInteraction: import("discord.js").ModalSubmitInteraction | undefined;

  try {
    const modalComponents: ModalComponent[] = [
      {
        customId: PROVIDER_SELECT_ID,
        labelKey: "commands.provider.add.provider_label",
        descriptionKey: "commands.provider.add.provider_description",
        placeholder: "commands.provider.add.provider_placeholder",
        required: true,
        options: providerSelectOptions,
      },
      {
        customId: API_KEY_INPUT_ID,
        labelKey: "commands.provider.add.api_key_label",
        descriptionKey: "commands.provider.add.api_key_description",
        placeholder: "commands.provider.add.api_key_placeholder",
        required: false,
        style: TextInputStyle.Short,
        maxLength: 200,
      },
    ];

    const modalResult = await promptWithRawModal(
      interaction,
      locale,
      {
        modalCustomId: MODAL_CUSTOM_ID,
        modalTitleKey: "commands.provider.add.modal_title",
        components: modalComponents,
      },
      MessageFlags.Ephemeral,
    );

    if (modalResult.outcome !== "submit") {
      return;
    }

    modalSubmitInteraction = modalResult.interaction;
    const selectedProvider = modalResult.values?.[PROVIDER_SELECT_ID]?.trim().toLowerCase();
    const apiKeyInput = modalResult.values?.[API_KEY_INPUT_ID]?.trim();
    const isLegacyCustomSelection = selectedProvider === "custom";

    if (!modalSubmitInteraction || !selectedProvider) {
      log.error("Provider add modal result unexpectedly missing interaction or values");
      return;
    }

    if (isLegacyCustomSelection) {
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "commands.provider.add.custom_moved_title",
        descriptionKey: "commands.provider.add.custom_moved_description",
        descriptionVars: {
          custom_models_add_command: commandRegistry.getCommandMention("provider", "custom-endpoint", "add"),
          model_text_command: commandRegistry.getCommandMention("model", "text"),
          help_custom_models_command: commandRegistry.getCommandMention("help"),
        },
        color: ColorCode.WARN,
      });
      return;
    }

    if (!apiKeyInput) {
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "commands.provider.api-key.set.invalid_key_title",
        descriptionKey: "commands.provider.api-key.set.invalid_key_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const existingConfig = await llmProviderRepo.loadSavedProviderConfig(tomoriState.server_id, selectedProvider);
    if (apiKeyInput.length < 10) {
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "commands.provider.api-key.set.invalid_key_title",
        descriptionKey: "commands.provider.api-key.set.invalid_key_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    let validationResult: Awaited<
      ReturnType<Awaited<ReturnType<typeof ProviderFactory.getProviderByName>>["validateApiKey"]>
    > = { valid: false };
    let providerInstance: Awaited<ReturnType<typeof ProviderFactory.getProviderByName>> | undefined;
    try {
      providerInstance = await ProviderFactory.getProviderByName(selectedProvider);
      validationResult = await providerInstance.validateApiKey(apiKeyInput);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("Unsupported provider")) {
        await replyInfoEmbed(modalSubmitInteraction, locale, {
          titleKey: "commands.provider.api-key.set.unsupported_provider_title",
          descriptionKey: "commands.provider.api-key.set.unsupported_provider_description",
          descriptionVars: {
            provider: selectedProvider,
          },
          color: ColorCode.ERROR,
        });
      } else {
        await replyInfoEmbed(modalSubmitInteraction, locale, {
          titleKey: "commands.provider.api-key.set.validation_error_title",
          descriptionKey: "commands.provider.api-key.set.validation_error_description",
          color: ColorCode.ERROR,
        });
      }
      return;
    }

    if (!validationResult.valid) {
      let errorDescription = "API key validation failed";
      if (validationResult.error) {
        try {
          if (providerInstance) {
            errorDescription =
              providerInstance.formatErrorDescription(validationResult.error, locale) ??
              `Error ${validationResult.error.code ?? "unknown"}: ${validationResult.error.message}`;
          }
        } catch (providerError) {
          log.warn("Failed to format provider validation error description", providerError);
        }
      }

      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "commands.provider.api-key.set.key_validation_failed_title",
        description: errorDescription,
        color: ColorCode.ERROR,
      });
      return;
    }

    const encryptionResult = await encryptApiKey(apiKeyInput);

    const savedConfig = await buildSavedProviderConfigFromExistingOrDefaults({
      serverId: tomoriState.server_id,
      provider: selectedProvider,
      apiKey: encryptionResult.encrypted,
      keyVersion: encryptionResult.version,
      baseConfig: tomoriState.config,
      existingConfig,
    });

    const upserted = await llmProviderRepo.upsertSavedProviderConfig(tomoriState.server_id, savedConfig);
    if (!upserted) {
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "general.errors.update_failed_title",
        descriptionKey: "general.errors.update_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const activationResult = await activateServerTextModelFromSavedConfig({
      serverDiscId: serverId,
      tomoriState,
      savedConfig,
    });
    if (activationResult.status !== "activated") {
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey:
          activationResult.status === "missing_model"
            ? "commands.provider.api-key.set.no_default_model_title"
            : "general.errors.update_failed_title",
        descriptionKey:
          activationResult.status === "missing_model"
            ? "commands.provider.api-key.set.no_default_model_description"
            : "general.errors.update_failed_description",
        descriptionVars: {
          provider: getProviderDisplayName(selectedProvider),
        },
        color: ColorCode.ERROR,
      });
      return;
    }

    await replyInfoEmbed(modalSubmitInteraction, locale, {
      titleKey: "commands.provider.add.success_title",
      descriptionKey: existingConfig ? "commands.provider.add.updated_existing" : "commands.provider.add.success",
      descriptionVars: {
        provider: getProviderDisplayName(selectedProvider),
        model_name: activationResult.modelName ?? localizer(locale, "general.unknown"),
      },
      color: ColorCode.SUCCESS,
    });
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: tomoriState.server_id,
      personaId: tomoriState.persona_id,
      errorType: "CommandExecutionError",
      metadata: {
        command: "provider add",
        guildId: interaction.guild?.id,
        executorDiscordId: interaction.user.id,
      },
    };
    await log.error(`Error executing /provider add for user ${userData.user_disc_id}`, error as Error, context);

    await replyInfoEmbed(modalSubmitInteraction ?? interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
  }
}
