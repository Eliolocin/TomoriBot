import type {
  ActionRowData,
  ButtonComponentData,
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  ComponentInContainerData,
  ContainerComponentData,
  SlashCommandSubcommandBuilder,
} from "discord.js";
import { ButtonStyle, ComponentType, MessageFlags } from "discord.js";
import { configRepository, llmModelRepo, llmOverrideRepo, llmProviderRepo } from "@/utils/db/repositories";

import { getCachedTomoriState, getCachedAllPersonas, invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { localizer } from "@/utils/text/localizer";
import { log, ColorCode } from "@/utils/misc/logger";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import {
  beginAnchorPrivateWorkflow,
  buildPersonaWorkflowNotice,
  completePersonaWorkflow,
  PERSONA_WORKFLOW_COMPONENT_TIMEOUT_MS,
  retryPersonaWorkflow,
  runPersonaPickerWorkflow,
  type AnchorPrivateWorkflowPhase,
  type PersonaWorkflowComponentsV2Payload,
  type PersonaWorkflowInPlacePhase,
  type PersonaWorkflowMessageController,
  type PersonaWorkflowModalPhase,
} from "@/utils/discord/ui/personaWorkflow";
import {
  acquireModelModalOpener,
  buildOpenRouterMovedNotice,
  buildOpenSelectorPayload,
  buildProviderPickerPayload,
  openAnchorModal,
} from "@/utils/discord/ui/anchorModelFlow";
import type { UserRow, ErrorContext, LlmRow } from "@/types/db/schema";
import type { SelectOption } from "@/types/discord/modal";
import { isCustomProvider } from "@/utils/provider/customProviderUtils";
import { buildFallbackModelPersistence } from "@/utils/provider/fallbackModelIdentity";
import { resolveLogitBiasEntriesForLlm } from "@/utils/provider/logitBiasResolver";
import { loadSavedProvidersForCapability } from "@/utils/provider/savedProviderConfig";
import { getProviderDisplayName } from "@/utils/provider/providerInfoRegistry";

const MODAL_CUSTOM_ID = "config_model_text_modal";
const MODEL_SELECT_ID = "model_select";

/**
 * Returns a localized description with capability flags prepended (e.g. "(FREE+TOOLS+IMG) Description").
 */
function getLocalizedDescription(model: LlmRow, locale: string): string {
  if (model.is_scoped_registration) {
    return localizer(locale, "general.scoped_openrouter_model_description");
  }

  const normalizedLocale = locale.toLowerCase().split("-")[0];
  const description = normalizedLocale === "ja" ? model.ja_description : model.llm_description;
  const baseDescription = description || model.llm_description || `${model.llm_provider} model`;

  if (model.llm_codename === "other-model") {
    return baseDescription;
  }

  const flags: string[] = [];
  if (model.is_free && !isCustomProvider(model.llm_provider)) flags.push("FREE");
  if (model.has_tools) flags.push("TOOLS");
  if (model.sees_images) flags.push("IMG");
  if (model.sees_videos) flags.push("VID");
  if (model.supports_structoutput) flags.push("STRUCT");

  const flagPrefix = flags.length > 0 ? `(${flags.join("+")}) ` : "";
  return `${flagPrefix}${baseDescription}`;
}

function buildPersonaModelLoadingNotice(locale: string): PersonaWorkflowComponentsV2Payload {
  return buildPersonaWorkflowNotice({
    locale,
    titleKey: "general.persona_workflow.loading_title",
    descriptionKey: "general.persona_workflow.loading_description",
    color: ColorCode.INFO,
  });
}

function buildPersonaModelModalReady(locale: string, customId: string): PersonaWorkflowComponentsV2Payload {
  const container: ContainerComponentData<ComponentInContainerData> = {
    type: ComponentType.Container,
    accentColor: Number.parseInt(ColorCode.INFO.replace("#", ""), 16),
    components: [
      {
        type: ComponentType.TextDisplay,
        content: `### ${localizer(locale, "general.persona_workflow.modal_ready_title")}`,
      },
      {
        type: ComponentType.TextDisplay,
        content: localizer(locale, "general.persona_workflow.modal_ready_description"),
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            customId,
            label: localizer(locale, "general.persona_workflow.open_modal_button"),
            style: ButtonStyle.Secondary,
          },
        ],
      } satisfies ActionRowData<ButtonComponentData>,
    ],
  };
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

