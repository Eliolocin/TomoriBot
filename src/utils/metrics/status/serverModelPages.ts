import { type ChatInputCommandInteraction, type Client, MessageFlags } from "discord.js";
import type { SummaryEmbedOptions } from "@/types/discord/embed";
import type { TomoriState } from "@/types/db/schema";
import { llmModelRepo, llmOverrideRepo, personaRepository } from "@/utils/db/repositories";
import { getDiffusionModelById } from "@/utils/image/naiDiffusionModels";
import { getQuotaConfig } from "@/utils/quota/imageQuotaManager";
import { getTextQuotaConfig } from "@/utils/quota/textQuotaManager";
import { getVideoQuotaConfig } from "@/utils/quota/videoQuotaManager";
import {
  resolveActiveSpeechEndpoint,
  resolveActiveTranscriptionEndpoint,
} from "@/utils/provider/speechEndpointResolver";
import { formatLlmDisplayLabel } from "@/utils/provider/modelDisplay";
import { resolveCustomEndpointForProvider } from "@/utils/provider/customEndpointService";
import { replyPaginatedStatusPages } from "@/utils/discord/ui/statusComponents";
import { ColorCode } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";
import { formatBooleanLocalized } from "@/utils/text/processors/formatters";
import { loadVideoModelById } from "@/utils/metrics/dbStats";
import { formatChannelLlmOverrides, formatPersonaLlmOverrides } from "@/utils/metrics/status/channelFormatters";
import {
  formatFallbackChain,
  formatOmittedSamplingParams,
  formatQuotaLimitValue,
  getThinkingLevelLabel,
} from "@/utils/metrics/status/sharedFormatters";

