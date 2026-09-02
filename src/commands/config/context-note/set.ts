/**
 * Command: /config context-note set
 * Allows users to set an author's note injected into conversation history
 * at a configurable depth to combat context drift.
 *
 * Scopes:
 * - persona: Bound to a specific persona (persona picker shown first)
 * - channel: Bound to a specific Discord channel (channel option on the slash command)
 * - global:  Server-wide fallback used when neither the active persona nor the channel has a note
 *
 * Persona and channel notes are additive; both are injected when set.
 * Submitting a blank note clears (removes) the stored value.
 */

import type { ChatInputCommandInteraction, Client, ModalSubmitInteraction } from "discord.js";
import { ChannelType, MessageFlags, TextInputStyle } from "discord.js";
import type { UserRow } from "@/types/db/schema";
import { getCachedTomoriState, invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { channelContextNoteRepo, configRepository, personaRepository } from "@/utils/db/repositories";
import { localizer } from "@/utils/text/localizer";
import {
  buildTextPreview,
  CONFIRMATION_PREVIEW_BUDGET,
  textPreviewFooterKey,
  textPreviewFooterVars,
} from "@/utils/text/textPreview";
import { log, ColorCode } from "@/utils/misc/logger";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { promptWithRawModal } from "@/utils/discord/ui/modals";
import {
  buildPersonaWorkflowNotice,
  completePersonaWorkflow,
  runPersonaPickerWorkflow,
} from "@/utils/discord/ui/personaWorkflow";
import { CONTEXT_NOTE_DEPTH_MAX, CONTEXT_NOTE_MAX_LENGTH } from "@/utils/discord/contextNoteOptions";

const MODAL_CUSTOM_ID = "config_context_note_modal";

/**
 * Configure the /config context-note set subcommand metadata.
 * The commandLoader auto-localizes descriptions, option descriptions, and choice labels
 * from the keys at commands.config.context-note.set.* in the locale files.
 */
export const configureSubcommand = (subcommand: import("discord.js").SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("set")
    .setDescription(localizer("en-US", "commands.config.context-note.set.description"))
    .addStringOption((option) =>
      option
        .setName("scope")
        .setDescription(localizer("en-US", "commands.config.context-note.set.scope_description"))
        .setRequired(true)
        .addChoices(
          {
            name: localizer("en-US", "commands.config.context-note.set.persona_option"),
            value: "persona",
          },
          {
            name: localizer("en-US", "commands.config.context-note.set.channel_option"),
            value: "channel",
          },
          {
            name: localizer("en-US", "commands.config.context-note.set.global_option"),
            value: "global",
          },
        ),
    )
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription(localizer("en-US", "commands.config.context-note.set.channel_description"))
        .setRequired(false)
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
          ChannelType.PublicThread,
          ChannelType.PrivateThread,
        ),
    );

