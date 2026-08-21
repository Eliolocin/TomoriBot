import {
  MessageFlags,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import { getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import { llmModelRepo, llmProviderRepo } from "@/utils/db/repositories";

import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { promptWithUnacknowledgedConfirmation } from "@/utils/discord/ui/confirmation";
import { promptWithRawModal } from "@/utils/discord/ui/modals";
import { log, ColorCode } from "@/utils/misc/logger";
import { ProviderFactory } from "@/utils/provider/providerFactory";
import {
  getAllProviderChoices,
  getProviderAddChoiceDescriptionKey,
  getProviderDisplayName,
} from "@/utils/provider/providerInfoRegistry";
import { encryptApiKey } from "@/utils/security/crypto";
import { localizer } from "@/utils/text/localizer";
import type { ErrorContext, UserRow } from "@/types/db/schema";
import type { ModalComponent, SelectOption } from "@/types/discord/modal";
import { isPersonalTextCredentialRotation } from "@/utils/provider/personalProviderHelpers";
import { buildUserSavedProviderConfigFromExistingOrDefaults } from "@/utils/provider/savedProviderConfig";
import { isCustomProvider } from "@/utils/provider/customProviderUtils";
import { commandRegistry } from "@/utils/discord/commandRegistry";
import { activatePersonalProviderTextModel } from "@/utils/provider/providerActivation";

const MODAL_CUSTOM_ID = "personal_provider_add_modal";
const PROVIDER_SELECT_ID = "provider_select";
const API_KEY_INPUT_ID = "api_key_input";

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("add").setDescription(localizer("en-US", "commands.personal.provider.add.description"));

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

  if (!userData.user_id) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const tomoriState = await getCachedTomoriState(interaction.guild?.id ?? interaction.user.id);
  if (!tomoriState) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.tomori_not_setup_title",
      descriptionKey: "general.errors.tomori_not_setup_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const providerChoices = getAllProviderChoices().filter(
    (choice) => !isCustomProvider(choice.value) && choice.value !== "custom",
  );
  const existingProviders = new Set(
    (await llmProviderRepo.loadUserSavedProviderConfigs(userData.user_id)).map((row) => row.provider),
  );
  const existingSuffix = localizer(locale, "commands.personal.provider.add.already_existing_suffix");
  const providerOptions: SelectOption[] = providerChoices.map((choice) => {
    const descriptionKey = getProviderAddChoiceDescriptionKey(choice.value);
    return {
      label: existingProviders.has(choice.value) ? `${choice.name} (${existingSuffix})` : choice.name,
      value: choice.value,
      description: descriptionKey ? localizer(locale, descriptionKey) : undefined,
    };
  });
  providerOptions.push({
    label: getProviderDisplayName("custom"),
    value: "custom",
    description: localizer(locale, "commands.personal.provider.add.custom_deprecated_description"),
  });

  try {
    const modalComponents: ModalComponent[] = [
      {
        customId: PROVIDER_SELECT_ID,
        labelKey: "commands.personal.provider.add.provider_label",
        descriptionKey: "commands.personal.provider.add.provider_description",
        placeholder: "commands.personal.provider.add.provider_placeholder",
        required: true,
        options: providerOptions,
      },
      {
        customId: API_KEY_INPUT_ID,
        labelKey: "commands.personal.provider.add.api_key_label",
        descriptionKey: "commands.personal.provider.add.api_key_description",
        placeholder: "commands.personal.provider.add.api_key_placeholder",
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
        modalTitleKey: "commands.personal.provider.add.modal_title",
        components: modalComponents,
      },
      MessageFlags.Ephemeral,
    );

    if (modalResult.outcome !== "submit" || !modalResult.interaction) {
      return;
    }

    const selectedProvider = modalResult.values?.[PROVIDER_SELECT_ID]?.trim().toLowerCase();
    const apiKeyInput = modalResult.values?.[API_KEY_INPUT_ID]?.trim();
    if (!selectedProvider) {
      return;
    }

    if (selectedProvider === "custom") {
      await replyInfoEmbed(modalResult.interaction, locale, {
        titleKey: "commands.personal.provider.add.custom_moved_title",
        descriptionKey: "commands.personal.provider.add.custom_moved_description",
        descriptionVars: {
          custom_models_add_command: commandRegistry.getCommandMention("personal", "custom-endpoint", "add"),
          model_text_command: commandRegistry.getCommandMention("personal", "provider", "model-text"),
          help_custom_models_command: commandRegistry.getCommandMention("help"),
        },
        color: ColorCode.WARN,
      });
      return;
    }

    if (!apiKeyInput) {
      return;
    }

    if (apiKeyInput.length < 10) {
      await replyInfoEmbed(modalResult.interaction, locale, {
        titleKey: "commands.provider.api-key.set.invalid_key_title",
        descriptionKey: "commands.provider.api-key.set.invalid_key_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const providerInstance = await ProviderFactory.getProviderByName(selectedProvider);
    const validationResult = await providerInstance.validateApiKey(apiKeyInput);
    if (!validationResult.valid) {
      const errorDescription = validationResult.error
        ? (providerInstance.formatErrorDescription(validationResult.error, locale) ?? validationResult.error.message)
        : localizer(locale, "commands.provider.api-key.set.key_validation_failed_description");

      await replyInfoEmbed(modalResult.interaction, locale, {
        titleKey: "commands.provider.api-key.set.key_validation_failed_title",
        description: errorDescription,
        color: ColorCode.ERROR,
      });
      return;
    }

    const existingConfig = await llmProviderRepo.loadUserSavedProviderConfig(userData.user_id, selectedProvider);
    const encryptionResult = await encryptApiKey(apiKeyInput);
    const savedConfig = await buildUserSavedProviderConfigFromExistingOrDefaults({
      userId: userData.user_id,
      provider: selectedProvider,
      apiKey: encryptionResult.encrypted,
      keyVersion: encryptionResult.version,
      baseConfig: tomoriState.config,
      existingConfig,
    });

    // Saving a provider also activates its personal text model, so this command can silently
    // move the user's text routing off every server's default. Confirm that cross-server
    // consequence unless the personal text route already points at this same provider, where
    // the only real change is the stored credential.
    const savedProviderRows = await llmProviderRepo.loadUserSavedProviderConfigs(userData.user_id);
    const isCredentialRotation = isPersonalTextCredentialRotation(savedProviderRows, selectedProvider);

    let responseInteraction: typeof modalResult.interaction | ButtonInteraction = modalResult.interaction;
    if (!isCredentialRotation) {
      const pendingModel = savedConfig.llm_id ? await llmModelRepo.loadById(savedConfig.llm_id) : null;
      const confirmation = await promptWithUnacknowledgedConfirmation(modalResult.interaction, locale, {
        embedTitleKey: "commands.personal.provider.activation_confirm_title",
        embedDescriptionKey: "commands.personal.provider.activation_confirm_description",
        embedDescriptionVars: {
          capability: localizer(locale, "commands.personal.provider.capability_text"),
          provider: getProviderDisplayName(selectedProvider),
          model: pendingModel?.llm_codename ?? localizer(locale, "general.unknown"),
        },
        continueLabelKey: "commands.personal.provider.activation_confirm_continue",
        cancelLabelKey: "commands.personal.provider.activation_confirm_cancel",
        continueCustomId: "personal_provider_add_confirm",
        cancelCustomId: "personal_provider_add_cancel",
      });
      if (confirmation.outcome !== "continue" || !confirmation.interaction) {
        return;
      }
      // Acknowledge before the encrypt/upsert/activate chain so the button never expires.
      await confirmation.interaction.deferUpdate();
      responseInteraction = confirmation.interaction;
    }

    const upserted = await llmProviderRepo.upsertUserSavedProviderConfig(userData.user_id, savedConfig);
    if (!upserted) {
      await replyInfoEmbed(responseInteraction, locale, {
        titleKey: "general.errors.update_failed_title",
        descriptionKey: "general.errors.update_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const activationResult = await activatePersonalProviderTextModel({
      userId: userData.user_id,
      provider: selectedProvider,
      llmId: savedConfig.llm_id,
    });
    if (activationResult.status !== "activated") {
      await replyInfoEmbed(responseInteraction, locale, {
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

    await replyInfoEmbed(responseInteraction, locale, {
      titleKey: "commands.personal.provider.add.success_title",
      descriptionKey: isCredentialRotation
        ? "commands.personal.provider.add.rotated_description"
        : existingConfig
          ? "commands.personal.provider.add.updated_description"
          : "commands.personal.provider.add.success_description",
      descriptionVars: {
        provider: getProviderDisplayName(selectedProvider),
        model_name: activationResult.modelName ?? localizer(locale, "general.unknown"),
        scope_notice: localizer(locale, "commands.personal.provider.scope_notice"),
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
        command: "personal provider add",
        guildId: interaction.guild?.id,
        executorDiscordId: interaction.user.id,
      },
    };
    await log.error("Error executing /personal provider add", error as Error, context);

    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
  }
}