export async function showServerModelStatus(
  client: Client,
  interaction: ChatInputCommandInteraction,
  serverDiscId: string,
  tomoriState: TomoriState,
  locale: string,
): Promise<void> {
  const config = tomoriState.config;
  const llm = tomoriState.llm;
  const [
    allPersonas,
    channelLlmOverrides,
    imageQuotaConfig,
    textQuotaConfig,
    videoQuotaConfig,
    diffusionModel,
    embeddingModel,
    videoModel,
    naiDiffusionModel,
    speechModel,
    transcriptionModel,
    visionEndpoint,
  ] = await Promise.all([
    personaRepository.loadAllForServer(serverDiscId),
    llmOverrideRepo.getAllChannelLlmOverridesForServer(tomoriState.server_id),
    getQuotaConfig(tomoriState.server_id),
    getTextQuotaConfig(tomoriState.server_id),
    getVideoQuotaConfig(tomoriState.server_id),
    config.diffusion_model_id ? getDiffusionModelById(config.diffusion_model_id) : Promise.resolve(null),
    config.embedding_model_id ? llmModelRepo.loadEmbeddingModelById(config.embedding_model_id) : Promise.resolve(null),
    config.video_model_id ? loadVideoModelById(config.video_model_id) : Promise.resolve(null),
    config.nai_diffusion_model_id ? getDiffusionModelById(config.nai_diffusion_model_id) : Promise.resolve(null),
    resolveActiveSpeechEndpoint(tomoriState.server_id),
    resolveActiveTranscriptionEndpoint(tomoriState.server_id),
    tomoriState.vision_llm
      ? resolveCustomEndpointForProvider(
          tomoriState.vision_llm.llm_provider.toLowerCase(),
          "text",
          config.vision_llm_id,
        )
      : Promise.resolve(null),
  ]);

  const modelValue = config.llm_id
    ? formatLlmDisplayLabel(llm, config.custom_model_name, config.other_model_codename)
    : config.user_byok_mode
      ? localizer(locale, "commands.choices.none_user_byok")
      : localizer(locale, "commands.choices.none");
  // custom_model_name and other_model_codename describe the *text* model, so passing them here
  // renders the chat model's name in the vision field whenever the vision model is a custom
  // endpoint. The vision model's own upstream name lives on its endpoint row.
  const visionModelValue = tomoriState.vision_llm
    ? formatLlmDisplayLabel(tomoriState.vision_llm, visionEndpoint?.model_name, null)
    : localizer(locale, "commands.choices.none");
  const fallbackModelsValue = formatFallbackChain(
    tomoriState.fallback_chain,
    tomoriState.fallback_llms,
    locale,
    config.custom_model_name,
    config.other_model_codename,
  );
  const logitBiasesValue =
    config.llm_logit_biases.length > 0
      ? localizer(locale, "commands.tool.status.item_count", { count: config.llm_logit_biases.length })
      : localizer(locale, "commands.choices.none");
  const diffusionModelValue = diffusionModel
    ? `${diffusionModel.codename} (${diffusionModel.provider})`
    : localizer(locale, "commands.choices.none");
  const videoModelValue = videoModel
    ? `${videoModel.codename} (${videoModel.provider})`
    : localizer(locale, "commands.choices.none");
  const embeddingModelValue = embeddingModel
    ? `${embeddingModel.codename} (${embeddingModel.provider})`
    : localizer(locale, "commands.choices.none");
  const speechModelValue = speechModel
    ? `${speechModel.endpoint.display_name} (${speechModel.endpoint.api_style})`
    : localizer(locale, "commands.choices.none");
  const transcriptionModelValue = transcriptionModel
    ? `${transcriptionModel.endpoint.display_name} (${transcriptionModel.endpoint.api_style})`
    : localizer(locale, "commands.choices.none");
  const customEndpointConfiguredValue = formatBooleanLocalized(!!config.custom_endpoint_url, locale);
  const naiDiffusionModelValue = naiDiffusionModel
    ? `${naiDiffusionModel.codename} (${naiDiffusionModel.provider})`
    : localizer(locale, "commands.choices.none");
  const channelLlmOverridesValue = await formatChannelLlmOverrides(
    client,
    channelLlmOverrides,
    locale,
    config.custom_model_name,
    config.other_model_codename,
  );
  const personaLlmOverridesValue = formatPersonaLlmOverrides(
    allPersonas,
    locale,
    config.custom_model_name,
    config.other_model_codename,
  );

  const serverPage1: SummaryEmbedOptions = {
    titleKey: "commands.tool.status.server_page1_title",
    descriptionKey: "commands.tool.status.server_page1_description",
    color: ColorCode.INFO,
    fields: [
      {
        nameKey: "commands.tool.status.field_model",
        value: modelValue,
        inline: false,
      },
      {
        nameKey: "commands.tool.status.field_speech_model",
        value: speechModelValue,
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_transcription_model",
        value: transcriptionModelValue,
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_temperature",
        value: String(config.llm_temperature),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_top_p",
        value: String(config.llm_top_p),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_top_k",
        value: String(config.llm_top_k),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_min_p",
        value: String(config.llm_min_p),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_frequency_penalty",
        value: String(config.llm_frequency_penalty),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_presence_penalty",
        value: String(config.llm_presence_penalty),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_omitted_params",
        value: formatOmittedSamplingParams(config.llm_disabled_params, locale),
        inline: false,
      },
      {
        nameKey: "commands.tool.status.field_humanizer",
        value: String(config.humanizer_degree),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_thinking_level",
        value: getThinkingLevelLabel(locale, config.thinking_level),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_vision_model",
        value: visionModelValue,
        inline: false,
      },
      {
        nameKey: "commands.tool.status.field_fallback_models",
        value: fallbackModelsValue,
        inline: false,
      },
      {
        nameKey: "commands.tool.status.field_logit_biases",
        value: logitBiasesValue,
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_diffusion_model",
        value: diffusionModelValue,
        inline: false,
      },
      {
        nameKey: "commands.tool.status.field_video_model",
        value: videoModelValue,
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_embedding_model",
        value: embeddingModelValue,
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_custom_endpoint",
        value: customEndpointConfiguredValue,
        inline: true,
      },
    ],
  };

  const serverPage2: SummaryEmbedOptions = {
    titleKey: "commands.tool.status.server_page6_title",
    descriptionKey: "commands.tool.status.server_page6_description",
    color: ColorCode.INFO,
    fields: [
      {
        nameKey: "commands.tool.status.field_channel_llm_overrides",
        value: channelLlmOverridesValue,
        inline: false,
      },
      {
        nameKey: "commands.tool.status.field_persona_llm_overrides",
        value: personaLlmOverridesValue,
        inline: false,
      },
    ],
  };

  const serverPage3: SummaryEmbedOptions = {
    titleKey: "commands.tool.status.server_page7_title",
    descriptionKey: "commands.tool.status.server_page7_description",
    color: ColorCode.INFO,
    fields: [
      {
        nameKey: "commands.tool.status.field_image_quota_enabled",
        value: formatBooleanLocalized(imageQuotaConfig.enabled, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_image_quota_daily_user",
        value: formatQuotaLimitValue(locale, imageQuotaConfig.daily_user_quota),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_image_quota_serverwide",
        value: formatQuotaLimitValue(locale, imageQuotaConfig.serverwide_quota),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_image_quota_reset_days",
        value: localizer(locale, "commands.tool.status.field_quota_reset_days_value", {
          days: imageQuotaConfig.serverwide_quota_resets_in,
        }),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_text_quota_enabled",
        value: formatBooleanLocalized(textQuotaConfig.enabled, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_text_quota_daily_user",
        value: formatQuotaLimitValue(locale, textQuotaConfig.daily_user_quota),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_text_quota_serverwide",
        value: formatQuotaLimitValue(locale, textQuotaConfig.serverwide_quota),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_text_quota_reset_days",
        value: localizer(locale, "commands.tool.status.field_quota_reset_days_value", {
          days: textQuotaConfig.serverwide_quota_resets_in,
        }),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_video_quota_enabled",
        value: formatBooleanLocalized(videoQuotaConfig.enabled, locale),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_video_quota_daily_user",
        value: formatQuotaLimitValue(locale, videoQuotaConfig.daily_user_quota),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_video_quota_serverwide",
        value: formatQuotaLimitValue(locale, videoQuotaConfig.serverwide_quota),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_video_quota_reset_days",
        value: localizer(locale, "commands.tool.status.field_quota_reset_days_value", {
          days: videoQuotaConfig.serverwide_quota_resets_in,
        }),
        inline: true,
      },
    ],
  };

  const serverPage4: SummaryEmbedOptions = {
    titleKey: "commands.tool.status.server_page8_title",
    descriptionKey: "commands.tool.status.server_page8_description",
    color: ColorCode.INFO,
    fields: [
      {
        nameKey: "commands.tool.status.field_nai_diffusion_model",
        value: naiDiffusionModelValue,
        inline: false,
      },
      {
        nameKey: "commands.tool.status.field_nai_preset",
        value: config.nai_preset_name ?? localizer(locale, "commands.choices.none"),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_nai_sampler",
        value: config.nai_sampler ?? localizer(locale, "commands.choices.none"),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_nai_steps",
        value: config.nai_steps != null ? String(config.nai_steps) : localizer(locale, "commands.choices.none"),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_nai_scale",
        value: config.nai_scale != null ? String(config.nai_scale) : localizer(locale, "commands.choices.none"),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_nai_noise_schedule",
        value: config.nai_noise_schedule ?? localizer(locale, "commands.choices.none"),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_nai_cfg_rescale",
        value:
          config.nai_cfg_rescale != null ? String(config.nai_cfg_rescale) : localizer(locale, "commands.choices.none"),
        inline: true,
      },
      {
        nameKey: "commands.tool.status.field_image_default_positive_tags",
        value:
          config.image_default_positive_tags.length > 0
            ? config.image_default_positive_tags.join(", ")
            : localizer(locale, "commands.choices.none"),
        inline: false,
      },
      {
        nameKey: "commands.tool.status.field_image_default_negative_tags",
        value:
          config.image_default_negative_tags.length > 0
            ? config.image_default_negative_tags.join(", ")
            : localizer(locale, "commands.choices.none"),
        inline: false,
      },
    ],
  };

  await replyPaginatedStatusPages(
    interaction,
    locale,
    [serverPage1, serverPage2, serverPage3, serverPage4],
    MessageFlags.Ephemeral,
  );
}