/**
 * Opens this command's model-selection modal on the anchor message, delegating the
 * lifecycle (including the `>25` range-selector bridge) to the shared anchor helper.
 * Only the modal's own copy and field id are this command's business.
 */
async function openModelModal(
  phase: AnchorPrivateWorkflowPhase,
  button: ButtonInteraction,
  locale: string,
  modelOptions: SelectOption[],
  modalCustomId: string,
): Promise<PersonaWorkflowModalPhase | null> {
  return openAnchorModal(phase, button, locale, {
    modalCustomId,
    modalTitleKey: "commands.model.text.modal_title",
    components: [
      {
        customId: MODEL_SELECT_ID,
        labelKey: "commands.model.text.select_label",
        descriptionKey: "commands.model.text.select_description",
        placeholder: "commands.model.text.select_placeholder",
        required: true,
        options: modelOptions,
      },
    ],
  });
}

/** Builds the model-option list shown in the selection modal for one provider. */
function buildModelSelectOptions(models: LlmRow[], locale: string, labelFromDescription = false): SelectOption[] {
  return models.map((model) => ({
    label: safeSelectOptionText(
      labelFromDescription ? model.llm_description?.trim() || model.llm_codename : model.llm_codename,
    ),
    value: safeSelectOptionText(model.llm_codename),
    description: safeSelectOptionText(getLocalizedDescription(model, locale)),
  }));
}

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("text")
    .setDescription(localizer("en-US", "commands.model.text.description"))
    .addStringOption((option) =>
      option
        .setName("scope")
        .setDescription(localizer("en-US", "commands.model.text.scope_description"))
        .setRequired(false)
        .addChoices(
          { name: localizer("en-US", "commands.model.text.scope_global"), value: "global" },
          { name: localizer("en-US", "commands.model.text.scope_channel"), value: "channel" },
          { name: localizer("en-US", "commands.model.text.scope_persona"), value: "persona" },
        ),
    );

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.channel) {
    await replyInfoEmbed(interaction, userData.language_pref, {
      titleKey: "general.errors.channel_only_title",
      descriptionKey: "general.errors.channel_only_description",
      color: ColorCode.ERROR,
    });
    return;
  }

  const scope = interaction.options.getString("scope") ?? "global";
  if (scope === "persona") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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

  const savedProviders = await loadSavedProvidersForCapability(tomoriState.server_id, "text");

  let selectedModel: LlmRow | null = null;
  // Anchor one-message controller for channel/global scopes. Tracked so the outer
  // catch can render an unexpected-error terminal on the same ephemeral message.
  let anchorMessage: PersonaWorkflowMessageController | null = null;
  const personaWorkflowState: { message: PersonaWorkflowMessageController | null } = { message: null };

  try {
    // Channel scope: anchor one-message flow; provider picker → model picker →
    //    channel override → terminal result, all edited in place on one ephemeral message.
    if (scope === "channel") {
      const currentChannelModel =
        (await llmOverrideRepo.getChannelLlmOverride(tomoriState.server_id, interaction.channelId)) ?? tomoriState.llm;
      const idRoot = "model_text_channel";

      // Open the anchor message with the correct initial control for the
      //     number of saved providers (none → error, one → open button, many → picker).
      const initialPayload =
        savedProviders.length === 0
          ? buildPersonaWorkflowNotice({
              locale,
              titleKey: "commands.model.providerPicker.no_providers_title",
              descriptionKey: "commands.model.providerPicker.no_providers_description",
              color: ColorCode.ERROR,
            })
          : savedProviders.length === 1
            ? buildOpenSelectorPayload(locale, `${idRoot}_open`)
            : buildProviderPickerPayload(
                locale,
                idRoot,
                savedProviders.map((p) => p.provider),
                [{ model: currentChannelModel.llm_codename, provider: currentChannelModel.llm_provider }],
              );

      const phase = await beginAnchorPrivateWorkflow(interaction, locale, initialPayload);
      anchorMessage = phase.message;
      if (savedProviders.length === 0) return;

      // Resolve the provider and the unacknowledged button the modal opens from.
      const opener = await acquireModelModalOpener(phase, interaction.user.id, locale, savedProviders, idRoot);
      if (!opener) return;

      const availableModels = await llmModelRepo.loadAvailableModelsForProvider(opener.provider, false, {
        kind: "server",
        ownerId: tomoriState.server_id,
      });
      if (!availableModels?.length) {
        await phase.useButton(opener.button).replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "commands.model.text.no_models_title",
            descriptionKey: "commands.model.text.no_models_description",
            color: ColorCode.ERROR,
          }),
        );
        return;
      }

      // Open the model modal (>25 routes through the anchor range selector).
      const modalPhase = await openModelModal(
        phase,
        opener.button,
        locale,
        buildModelSelectOptions(availableModels, userData.language_pref),
        "config_model_text_channel_modal",
      );
      if (!modalPhase) return;

      // Acknowledge within 3s, then write and render the terminal on the one message.
      const work = await modalPhase.beginInPlaceWork();
      const selectedChannelModel =
        availableModels.find((m) => m.llm_codename === modalPhase.values[MODEL_SELECT_ID]) ?? null;

      if (!selectedChannelModel?.llm_id) {
        await work.message.replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "commands.model.text.invalid_model_title",
            descriptionKey: "commands.model.text.invalid_model_description",
            color: ColorCode.ERROR,
          }),
        );
        return;
      }

      if (selectedChannelModel.llm_codename === "other-model") {
        await work.message.replace(buildOpenRouterMovedNotice(locale));
        return;
      }

      const channelWriteOk = await llmOverrideRepo.setChannelLlmOverride(
        tomoriState.server_id,
        interaction.channelId,
        selectedChannelModel.llm_id,
        { serverDiscId: serverId },
      );
      if (!channelWriteOk) {
        await work.message.replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "general.errors.update_failed_title",
            descriptionKey: "general.errors.update_failed_description",
            color: ColorCode.ERROR,
          }),
        );
        return;
      }

      await work.message.replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "commands.model.text.success_title",
          descriptionKey: "commands.model.text.scope_set_channel_success",
          descriptionVars: {
            channel: interaction.channel?.toString() ?? interaction.channelId,
            model: selectedChannelModel.llm_codename,
          },
          color: ColorCode.SUCCESS,
        }),
      );
      return;
    }

    // Persona scope: persona picker → provider picker → model picker → persona override
    if (scope === "persona") {
      const allPersonas = await getCachedAllPersonas(serverId);
      if (!allPersonas.length) {
        await replyInfoEmbed(interaction, locale, {
          titleKey: "general.errors.tomori_not_setup_title",
          descriptionKey: "general.errors.tomori_not_setup_description",
          color: ColorCode.ERROR,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await runPersonaPickerWorkflow(interaction, locale, {
        personas: allPersonas,
        color: ColorCode.INFO,
        async onSelected(selection) {
          personaWorkflowState.message = selection.message;
          const selectedPersona = selection.persona;
          const personaId = selectedPersona.persona_id;
          if (personaId == null) {
            const work = await selection.beginInPlaceWork();
            await work.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "general.errors.invalid_option_title",
                descriptionKey: "general.errors.invalid_option_description",
                color: ColorCode.ERROR,
              }),
            );
            return completePersonaWorkflow();
          }

          try {
            const currentPersonaModel = selectedPersona.persona_llm ?? tomoriState.llm;
            let selectedProvider: string;

            if (savedProviders.length === 0) {
              const work = await selection.beginInPlaceWork();
              await work.message.replace(
                buildPersonaWorkflowNotice({
                  locale,
                  titleKey: "commands.model.providerPicker.no_providers_title",
                  descriptionKey: "commands.model.providerPicker.no_providers_description",
                  color: ColorCode.ERROR,
                }),
              );
              return completePersonaWorkflow();
            }

            if (savedProviders.length === 1) {
              selectedProvider = savedProviders[0].provider.toLowerCase();
              const work = await selection.beginInPlaceWork();
              await work.message.replace(buildPersonaModelLoadingNotice(locale));
            } else {
              const work = await selection.beginInPlaceWork();
              const providerPrefix = `persona_model_${selection.phaseId}_provider`;
              await work.message.replace(
                buildProviderPickerPayload(
                  locale,
                  providerPrefix,
                  savedProviders.map((provider) => provider.provider),
                  [{ model: currentPersonaModel.llm_codename, provider: currentPersonaModel.llm_provider }],
                ),
              );

              let providerButton: import("discord.js").ButtonInteraction;
              try {
                const providerMessage = await work.message.fetchMessage();
                providerButton = await providerMessage.awaitMessageComponent({
                  componentType: ComponentType.Button,
                  filter: (candidate) =>
                    candidate.user.id === interaction.user.id && candidate.customId.startsWith(providerPrefix),
                  time: PERSONA_WORKFLOW_COMPONENT_TIMEOUT_MS,
                });
              } catch {
                await work.message.replace(
                  buildPersonaWorkflowNotice({
                    locale,
                    titleKey: "general.interaction.timeout_title",
                    descriptionKey: "general.pagination.timeout",
                    color: ColorCode.WARN,
                  }),
                );
                return completePersonaWorkflow();
              }

              const providerAction = selection.useButton(providerButton);
              if (providerButton.customId === `${providerPrefix}_cancel`) {
                await providerAction.replace(
                  buildPersonaWorkflowNotice({
                    locale,
                    titleKey: "general.interaction.cancel_title",
                    descriptionKey: "general.pagination.cancelled",
                    color: ColorCode.WARN,
                  }),
                );
                return retryPersonaWorkflow();
              }

              const providerIndex = Number.parseInt(providerButton.customId.replace(`${providerPrefix}_`, ""), 10);
              const provider = savedProviders[providerIndex];
              if (!provider) {
                await providerAction.replace(
                  buildPersonaWorkflowNotice({
                    locale,
                    titleKey: "general.errors.invalid_option_title",
                    descriptionKey: "general.errors.invalid_option_description",
                    color: ColorCode.ERROR,
                  }),
                );
                return completePersonaWorkflow();
              }
              selectedProvider = provider.provider.toLowerCase();
              const providerWork = await providerAction.beginInPlaceWork();
              await providerWork.message.replace(buildPersonaModelLoadingNotice(locale));
            }

            const personaAvailableModels = await llmModelRepo.loadAvailableModelsForProvider(selectedProvider, false, {
              kind: "server",
              ownerId: tomoriState.server_id,
            });
            if (!personaAvailableModels?.length) {
              await selection.message.replace(
                buildPersonaWorkflowNotice({
                  locale,
                  titleKey: "commands.model.text.no_models_title",
                  descriptionKey: "commands.model.text.no_models_description",
                  color: ColorCode.ERROR,
                }),
              );
              return completePersonaWorkflow();
            }

            const personaModelOptions: SelectOption[] = personaAvailableModels.map((model) => ({
              label: safeSelectOptionText(model.llm_codename),
              value: safeSelectOptionText(model.llm_codename),
              description: safeSelectOptionText(getLocalizedDescription(model, userData.language_pref)),
            }));
            const modalButtonId = `persona_model_${selection.phaseId}_open`;
            await selection.message.replace(buildPersonaModelModalReady(locale, modalButtonId));

            let modalButton: import("discord.js").ButtonInteraction;
            try {
              const modalMessage = await selection.message.fetchMessage();
              modalButton = await modalMessage.awaitMessageComponent({
                componentType: ComponentType.Button,
                filter: (candidate) =>
                  candidate.user.id === interaction.user.id && candidate.customId === modalButtonId,
                time: PERSONA_WORKFLOW_COMPONENT_TIMEOUT_MS,
              });
            } catch {
              await selection.message.replace(
                buildPersonaWorkflowNotice({
                  locale,
                  titleKey: "general.interaction.timeout_title",
                  descriptionKey: "general.pagination.timeout",
                  color: ColorCode.WARN,
                }),
              );
              return retryPersonaWorkflow();
            }

            const personaModalResult = await selection.useButton(modalButton).openModal({
              modalCustomId: "config_model_text_persona_modal",
              modalTitleKey: "commands.model.text.modal_title",
              components: [
                {
                  customId: MODEL_SELECT_ID,
                  labelKey: "commands.model.text.select_label",
                  descriptionKey: "commands.model.text.select_description",
                  placeholder: "commands.model.text.select_placeholder",
                  required: true,
                  options: personaModelOptions,
                },
              ],
            });
            if (personaModalResult.outcome !== "submitted") {
              return retryPersonaWorkflow();
            }

            const modalWork = await personaModalResult.phase.beginInPlaceWork();
            const selectedPersonaCodename = personaModalResult.phase.values[MODEL_SELECT_ID];
            const selectedPersonaModel =
              personaAvailableModels.find((model) => model.llm_codename === selectedPersonaCodename) ?? null;

            if (!selectedPersonaModel?.llm_id) {
              await modalWork.message.replace(
                buildPersonaWorkflowNotice({
                  locale,
                  titleKey: "commands.model.text.invalid_model_title",
                  descriptionKey: "commands.model.text.invalid_model_description",
                  color: ColorCode.ERROR,
                }),
              );
              return completePersonaWorkflow();
            }

            if (selectedPersonaModel.llm_codename === "other-model") {
              await modalWork.message.replace(buildOpenRouterMovedNotice(locale));
              return completePersonaWorkflow();
            }

            const personaWriteOk = await llmOverrideRepo.setPersonaLlmOverride(personaId, selectedPersonaModel.llm_id, {
              serverDiscId: serverId,
            });
            if (!personaWriteOk) {
              await modalWork.message.replace(
                buildPersonaWorkflowNotice({
                  locale,
                  titleKey: "general.errors.update_failed_title",
                  descriptionKey: "general.errors.update_failed_description",
                  color: ColorCode.ERROR,
                }),
              );
              return completePersonaWorkflow();
            }

            selectedPersona.persona_llm = selectedPersonaModel;
            await modalWork.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "commands.model.text.success_title",
                descriptionKey: "commands.model.text.scope_set_persona_success",
                descriptionVars: {
                  persona: selectedPersona.persona_nickname,
                  model: selectedPersonaModel.llm_codename,
                },
                footerKey: "general.pagination.reloading_persona_picker",
                color: ColorCode.SUCCESS,
              }),
            );
            return retryPersonaWorkflow();
          } catch (error) {
            await selection.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "general.errors.unknown_error_title",
                descriptionKey: "general.errors.unknown_error_description",
                color: ColorCode.ERROR,
              }),
            );
            throw error;
          }
        },
      });
      return;
    }

    // Global scope: anchor one-message flow; provider picker → (custom capability
    //    activation | model picker) → mirror write → terminal result, all on one message.
    const idRoot = "model_text_global";
    const initialPayload =
      savedProviders.length === 0
        ? buildPersonaWorkflowNotice({
            locale,
            titleKey: "commands.model.providerPicker.no_providers_title",
            descriptionKey: "commands.model.providerPicker.no_providers_description",
            color: ColorCode.ERROR,
          })
        : savedProviders.length === 1
          ? buildOpenSelectorPayload(locale, `${idRoot}_open`)
          : buildProviderPickerPayload(
              locale,
              idRoot,
              savedProviders.map((p) => p.provider),
              [{ model: tomoriState.llm.llm_codename, provider: tomoriState.llm.llm_provider }],
            );

    const phase = await beginAnchorPrivateWorkflow(interaction, locale, initialPayload);
    anchorMessage = phase.message;
    if (savedProviders.length === 0) return;

    const opener = await acquireModelModalOpener(phase, interaction.user.id, locale, savedProviders, idRoot);
    if (!opener) return;
    const selectedProvider = opener.provider;
    const selectedSavedConfig = savedProviders.find((p) => p.provider.toLowerCase() === selectedProvider) ?? null;

    // Custom provider: pick among the label's registered text models, then activate the choice.
    if (isCustomProvider(selectedProvider)) {
      const customAvailableModels = selectedSavedConfig
        ? await llmModelRepo.loadAvailableModelsForProvider(selectedProvider, false, {
            kind: "server",
            ownerId: tomoriState.server_id,
          })
        : null;
      if (!selectedSavedConfig || !customAvailableModels?.length) {
        await phase.useButton(opener.button).replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "commands.model.text.no_models_title",
            descriptionKey: "commands.model.text.no_models_description",
            color: ColorCode.ERROR,
          }),
        );
        return;
      }

      // Single registered model activates directly (no modal); multiple show a
      // string-select modal on the same anchor message.
      let work: PersonaWorkflowInPlacePhase;
      let customModel: LlmRow | null;
      if (customAvailableModels.length === 1) {
        work = await phase.useButton(opener.button).beginInPlaceWork();
        customModel = customAvailableModels[0];
      } else {
        const customModalPhase = await openModelModal(
          phase,
          opener.button,
          locale,
          buildModelSelectOptions(customAvailableModels, userData.language_pref, true),
          "config_model_text_custom_modal",
        );
        if (!customModalPhase) return;
        work = await customModalPhase.beginInPlaceWork();
        customModel =
          customAvailableModels.find((m) => m.llm_codename === customModalPhase.values[MODEL_SELECT_ID]) ?? null;
      }
      selectedModel = customModel;

      if (!customModel?.llm_id) {
        await work.message.replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "commands.model.text.invalid_model_title",
            descriptionKey: "commands.model.text.invalid_model_description",
            color: ColorCode.ERROR,
          }),
        );
        return;
      }

      if (customModel.llm_id === tomoriState.config.llm_id) {
        await work.message.replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "commands.model.text.already_selected_title",
            descriptionKey: "commands.model.text.already_selected_description",
            descriptionVars: { model_name: customModel.llm_description ?? customModel.llm_codename },
            color: ColorCode.WARN,
          }),
        );
        return;
      }

      const resolvedLogitBiases = resolveLogitBiasEntriesForLlm(
        selectedSavedConfig.llm_logit_biases ?? tomoriState.config.llm_logit_biases ?? [],
        customModel,
      );
      const customEndpoints = await llmProviderRepo.loadCustomEndpointsForServer(tomoriState.server_id);
      // The live chain is cross-provider by design, so it is pruned rather than cleared: only
      // the model being promoted has to go, or it would block every later /model fallback edit.
      const { fallbackModelRefs, fallbackLlmIds } = buildFallbackModelPersistence(
        tomoriState.config.fallback_model_refs ?? [],
        customModel.llm_id,
        customEndpoints,
      );
      const disabledParams = selectedSavedConfig.llm_disabled_params ?? [];

      const [updatedModel, updatedChat] = await Promise.all([
        configRepository.updateModelConfig(tomoriState.server_id, {
          llm_id: customModel.llm_id,
          api_key: selectedSavedConfig.api_key,
          key_version: selectedSavedConfig.key_version ?? 1,
          thinking_level: selectedSavedConfig.thinking_level ?? "auto",
          fallback_llm_ids: fallbackLlmIds,
          llm_temperature: selectedSavedConfig.llm_temperature ?? tomoriState.config.llm_temperature ?? 1.0,
          llm_disabled_params: disabledParams,
          custom_model_name: null,
          custom_endpoint_url: null,
          custom_num_ctx: null,
        }),
        configRepository.updateChatConfig(tomoriState.server_id, {
          llm_top_p: selectedSavedConfig.llm_top_p ?? tomoriState.config.llm_top_p ?? 0.95,
          llm_top_k: selectedSavedConfig.llm_top_k ?? tomoriState.config.llm_top_k ?? 0,
          llm_frequency_penalty:
            selectedSavedConfig.llm_frequency_penalty ?? tomoriState.config.llm_frequency_penalty ?? 0.0,
          llm_presence_penalty:
            selectedSavedConfig.llm_presence_penalty ?? tomoriState.config.llm_presence_penalty ?? 0.0,
          llm_min_p: selectedSavedConfig.llm_min_p ?? tomoriState.config.llm_min_p ?? 0.05,
          llm_logit_biases: resolvedLogitBiases.entries,
          fallback_model_refs: fallbackModelRefs,
        }),
      ]);
      // The split-table writes are not transactional. Invalidate after either
      // succeeds so a partial write cannot leave a stale assembled state.
      if (updatedModel || updatedChat) {
        invalidateTomoriStateCache(serverId);
      }

      if (!updatedModel || !updatedChat) {
        const context: ErrorContext = {
          personaId: tomoriState.persona_id,
          serverId: tomoriState.server_id,
          userId: userData.user_id,
          errorType: "DatabaseUpdateError",
          metadata: {
            command: "model text",
            guildId: serverId,
            scope: "global",
            selectedProvider,
            selectedModelCodename: customModel.llm_codename,
            targetLlmId: customModel.llm_id,
            modelConfigUpdated: updatedModel,
            chatConfigUpdated: updatedChat,
          },
        };
        await log.error(
          "Failed to update all custom-provider LLM configuration tables",
          new Error("One or more database updates returned false"),
          context,
        );
        await work.message.replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "general.errors.update_failed_title",
            descriptionKey: "general.errors.update_failed_description",
            color: ColorCode.ERROR,
          }),
        );
        return;
      }

      await work.message.replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "commands.model.text.success_title",
          descriptionKey: "commands.model.text.success_description",
          descriptionVars: {
            model_name: customModel.llm_description ?? customModel.llm_codename,
            previous_model: tomoriState.llm?.llm_codename ?? localizer(locale, "general.unknown"),
            provider: getProviderDisplayName(selectedProvider),
          },
          color: ColorCode.SUCCESS,
        }),
      );
      return;
    }

    // Regular provider: model picker on the anchor message.
    const availableModels = await llmModelRepo.loadAvailableModelsForProvider(selectedProvider, false, {
      kind: "server",
      ownerId: tomoriState.server_id,
    });
    if (!availableModels?.length) {
      await phase.useButton(opener.button).replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "commands.model.text.no_models_title",
          descriptionKey: "commands.model.text.no_models_description",
          color: ColorCode.ERROR,
        }),
      );
      return;
    }

    // >25 models route through the anchor range selector automatically.
    const modalPhase = await openModelModal(
      phase,
      opener.button,
      locale,
      buildModelSelectOptions(availableModels, userData.language_pref),
      MODAL_CUSTOM_ID,
    );
    if (!modalPhase) return;

    const work = await modalPhase.beginInPlaceWork();
    const selectedModelCodename = modalPhase.values[MODEL_SELECT_ID];
    selectedModel = availableModels.find((model) => model.llm_codename === selectedModelCodename) ?? null;

    if (!selectedModel?.llm_id) {
      const context: ErrorContext = {
        personaId: tomoriState.persona_id,
        serverId: tomoriState.server_id,
        userId: userData.user_id,
        errorType: "CommandExecutionError",
        metadata: {
          command: "model text",
          guildId: interaction.guild?.id ?? interaction.user.id,
          requestedModel: selectedModelCodename,
          availableModels: availableModels.map((m) => m.llm_codename),
        },
      };
      await log.error(
        "Selected model codename not found in available LLMs from DB",
        new Error("Invalid model selection despite modal choices"),
        context,
      );
      await work.message.replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "commands.model.text.invalid_model_title",
          descriptionKey: "commands.model.text.invalid_model_description",
          color: ColorCode.ERROR,
        }),
      );
      return;
    }

    if (selectedModel.llm_codename === "other-model") {
      await work.message.replace(buildOpenRouterMovedNotice(locale));
      return;
    }

    if (selectedModel.llm_id === tomoriState.config.llm_id) {
      await work.message.replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "commands.model.text.already_selected_title",
          descriptionKey: "commands.model.text.already_selected_description",
          descriptionVars: { model_name: selectedModel.llm_codename },
          color: ColorCode.WARN,
        }),
      );
      return;
    }

    const resolvedLogitBiases = resolveLogitBiasEntriesForLlm(
      selectedSavedConfig?.llm_logit_biases ?? tomoriState.config.llm_logit_biases ?? [],
      selectedModel,
    );
    const promotedLlmId = selectedModel.llm_id;
    // The live chain is cross-provider by design, so it is pruned rather than cleared: only
    // the model being promoted has to go, or it would block every later /model fallback edit.
    const { fallbackModelRefs, fallbackLlmIds } = buildFallbackModelPersistence(
      tomoriState.config.fallback_model_refs ?? [],
      promotedLlmId,
    );
    const disabledParams = selectedSavedConfig?.llm_disabled_params ?? [];

    const [updatedModel, updatedChat] = await Promise.all([
      configRepository.updateModelConfig(tomoriState.server_id, {
        llm_id: selectedModel.llm_id,
        api_key: selectedSavedConfig?.api_key ?? null,
        key_version: selectedSavedConfig?.key_version ?? 1,
        thinking_level: selectedSavedConfig?.thinking_level ?? "auto",
        fallback_llm_ids: fallbackLlmIds,
        llm_temperature: selectedSavedConfig?.llm_temperature ?? tomoriState.config.llm_temperature ?? 1.0,
        llm_disabled_params: disabledParams,
        custom_model_name: null,
        custom_endpoint_url: null,
        custom_num_ctx: null,
      }),
      configRepository.updateChatConfig(tomoriState.server_id, {
        llm_top_p: selectedSavedConfig?.llm_top_p ?? tomoriState.config.llm_top_p ?? 0.95,
        llm_top_k: selectedSavedConfig?.llm_top_k ?? tomoriState.config.llm_top_k ?? 0,
        llm_frequency_penalty:
          selectedSavedConfig?.llm_frequency_penalty ?? tomoriState.config.llm_frequency_penalty ?? 0.0,
        llm_presence_penalty:
          selectedSavedConfig?.llm_presence_penalty ?? tomoriState.config.llm_presence_penalty ?? 0.0,
        llm_min_p: selectedSavedConfig?.llm_min_p ?? tomoriState.config.llm_min_p ?? 0.05,
        llm_logit_biases: resolvedLogitBiases.entries,
        fallback_model_refs: fallbackModelRefs,
      }),
    ]);
    // Keep invalidation immediately after the primary split writes. This also
    // protects readers when only one of the non-transactional writes succeeds.
    if (updatedModel || updatedChat) {
      invalidateTomoriStateCache(serverId);
    }

    if (!updatedModel || !updatedChat) {
      const context: ErrorContext = {
        personaId: tomoriState.persona_id,
        serverId: tomoriState.server_id,
        userId: userData.user_id,
        errorType: "DatabaseUpdateError",
        metadata: {
          command: "model text",
          guildId: interaction.guild?.id ?? interaction.user.id,
          selectedModelCodename,
          targetLlmId: selectedModel.llm_id,
          modelConfigUpdated: updatedModel,
          chatConfigUpdated: updatedChat,
        },
      };
      await log.error(
        "Failed to update all LLM configuration tables",
        new Error("One or more database updates returned false"),
        context,
      );
      await work.message.replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "general.errors.update_failed_title",
          descriptionKey: "general.errors.update_failed_description",
          color: ColorCode.ERROR,
        }),
      );
      return;
    }

    const naiDefaultPresets: Record<string, { name: string; target: "kayra" | "erato" }> = {
      "kayra-v1": { name: "Carefree-Kayra", target: "kayra" },
      "llama-3-erato-v1": { name: "Erato-Shosetsu", target: "erato" },
    };
    const defaultPresetEntry = naiDefaultPresets[selectedModel.llm_codename];
    if (defaultPresetEntry) {
      const naiPresets = await configRepository.loadNaiPresets(defaultPresetEntry.target);
      const defaultPreset = naiPresets.find((p) => p.preset_name === defaultPresetEntry.name);
      if (defaultPreset) {
        const presetApplied = await configRepository.applyNaiPreset(
          tomoriState.server_id,
          defaultPreset,
          selectedModel.llm_codename,
          serverId,
        );
        if (!presetApplied) {
          // The preset spans three non-transactional writes. Invalidate again
          // after the failed attempt in case any sub-write committed.
          invalidateTomoriStateCache(serverId);

          const context: ErrorContext = {
            personaId: tomoriState.persona_id,
            serverId: tomoriState.server_id,
            userId: userData.user_id,
            errorType: "DatabaseUpdateError",
            metadata: {
              command: "model text",
              guildId: serverId,
              scope: "global",
              selectedModelCodename,
              targetLlmId: selectedModel.llm_id,
              naiPresetName: defaultPreset.preset_name,
            },
          };
          await log.error(
            "Failed to apply the default NovelAI preset after updating the text model",
            new Error("NovelAI preset update returned false"),
            context,
          );

          await work.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "general.errors.update_failed_title",
              descriptionKey: "general.errors.update_failed_description",
              color: ColorCode.ERROR,
            }),
          );
          return;
        }
      } else {
        log.warn(
          `Default NAI preset "${defaultPresetEntry.name}" not found in DB. Was the seed catalog loaded? Skipping auto-apply.`,
        );
      }
    }

    const previousModel = tomoriState.llm;
    await work.message.replace(
      buildPersonaWorkflowNotice({
        locale,
        titleKey: "commands.model.text.success_title",
        descriptionKey: "commands.model.text.success_description",
        descriptionVars: {
          model_name: selectedModel.llm_codename,
          previous_model: previousModel?.llm_codename ?? localizer(locale, "general.unknown"),
          provider: getProviderDisplayName(selectedProvider),
        },
        color: ColorCode.SUCCESS,
      }),
    );
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: tomoriState.server_id,
      personaId: tomoriState.persona_id,
      errorType: "CommandExecutionError",
      metadata: {
        command: "model text",
        guildId: interaction.guild?.id ?? interaction.user.id,
        executorDiscordId: interaction.user.id,
        targetLlmIdAttempted: selectedModel?.llm_id,
      },
    };
    await log.error(`Error executing /model text for user ${userData.user_disc_id}`, error as Error, context);

    if (personaWorkflowState.message) {
      await personaWorkflowState.message.replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "general.errors.unknown_error_title",
          descriptionKey: "general.errors.unknown_error_description",
          color: ColorCode.ERROR,
        }),
      );
      return;
    }

    // Channel/global scopes render their unexpected-error terminal on the same anchor
    // message. Best-effort: if the message is already gone (fatal), fall back to a reply.
    if (anchorMessage) {
      try {
        await anchorMessage.replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: "general.errors.unknown_error_title",
            descriptionKey: "general.errors.unknown_error_description",
            color: ColorCode.ERROR,
          }),
        );
        return;
      } catch {}
    }

    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
  }
}
