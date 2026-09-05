import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import { log, ColorCode } from "@/utils/misc/logger";
import { safeReply } from "@/utils/discord/safeReply";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { ensureSpeechCommandAccess } from "@/utils/discord/speechPermission";
import { promptWithPaginatedModal, safeSelectOptionText } from "@/utils/discord/ui/modals";
import { createStandardEmbed } from "@/utils/discord/embedHelper";
import { deleteStoredVoiceSample } from "@/utils/storage/voiceSampleStorage";
import {
  clearPersonaVoiceSampleRefs,
  deleteVoiceSample,
  loadVoiceSamples,
  countPersonaVoiceSampleRefs,
} from "@/utils/db/repositories/SpeechRepository";
import { serverRepository } from "@/utils/db/repositories/ServerRepository";
import type { ErrorContext, UserRow } from "@/types/db/schema";
import type { SelectOption } from "@/types/discord/modal";
import { localizer } from "@/utils/text/localizer";

const CONFIRM_BTN_ID = "voice_remove_confirm";
const CANCEL_BTN_ID = "voice_remove_cancel";
const MODAL_CUSTOM_ID = "voice_remove_modal";
const SAMPLE_SELECT_ID = "sample_select";
const INTERACTION_TIMEOUT_MS = 30_000;

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("voice-remove").setDescription(localizer("en-US", "commands.speech.voice_remove.description"));

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!(await ensureSpeechCommandAccess(interaction, locale))) {
    return;
  }

  if (!interaction.channel) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.channel_only_title",
      descriptionKey: "general.errors.channel_only_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const serverId = await serverRepository.loadServerIdByDiscId(interaction.guild?.id ?? interaction.user.id);
  if (!serverId) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.tomori_not_setup_title",
      descriptionKey: "general.errors.tomori_not_setup_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    const sampleRows = await loadVoiceSamples(serverId);

    if (!sampleRows.length) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.speech.voice_remove.no_sample_title",
        descriptionKey: "commands.speech.voice_remove.no_sample_description",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Row indexes keep select values bounded even when user-provided sample names
    // approach Discord's component limits.
    const sampleSelectOptions: SelectOption[] = sampleRows.map((s, index) => ({
      label: safeSelectOptionText(s.name),
      value: index.toString(),
    }));

    // Show modal with string select; must be called before any defer/reply.
    const modalResult = await promptWithPaginatedModal(interaction, locale, {
      modalCustomId: MODAL_CUSTOM_ID,
      modalTitleKey: "commands.speech.voice_remove.modal_title",
      components: [
        {
          customId: SAMPLE_SELECT_ID,
          labelKey: "commands.speech.voice_remove.select_label",
          placeholder: "commands.speech.voice_remove.select_placeholder",
          required: true,
          options: sampleSelectOptions,
        },
      ],
    });

    if (modalResult.outcome !== "submit") {
      log.info(`Voice remove modal ${modalResult.outcome} for user ${interaction.user.id}`);
      return;
    }

    // biome-ignore lint/style/noNonNullAssertion: "submit" outcome guarantees these exist
    const modalSubmitInteraction = modalResult.interaction!;
    if (!modalSubmitInteraction.deferred && !modalSubmitInteraction.replied) {
      await modalSubmitInteraction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    // biome-ignore lint/style/noNonNullAssertion: "submit" outcome guarantees these exist
    const selectedIndex = Number.parseInt(modalResult.values![SAMPLE_SELECT_ID], 10);
    const sampleRow = sampleRows[selectedIndex];
    if (!sampleRow) {
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "general.errors.invalid_option_title",
        descriptionKey: "general.errors.invalid_option_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    // biome-ignore lint/style/noNonNullAssertion: sampleRow is validated above, sample_id is always present on VoiceSampleRow
    const refCount = await countPersonaVoiceSampleRefs(serverId, sampleRow.sample_id!);

    const confirmEmbed = createStandardEmbed(locale, {
      titleKey: "commands.speech.voice_remove.confirm_title",
      descriptionKey: "commands.speech.voice_remove.confirm_description",
      descriptionVars: { name: sampleRow.name, refs: String(refCount) },
      color: ColorCode.WARN,
    });

    const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(CONFIRM_BTN_ID)
        .setLabel(localizer(locale, "commands.speech.voice_remove.confirm_button"))
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(CANCEL_BTN_ID)
        .setLabel(localizer(locale, "commands.speech.voice_remove.cancel_button"))
        .setStyle(ButtonStyle.Secondary),
    );

    const confirmMessage = await modalSubmitInteraction.editReply({ embeds: [confirmEmbed], components: [confirmRow] });

    let buttonInteraction: ButtonInteraction;
    try {
      buttonInteraction = (await confirmMessage.awaitMessageComponent({
        filter: (i) =>
          i.user.id === interaction.user.id && (i.customId === CONFIRM_BTN_ID || i.customId === CANCEL_BTN_ID),
        time: INTERACTION_TIMEOUT_MS,
      })) as ButtonInteraction;
    } catch {
      await safeReply(modalSubmitInteraction.editReply({ components: [] }), "voice-remove confirm timeout");
      return;
    }

    await buttonInteraction.deferUpdate();

    if (buttonInteraction.customId === CANCEL_BTN_ID) {
      await modalSubmitInteraction.editReply({ embeds: [], components: [] });
      return;
    }

    // biome-ignore lint/style/noNonNullAssertion: sampleRow is validated above, sample_id is always present
    await clearPersonaVoiceSampleRefs(serverId, sampleRow.sample_id!);

    // biome-ignore lint/style/noNonNullAssertion: sampleRow is validated above, sample_id is always present
    await deleteVoiceSample(sampleRow.sample_id!);
    // biome-ignore lint/style/noNonNullAssertion: sampleRow is validated above, file_path is always present
    await deleteStoredVoiceSample(sampleRow.file_path!);

    log.info(
      `[VoiceRemove] Deleted sample "${sampleRow.name}" (id=${sampleRow.sample_id}) for server ${serverId} | ${refCount} persona(s) cleared`,
    );

    await replyInfoEmbed(modalSubmitInteraction, locale, {
      titleKey: "commands.speech.voice_remove.success_title",
      descriptionKey: "commands.speech.voice_remove.success_description",
      descriptionVars: { name: sampleRow.name },
      color: ColorCode.SUCCESS,
    });
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId,
      errorType: "CommandExecutionError",
      metadata: {
        command: "speech voice-remove",
        guildId: interaction.guild?.id,
        executorDiscordId: interaction.user.id,
      },
    };
    await log.error("Error executing /speech voice-remove", error as Error, context);
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
    });
  }
}
