import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type ModalSubmitInteraction,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import type { CheckboxGroupOption, ModalCheckboxGroupField } from "@/types/discord/modal";
import type { ConditioningGroup } from "@/utils/db/repositories/ConditioningMemoryRepository";
import type { ConditioningType, TomoriState, UserRow } from "@/types/db/schema";
import { createStandardEmbed } from "@/utils/discord/embedHelper";
import { promptWithRawModal } from "@/utils/discord/ui/modals";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { ColorCode, log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";
import { conditioningMemoryRepository } from "@/utils/db/repositories/ConditioningMemoryRepository";
import { hasManageGuildPermission } from "@/utils/conditioning/conditioningCommandHelper";
import { personaRepository } from "@/utils/db/repositories";

const CHECKBOX_GROUP_PREFIX = "conditioning_manage_group";
const PAGE_BUTTON_PREFIX = "conditioning_manage_page_";
const DONE_BUTTON_ID = "conditioning_manage_done";
const MAX_OPTIONS_PER_GROUP = 10;
const MAX_GROUPS_PER_MODAL = 5;
const ENTRIES_PER_PAGE = MAX_OPTIONS_PER_GROUP * MAX_GROUPS_PER_MODAL;
const PAGE_SELECT_TIMEOUT_MS = 300_000;
const MAX_PAGE_BUTTONS = 24;

type ConditioningManageEntry = ConditioningGroup & {
  serverId: number;
  personaName: string;
  personaLineageId: number;
};

function hasManageableReason(entry: ConditioningManageEntry): boolean {
  return entry.reasonText.trim().length > 0;
}

function truncateOptionLabel(value: string): string {
  return value.length > 100 ? `${value.slice(0, 97)}...` : value;
}

function getTypeMarker(locale: string, conditioningType: ConditioningType): string {
  return localizer(locale, `commands.conditioning.manage.marker_${conditioningType}`);
}

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("manage").setDescription(localizer("en-US", "commands.conditioning.manage.description"));

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
  locale: string,
): Promise<void> {
  if (!hasManageGuildPermission(interaction)) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.permission_denied_title",
      descriptionKey: "general.errors.permission_denied_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.guildId) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.guild_only_title",
      descriptionKey: "general.errors.guild_only_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const personas = await personaRepository.loadAllForServer(interaction.guildId);
  if (personas.length === 0) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.tomori_not_setup_title",
      descriptionKey: "general.errors.tomori_not_setup_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const entries = await loadManageEntries(personas);
  if (entries.length === 0) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.conditioning.manage.none_title",
      descriptionKey: "commands.conditioning.manage.none_description",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const totalPages = Math.ceil(entries.length / ENTRIES_PER_PAGE);
  if (totalPages > MAX_PAGE_BUTTONS) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.conditioning.manage.too_many_title",
      descriptionKey: "commands.conditioning.manage.too_many_description",
      descriptionVars: {
        total_entries: entries.length.toString(),
        total_pages: totalPages.toString(),
        max_pages: MAX_PAGE_BUTTONS.toString(),
      },
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (entries.length <= ENTRIES_PER_PAGE) {
    await executeSinglePage(interaction, locale, entries);
    return;
  }

  await executeMultiPage(interaction, locale, entries);
}

async function loadManageEntries(personas: TomoriState[]): Promise<ConditioningManageEntry[]> {
  const personaEntries = await Promise.all(
    personas.map(async (persona) => {
      const groups = await conditioningMemoryRepository.loadGroupsForPersona(
        persona.server_id,
        persona.persona_lineage_id ?? 0,
      );
      return groups.map(
        (group): ConditioningManageEntry => ({
          ...group,
          serverId: persona.server_id,
          personaName: persona.persona_nickname,
          personaLineageId: persona.persona_lineage_id ?? 0,
        }),
      );
    }),
  );

  return personaEntries
    .flat()
    .filter(hasManageableReason)
    .sort((a, b) => {
      const timeDiff = b.updatedAt.getTime() - a.updatedAt.getTime();
      if (timeDiff !== 0) return timeDiff;
      return a.personaName.localeCompare(b.personaName);
    });
}

async function executeSinglePage(
  interaction: ChatInputCommandInteraction,
  locale: string,
  entries: ConditioningManageEntry[],
): Promise<void> {
  const checkboxGroups = buildCheckboxGroups(entries, locale);
  const modalResult = await promptWithRawModal(
    interaction,
    locale,
    {
      modalCustomId: `conditioning_manage_${interaction.id}`,
      modalTitleKey: "commands.conditioning.manage.modal_title",
      components: checkboxGroups,
    },
    MessageFlags.Ephemeral,
  );

  if (modalResult.outcome !== "submit" || !modalResult.interaction) {
    return;
  }

  const selectedIndexes = collectSelectedIndexes(modalResult.multiValues, checkboxGroups.length);
  await persistUpdate(modalResult.interaction, locale, entries, selectedIndexes);
}

