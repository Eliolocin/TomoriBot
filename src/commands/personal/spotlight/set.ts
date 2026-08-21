import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import type { ModalCheckboxGroupField, SelectOption } from "@/types/discord/modal";
import type { ErrorContext, TomoriState, UserRow } from "@/types/db/schema";
import { getCachedTomoriState, getCachedAllPersonas } from "@/utils/cache/tomoriStateCache";
import {
  getCachedPersonalSpotlightStatus,
  invalidatePersonalSpotlightCache,
} from "@/utils/cache/personalSpotlightCache";
import { userRepository } from "@/utils/db/repositories/UserRepository";
import {
  acknowledgeModalSubmitForRefresh,
  promptWithPaginatedModal,
  promptWithRawModal,
  safeSelectOptionText,
} from "@/utils/discord/ui/modals";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { ColorCode, log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";

const MAX_OPTIONS_PER_GROUP = 10;
const MAX_GROUPS_PER_MODAL = 5;
const MAX_PERSONAS_PER_MODAL = MAX_OPTIONS_PER_GROUP * MAX_GROUPS_PER_MODAL;
const CHECKBOX_ID_PREFIX = "personal_spotlight_set_checkbox_group";
const AUTO_TRIGGER_INPUT_ID = "personal_spotlight_auto_trigger_persona";

type PersonaWithId = TomoriState & { persona_id: number };

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("set")
    .setDescription(localizer("en-US", "commands.personal.spotlight.set.description"))
    .addIntegerOption((option) =>
      option
        .setName("hours")
        .setDescription(localizer("en-US", "commands.personal.spotlight.set.hours_description"))
        .setMinValue(0)
        .setRequired(true),
    )
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription(localizer("en-US", "commands.personal.spotlight.set.channel_description"))
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    );

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  const errorContext: ErrorContext = {
    userId: userData.user_id,
    serverId: null,
    personaId: null,
    metadata: {
      command: "personal spotlight set",
      guildId: interaction.guildId,
      executorDiscordId: interaction.user.id,
    },
  };

  try {
    if (!interaction.guild || !interaction.guildId) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.guild_only_title",
        descriptionKey: "general.errors.guild_only_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    if (!userData.user_id) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.operation_failed_title",
        descriptionKey: "general.errors.operation_failed_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const hours = interaction.options.getInteger("hours", true);
    const selectedChannel = interaction.options.getChannel("channel", true);
    if (selectedChannel.type !== ChannelType.GuildText) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.invalid_option_title",
        descriptionKey: "general.errors.invalid_option_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const [tomoriState, allPersonasRaw] = await Promise.all([
      getCachedTomoriState(interaction.guildId),
      getCachedAllPersonas(interaction.guildId),
    ]);
    if (!tomoriState) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    errorContext.serverId = tomoriState.server_id;
    errorContext.personaId = tomoriState.persona_id;

    const allPersonas = allPersonasRaw.filter(
      (persona): persona is PersonaWithId => typeof persona.persona_id === "number",
    );
    if (allPersonas.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.personal.spotlight.set.no_personas_title",
        descriptionKey: "commands.personal.spotlight.set.no_personas_description",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (allPersonas.length > MAX_PERSONAS_PER_MODAL) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.personal.spotlight.set.too_many_personas_title",
        descriptionKey: "commands.personal.spotlight.set.too_many_personas_description",
        descriptionVars: {
          count: allPersonas.length.toString(),
          max_entries: MAX_PERSONAS_PER_MODAL.toString(),
          max_groups: MAX_GROUPS_PER_MODAL.toString(),
        },
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const currentSpotlight = await getCachedPersonalSpotlightStatus(
      tomoriState.server_id,
      userData.user_id,
      selectedChannel.id,
    );
    const checkboxGroups = buildPersonaCheckboxGroups(allPersonas, new Set(currentSpotlight?.personaIds ?? []), locale);
    const firstModalResult = await promptWithRawModal(interaction, locale, {
      modalCustomId: `personal_spotlight_set_modal_${interaction.id}`,
      modalTitleKey: "commands.personal.spotlight.set.modal_title",
      components: checkboxGroups,
    });

    if (firstModalResult.outcome !== "submit" || !firstModalResult.interaction) {
      return;
    }

    const modalInteraction = firstModalResult.interaction;
    const selectedPersonaIds = collectCheckedPersonaIds(firstModalResult.multiValues, checkboxGroups.length).sort(
      (left, right) => left - right,
    );
    if (selectedPersonaIds.length === 0) {
      await replyInfoEmbed(modalInteraction, locale, {
        titleKey: "commands.personal.spotlight.set.no_selection_title",
        descriptionKey: "commands.personal.spotlight.set.no_selection_description",
        color: ColorCode.WARN,
      });
      return;
    }

    const selectedPersonas = allPersonas.filter((persona) => selectedPersonaIds.includes(persona.persona_id));
    const finishButtonId = `personal_spotlight_finish_${interaction.id}`;
    const autoTriggerButtonId = `personal_spotlight_auto_${interaction.id}`;
    const transactionEmbed = new EmbedBuilder()
      .setTitle(localizer(locale, "commands.personal.spotlight.set.transaction_title"))
      .setDescription(
        [
          buildSpotlightSummary({
            locale,
            channelId: selectedChannel.id,
            durationText: formatDurationText(locale, hours, hours === 0 ? null : buildExpiresAt(hours)),
            personas: selectedPersonas,
            autoTriggerText: localizer(locale, "commands.personal.spotlight.set.auto_trigger_pending"),
          }),
          localizer(locale, "commands.personal.spotlight.set.transaction_prompt"),
        ].join("\n\n"),
      )
      .setColor(ColorCode.INFO);

    await modalInteraction.reply({
      embeds: [transactionEmbed],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(finishButtonId)
            .setLabel(localizer(locale, "commands.personal.spotlight.set.finish_button"))
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(autoTriggerButtonId)
            .setLabel(localizer(locale, "commands.personal.spotlight.set.auto_trigger_button"))
            .setStyle(ButtonStyle.Primary),
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });

    const replyMessage = await modalInteraction.fetchReply();
    let buttonInteraction: ButtonInteraction;
    try {
      buttonInteraction = await replyMessage.awaitMessageComponent({
        filter: (componentInteraction) =>
          componentInteraction.user.id === interaction.user.id &&
          (componentInteraction.customId === finishButtonId || componentInteraction.customId === autoTriggerButtonId),
        componentType: ComponentType.Button,
        time: 300_000,
      });
    } catch {
      await modalInteraction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "general.interaction.timeout_title"))
            .setDescription(localizer(locale, "general.interaction.timeout_description"))
            .setColor(ColorCode.WARN),
        ],
        components: [],
      });
      return;
    }

    let finalAutoTriggerPersonaId: number | null = null;
    if (buttonInteraction.customId === finishButtonId) {
      await buttonInteraction.deferUpdate();
    } else if (selectedPersonas.length === 1) {
      await buttonInteraction.deferUpdate();
      finalAutoTriggerPersonaId = selectedPersonas[0]?.persona_id ?? null;
    } else {
      const autoTriggerModalResult =
        selectedPersonas.length <= MAX_OPTIONS_PER_GROUP
          ? await promptWithRawModal(buttonInteraction, locale, {
              modalCustomId: `personal_spotlight_auto_modal_${interaction.id}`,
              modalTitleKey: "commands.personal.spotlight.set.auto_modal_title",
              components: [
                {
                  kind: "radioGroup",
                  customId: AUTO_TRIGGER_INPUT_ID,
                  labelKey: "commands.personal.spotlight.set.auto_select_label",
                  descriptionKey: "commands.personal.spotlight.set.auto_select_description",
                  required: true,
                  options: buildAutoTriggerRadioOptions(selectedPersonas),
                },
              ],
            })
          : await promptWithPaginatedModal(buttonInteraction, locale, {
              modalCustomId: `personal_spotlight_auto_modal_${interaction.id}`,
              modalTitleKey: "commands.personal.spotlight.set.auto_modal_title",
              components: [
                {
                  customId: AUTO_TRIGGER_INPUT_ID,
                  labelKey: "commands.personal.spotlight.set.auto_select_label",
                  descriptionKey: "commands.personal.spotlight.set.auto_select_description",
                  placeholder: localizer(locale, "commands.personal.spotlight.set.auto_select_placeholder"),
                  required: true,
                  options: buildAutoTriggerSelectOptions(selectedPersonas, locale),
                },
              ],
            });

      if (autoTriggerModalResult.outcome !== "submit" || !autoTriggerModalResult.interaction) {
        await modalInteraction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle(localizer(locale, "general.interaction.timeout_title"))
              .setDescription(localizer(locale, "general.interaction.timeout_description"))
              .setColor(ColorCode.WARN),
          ],
          components: [],
        });
        return;
      }

      await acknowledgeModalSubmitForRefresh(autoTriggerModalResult.interaction);
      finalAutoTriggerPersonaId = Number.parseInt(autoTriggerModalResult.values?.[AUTO_TRIGGER_INPUT_ID] ?? "", 10);
      if (!selectedPersonaIds.includes(finalAutoTriggerPersonaId)) {
        await modalInteraction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle(localizer(locale, "general.errors.invalid_option_title"))
              .setDescription(localizer(locale, "general.errors.invalid_option_description"))
              .setColor(ColorCode.ERROR),
          ],
          components: [],
        });
        return;
      }
    }

    const expiresAt = buildExpiresAt(hours);
    if (isNoOpPersonalSpotlightUpdate(currentSpotlight, selectedPersonaIds, finalAutoTriggerPersonaId, hours)) {
      await modalInteraction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "commands.personal.spotlight.set.no_changes_title"))
            .setDescription(
              [
                localizer(locale, "commands.personal.spotlight.set.no_changes_description"),
                buildSpotlightSummary({
                  locale,
                  channelId: selectedChannel.id,
                  durationText: formatDurationText(locale, hours, expiresAt),
                  personas: selectedPersonas,
                  autoTriggerText: formatAutoTriggerText(locale, selectedPersonas, finalAutoTriggerPersonaId),
                }),
              ].join("\n\n"),
            )
            .setColor(ColorCode.INFO),
        ],
        components: [],
      });
      return;
    }

    await userRepository.replacePersonalSpotlight(
      tomoriState.server_id,
      userData.user_id,
      selectedChannel.id,
      selectedPersonaIds,
      finalAutoTriggerPersonaId,
      expiresAt,
    );
    invalidatePersonalSpotlightCache(tomoriState.server_id, userData.user_id, selectedChannel.id);

    await modalInteraction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(localizer(locale, "commands.personal.spotlight.set.success_title"))
          .setDescription(
            [
              localizer(locale, "commands.personal.spotlight.set.success_description"),
              buildSpotlightSummary({
                locale,
                channelId: selectedChannel.id,
                durationText: formatDurationText(locale, hours, expiresAt),
                personas: selectedPersonas,
                autoTriggerText: formatAutoTriggerText(locale, selectedPersonas, finalAutoTriggerPersonaId),
              }),
            ].join("\n\n"),
          )
          .setColor(ColorCode.SUCCESS),
      ],
      components: [],
    });

    log.success(
      `Updated personal spotlight for user ${interaction.user.id} in guild ${interaction.guildId} for channel ${selectedChannel.id} with personas [${selectedPersonaIds.join(", ")}] and auto-trigger ${finalAutoTriggerPersonaId ?? "none"}`,
    );
  } catch (error) {
    await log.error("Error executing /personal spotlight set", error as Error, errorContext);
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
  }
}

