import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { MessageFlags, TextInputStyle } from "discord.js";
import type { TomoriState, UserRow } from "@/types/db/schema";
import { log, ColorCode } from "@/utils/misc/logger";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import {
  buildPersonaWorkflowNotice,
  completePersonaWorkflow,
  retryPersonaWorkflow,
  runPersonaPickerWorkflow,
  type PersonaWorkflowMessageController,
} from "@/utils/discord/ui/personaWorkflow";
import { getCachedTomoriState, invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { personaRepository } from "@/utils/db/repositories";
import { localizer } from "@/utils/text/localizer";
import { combineModalPromptParts, splitPromptIntoModalParts } from "@/utils/text/modalPromptParts";
import { resolvePrefillPrompt } from "@/utils/text/personaPrompt";

const MODAL_CUSTOM_ID = "teach_personaprompt_modal";
const PERSONA_PROMPT_INPUT_IDS = [
  "persona_prompt_part1",
  "persona_prompt_part2",
  "persona_prompt_part3",
  "persona_prompt_part4",
] as const;
const PERSONA_PROMPT_PART_MAX_LENGTH = 4000;
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("set").setDescription(localizer("en-US", "commands.persona.prompt.set.description"));

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
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

  if (interaction.guild) {
    const hasPermission = interaction.memberPermissions?.has("ManageGuild") ?? false;
    if (!hasPermission) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.teach.personaprompt.no_permission_title",
        descriptionKey: "commands.teach.personaprompt.no_permission_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  let tomoriState: TomoriState | null = null;
  const workflowState: { message: PersonaWorkflowMessageController | null } = { message: null };
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const serverDiscId = interaction.guild?.id ?? interaction.user.id;
    tomoriState = await getCachedTomoriState(serverDiscId);
    if (!tomoriState) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const allPersonas = await personaRepository.loadAllForServer(serverDiscId);
    if (allPersonas.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.unknown_error_title",
        descriptionKey: "general.errors.unknown_error_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await runPersonaPickerWorkflow(interaction, locale, {
      personas: allPersonas,
      color: ColorCode.INFO,
      async onSelected(selection) {
        workflowState.message = selection.message;
        const selectedPersona = selection.persona;

        if (!selectedPersona.persona_id) {
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

        const existingPromptParts = splitPromptIntoModalParts(
          resolvePrefillPrompt(selectedPersona),
          PERSONA_PROMPT_INPUT_IDS.length,
          PERSONA_PROMPT_PART_MAX_LENGTH,
        );

        const modalResult = await selection.openModal({
          modalCustomId: MODAL_CUSTOM_ID,
          modalTitleKey: "commands.teach.personaprompt.modal_title",
          components: [
            {
              customId: PERSONA_PROMPT_INPUT_IDS[0],
              labelKey: "commands.teach.personaprompt.part1_label",
              descriptionKey: "commands.teach.personaprompt.part1_description",
              placeholder: "commands.teach.personaprompt.part1_placeholder",
              style: TextInputStyle.Paragraph,
              required: false,
              maxLength: PERSONA_PROMPT_PART_MAX_LENGTH,
              value: existingPromptParts[0] || undefined,
            },
            {
              customId: PERSONA_PROMPT_INPUT_IDS[1],
              labelKey: "commands.teach.personaprompt.part2_label",
              placeholder: "commands.teach.personaprompt.part2_placeholder",
              style: TextInputStyle.Paragraph,
              required: false,
              maxLength: PERSONA_PROMPT_PART_MAX_LENGTH,
              value: existingPromptParts[1] || undefined,
            },
            {
              customId: PERSONA_PROMPT_INPUT_IDS[2],
              labelKey: "commands.teach.personaprompt.part3_label",
              placeholder: "commands.teach.personaprompt.part3_placeholder",
              style: TextInputStyle.Paragraph,
              required: false,
              maxLength: PERSONA_PROMPT_PART_MAX_LENGTH,
              value: existingPromptParts[2] || undefined,
            },
            {
              customId: PERSONA_PROMPT_INPUT_IDS[3],
              labelKey: "commands.teach.personaprompt.part4_label",
              placeholder: "commands.teach.personaprompt.part4_placeholder",
              style: TextInputStyle.Paragraph,
              required: false,
              maxLength: PERSONA_PROMPT_PART_MAX_LENGTH,
              value: existingPromptParts[3] || undefined,
            },
          ],
        });

        if (modalResult.outcome !== "submitted") {
          log.info(`Teach personaprompt modal ${modalResult.outcome} for user ${interaction.user.id}`);
          return modalResult.outcome === "fatal" ? completePersonaWorkflow() : retryPersonaWorkflow();
        }

        const work = await modalResult.phase.beginInPlaceWork();
        const personaPrompt = combineModalPromptParts(
          PERSONA_PROMPT_INPUT_IDS.map((inputId) => modalResult.phase.values[inputId] || ""),
          PERSONA_PROMPT_PART_MAX_LENGTH,
        );
        const ok = await personaRepository.setPrompt(selectedPersona.persona_id, personaPrompt || "");
        if (!ok) {
          await work.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "general.errors.update_failed_title",
              descriptionKey: "general.errors.update_failed_description",
              footerKey: "general.pagination.reloading_persona_picker",
              color: ColorCode.ERROR,
            }),
          );
          return retryPersonaWorkflow();
        }

        selectedPersona.persona_prompt = personaPrompt || null;
        invalidateTomoriStateCache(serverDiscId);
        await work.message.replace(
          buildPersonaWorkflowNotice({
            locale,
            titleKey: personaPrompt
              ? "commands.teach.personaprompt.success_title"
              : "commands.forget.personaprompt.success_title",
            descriptionKey: personaPrompt
              ? "commands.teach.personaprompt.success_description"
              : "commands.forget.personaprompt.success_description",
            descriptionVars: { persona_name: selectedPersona.persona_nickname },
            footerKey: "general.pagination.reloading_persona_picker",
            color: ColorCode.SUCCESS,
          }),
        );
        return retryPersonaWorkflow();
      },
    });
  } catch (error) {
    await log.error("Error in /teach personaprompt command", error, {
      serverId: tomoriState?.server_id,
      personaId: tomoriState?.persona_id,
      errorType: "CommandExecutionError",
      metadata: {
        command: "teach personaprompt",
        guildId: interaction.guild?.id,
        userId: interaction.user.id,
      },
    });

    if (workflowState.message) {
      await workflowState.message.replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: "general.errors.unknown_error_title",
          descriptionKey: "general.errors.unknown_error_description",
          color: ColorCode.ERROR,
        }),
      );
    } else {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.unknown_error_title",
        descriptionKey: "general.errors.unknown_error_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
    }
  }
}