async function executeMultiPage(
  interaction: ChatInputCommandInteraction,
  locale: string,
  entries: ConditioningManageEntry[],
): Promise<void> {
  const totalPages = Math.ceil(entries.length / ENTRIES_PER_PAGE);

  await interaction.reply({
    embeds: [buildPageSelectEmbed(locale, entries.length, totalPages)],
    components: buildPageActionRows(totalPages, entries.length, locale),
    flags: MessageFlags.Ephemeral,
  });

  const pageMessage = await interaction.fetchReply();
  const collector = pageMessage.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (buttonInteraction) =>
      buttonInteraction.user.id === interaction.user.id &&
      (buttonInteraction.customId.startsWith(PAGE_BUTTON_PREFIX) || buttonInteraction.customId === DONE_BUTTON_ID),
    time: PAGE_SELECT_TIMEOUT_MS,
  });

  collector.on("collect", (pageButtonInteraction) => {
    if (pageButtonInteraction.customId === DONE_BUTTON_ID) {
      void pageButtonInteraction.deferUpdate().finally(() => collector.stop("done"));
      return;
    }

    void handlePageSelection(pageButtonInteraction, interaction.id, locale, entries).catch((error) => {
      log.error("Conditioning manage page failed", error);
    });
  });

  await new Promise<void>((resolve) => collector.once("end", () => resolve()));

  try {
    await interaction.editReply({
      embeds: [buildPageSelectEmbed(locale, entries.length, totalPages)],
      components: [],
    });
  } catch {}
}

async function handlePageSelection(
  pageButtonInteraction: ButtonInteraction,
  commandInteractionId: string,
  locale: string,
  entries: ConditioningManageEntry[],
): Promise<void> {
  const selectedPage = Number.parseInt(pageButtonInteraction.customId.replace(PAGE_BUTTON_PREFIX, ""), 10);
  const startIndex = (selectedPage - 1) * ENTRIES_PER_PAGE;
  const pageEntries = entries.slice(startIndex, startIndex + ENTRIES_PER_PAGE);
  const checkboxGroups = buildCheckboxGroups(pageEntries, locale);
  const modalResult = await promptWithRawModal(
    pageButtonInteraction,
    locale,
    {
      modalCustomId: `conditioning_manage_${commandInteractionId}`,
      modalTitleKey: "commands.conditioning.manage.modal_title",
      components: checkboxGroups,
    },
    MessageFlags.Ephemeral,
  );

  if (modalResult.outcome === "submit" && modalResult.interaction) {
    const selectedIndexes = collectSelectedIndexes(modalResult.multiValues, checkboxGroups.length);
    await persistUpdate(modalResult.interaction, locale, pageEntries, selectedIndexes);
  }
}

function buildCheckboxGroups(entries: ConditioningManageEntry[], locale: string): ModalCheckboxGroupField[] {
  const checkboxGroups: ModalCheckboxGroupField[] = [];

  for (let i = 0; i < entries.length; i += MAX_OPTIONS_PER_GROUP) {
    const chunk = entries.slice(i, i + MAX_OPTIONS_PER_GROUP);
    const groupIndex = Math.floor(i / MAX_OPTIONS_PER_GROUP);
    const options: CheckboxGroupOption[] = chunk.map((entry, index) => {
      const effectiveIndex = i + index;
      const actionLabel = localizer(locale, `commands.${entry.conditioningType}.${entry.actionKey}.history_label`);
      const descriptionKey =
        entry.totalCount > 1
          ? "commands.conditioning.manage.option_reason_description"
          : "commands.conditioning.manage.option_reason_description_single";
      let description = localizer(locale, descriptionKey, {
        count: entry.totalCount.toString(),
        reason: entry.reasonText,
      });
      if (entry.actionText) {
        description = `${description} • ${entry.actionText}`;
      }

      return {
        label: truncateOptionLabel(
          localizer(locale, "commands.conditioning.manage.option_label", {
            persona_name: entry.personaName,
            type_marker: getTypeMarker(locale, entry.conditioningType),
            action: actionLabel,
          }),
        ),
        value: effectiveIndex.toString(),
        description: truncateOptionLabel(description),
        default: true,
      };
    });

    checkboxGroups.push({
      kind: "checkboxGroup",
      customId: `${CHECKBOX_GROUP_PREFIX}_${groupIndex}`,
      labelKey:
        groupIndex === 0
          ? "commands.conditioning.manage.checkbox_label"
          : "commands.conditioning.manage.checkbox_label_continued",
      descriptionKey: groupIndex === 0 ? "commands.conditioning.manage.checkbox_description" : undefined,
      minValues: 0,
      required: false,
      options,
    });
  }

  return checkboxGroups;
}