function buildPersonaCheckboxGroups(
  personas: PersonaWithId[],
  selectedPersonaIds: Set<number>,
  locale: string,
): ModalCheckboxGroupField[] {
  const groups: ModalCheckboxGroupField[] = [];

  for (let index = 0; index < personas.length; index += MAX_OPTIONS_PER_GROUP) {
    const chunk = personas.slice(index, index + MAX_OPTIONS_PER_GROUP);
    const groupIndex = Math.floor(index / MAX_OPTIONS_PER_GROUP);
    groups.push({
      kind: "checkboxGroup",
      customId: `${CHECKBOX_ID_PREFIX}_${groupIndex}`,
      labelKey:
        groupIndex === 0
          ? "commands.personal.spotlight.set.checkbox_label"
          : "commands.personal.spotlight.set.checkbox_label_continued",
      descriptionKey: groupIndex === 0 ? "commands.personal.spotlight.set.checkbox_description" : undefined,
      minValues: 0,
      required: false,
      options: chunk.map((persona) => ({
        label: safeSelectOptionText(persona.persona_nickname),
        value: persona.persona_id.toString(),
        description: safeSelectOptionText(
          localizer(
            locale,
            persona.is_alter
              ? "commands.shared.persona_select.alter_persona_description"
              : "commands.shared.persona_select.main_persona_description",
          ),
        ),
        default: selectedPersonaIds.has(persona.persona_id),
      })),
    });
  }

  return groups;
}

