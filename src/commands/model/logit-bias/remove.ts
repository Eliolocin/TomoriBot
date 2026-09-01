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
import { configRepository } from "@/utils/db/repositories";
import { getCachedTomoriState, invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { createStandardEmbed } from "@/utils/discord/embedHelper";
import { promptWithRawModal } from "@/utils/discord/ui/modals";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { localizer } from "@/utils/text/localizer";
import { log, ColorCode } from "@/utils/misc/logger";
import type { ErrorContext, UserRow } from "@/types/db/schema";
import type { CheckboxGroupOption, ModalCheckboxGroupField } from "@/types/discord/modal";
import type { LogitBiasEntry } from "@/types/provider/logitBias";
import { formatLogitBiasValue } from "@/types/provider/logitBias";

const CHECKBOX_ID_PREFIX = "config_logitbias_checkbox_group";
const MAX_OPTIONS_PER_GROUP = 10;
const MAX_GROUPS_PER_MODAL = 5;
const ENTRIES_PER_PAGE = MAX_OPTIONS_PER_GROUP * MAX_GROUPS_PER_MODAL;
const PAGE_BUTTON_LIMIT = 9;
const PAGE_SELECT_TIMEOUT_MS = 300_000;

function truncateCheckboxLabel(text: string): string {
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

function buildCheckboxGroups(pageEntries: LogitBiasEntry[]): ModalCheckboxGroupField[] {
  const groups: ModalCheckboxGroupField[] = [];

  for (let i = 0; i < pageEntries.length; i += MAX_OPTIONS_PER_GROUP) {
    const chunk = pageEntries.slice(i, i + MAX_OPTIONS_PER_GROUP);
    const groupIndex = Math.floor(i / MAX_OPTIONS_PER_GROUP);
    const options: CheckboxGroupOption[] = chunk.map((entry) => ({
      label: truncateCheckboxLabel(entry.text),
      value: entry.id,
      description: `Bias: ${formatLogitBiasValue(entry.value)}`,
      default: true,
    }));

    groups.push({
      kind: "checkboxGroup",
      customId: `${CHECKBOX_ID_PREFIX}_${groupIndex}`,
      labelKey:
        groupIndex === 0
          ? "commands.model.logit-bias.remove.checkbox_label"
          : "commands.model.logit-bias.remove.checkbox_label_continued",
      descriptionKey: groupIndex === 0 ? "commands.model.logit-bias.remove.checkbox_description" : undefined,
      minValues: 0,
      required: false,
      options,
    });
  }

  return groups;
}

function collectSelectedIds(multiValues: Record<string, string[]> | undefined, groupCount: number): Set<string> {
  const selectedIds = new Set<string>();

  for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
    const values = multiValues?.[`${CHECKBOX_ID_PREFIX}_${groupIndex}`] ?? [];
    for (const value of values) {
      selectedIds.add(value);
    }
  }

  return selectedIds;
}

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("remove")
    .setDescription(localizer("en-US", "commands.model.logit-bias.remove.description"))
    .addBooleanOption((option) =>
      option
        .setName("clearall")
        .setDescription(localizer("en-US", "commands.model.logit-bias.remove.clearall_description"))
        .setRequired(false),
    );

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  const serverDiscId = interaction.guild?.id ?? interaction.user.id;
  const clearAll = interaction.options.getBoolean("clearall") ?? false;

  try {
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

    const logitBiasEntries = tomoriState.config.llm_logit_biases ?? [];
    if (logitBiasEntries.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.model.logit-bias.remove.none_title",
        descriptionKey: "commands.model.logit-bias.remove.none_description",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (clearAll) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const updated = await configRepository.updateChatConfig(tomoriState.server_id, {
        llm_logit_biases: [],
      });

      if (!updated) {
        const context: ErrorContext = {
          personaId: tomoriState.persona_id,
          serverId: tomoriState.server_id,
          userId: userData.user_id,
          errorType: "DatabaseUpdateError",
          metadata: {
            command: "config logitbias remove",
            clearAll,
          },
        };
        await log.error("Failed to clear llm_logit_biases config", new Error("Database update failed"), context);
        await replyInfoEmbed(interaction, locale, {
          titleKey: "general.errors.update_failed_title",
          descriptionKey: "general.errors.update_failed_description",
          color: ColorCode.ERROR,
        });
        return;
      }

      invalidateTomoriStateCache(serverDiscId);

      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.model.logit-bias.remove.clearall_success_title",
        descriptionKey: "commands.model.logit-bias.remove.clearall_success_description",
        descriptionVars: {
          removed_count: logitBiasEntries.length.toString(),
        },
        color: ColorCode.SUCCESS,
      });
      return;
    }

    const totalPages = Math.ceil(logitBiasEntries.length / ENTRIES_PER_PAGE);
    if (totalPages > PAGE_BUTTON_LIMIT) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.model.logit-bias.remove.too_many_title",
        descriptionKey: "commands.model.logit-bias.remove.too_many_description",
        descriptionVars: {
          total_entries: logitBiasEntries.length.toString(),
          total_pages: totalPages.toString(),
          max_pages: PAGE_BUTTON_LIMIT.toString(),
        },
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let modalSource: ChatInputCommandInteraction | ButtonInteraction = interaction;
    let pageEntries = logitBiasEntries;

    if (totalPages > 1) {
      const pageSelectEmbed = createStandardEmbed(locale, {
        titleKey: "commands.model.logit-bias.remove.select_page_title",
        descriptionKey: "commands.model.logit-bias.remove.select_page_description",
        descriptionVars: {
          total_entries: logitBiasEntries.length.toString(),
          total_pages: totalPages.toString(),
        },
        color: ColorCode.INFO,
      });

      const pageButtons: ButtonBuilder[] = [];
      for (let page = 1; page <= totalPages; page++) {
        const startEntry = (page - 1) * ENTRIES_PER_PAGE + 1;
        const endEntry = Math.min(page * ENTRIES_PER_PAGE, logitBiasEntries.length);
        pageButtons.push(
          new ButtonBuilder()
            .setCustomId(`config_logitbias_page_${page}`)
            .setLabel(`${startEntry}-${endEntry}`)
            .setStyle(ButtonStyle.Secondary),
        );
      }

      const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(...pageButtons);

      const pageSelectMessage = await interaction.reply({
        embeds: [pageSelectEmbed],
        components: [actionRow],
        flags: MessageFlags.Ephemeral,
      });

      let pageButtonInteraction: ButtonInteraction;
      try {
        pageButtonInteraction = (await pageSelectMessage.awaitMessageComponent({
          filter: (buttonInteraction) =>
            buttonInteraction.user.id === interaction.user.id &&
            buttonInteraction.customId.startsWith("config_logitbias_page_"),
          time: PAGE_SELECT_TIMEOUT_MS,
        })) as ButtonInteraction;
      } catch {
        log.info("[Config Logit Bias Remove] Page selection timed out");
        return;
      }

      const selectedPage = Number.parseInt(pageButtonInteraction.customId.replace("config_logitbias_page_", ""), 10);
      const startIndex = (selectedPage - 1) * ENTRIES_PER_PAGE;
      pageEntries = logitBiasEntries.slice(startIndex, startIndex + ENTRIES_PER_PAGE);
      modalSource = pageButtonInteraction;
    }

    const checkboxGroups = buildCheckboxGroups(pageEntries);
    const modalResult = await promptWithRawModal(
      modalSource,
      locale,
      {
        modalCustomId: `config_logitbias_remove_${interaction.id}`,
        modalTitleKey: "commands.model.logit-bias.remove.modal_title",
        components: checkboxGroups,
      },
      MessageFlags.Ephemeral,
    );

    if (modalResult.outcome !== "submit") return;
    if (!modalResult.interaction) {
      log.error("Logit bias remove modal unexpectedly missing interaction");
      return;
    }

    const modalInteraction = modalResult.interaction;
    const selectedIds = collectSelectedIds(modalResult.multiValues, checkboxGroups.length);
    const pageEntryIds = new Set(pageEntries.map((entry) => entry.id));
    const remainingEntries = logitBiasEntries.filter(
      (entry) => !pageEntryIds.has(entry.id) || selectedIds.has(entry.id),
    );
    const removedEntries = pageEntries.filter((entry) => !selectedIds.has(entry.id));

    if (removedEntries.length === 0) {
      await replyInfoEmbed(modalInteraction, locale, {
        titleKey: "commands.model.logit-bias.remove.no_removals_title",
        descriptionKey: "commands.model.logit-bias.remove.no_removals_description",
        color: ColorCode.INFO,
      });
      return;
    }

    const updated = await configRepository.updateChatConfig(tomoriState.server_id, {
      llm_logit_biases: remainingEntries,
    });

    if (!updated) {
      const context: ErrorContext = {
        personaId: tomoriState.persona_id,
        serverId: tomoriState.server_id,
        userId: userData.user_id,
        errorType: "DatabaseUpdateError",
        metadata: {
          command: "config logitbias remove",
          removedCount: removedEntries.length,
        },
      };
      await log.error("Failed to update llm_logit_biases after removals", new Error("Database update failed"), context);
      await replyInfoEmbed(modalInteraction, locale, {
        titleKey: "general.errors.update_failed_title",
        descriptionKey: "general.errors.update_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    invalidateTomoriStateCache(serverDiscId);

    await replyInfoEmbed(modalInteraction, locale, {
      titleKey: "commands.model.logit-bias.remove.success_title",
      descriptionKey: "commands.model.logit-bias.remove.success_description",
      descriptionVars: {
        removed_count: removedEntries.length.toString(),
        remaining_count: remainingEntries.length.toString(),
      },
      color: ColorCode.SUCCESS,
    });
  } catch (error) {
    const tomoriState = await getCachedTomoriState(serverDiscId);
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: tomoriState?.server_id,
      personaId: tomoriState?.persona_id,
      errorType: "CommandExecutionError",
      metadata: {
        command: "config logitbias remove",
        guildId: interaction.guild?.id,
        executorDiscordId: interaction.user.id,
        clearAll,
      },
    };
    await log.error("Error executing /config logit-bias remove", error as Error, context);

    if (!interaction.replied && !interaction.deferred) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.unknown_error_title",
        descriptionKey: "general.errors.unknown_error_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.followUp({
      content: localizer(locale, "general.errors.unknown_error_description"),
      flags: MessageFlags.Ephemeral,
    });
  }
}