function collectSelectedIndexes(multiValues: Record<string, string[]> | undefined, groupCount: number): Set<number> {
  const indexes = new Set<number>();
  for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
    for (const value of multiValues?.[`${CHECKBOX_GROUP_PREFIX}_${groupIndex}`] ?? []) {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        indexes.add(parsed);
      }
    }
  }
  return indexes;
}

function buildPageSelectEmbed(locale: string, totalEntries: number, totalPages: number) {
  return createStandardEmbed(locale, {
    titleKey: "commands.conditioning.manage.select_page_title",
    descriptionKey: "commands.conditioning.manage.select_page_description",
    descriptionVars: {
      total_entries: totalEntries.toString(),
      total_pages: totalPages.toString(),
    },
    color: ColorCode.INFO,
  });
}

function buildPageActionRows(
  totalPages: number,
  totalEntries: number,
  locale: string,
): ActionRowBuilder<ButtonBuilder>[] {
  const pageButtons: ButtonBuilder[] = [];

  for (let page = 1; page <= totalPages; page++) {
    const start = (page - 1) * ENTRIES_PER_PAGE + 1;
    const end = Math.min(page * ENTRIES_PER_PAGE, totalEntries);
    pageButtons.push(
      new ButtonBuilder()
        .setCustomId(`${PAGE_BUTTON_PREFIX}${page}`)
        .setLabel(`${start}-${end}`)
        .setStyle(ButtonStyle.Secondary),
    );
  }

  pageButtons.push(
    new ButtonBuilder()
      .setCustomId(DONE_BUTTON_ID)
      .setLabel(localizer(locale, "commands.conditioning.manage.done_button"))
      .setStyle(ButtonStyle.Secondary),
  );

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < pageButtons.length; i += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...pageButtons.slice(i, i + 5)));
  }

  return rows;
}

async function persistUpdate(
  responseInteraction: ModalSubmitInteraction,
  locale: string,
  entries: ConditioningManageEntry[],
  selectedIndexes: Set<number>,
): Promise<void> {
  const groupsToDelete = entries.filter((_entry, index) => !selectedIndexes.has(index));

  if (groupsToDelete.length === 0) {
    await replyInfoEmbed(responseInteraction, locale, {
      titleKey: "commands.conditioning.manage.no_changes_title",
      descriptionKey: "commands.conditioning.manage.no_changes_description",
      color: ColorCode.INFO,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const groupsByPersona = new Map<number, ConditioningManageEntry[]>();
  for (const group of groupsToDelete) {
    const personaGroups = groupsByPersona.get(group.personaLineageId) ?? [];
    personaGroups.push(group);
    groupsByPersona.set(group.personaLineageId, personaGroups);
  }

  let deletedRows = 0;
  for (const [personaLineageId, personaGroups] of groupsByPersona) {
    deletedRows += await conditioningMemoryRepository.deleteGroupsForPersona(
      personaGroups[0]?.serverId ?? 0,
      personaLineageId,
      personaGroups.map((group) => ({
        conditioningType: group.conditioningType,
        actionKey: group.actionKey,
        reasonNormalized: group.reasonNormalized,
      })),
    );
  }

  if (deletedRows === 0) {
    await replyInfoEmbed(responseInteraction, locale, {
      titleKey: "general.errors.update_failed_title",
      descriptionKey: "general.errors.update_failed_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const removedRewardGroups = groupsToDelete.filter((group) => group.conditioningType === "reward").length;
  const removedPunishGroups = groupsToDelete.filter((group) => group.conditioningType === "punish").length;
  const affectedPersonas = new Set(groupsToDelete.map((group) => group.personaLineageId)).size;

  await replyInfoEmbed(responseInteraction, locale, {
    titleKey: "commands.conditioning.manage.success_title",
    descriptionKey: "commands.conditioning.manage.success_description",
    descriptionVars: {
      reward_groups: removedRewardGroups.toString(),
      punish_groups: removedPunishGroups.toString(),
      deleted_rows: deletedRows.toString(),
      persona_count: affectedPersonas.toString(),
    },
    color: ColorCode.SUCCESS,
    flags: MessageFlags.Ephemeral,
  });
}