function collectCheckedPersonaIds(multiValues: Record<string, string[]> | undefined, groupCount: number): number[] {
  const personaIds: number[] = [];

  for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
    const values = multiValues?.[`${CHECKBOX_ID_PREFIX}_${groupIndex}`] ?? [];
    for (const value of values) {
      const personaId = Number.parseInt(value, 10);
      if (Number.isInteger(personaId) && personaId > 0 && !personaIds.includes(personaId)) {
        personaIds.push(personaId);
      }
    }
  }

  return personaIds;
}

function buildExpiresAt(hours: number): Date | null {
  if (hours === 0) {
    return null;
  }

  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

function buildAutoTriggerRadioOptions(personas: PersonaWithId[]) {
  return personas.map((persona, index) => ({
    label: safeSelectOptionText(persona.persona_nickname),
    value: persona.persona_id.toString(),
    default: index === 0,
  }));
}

function buildAutoTriggerSelectOptions(personas: PersonaWithId[], locale: string): SelectOption[] {
  return personas.map((persona) => ({
    label: safeSelectOptionText(persona.persona_nickname),
    value: persona.persona_id.toString(),
    description: localizer(
      locale,
      persona.is_alter
        ? "commands.shared.persona_select.alter_persona_description"
        : "commands.shared.persona_select.main_persona_description",
    ),
  }));
}

function formatDurationText(locale: string, hours: number, expiresAt: Date | null): string {
  if (hours === 0 || !expiresAt) {
    return localizer(locale, "commands.personal.spotlight.set.duration_permanent");
  }

  return localizer(locale, "commands.personal.spotlight.set.duration_timed", {
    hours: hours.toString(),
    expires_at: `<t:${Math.floor(expiresAt.getTime() / 1000)}:F>`,
  });
}

function formatAutoTriggerText(locale: string, personas: PersonaWithId[], autoTriggerPersonaId: number | null): string {
  if (!autoTriggerPersonaId) {
    return localizer(locale, "commands.personal.spotlight.set.auto_trigger_none");
  }

  return (
    personas.find((persona) => persona.persona_id === autoTriggerPersonaId)?.persona_nickname ??
    autoTriggerPersonaId.toString()
  );
}

function formatPersonaList(locale: string, personas: PersonaWithId[]): string {
  const visiblePersonas = personas.slice(0, 8).map((persona) => `**${persona.persona_nickname}**`);
  if (personas.length > visiblePersonas.length) {
    visiblePersonas.push(
      localizer(locale, "commands.personal.spotlight.set.more_personas", {
        count: personas.length - visiblePersonas.length,
      }),
    );
  }

  return visiblePersonas.join(", ");
}

function buildSpotlightSummary({
  locale,
  channelId,
  durationText,
  personas,
  autoTriggerText,
}: {
  locale: string;
  channelId: string;
  durationText: string;
  personas: PersonaWithId[];
  autoTriggerText: string;
}): string {
  return [
    localizer(locale, "commands.personal.spotlight.set.summary_channel_line", {
      channel: `<#${channelId}>`,
    }),
    localizer(locale, "commands.personal.spotlight.set.summary_duration_line", {
      duration: durationText,
    }),
    localizer(locale, "commands.personal.spotlight.set.summary_personas_line", {
      personas: formatPersonaList(locale, personas),
    }),
    localizer(locale, "commands.personal.spotlight.set.summary_auto_trigger_line", {
      persona: autoTriggerText,
    }),
  ].join("\n");
}

function isNoOpPersonalSpotlightUpdate(
  currentSpotlight: Awaited<ReturnType<typeof getCachedPersonalSpotlightStatus>> | null,
  nextPersonaIds: number[],
  nextAutoTriggerPersonaId: number | null,
  hours: number,
): boolean {
  if (hours !== 0 || !currentSpotlight || currentSpotlight.expiresAt !== null) {
    return false;
  }

  if (currentSpotlight.autoTriggerPersonaId !== nextAutoTriggerPersonaId) {
    return false;
  }

  if (currentSpotlight.personaIds.length !== nextPersonaIds.length) {
    return false;
  }

  return currentSpotlight.personaIds.every((personaId, index) => personaId === nextPersonaIds[index]);
}
