import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import { configRepository, llmModelRepo, llmProviderRepo } from "@/utils/db/repositories";

import { getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import { localizer } from "@/utils/text/localizer";
import { log, ColorCode } from "@/utils/misc/logger";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import type { UserRow, ErrorContext } from "@/types/db/schema";
import { getProviderDisplayName } from "@/utils/provider/providerInfoRegistry";
import { deleteCustomLLMEntry } from "@/utils/provider/legacyCustomProvider";
import { isCustomProvider } from "@/utils/provider/customProviderUtils";
import { hasRegisteredCustomProvider, loadProviderDefaultSelectionIds } from "@/utils/provider/savedProviderConfig";
import { cleanupCustomProviderArtifacts } from "@/utils/provider/customEndpointService";
import { promptForSavedProvider } from "@/utils/discord/providerPicker";

async function resolveLlmProvider(llmId: number | null | undefined): Promise<string | null> {
  if (!llmId) return null;
  const llm = await llmModelRepo.loadById(llmId);
  return llm?.llm_provider ? llm.llm_provider.toLowerCase() : null;
}

async function resolveDiffusionProvider(diffusionModelId: number | null | undefined): Promise<string | null> {
  if (!diffusionModelId) return null;
  const model = await llmModelRepo.loadDiffusionModelById(diffusionModelId);
  return model?.provider ? String(model.provider).toLowerCase() : null;
}

async function resolveEmbeddingProvider(embeddingModelId: number | null | undefined): Promise<string | null> {
  if (!embeddingModelId) return null;
  const model = await llmModelRepo.loadEmbeddingModelById(embeddingModelId);
  return model?.provider ? String(model.provider).toLowerCase() : null;
}

async function resolveVideoProvider(videoModelId: number | null | undefined): Promise<string | null> {
  if (!videoModelId) return null;
  const model = await llmModelRepo.loadVideoGenerationModelById(videoModelId);
  return model?.provider ? String(model.provider).toLowerCase() : null;
}

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("remove").setDescription(localizer("en-US", "commands.provider.remove.description"));

/**
 * Removes a saved provider configuration from the database.
 * Shows all saved providers with the active one as a disabled button.
 */
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

  let resultTarget: ChatInputCommandInteraction | import("discord.js").ButtonInteraction = interaction;

  try {
    const rawSavedConfigs = await llmProviderRepo.loadSavedProviderConfigs(tomoriState.server_id);
    // Custom providers with live endpoints are managed via /provider custom-endpoint remove.
    // Orphaned custom provider rows (no matching custom_endpoints) are kept here as a
    // cleanup path, because they have no other way to be removed.
    const visibleSavedConfigs = (
      await Promise.all(
        rawSavedConfigs.map(async (config) => {
          if (
            isCustomProvider(config.provider) &&
            (await hasRegisteredCustomProvider(config.provider, { serverId: tomoriState.server_id }))
          ) {
            return null;
          }
          return config;
        }),
      )
    ).flatMap((config) => (config ? [config] : []));
    const currentProvider = tomoriState.llm.llm_provider.toLowerCase();
    const removableConfigs = tomoriState.config.user_byok_mode
      ? visibleSavedConfigs
      : visibleSavedConfigs.filter((c) => c.provider.toLowerCase() !== currentProvider);

    if (removableConfigs.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.provider.remove.no_saved_title",
        descriptionKey: "commands.provider.remove.no_saved_description",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const pickerResult = await promptForSavedProvider(interaction, locale, visibleSavedConfigs, {
      alwaysShowPicker: true,
      disabledProviders: tomoriState.config.user_byok_mode ? [] : [currentProvider],
      titleKey: "commands.provider.remove.picker_title",
      descriptionKey: "commands.provider.remove.picker_description",
      currentSelections: [
        {
          model: tomoriState.llm.llm_codename,
          provider: tomoriState.llm.llm_provider,
        },
      ],
      additionalDescription: [
        localizer(locale, "commands.provider.remove.active_provider_note", {
          provider: getProviderDisplayName(currentProvider),
        }),
        localizer(locale, "commands.provider.remove.custom_endpoint_note"),
      ].join("\n\n"),
    });

    if (!pickerResult) return; // cancelled or timed out

    const selectedProvider = pickerResult.provider;
    resultTarget = pickerResult.pickerInteraction ?? pickerResult.interaction;

    const activeProvider = tomoriState.llm.llm_provider.toLowerCase();
    const deletingActiveProvider = selectedProvider.toLowerCase() === activeProvider;
    const activeDefaults =
      deletingActiveProvider && tomoriState.config.user_byok_mode
        ? {
            llm_id: null,
            diffusion_model_id: null,
            embedding_model_id: null,
            nai_diffusion_model_id: null,
            video_model_id: null,
            vision_llm_id: null,
          }
        : await loadProviderDefaultSelectionIds(activeProvider);
    const reassignmentLines: string[] = [];

    const [embeddingProvider, standardImageProvider, naiImageProvider, videoProvider, visionProvider] =
      await Promise.all([
        resolveEmbeddingProvider(tomoriState.config.embedding_model_id),
        resolveDiffusionProvider(tomoriState.config.diffusion_model_id),
        resolveDiffusionProvider(tomoriState.config.nai_diffusion_model_id),
        resolveVideoProvider(tomoriState.config.video_model_id),
        resolveLlmProvider(tomoriState.config.vision_llm_id),
      ]);

    const nextLlmId = deletingActiveProvider && tomoriState.config.user_byok_mode ? null : tomoriState.config.llm_id;
    const nextEmbeddingModelId =
      embeddingProvider === selectedProvider.toLowerCase()
        ? activeDefaults.embedding_model_id
        : tomoriState.config.embedding_model_id;
    const nextDiffusionModelId =
      standardImageProvider === selectedProvider.toLowerCase()
        ? activeDefaults.diffusion_model_id
        : tomoriState.config.diffusion_model_id;
    const nextNaiDiffusionModelId =
      naiImageProvider === selectedProvider.toLowerCase()
        ? activeDefaults.nai_diffusion_model_id
        : tomoriState.config.nai_diffusion_model_id;
    const nextVideoModelId =
      videoProvider === selectedProvider.toLowerCase()
        ? activeDefaults.video_model_id
        : tomoriState.config.video_model_id;
    const nextVisionLlmId =
      visionProvider === selectedProvider.toLowerCase()
        ? activeDefaults.vision_llm_id
        : tomoriState.config.vision_llm_id;

    const fallbackRows =
      tomoriState.config.fallback_llm_ids && tomoriState.config.fallback_llm_ids.length > 0
        ? await llmModelRepo.getLlmsByIds(tomoriState.config.fallback_llm_ids)
        : [];
    const nextFallbackIds = fallbackRows
      .filter((row) => row.llm_provider.toLowerCase() !== selectedProvider.toLowerCase())
      .flatMap((row) => (row.llm_id === undefined ? [] : [row.llm_id]));
    const nextConfigApiKey =
      deletingActiveProvider && tomoriState.config.user_byok_mode ? null : tomoriState.config.api_key;
    const nextConfigKeyVersion =
      deletingActiveProvider && tomoriState.config.user_byok_mode ? 1 : (tomoriState.config.key_version ?? 1);
    const nextCustomEndpointUrl =
      deletingActiveProvider && tomoriState.config.user_byok_mode ? null : tomoriState.config.custom_endpoint_url;
    const nextCustomModelName =
      deletingActiveProvider && tomoriState.config.user_byok_mode ? null : tomoriState.config.custom_model_name;
    const nextCustomNumCtx =
      deletingActiveProvider && tomoriState.config.user_byok_mode ? null : tomoriState.config.custom_num_ctx;

    if (nextLlmId !== tomoriState.config.llm_id) {
      reassignmentLines.push(`- Text model -> ${nextLlmId ? `\`${nextLlmId}\`` : "*cleared*"}`);
    }
    if (nextEmbeddingModelId !== tomoriState.config.embedding_model_id) {
      reassignmentLines.push(
        `- Embedding model -> ${nextEmbeddingModelId ? `\`${nextEmbeddingModelId}\`` : "*cleared*"}`,
      );
    }
    if (nextDiffusionModelId !== tomoriState.config.diffusion_model_id) {
      reassignmentLines.push(
        `- Standard image model -> ${nextDiffusionModelId ? `\`${nextDiffusionModelId}\`` : "*cleared*"}`,
      );
    }
    if (nextNaiDiffusionModelId !== tomoriState.config.nai_diffusion_model_id) {
      reassignmentLines.push(
        `- NovelAI image model -> ${nextNaiDiffusionModelId ? `\`${nextNaiDiffusionModelId}\`` : "*cleared*"}`,
      );
    }
    if (nextVideoModelId !== tomoriState.config.video_model_id) {
      reassignmentLines.push(`- Video model -> ${nextVideoModelId ? `\`${nextVideoModelId}\`` : "*cleared*"}`);
    }
    if (nextVisionLlmId !== tomoriState.config.vision_llm_id) {
      reassignmentLines.push(`- Vision model -> ${nextVisionLlmId ? `\`${nextVisionLlmId}\`` : "*cleared*"}`);
    }
    if (nextFallbackIds.length !== (tomoriState.config.fallback_llm_ids ?? []).length) {
      reassignmentLines.push("- Fallback models -> removed entries from the deleted provider");
    }

    await Promise.all([
      configRepository.updateModelConfig(tomoriState.server_id, {
        llm_id: nextLlmId,
        api_key: nextConfigApiKey,
        key_version: nextConfigKeyVersion,
        custom_endpoint_url: nextCustomEndpointUrl,
        custom_model_name: nextCustomModelName,
        custom_num_ctx: nextCustomNumCtx,
        embedding_model_id: nextEmbeddingModelId,
        diffusion_model_id: nextDiffusionModelId,
        video_model_id: nextVideoModelId,
        vision_llm_id: nextVisionLlmId,
        fallback_llm_ids: nextFallbackIds,
      }),
      configRepository.updateNovelaiImagegenConfig(tomoriState.server_id, {
        nai_diffusion_model_id: nextNaiDiffusionModelId,
      }),
    ]);

    const deleted = await llmProviderRepo.deleteSavedProviderConfig(tomoriState.server_id, selectedProvider, {
      serverDiscId: serverId,
    });

    if (!deleted) {
      await replyInfoEmbed(resultTarget, locale, {
        titleKey: "general.errors.update_failed_title",
        descriptionKey: "general.errors.update_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const { purgeRotationKeysForProvider } = await import("@/utils/security/keyRotation");
    const purgedCount = await purgeRotationKeysForProvider(tomoriState.server_id, selectedProvider);
    if (purgedCount > 0) {
      log.info(`Purged ${purgedCount} rotation key(s) for removed provider ${selectedProvider}`);
    }

    if (selectedProvider.toLowerCase() === "custom") {
      log.info("Removing saved legacy custom provider config - cleaning up legacy custom LLM entry");
      await deleteCustomLLMEntry(serverId);
    } else if (isCustomProvider(selectedProvider)) {
      log.info(
        `Removing saved labeled custom provider config - cleaning up provider artifacts for ${selectedProvider}`,
      );
      await cleanupCustomProviderArtifacts(selectedProvider);
    }

    await replyInfoEmbed(resultTarget, locale, {
      titleKey: "commands.provider.remove.success_title",
      descriptionKey:
        reassignmentLines.length > 0
          ? "commands.provider.remove.auto_reassigned_description"
          : "commands.provider.remove.success_description",
      descriptionVars: {
        provider: getProviderDisplayName(selectedProvider),
        reassignments: reassignmentLines.join("\n"),
      },
      color: ColorCode.SUCCESS,
    });
  } catch (error) {
    let serverIdForError: number | null = null;
    let personaIdForError: number | null = null;
    const errorServerId = interaction.guild?.id ?? interaction.user.id;
    const state = await getCachedTomoriState(errorServerId);
    serverIdForError = state?.server_id ?? null;
    personaIdForError = state?.persona_id ?? null;

    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: serverIdForError,
      personaId: personaIdForError,
      errorType: "CommandExecutionError",
      metadata: {
        command: "provider remove",
        guildId: interaction.guild?.id,
        executorDiscordId: interaction.user.id,
      },
    };
    await log.error(`Error executing /provider remove for user ${userData.user_disc_id}`, error as Error, context);

    await replyInfoEmbed(resultTarget, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
  }
}
