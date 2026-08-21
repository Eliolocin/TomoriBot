import type { Client, ChatInputCommandInteraction, UserSelectMenuInteraction } from "discord.js";
import {
  MessageFlags,
  type SlashCommandSubcommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  UserSelectMenuBuilder,
  ComponentType,
} from "discord.js";
import { localizer } from "@/utils/text/localizer";
import { ColorCode, log } from "@/utils/misc/logger";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { promptWithPaginatedModal, safeSelectOptionText } from "@/utils/discord/ui/modals";
import { personaRepository } from "@/utils/db/repositories";
import { getCachedWhitelistStatus } from "@/utils/cache/channelWhitelistCache";
import { getCachedPersonalSpotlightStatus } from "@/utils/cache/personalSpotlightCache";
import { filterPersonasForTrigger } from "@/utils/persona/personaAccess";
import type { SelectOption } from "@/types/discord/modal";
import type { UserRow } from "@/types/db/schema";
import {
  executePersonaImpersonation,
  executeUserImpersonation,
  executeSystemImpersonation,
} from "@/utils/impersonate/impersonateOperations";

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) => {
  return subcommand
    .setName("impersonate")
    .setDescription(localizer("en-US", "commands.impersonate.description"))
    .addStringOption((option) =>
      option
        .setName("target")
        .setDescription(localizer("en-US", "commands.impersonate.target_description"))
        .setRequired(true)
        .addChoices(
          {
            name: localizer("en-US", "commands.impersonate.target_persona"),
            value: "persona",
          },
          {
            name: localizer("en-US", "commands.impersonate.target_user"),
            value: "user",
          },
          {
            name: localizer("en-US", "commands.impersonate.target_system"),
            value: "system",
          },
        ),
    );
};

async function handleTargetUserImpersonation(
  client: Client,
  interaction: ChatInputCommandInteraction,
  locale: string,
): Promise<void> {
  const userSelect = new UserSelectMenuBuilder()
    .setCustomId("impersonate_target_user_select")
    .setPlaceholder(localizer(locale, "commands.impersonate.user_select_placeholder"))
    .setMinValues(1)
    .setMaxValues(1);

  const selectEmbed = new EmbedBuilder()
    .setTitle(localizer(locale, "commands.impersonate.user_select_title"))
    .setDescription(localizer(locale, "commands.impersonate.user_select_description"))
    .setColor(ColorCode.INFO);

  await interaction.reply({
    embeds: [selectEmbed],
    components: [new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(userSelect)],
    flags: MessageFlags.Ephemeral,
  });

  const promptMessage = await interaction.fetchReply();
  let userSelectInteraction: UserSelectMenuInteraction;

  try {
    userSelectInteraction = await promptMessage.awaitMessageComponent({
      componentType: ComponentType.UserSelect,
      filter: (i: UserSelectMenuInteraction) => i.user.id === interaction.user.id,
      time: 60_000,
    });
  } catch (_error) {
    log.warn(`[/bot impersonate user] User select prompt timed out for user ${interaction.user.id}`);
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.interaction.timeout_title",
      descriptionKey: "general.interaction.timeout_description",
      color: ColorCode.WARN,
    });
    return;
  }

  await userSelectInteraction.deferUpdate();
  await interaction.editReply({ components: [] });

  const selectedUserId = userSelectInteraction.values[0];
  const selectedUser = userSelectInteraction.users.get(selectedUserId);
  const selectedMember = interaction.guild?.members.cache.get(selectedUserId);
  const selectedDisplayName =
    selectedMember?.displayName || selectedUser?.displayName || selectedUser?.username || "User";

  await executeUserImpersonation(client, interaction, locale, selectedUserId, selectedDisplayName);
}

