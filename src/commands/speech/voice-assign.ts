import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import type { ErrorContext, TomoriState, UserRow } from "@/types/db/schema";
import type { SelectOption } from "@/types/discord/modal";
import { ELEVENLABS_SERVICE_NAME } from "@/utils/audio/elevenLabsAccount";
import { type ElevenLabsVoiceCatalogEntry, fetchElevenLabsVoiceCatalog } from "@/utils/audio/elevenLabsVoiceCatalog";
import { invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { personaRepository } from "@/utils/db/repositories";
import { loadVoiceSamples } from "@/utils/db/repositories/SpeechRepository";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import { ensureSpeechCommandAccess } from "@/utils/discord/speechPermission";
import {
  buildPersonaWorkflowNotice,
  completePersonaWorkflow,
  retryPersonaWorkflow,
  runPersonaPickerWorkflow,
  type PersonaWorkflowMessageController,
} from "@/utils/discord/ui/personaWorkflow";
import { ColorCode, log } from "@/utils/misc/logger";
import { resolveActiveSpeechEndpoint } from "@/utils/provider/speechEndpointResolver";
import { getOptApiKey } from "@/utils/security/crypto";
import { localizer } from "@/utils/text/localizer";

const ELEVENLABS_MODAL_ID = "voice_assign_elevenlabs_modal";
const CLONE_MODAL_ID = "voice_assign_clone_modal";
const VOICE_SELECT_ID = "voice_select";
const SAMPLE_SELECT_ID = "sample_select";
const CLEAR_VOICE_VALUE = "__clear__";

type WorkflowState = {
  selectedPersona: TomoriState | null;
  message: PersonaWorkflowMessageController | null;
};

function buildVoiceDescription(voice: ElevenLabsVoiceCatalogEntry, locale: string): string {
  const parts = [voice.category, voice.labels.gender, voice.labels.age, voice.labels.accent]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  if (parts.length > 0) return safeSelectOptionText(parts.join(" | "));
  if (voice.description) return safeSelectOptionText(voice.description);
  return safeSelectOptionText(localizer(locale, "commands.config.voice.elevenlabs.voice_available_description"));
}

function buildVoiceOptions(voices: ElevenLabsVoiceCatalogEntry[], locale: string): SelectOption[] {
  return [
    {
      label: safeSelectOptionText(localizer(locale, "commands.speech.voice_assign.clear_choice_label")),
      value: CLEAR_VOICE_VALUE,
      description: safeSelectOptionText(localizer(locale, "commands.speech.voice_assign.clear_choice_description")),
    },
    ...voices.map((voice) => ({
      label: safeSelectOptionText(voice.name),
      value: voice.voiceId,
      description: buildVoiceDescription(voice, locale),
    })),
  ];
}

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("voice-assign").setDescription(localizer("en-US", "commands.speech.voice_assign.description"));

/** Assigns a TTS clone sample or ElevenLabs voice to a selected persona. */
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
  const workflowState: WorkflowState = { selectedPersona: null, message: null };

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
    const allPersonas = await personaRepository.loadAllForServer(serverDiscId);
    if (allPersonas.length === 0 || !allPersonas[0]?.server_id) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const serverId = allPersonas[0].server_id;
    const speechEndpoint = await resolveActiveSpeechEndpoint(serverId);
    const apiStyle = speechEndpoint?.endpoint.api_style ?? null;
    const legacyElevenLabsKey = await getOptApiKey(serverId, ELEVENLABS_SERVICE_NAME);
    const elevenLabsApiKey = apiStyle === "elevenlabs" ? speechEndpoint?.apiKey || legacyElevenLabsKey : null;
    const effectiveStyle = apiStyle ?? (legacyElevenLabsKey !== null ? "elevenlabs" : null);

    if (!effectiveStyle) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.speech.voice_assign.no_speech_endpoint_title",
        descriptionKey: "commands.speech.voice_assign.no_speech_endpoint_description",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (effectiveStyle === "tts-clone") {
      const sampleRows = await loadVoiceSamples(serverId);
      if (sampleRows.length === 0) {
        await replyInfoEmbed(interaction, locale, {
          titleKey: "commands.speech.voice_assign.no_sample_title",
          descriptionKey: "commands.speech.voice_assign.no_sample_description",
          color: ColorCode.WARN,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const sampleOptions: SelectOption[] = [
        {
          label: safeSelectOptionText(localizer(locale, "commands.speech.voice_assign.clear_choice_label")),
          value: CLEAR_VOICE_VALUE,
          description: safeSelectOptionText(localizer(locale, "commands.speech.voice_assign.clear_choice_description")),
        },
        ...sampleRows.map((sample) => {
          const durationLabel =
            sample.duration_ms > 0 ? `${Math.floor(sample.duration_ms / 1000)}s` : localizer(locale, "general.unknown");
          const hintKey = sample.ref_text
            ? "commands.speech.voice_assign.sample_ref_hint_with"
            : "commands.speech.voice_assign.sample_ref_hint_without";
          return {
            label: safeSelectOptionText(sample.name),
            value: String(sample.sample_id),
            description: safeSelectOptionText(localizer(locale, hintKey, { duration: durationLabel })),
          };
        }),
      ];

      await runPersonaPickerWorkflow(interaction, locale, {
        personas: allPersonas,
        color: ColorCode.INFO,
        titleKey: "commands.speech.voice_assign.select_persona_title",
        onSelected: async (selection) => {
          workflowState.selectedPersona = selection.persona;
          workflowState.message = selection.message;
          const personaId = selection.persona.persona_id;
          if (!personaId) {
            const work = await selection.beginInPlaceWork();
            await work.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "general.errors.invalid_option_title",
                descriptionKey: "general.errors.invalid_option_description",
                footerKey: "general.pagination.reloading_persona_picker",
                color: ColorCode.ERROR,
              }),
            );
            return retryPersonaWorkflow();
          }

          const modalResult = await selection.openModal({
            modalCustomId: CLONE_MODAL_ID,
            modalTitleKey: "commands.speech.voice_assign.assign_clone_title",
            components: [
              {
                customId: SAMPLE_SELECT_ID,
                labelKey: "commands.speech.voice_assign.assign_clone_title",
                placeholder: "commands.speech.voice_assign.assign_clone_title",
                required: true,
                options: sampleOptions,
              },
            ],
          });
          if (modalResult.outcome !== "submitted") {
            return modalResult.outcome === "fatal" ? completePersonaWorkflow() : retryPersonaWorkflow();
          }

          const work = await modalResult.phase.beginInPlaceWork();
          const chosenValue = modalResult.phase.values[SAMPLE_SELECT_ID];
          const isClear = chosenValue === CLEAR_VOICE_VALUE;
          const chosenSample = isClear
            ? null
            : (sampleRows.find((sample) => String(sample.sample_id) === chosenValue) ?? null);
          if (!isClear && !chosenSample) {
            await work.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "general.errors.invalid_option_title",
                descriptionKey: "general.errors.invalid_option_description",
                footerKey: "general.pagination.reloading_persona_picker",
                color: ColorCode.ERROR,
              }),
            );
            return retryPersonaWorkflow();
          }

          const voiceDesignName = selection.persona.speech_voice_design_prompt?.trim() ? "VoiceDesign" : null;
          const updatedTomori = await personaRepository.setVoiceConfig(personaId, {
            speech_voice_sample_id: chosenSample?.sample_id ?? null,
            speech_voice_id: isClear ? (selection.persona.speech_voice_id ?? null) : null,
            speech_voice_name: isClear ? voiceDesignName : (chosenSample?.name ?? null),
            speech_voice_design_prompt: selection.persona.speech_voice_design_prompt ?? null,
          });
          if (!updatedTomori) {
            await work.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "general.errors.update_failed_title",
                descriptionKey: "general.errors.update_failed_description",
                color: ColorCode.ERROR,
              }),
            );
            return completePersonaWorkflow();
          }

          invalidateTomoriStateCache(serverDiscId);
          await work.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: isClear
                ? "commands.speech.voice_assign.cleared_title"
                : "commands.speech.voice_assign.success_title",
              descriptionKey: isClear
                ? "commands.speech.voice_assign.cleared_description"
                : "commands.speech.voice_assign.success_description",
              descriptionVars: isClear
                ? { persona: selection.persona.persona_nickname }
                : { persona: selection.persona.persona_nickname, voice: chosenSample?.name ?? "" },
              footerKey: "general.pagination.reloading_persona_picker",
              color: ColorCode.SUCCESS,
            }),
          );
          const refreshedPersonas = await personaRepository.loadAllForServer(serverDiscId);
          return retryPersonaWorkflow(refreshedPersonas);
        },
      });
      return;
    }

    const activeElevenLabsKey = elevenLabsApiKey ?? legacyElevenLabsKey;
    if (!activeElevenLabsKey) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.config.voice.elevenlabs.no_key_title",
        descriptionKey: "commands.config.voice.elevenlabs.no_key_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const voiceCatalogResult = await fetchElevenLabsVoiceCatalog(activeElevenLabsKey);
    if (!voiceCatalogResult.success || !voiceCatalogResult.voices?.length) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.speech.voice_assign.elevenlabs_voice_fetch_failed_title",
        descriptionKey: "commands.speech.voice_assign.elevenlabs_voice_fetch_failed_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const availableVoices = voiceCatalogResult.voices;
    await runPersonaPickerWorkflow(interaction, locale, {
      personas: allPersonas,
      color: ColorCode.INFO,
      titleKey: "commands.speech.voice_assign.select_persona_title",
      onSelected: async (selection) => {
        workflowState.selectedPersona = selection.persona;
        workflowState.message = selection.message;
        const personaId = selection.persona.persona_id;
        if (!personaId) {
          const work = await selection.beginInPlaceWork();
          await work.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "general.errors.invalid_option_title",
              descriptionKey: "general.errors.invalid_option_description",
              footerKey: "general.pagination.reloading_persona_picker",
              color: ColorCode.ERROR,
            }),
          );
          return retryPersonaWorkflow();
        }

        const modalResult = await selection.openModal({
          modalCustomId: ELEVENLABS_MODAL_ID,
          modalTitleKey: "commands.speech.voice_assign.elevenlabs_modal_title",
          components: [
            {
              customId: VOICE_SELECT_ID,
              labelKey: "commands.config.voice.elevenlabs.select_label",
              descriptionKey: "commands.config.voice.elevenlabs.select_description",
              placeholder: "commands.config.voice.elevenlabs.select_placeholder",
              required: true,
              options: buildVoiceOptions(availableVoices, locale),
            },
          ],
        });
        if (modalResult.outcome !== "submitted") {
          return modalResult.outcome === "fatal" ? completePersonaWorkflow() : retryPersonaWorkflow();
        }

        const work = await modalResult.phase.beginInPlaceWork();
        const selectedVoiceId = modalResult.phase.values[VOICE_SELECT_ID];
        const isClear = selectedVoiceId === CLEAR_VOICE_VALUE;
        const chosenVoice = isClear
          ? null
          : (availableVoices.find((voice) => voice.voiceId === selectedVoiceId) ?? null);
        if (!selectedVoiceId || (!isClear && !chosenVoice)) {
          await work.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "general.errors.invalid_option_title",
              descriptionKey: "general.errors.invalid_option_description",
              footerKey: "general.pagination.reloading_persona_picker",
              color: ColorCode.ERROR,
            }),
          );
          return retryPersonaWorkflow();
        }

        const updatedTomori = await personaRepository.setVoiceConfig(personaId, {
          speech_voice_id: chosenVoice?.voiceId ?? null,
          speech_voice_name:
            chosenVoice?.name ?? (selection.persona.speech_voice_design_prompt?.trim() ? "VoiceDesign" : null),
          speech_voice_sample_id: null,
          speech_voice_design_prompt: selection.persona.speech_voice_design_prompt ?? null,
        });
        if (!updatedTomori) {
          await work.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "general.errors.update_failed_title",
              descriptionKey: "general.errors.update_failed_description",
              color: ColorCode.ERROR,
            }),
          );
          return completePersonaWorkflow();
        }

        invalidateTomoriStateCache(serverDiscId);
        await work.message.replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: isClear
              ? "commands.speech.voice_assign.cleared_title"
              : "commands.speech.voice_assign.success_title",
            descriptionKey: isClear
              ? "commands.speech.voice_assign.cleared_description"
              : "commands.speech.voice_assign.success_description",
            descriptionVars: isClear
              ? { persona: selection.persona.persona_nickname }
              : { persona: selection.persona.persona_nickname, voice: chosenVoice?.name ?? "" },
            footerKey: "general.pagination.reloading_persona_picker",
            color: ColorCode.SUCCESS,
          }),
        );
        const refreshedPersonas = await personaRepository.loadAllForServer(serverDiscId);
        return retryPersonaWorkflow(refreshedPersonas);
      },
    });
  } catch (error) {
    const selectedPersona = workflowState.selectedPersona;
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: selectedPersona?.server_id ?? null,
      personaId: selectedPersona?.persona_id ?? null,
      errorType: "CommandExecutionError",
      metadata: {
        command: "speech voice-assign",
        guildId: serverDiscId,
        executorDiscordId: interaction.user.id,
        selectedPersonaId: selectedPersona?.persona_id ?? null,
      },
    };
    await log.error("Error executing /speech voice-assign", error as Error, context);
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
