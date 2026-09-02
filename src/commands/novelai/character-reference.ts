import {
  MessageFlags,
  type Attachment,
  type ChatInputCommandInteraction,
  type Client,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import { invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { personaRepository, userRepository } from "@/utils/db/repositories";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import {
  buildPersonaWorkflowNotice,
  completePersonaWorkflow,
  PersonaWorkflowUpdateError,
  runPersonaPickerWorkflow,
  type PersonaWorkflowMessageController,
} from "@/utils/discord/ui/personaWorkflow";
import { ColorCode, log } from "@/utils/misc/logger";
import { prepareAttachmentForStorage, replaceStoredCharReference } from "@/utils/storage/charRefOperations";
import { localizer } from "@/utils/text/localizer";
import type { TomoriState, UserRow } from "@/types/db/schema";

const TARGET_ME = "me";
const TARGET_PERSONA = "persona";

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("character-reference")
    .setDescription(localizer("en-US", "commands.novelai.character-reference.description"))
    .addStringOption((option) =>
      option
        .setName("target")
        .setDescription(localizer("en-US", "commands.novelai.character-reference.target_description"))
        .addChoices({ name: "Me", value: TARGET_ME }, { name: "Persona", value: TARGET_PERSONA })
        .setRequired(true),
    )
    .addAttachmentOption((option) =>
      option
        .setName("image")
        .setDescription(localizer("en-US", "commands.novelai.character-reference.image_description"))
        .setRequired(false),
    );

async function handleUserTarget(
  interaction: ChatInputCommandInteraction,
  locale: string,
  userData: UserRow,
  imageAttachment: Attachment | null,
): Promise<void> {
  const userId = userData.user_id;
  if (userId === undefined) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.update_failed_title",
      descriptionKey: "general.errors.update_failed_description",
      color: ColorCode.ERROR,
    });
    return;
  }

  let pngBuffer: Buffer | null = null;

  if (imageAttachment) {
    const prepared = await prepareAttachmentForStorage(imageAttachment);
    if (!prepared.success) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: prepared.titleKey,
        descriptionKey: prepared.descriptionKey,
        color: ColorCode.ERROR,
      });
      return;
    }

    pngBuffer = prepared.buffer;
  }

  const previousRef = userData.nai_char_ref_url ?? null;
  const updated = await replaceStoredCharReference({
    entityType: "users",
    entityId: userData.user_disc_id,
    previousRef,
    nextBuffer: pngBuffer,
    persistNextRef: async (nextRef) => {
      const updatedUser = await userRepository.update(userId, { nai_char_ref_url: nextRef });
      return updatedUser !== null;
    },
    onPersistSuccess: () => undefined,
  });

  if (!updated) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.update_failed_title",
      descriptionKey: "general.errors.update_failed_description",
      color: ColorCode.ERROR,
    });
    return;
  }

  await replyInfoEmbed(interaction, locale, {
    titleKey: imageAttachment
      ? "commands.novelai.character-reference.success_title"
      : "commands.novelai.character-reference.cleared_title",
    descriptionKey: imageAttachment
      ? "commands.novelai.character-reference.success_me_description"
      : "commands.novelai.character-reference.cleared_me_description",
    color: ColorCode.SUCCESS,
  });
}

async function handlePersonaTarget(
  message: PersonaWorkflowMessageController,
  locale: string,
  guildId: string,
  selectedPersona: TomoriState,
  imageAttachment: Attachment | null,
): Promise<void> {
  const personaId = selectedPersona.persona_id;
  if (!personaId) {
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

  let pngBuffer: Buffer | null = null;

  if (imageAttachment) {
    const prepared = await prepareAttachmentForStorage(imageAttachment);
    if (!prepared.success) {
      await message.replace(
        buildPersonaWorkflowNotice({
          locale,
          titleKey: prepared.titleKey,
          descriptionKey: prepared.descriptionKey,
          color: ColorCode.ERROR,
        }),
      );
      return;
    }

    pngBuffer = prepared.buffer;
  }

  const previousRef = selectedPersona.nai_char_ref_url ?? null;
  const updated = await replaceStoredCharReference({
    entityType: "personas",
    entityId: personaId,
    previousRef,
    nextBuffer: pngBuffer,
    persistNextRef: async (nextRef) => {
      return personaRepository.setNaiCharRef(personaId, nextRef);
    },
    onPersistSuccess: () => {
      invalidateTomoriStateCache(guildId);
    },
  });

  if (!updated) {
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

  await message.replace(
    buildPersonaWorkflowNotice({
      locale,
      titleKey: imageAttachment
        ? "commands.novelai.character-reference.success_title"
        : "commands.novelai.character-reference.cleared_title",
      descriptionKey: imageAttachment
        ? "commands.novelai.character-reference.success_persona_description"
        : "commands.novelai.character-reference.cleared_persona_description",
      descriptionVars: {
        persona_name: selectedPersona.persona_nickname,
      },
      color: ColorCode.SUCCESS,
    }),
  );
}

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  const target = interaction.options.getString("target", true);
  const imageAttachment = interaction.options.getAttachment("image");
  let personaWorkflowStarted = false;

  try {
    if (target === TARGET_ME) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await handleUserTarget(interaction, locale, userData, imageAttachment);
      return;
    }

    if (target !== TARGET_PERSONA) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.invalid_option_title",
        descriptionKey: "general.errors.invalid_option_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    if (!interaction.guild) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.guild_only_title",
        descriptionKey: "general.errors.guild_only_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    if (!interaction.memberPermissions?.has("ManageGuild")) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.permission_denied_title",
        descriptionKey: "general.errors.permission_denied_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const guildId = interaction.guild.id;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const allPersonas = await personaRepository.loadAllForServer(guildId);
    if (allPersonas.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    personaWorkflowStarted = true;
    await runPersonaPickerWorkflow(interaction, locale, {
      personas: allPersonas,
      titleKey: "commands.novelai.character-reference.persona_select_title",
      color: ColorCode.INFO,
      onSelected: async (selection) => {
        const { message } = await selection.beginInPlaceWork();
        const selectedPersona = selection.persona;

        try {
          if (!selectedPersona.persona_id) {
            await message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "general.errors.invalid_option_title",
                descriptionKey: "general.errors.invalid_option_description",
                color: ColorCode.ERROR,
              }),
            );
            return completePersonaWorkflow();
          }

          await message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "general.persona_workflow.loading_title",
              descriptionKey: "general.persona_workflow.loading_description",
              color: ColorCode.INFO,
            }),
          );
          await handlePersonaTarget(message, locale, guildId, selectedPersona, imageAttachment);
        } catch (error) {
          if (error instanceof PersonaWorkflowUpdateError) throw error;
          await log.error("Error in /novelai character-reference persona workflow", error, {
            serverId: selectedPersona.server_id,
            personaId: selectedPersona.persona_id,
            errorType: "CommandExecutionError",
            metadata: {
              command: "novelai character-reference",
              target,
              guildId: interaction.guild?.id ?? null,
              userDiscId: userData.user_disc_id,
            },
          });
          await message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "general.errors.unknown_error_title",
              descriptionKey: "general.errors.unknown_error_description",
              color: ColorCode.ERROR,
            }),
          );
        }

        return completePersonaWorkflow();
      },
    });
  } catch (error) {
    await log.error("Error in /novelai character-reference command", error, {
      errorType: "CommandExecutionError",
      metadata: {
        command: "novelai character-reference",
        target,
        guildId: interaction.guild?.id ?? null,
        userDiscId: userData.user_disc_id,
      },
    });

    if (personaWorkflowStarted) return;
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
    });
  }
}
