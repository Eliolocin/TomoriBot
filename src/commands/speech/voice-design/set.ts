import {
  MessageFlags,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type Client,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import { getCachedTomoriState, invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { personaRepository } from "@/utils/db/repositories";

import { ensureSpeechCommandAccess } from "@/utils/discord/speechPermission";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import {
  buildPersonaWorkflowNotice,
  completePersonaWorkflow,
  runPersonaPickerWorkflow,
  type PersonaWorkflowMessageController,
} from "@/utils/discord/ui/personaWorkflow";
import { log, ColorCode } from "@/utils/misc/logger";
import { resolveActiveSpeechEndpoint } from "@/utils/provider/speechEndpointResolver";
import type { ErrorContext, TomoriState, UserRow } from "@/types/db/schema";
import { localizer } from "@/utils/text/localizer";
import {
  buildTextPreview,
  CONFIRMATION_PREVIEW_BUDGET,
  textPreviewFooterKey,
  textPreviewFooterVars,
} from "@/utils/text/textPreview";

const PROMPT_MODAL_ID = "speech_voice_design_prompt_modal";
const PROMPT_FIELD_ID = "voice_design_prompt";
const MAX_VOICE_DESIGN_PROMPT_LENGTH = 1000;

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("set")
    .setDescription(localizer("en-US", "commands.speech.voice-design.set.description"))
    .addStringOption((option) =>
      option
        .setName("prompt")
        .setDescription(localizer("en-US", "commands.speech.voice_design.prompt_description"))
        .setRequired(false)
        .setMaxLength(MAX_VOICE_DESIGN_PROMPT_LENGTH),
    );

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!(await ensureSpeechCommandAccess(interaction, locale))) {
    return;
  }

  const serverDiscId = interaction.guild?.id ?? interaction.user.id;
  const workflowState: { message: PersonaWorkflowMessageController | null } = { message: null };

  if (!interaction.channel) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.channel_only_title",
      descriptionKey: "general.errors.channel_only_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const tomoriState = await getCachedTomoriState(serverDiscId);
    if (!tomoriState) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const speechEndpoint = await resolveActiveSpeechEndpoint(tomoriState.server_id);
    const supportsVoiceDesign =
      speechEndpoint?.endpoint.api_style === "tts-clone" &&
      speechEndpoint.endpoint.extra_config.supports_instruct === true;

    if (!supportsVoiceDesign) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.speech.voice_design.unsupported_endpoint_title",
        descriptionKey: "commands.speech.voice_design.unsupported_endpoint_description",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const allPersonas = await personaRepository.loadAllForServer(serverDiscId);
    if (allPersonas.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const inlinePrompt = interaction.options.getString("prompt")?.trim() ?? "";

    await runPersonaPickerWorkflow(interaction, locale, {
      personas: allPersonas,
      color: ColorCode.INFO,
      titleKey: "commands.speech.voice_design.select_persona_title",
      async onSelected(selection) {
        workflowState.message = selection.message;
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
          let designPrompt = inlinePrompt;
          let message: PersonaWorkflowMessageController;
          if (!designPrompt) {
            const existingPrompt = selectedPersona.speech_voice_design_prompt?.trim() ?? "";
            const modalResult = await selection.openModal({
              modalCustomId: PROMPT_MODAL_ID,
              modalTitleKey: existingPrompt
                ? "commands.speech.voice_design.update_modal_title"
                : "commands.speech.voice_design.modal_title",
              components: [
                {
                  customId: PROMPT_FIELD_ID,
                  labelKey: "commands.speech.voice_design.prompt_label",
                  descriptionKey: "commands.speech.voice_design.prompt_help",
                  placeholder: "commands.speech.voice_design.prompt_placeholder",
                  style: TextInputStyle.Paragraph,
                  required: true,
                  minLength: 10,
                  maxLength: MAX_VOICE_DESIGN_PROMPT_LENGTH,
                  value: existingPrompt.slice(0, MAX_VOICE_DESIGN_PROMPT_LENGTH),
                },
              ],
            });
            if (modalResult.outcome !== "submitted") {
              return completePersonaWorkflow();
            }

            const work = await modalResult.phase.beginInPlaceWork();
            message = work.message;
            designPrompt = modalResult.phase.values[PROMPT_FIELD_ID]?.trim() ?? "";
          } else {
            const work = await selection.beginInPlaceWork();
            message = work.message;
          }

          if (!designPrompt) {
            await message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "general.errors.invalid_option_title",
                descriptionKey: "commands.speech.voice_design.prompt_required_description",
                color: ColorCode.ERROR,
              }),
            );
            return completePersonaWorkflow();
          }

          await saveVoiceDesignPrompt(message, locale, serverDiscId, selectedPersona, designPrompt);
          return completePersonaWorkflow();
        } catch (error) {
          const context: ErrorContext = {
            userId: userData.user_id,
            serverId: selectedPersona.server_id,
            personaId,
            errorType: "CommandExecutionError",
            metadata: {
              command: "speech voice-design set",
              guildId: serverDiscId,
              executorDiscordId: interaction.user.id,
            },
          };
          await log.error("Error executing /speech voice-design set", error as Error, context);
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
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: null,
      personaId: null,
      errorType: "CommandExecutionError",
      metadata: {
        command: "speech voice-design set",
        guildId: interaction.guild?.id ?? interaction.user.id,
        executorDiscordId: interaction.user.id,
      },
    };
    await log.error("Error executing /speech voice-design set", error as Error, context);
    if (workflowState.message) {
      await workflowState.message.replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "general.errors.unknown_error_title",
          descriptionKey: "general.errors.unknown_error_description",
          color: ColorCode.ERROR,
        }),
      );
      return;
    }
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function saveVoiceDesignPrompt(
  message: PersonaWorkflowMessageController,
  locale: string,
  serverDiscId: string,
  selectedPersona: TomoriState,
  designPrompt: string,
): Promise<void> {
  if (!selectedPersona.persona_id) {
    await message.replace(
      buildPersonaWorkflowNotice({
        locale,
        titleKey: "general.errors.invalid_option_title",
        descriptionKey: "general.errors.invalid_option_description",
        color: ColorCode.ERROR,
      }),
    );
    return;
  }

  // Keep clone/provider voice assignments as reusable persona data. In auto
  // endpoint mode, speech_voice_name marks VoiceDesign as the active voice
  // choice while preserving any saved sample/provider voice for later.
  const updatedTomori = await personaRepository.setVoiceConfig(selectedPersona.persona_id, {
    speech_voice_sample_id: selectedPersona.speech_voice_sample_id ?? null,
    speech_voice_id: selectedPersona.speech_voice_id ?? null,
    speech_voice_design_prompt: designPrompt,
    speech_voice_name: "VoiceDesign",
  });

  if (!updatedTomori) {
    await message.replace(
      buildPersonaWorkflowNotice({
        locale,
        titleKey: "general.errors.update_failed_title",
        descriptionKey: "general.errors.update_failed_description",
        color: ColorCode.ERROR,
      }),
    );
    return;
  }

  invalidateTomoriStateCache(serverDiscId);
  // Rendered as a fenced block rather than a blockquote: a newline terminates a
  // Discord blockquote, so multi-line design prompts used to spill out of it.
  const preview = buildTextPreview(designPrompt, CONFIRMATION_PREVIEW_BUDGET);
  await message.replace(
    buildPersonaWorkflowNotice({
      locale,
      titleKey: "commands.speech.voice_design.success_title",
      descriptionKey: "commands.speech.voice_design.success_description",
      descriptionVars: {
        persona: selectedPersona.persona_nickname,
        preview: preview.text,
      },
      footerKey: textPreviewFooterKey(preview),
      footerVars: textPreviewFooterVars(preview),
      color: ColorCode.SUCCESS,
    }),
  );
}