/**
 * Execute /config context-note set.
 */
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

  // Resolve the branch before any asynchronous state reads. Persona scope can
  // safely pre-defer; channel/global scopes still need the root to open a modal.
  const scope = interaction.options.getString("scope", true) as "persona" | "channel" | "global";
  if (scope === "persona") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  const serverId = interaction.guildId ?? interaction.user.id;
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

  if (scope === "persona") {
    const allPersonas = await personaRepository.loadAllForServer(interaction.guild?.id ?? interaction.user.id);
    if (allPersonas.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.config.context-note.set.no_personas_title",
        descriptionKey: "commands.config.context-note.set.no_personas_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await runPersonaPickerWorkflow(interaction, locale, {
      personas: allPersonas,
      color: ColorCode.INFO,
      async onSelected(selection) {
        const selectedPersona = selection.persona;
        const personaId = selectedPersona.persona_id;
        if (personaId == null) {
          const work = await selection.beginInPlaceWork();
          await work.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: "general.errors.unknown_error_title",
              descriptionKey: "general.errors.unknown_error_description",
              color: ColorCode.ERROR,
            }),
          );
          return completePersonaWorkflow();
        }

        try {
          const modalResult = await selection.openModal({
            modalCustomId: MODAL_CUSTOM_ID,
            modalTitleKey: "commands.config.context-note.set.modal_title",
            components: [
              {
                customId: "context_note_text",
                style: TextInputStyle.Paragraph,
                labelKey: "commands.config.context-note.set.text_label",
                placeholder: "commands.config.context-note.set.text_placeholder",
                required: false,
                maxLength: CONTEXT_NOTE_MAX_LENGTH,
                value: selectedPersona.context_note || undefined,
              },
              {
                customId: "context_note_depth",
                style: TextInputStyle.Short,
                labelKey: "commands.config.context-note.set.depth_label",
                placeholder: "commands.config.context-note.set.depth_placeholder",
                required: true,
                maxLength: 3,
                value: String(selectedPersona.context_note_depth ?? 0),
              },
            ],
          });
          if (modalResult.outcome !== "submitted") {
            log.info(`Context note modal ${modalResult.outcome}`);
            return completePersonaWorkflow();
          }

          const work = await modalResult.phase.beginInPlaceWork();
          const rawNote = (modalResult.phase.values.context_note_text ?? "").trim();
          const rawDepth = (modalResult.phase.values.context_note_depth ?? "0").trim();
          const parsedDepth = Number.parseInt(rawDepth, 10);
          if (Number.isNaN(parsedDepth) || parsedDepth < 0 || parsedDepth > CONTEXT_NOTE_DEPTH_MAX) {
            await work.message.replace(
              buildPersonaWorkflowNotice({
                locale,
                titleKey: "commands.config.context-note.set.invalid_depth_title",
                descriptionKey: "commands.config.context-note.set.invalid_depth_description",
                color: ColorCode.ERROR,
              }),
            );
            return completePersonaWorkflow();
          }

          const noteToStore = rawNote || null;
          const depthToStore = rawNote ? parsedDepth : 0;
          const persisted = await personaRepository.setContextNote(personaId, noteToStore, depthToStore);
          if (!persisted) throw new Error("Failed to persist persona context note");
          selectedPersona.context_note = noteToStore;
          selectedPersona.context_note_depth = depthToStore;
          invalidateTomoriStateCache(serverId);

          const isRemoving = !rawNote;
          // Fence-safe preview of the stored note; the removal branch shows no
          // preview at all, so it never carries a truncation footer.
          const preview = buildTextPreview(noteToStore, CONFIRMATION_PREVIEW_BUDGET);
          await work.message.replace(
            buildPersonaWorkflowNotice({
              locale,
              titleKey: isRemoving
                ? "commands.config.context-note.set.success_removed_title"
                : "commands.config.context-note.set.success_set_title",
              descriptionKey: isRemoving
                ? "commands.config.context-note.set.success_removed_description"
                : "commands.config.context-note.set.success_set_description",
              descriptionVars: isRemoving
                ? { scope: selectedPersona.persona_nickname }
                : {
                    scope: selectedPersona.persona_nickname,
                    depth: String(depthToStore),
                    preview: preview.text,
                  },
              footerKey: isRemoving ? undefined : textPreviewFooterKey(preview),
              footerVars: textPreviewFooterVars(preview),
              color: ColorCode.SUCCESS,
            }),
          );
          log.info(
            `Context note ${isRemoving ? "cleared" : "updated"} for server ${serverId} scope=persona persona=${personaId} depth=${depthToStore}`,
          );
          return completePersonaWorkflow();
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

  // Declare interaction handles outside try-catch for fallback error replies
  const modalHost = interaction;
  let modalSubmitInteraction: ModalSubmitInteraction | undefined;
  let selectedChannelDiscId: string | null = null;

  try {
    if (scope === "channel") {
      const channelOption = interaction.options.getChannel("channel");
      if (!channelOption) {
        await replyInfoEmbed(interaction, locale, {
          titleKey: "commands.config.context-note.set.no_channel_title",
          descriptionKey: "commands.config.context-note.set.no_channel_description",
          color: ColorCode.ERROR,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      selectedChannelDiscId = channelOption.id;
    }

    let existingNote: string | null | undefined;
    let existingDepth: number;

    if (scope === "channel" && selectedChannelDiscId && tomoriState.server_id) {
      const existing = await channelContextNoteRepo.getChannelContextNote(tomoriState.server_id, selectedChannelDiscId);
      existingNote = existing?.note ?? null;
      existingDepth = existing?.depth ?? 0;
    } else {
      existingNote = tomoriState.config.context_note;
      existingDepth = tomoriState.config.context_note_depth ?? 0;
    }

    const modalResult = await promptWithRawModal(
      modalHost,
      locale,
      {
        modalCustomId: MODAL_CUSTOM_ID,
        modalTitleKey: "commands.config.context-note.set.modal_title",
        components: [
          {
            customId: "context_note_text",
            style: TextInputStyle.Paragraph,
            labelKey: "commands.config.context-note.set.text_label",
            placeholder: "commands.config.context-note.set.text_placeholder",
            required: false,
            maxLength: CONTEXT_NOTE_MAX_LENGTH,
            value: existingNote || undefined,
          },
          {
            customId: "context_note_depth",
            style: TextInputStyle.Short,
            labelKey: "commands.config.context-note.set.depth_label",
            placeholder: "commands.config.context-note.set.depth_placeholder",
            required: true,
            maxLength: 3,
            value: String(existingDepth),
          },
        ],
      },
      MessageFlags.Ephemeral,
    );

    if (modalResult.outcome !== "submit") {
      log.info(`Context note modal ${modalResult.outcome}`);
      return;
    }

    modalSubmitInteraction = modalResult.interaction;

    if (!modalSubmitInteraction) {
      log.error("Modal submit interaction is undefined after successful submit");
      return;
    }

    const rawNote = (modalResult.values?.context_note_text ?? "").trim();
    const rawDepth = (modalResult.values?.context_note_depth ?? "0").trim();
    const parsedDepth = Number.parseInt(rawDepth, 10);

    if (Number.isNaN(parsedDepth) || parsedDepth < 0 || parsedDepth > CONTEXT_NOTE_DEPTH_MAX) {
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "commands.config.context-note.set.invalid_depth_title",
        descriptionKey: "commands.config.context-note.set.invalid_depth_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Blank text = remove the note (NULL + reset depth to 0)
    const noteToStore = rawNote || null;
    const depthToStore = rawNote ? parsedDepth : 0;
    const isRemoving = !rawNote;

    let persisted: boolean;

    if (scope === "channel" && selectedChannelDiscId && tomoriState.server_id) {
      if (noteToStore) {
        persisted = await channelContextNoteRepo.setChannelContextNote(
          tomoriState.server_id,
          selectedChannelDiscId,
          noteToStore,
          depthToStore,
        );
      } else {
        persisted = await channelContextNoteRepo.deleteChannelContextNote(tomoriState.server_id, selectedChannelDiscId);
      }
    } else {
      persisted = await configRepository.updateChatConfig(tomoriState.server_id, {
        context_note: noteToStore,
        context_note_depth: depthToStore,
      });
    }

    if (!persisted) {
      throw new Error("Failed to persist context note");
    }

    // Invalidate tomori state cache AFTER the successful write (persona/global scopes)
    if (scope === "global") {
      invalidateTomoriStateCache(serverId);
    }

    const scopeLabel =
      scope === "channel" && selectedChannelDiscId
        ? `<#${selectedChannelDiscId}>`
        : localizer(locale, "commands.config.context-note.set.global_option");

    if (isRemoving) {
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "commands.config.context-note.set.success_removed_title",
        descriptionKey: "commands.config.context-note.set.success_removed_description",
        descriptionVars: { scope: scopeLabel },
        color: ColorCode.SUCCESS,
        flags: MessageFlags.Ephemeral,
      });
    } else {
      const preview = buildTextPreview(noteToStore, CONFIRMATION_PREVIEW_BUDGET);
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "commands.config.context-note.set.success_set_title",
        descriptionKey: "commands.config.context-note.set.success_set_description",
        descriptionVars: { scope: scopeLabel, depth: String(depthToStore), preview: preview.text },
        footerKey: textPreviewFooterKey(preview),
        footerVars: textPreviewFooterVars(preview),
        color: ColorCode.SUCCESS,
        flags: MessageFlags.Ephemeral,
      });
    }

    log.info(
      `Context note ${isRemoving ? "cleared" : "updated"} for server ${serverId} scope=${scope}${selectedChannelDiscId ? ` channel=${selectedChannelDiscId}` : ""} depth=${depthToStore}`,
    );
  } catch (error) {
    log.error("Failed to set context note:", error as Error);

    // Use the most specific available interaction for the error reply
    const replyTarget = modalSubmitInteraction ?? modalHost;

    await replyInfoEmbed(replyTarget, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
  }
}