async function handlePersonaImpersonation(
  client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.guildId || !interaction.channel) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.impersonate.missing_permissions_title",
      descriptionKey: "commands.impersonate.missing_permissions_description",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const serverId = interaction.guildId;
  const channel = interaction.channel;
  const invokingMember = interaction.member as import("discord.js").GuildMember | null;

  const allPersonas = await personaRepository.loadAllForServer(serverId);
  if (!allPersonas || allPersonas.length === 0) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.impersonate.no_personas_title",
      descriptionKey: "commands.impersonate.no_personas_description",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const isThread = "isThread" in channel && typeof channel.isThread === "function" && channel.isThread();
  const parentChannelId = isThread && "parent" in channel ? channel.parent?.id : undefined;
  const whitelistStatus = await getCachedWhitelistStatus(
    serverId,
    channel.id,
    invokingMember?.roles.cache.map((role) => role.id),
    parentChannelId,
  );

  const tomoriState = allPersonas.find((persona) => !persona.is_alter) ?? allPersonas[0];
  const personalSpotlightStatus = userData.user_id
    ? await getCachedPersonalSpotlightStatus(
        tomoriState?.server_id ?? 0,
        userData.user_id,
        parentChannelId ?? channel.id,
      )
    : null;

  const availablePersonas = filterPersonasForTrigger(allPersonas, whitelistStatus, personalSpotlightStatus);
  if (availablePersonas.length === 0) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.message_cooldown_title",
      descriptionKey: "commands.impersonate.persona_access_blocked",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const personaSelectOptions: SelectOption[] = availablePersonas.map((persona, index) => ({
    label: safeSelectOptionText(persona.persona_nickname),
    value: index.toString(),
    description: persona.is_alter ? "Alter Persona" : "Main Persona",
  }));

  const modalResult = await promptWithPaginatedModal(interaction, locale, {
    modalCustomId: "impersonate_persona_modal",
    modalTitleKey: "commands.impersonate.persona_modal_title",
    components: [
      {
        customId: "persona_select",
        labelKey: "commands.impersonate.persona_select_label",
        placeholder: localizer(locale, "commands.impersonate.persona_select_placeholder"),
        required: true,
        options: personaSelectOptions,
      },
      {
        customId: "message_content",
        labelKey: "commands.impersonate.persona_message_label",
        placeholder: localizer(locale, "commands.impersonate.persona_message_placeholder"),
        required: true,
        minLength: 1,
        maxLength: 2000,
        style: 2,
      },
    ],
  });

  if (modalResult.outcome !== "submit" || !modalResult.values || !modalResult.interaction) {
    return;
  }

  if (!modalResult.interaction.deferred && !modalResult.interaction.replied) {
    await modalResult.interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  const selectedIndex = Number.parseInt(modalResult.values.persona_select || "0", 10);
  const messageContent = modalResult.values.message_content || "";
  const selectedPersona = availablePersonas[selectedIndex];

  if (!selectedPersona?.persona_id) {
    return;
  }

  await executePersonaImpersonation(
    client,
    modalResult.interaction,
    userData,
    locale,
    selectedPersona.persona_id,
    messageContent,
  );
}

async function handleSystemImpersonation(interaction: ChatInputCommandInteraction, locale: string): Promise<void> {
  const modalResult = await promptWithPaginatedModal(interaction, locale, {
    modalCustomId: "impersonate_system_modal",
    modalTitleKey: "commands.impersonate.system_modal_title",
    components: [
      {
        customId: "system_content",
        labelKey: "commands.impersonate.system_content_label",
        placeholder: localizer(locale, "commands.impersonate.system_content_placeholder"),
        required: true,
        minLength: 1,
        maxLength: 2000,
        style: 2,
      },
    ],
  });

  if (modalResult.outcome !== "submit" || !modalResult.values || !modalResult.interaction) {
    return;
  }

  if (!modalResult.interaction.deferred && !modalResult.interaction.replied) {
    await modalResult.interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  const systemContent = modalResult.values.system_content || "";

  await executeSystemImpersonation(modalResult.interaction, locale, systemContent);
}

export async function execute(
  client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.guildId) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.guild_only_title",
      descriptionKey: "general.errors.guild_only_description",
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const target = interaction.options.getString("target", true);
  switch (target) {
    case "persona":
      await handlePersonaImpersonation(client, interaction, userData, locale);
      break;
    case "user":
      await handleTargetUserImpersonation(client, interaction, locale);
      break;
    case "system":
      await handleSystemImpersonation(interaction, locale);
      break;
    default:
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.invalid_option_title",
        descriptionKey: "general.errors.invalid_option_description",
        color: ColorCode.ERROR,
      });
      break;
  }
}
