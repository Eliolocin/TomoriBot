import {
  ApplicationCommandOptionType,
  AttachmentBuilder,
  EmbedBuilder,
  Client,
  ChatInputCommandInteraction,
  TextChannel,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  PermissionFlagsBits,
} from "discord.js";
import { Command, IUser, IBot, TeachPerms } from "../../types/global";
import { localizer } from "../../utils/textLocalizer";
import { convertMentionsToNicknames } from "../../utils/mentionConverter";
import BotModel from "../../models/botSchema";
import UserModel from "../../models/userSchema";
import fs from "fs";
import path from "path";

const INFO_PRICE = 50;
const CONVO_PRICE = 100;
const TRIGGER_PRICE = 30;

const command: Command = {
  name: "teach",
  description: "Teach the bot new information, conversations, names, and triggers",
  category: "tool",
  options: [
    {
      name: "info",
      description: "Add or remove bot information",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "action",
          description: "Choose to add or remove information",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: [
            { name: "Add Info", value: "add" },
            { name: "Remove Info", value: "remove" },
          ],
        },
      ],
    },
    {
      name: "convo",
      description: "Add or remove conversation examples",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "action",
          description: "Choose to add or remove conversation example",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: [
            { name: "Add Conversation", value: "add" },
            { name: "Remove Conversation", value: "remove" },
          ],
        },
      ],
    },
    {
      name: "trigger",
      description: "Add or remove bot trigger words",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "action",
          description: "Choose to add or remove trigger word",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: [
            { name: "Add Trigger", value: "add" },
            { name: "Remove Trigger", value: "remove" },
          ],
        },
        {
          name: "triggerword",
          description: "The trigger word to add (only for add action)",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
    {
      name: "nickname",
      description: "Teach the bot what to call you",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "name",
          description: "Your new nickname",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
    {
      name: "botname",
      description: "Teach the bot its new name",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "name",
          description: "The new name for the bot",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
    {
      name: "personality",
      description: "Change bot's personality directly",
      type: ApplicationCommandOptionType.Subcommand,
    },
    {
      name: "preset",
      description: "Change bot's personality to a preset",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "personality",
          description: "Choose a personality preset",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: [
            { name: "Default", value: "default" },
            { name: "Cutesy", value: "cutesy" },
            { name: "Calm", value: "calm" },
            { name: "Gremlin", value: "gremlin" },
            { name: "Yandere", value: "yandere" },
          ],
        },
      ],
    },
  ],

  callback: async (
    client: Client,
    interaction: ChatInputCommandInteraction,
    userData: IUser
  ): Promise<void> => {
    const subcommand = interaction.options.getSubcommand();
    const locale = userData.language || "en";

    try {
      const botData = await BotModel.findOne({
        serverID: interaction.guildId,
      });

      if (!botData) {
        throw new Error("Bot data not found");
      }

      const teachRestricted = ["info", "convo", "trigger"].includes(subcommand);
      if (teachRestricted) {
        const teachPerms = botData.settings.find((s: { key: string }) => s.key === "teachperms")?.value;
        
        switch (teachPerms) {
          case TeachPerms.CHANNEL_MANAGER:
            if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
              await interaction.reply({
                embeds: [
                  new EmbedBuilder()
                    .setColor("#E74C3C")
                    .setDescription(localizer(locale, "tool.teach.no_permission")),
                ],
                ephemeral: true,
              });
              return;
            }
            break;
    
          case TeachPerms.PRICED:
            let price = 0;
            if (subcommand === "info") price = INFO_PRICE;
            if (subcommand === "convo") price = CONVO_PRICE;
            if (subcommand === "trigger") price = TRIGGER_PRICE;
    
            if (userData.coins < price) {
              await interaction.reply({
                embeds: [
                  new EmbedBuilder()
                    .setColor("#E74C3C")
                    .setDescription(
                      localizer(locale, "tool.teach.insufficient_coins", { price })
                    ),
                ],
                ephemeral: true,
              });
              return;
            }
    
            userData.coins -= price;
            await UserModel.updateOne(
              { userID: userData.userID },
              { $set: { coins: userData.coins } }
            );
            break;
    
          case TeachPerms.FREE:
          default:
            break;
        }
      }

      switch (subcommand) {
        case "nickname":
          await handleNickname(interaction, userData, locale);
          break;
        case "botname":
          await handleBotname(interaction, botData, locale);
          break;
        case "info":
          const infoAction = interaction.options.getString("action", true);
          if (infoAction === "add") {
            await handleInfoAdd(interaction, botData, locale, client);
          } else {
            await handleInfoRemove(interaction, botData, locale);
          }
          break;
        case "convo":
          const convoAction = interaction.options.getString("action", true);
          if (convoAction === "add") {
            await handleConvoAdd(interaction, botData, locale, client);
          } else {
            await handleConvoRemove(interaction, botData, locale);
          }
          break;
        case "trigger":
          const triggerAction = interaction.options.getString("action", true);
          if (triggerAction === "add") {
            await handleTriggerAdd(interaction, botData, locale);
          } else {
            await handleTriggerRemove(interaction, botData, locale);
          }
          break;
        case "personality":
          await handlePersonality(interaction, botData, locale);
          break;
        case "preset":
          await handlePreset(interaction, botData, locale);
          break;
      }
    } catch (error) {
      console.error("Error in teach command:", error);
      const errorEmbed = new EmbedBuilder()
        .setColor("#E74C3C")
        .setTitle(localizer(locale, "tool.teach.error_title"))
        .setDescription(localizer(locale, "tool.teach.error_description"));

      await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
    }
  },
} as const;

function createCancelButton() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('cancel')
      .setLabel('❌ Cancel')
      .setStyle(ButtonStyle.Danger)
  );
}

async function handleInfoAdd(
  interaction: ChatInputCommandInteraction,
  botData: IBot,
  locale: string,
  client: Client
): Promise<void> {
  const promptEmbed = new EmbedBuilder()
    .setColor("#3498DB")
    .setTitle(localizer(locale, "tool.teach.info_prompt_title"))
    .setDescription(localizer(locale, "tool.teach.info_prompt_description"));

  await interaction.reply({ 
    embeds: [promptEmbed],
    components: [createCancelButton()]
  });
  
  if (!(interaction.channel instanceof TextChannel)) return;

  try {
    const messageFilter = (m: any) => m.author.id === interaction.user.id;
    const buttonFilter = (i: any) => 
      i.user.id === interaction.user.id && i.customId === 'cancel';

    const messageCollector = interaction.channel.createMessageCollector({
      filter: messageFilter,
      time: 30000,
      max: 1
    });

    const buttonCollector = interaction.channel.createMessageComponentCollector({
      filter: buttonFilter,
      componentType: ComponentType.Button,
      time: 30000
    });

    buttonCollector.on('collect', async () => {
      messageCollector.stop('cancelled');
      buttonCollector.stop();
      const cancelEmbed = new EmbedBuilder()
        .setColor("#E74C3C")
        .setTitle(localizer(locale, "tool.teach.cancelled_title"))
        .setDescription(localizer(locale, "tool.teach.cancelled_description"));
      await interaction.editReply({ 
        embeds: [cancelEmbed], 
        components: [] 
      });
    });

    messageCollector.on('collect', async (message) => {
      buttonCollector.stop();
      const infoText = message.content;
      const convertedText = await convertMentionsToNicknames(
        infoText,
        interaction.guild?.id as string
      );

      botData.botDatabase.push(convertedText);
      await botData.save();

      const successEmbed = new EmbedBuilder()
        .setColor("#2ECC71")
        .setTitle(localizer(locale, "tool.teach.info_success_title"))
        .setDescription(
          localizer(locale, "tool.teach.info_success_description", {
            info: convertedText,
          })
        );

      await interaction.followUp({ embeds: [successEmbed], ephemeral: false });
    });

  } catch (error) {
    console.error("Error in handleInfoAdd:", error);
    const errorEmbed = new EmbedBuilder()
      .setColor("#E74C3C")
      .setTitle(localizer(locale, "tool.teach.error_title"))
      .setDescription(localizer(locale, "tool.teach.error_description"));

    await interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
  }
}

async function handleInfoRemove(
  interaction: ChatInputCommandInteraction,
  botData: IBot,
  locale: string
): Promise<void> {
  if (botData.botDatabase.length === 0) {
    const emptyEmbed = new EmbedBuilder()
      .setColor("#E74C3C")
      .setTitle(localizer(locale, "tool.teach.info_empty_title"))
      .setDescription(localizer(locale, "tool.teach.info_empty_description"));

    await interaction.reply({ embeds: [emptyEmbed], ephemeral: false });
    return;
  }

  const listEmbed = new EmbedBuilder()
    .setColor("#3498DB")
    .setTitle(localizer(locale, "tool.teach.info_list_title"))
    .setDescription(
      botData.botDatabase
        .map((info, index) => `${index + 1}. ${info}`)
        .join("\n")
    )
    .setFooter({
      text: localizer(locale, "tool.teach.remove_prompt"),
    });

  await interaction.reply({ embeds: [listEmbed], components: [createCancelButton()] });

  try {
    const messageFilter = (m: any) =>
      m.author.id === interaction.user.id &&
      !isNaN(parseInt(m.content)) &&
      parseInt(m.content) > 0 &&
      parseInt(m.content) <= botData.botDatabase.length;

    const buttonFilter = (i: any) => 
      i.user.id === interaction.user.id && i.customId === 'cancel';

    if (!(interaction.channel instanceof TextChannel)) return;

    const messageCollector = interaction.channel.createMessageCollector({
      filter: messageFilter,
      max: 1,
      time: 30000
    });

    const buttonCollector = interaction.channel.createMessageComponentCollector({
      filter: buttonFilter,
      componentType: ComponentType.Button,
      time: 30000
    });

    buttonCollector.on('collect', async () => {
      messageCollector.stop('cancelled');
      buttonCollector.stop();
      const cancelEmbed = new EmbedBuilder()
        .setColor("#E74C3C")
        .setTitle(localizer(locale, "tool.teach.cancelled_title"))
        .setDescription(localizer(locale, "tool.teach.cancelled_description"));
      await interaction.editReply({ 
        embeds: [cancelEmbed], 
        components: [] 
      });
    });

    messageCollector.on('collect', async (message) => {
      buttonCollector.stop();
      const index = parseInt(message.content) - 1;
      const removedInfo = botData.botDatabase[index];
      botData.botDatabase.splice(index, 1);
      await botData.save();

      const successEmbed = new EmbedBuilder()
        .setColor("#2ECC71")
        .setTitle(localizer(locale, "tool.teach.info_remove_success_title"))
        .setDescription(
          localizer(locale, "tool.teach.info_remove_success_description", {
            info: removedInfo,
          })
        );

      await interaction.followUp({ embeds: [successEmbed], ephemeral: false });
    });

  } catch (error) {
    const errorEmbed = new EmbedBuilder()
      .setColor("#E74C3C")
      .setTitle(localizer(locale, "tool.teach.error_title"))
      .setDescription(localizer(locale, "tool.teach.error_description"));

    await interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
  }
}

async function handleConvoAdd(
  interaction: ChatInputCommandInteraction,
  botData: IBot,
  locale: string,
  client: Client
): Promise<void> {
  const promptEmbed = new EmbedBuilder()
    .setColor("#3498DB")
    .setTitle(localizer(locale, "tool.teach.convo_prompt_title"))
    .setDescription(localizer(locale, "tool.teach.convo_prompt_description"));

  try {
    if (!(interaction.channel instanceof TextChannel)) return;
    const messageFilter = (m: any) => m.author.id === interaction.user.id;
    const buttonFilter = (i: any) => 
      i.user.id === interaction.user.id && i.customId === 'cancel';

    const messageCollector = interaction.channel.createMessageCollector({
      filter: messageFilter,
      max: 1,
      time: 30000
    });

    const buttonCollector = interaction.channel.createMessageComponentCollector({
      filter: buttonFilter,
      componentType: ComponentType.Button,
      time: 30000
    });

    buttonCollector.on('collect', async () => {
      messageCollector.stop('cancelled');
      buttonCollector.stop();
      const cancelEmbed = new EmbedBuilder()
        .setColor("#E74C3C")
        .setTitle(localizer(locale, "tool.teach.cancelled_title"))
        .setDescription(localizer(locale, "tool.teach.cancelled_description"));
      await interaction.editReply({ 
        embeds: [cancelEmbed], 
        components: [] 
      });
    });

    messageCollector.on('collect', async (message) => {
      buttonCollector.stop();
      const convoText = message.content;
      const convertedText = await convertMentionsToNicknames(
        convoText,
        interaction.guild?.id as string
      );
      const [input, output] = convertedText.split("|").map((text) => text.trim());

      botData.conversationExamples.push({ input, output });
      await botData.save();

      const successEmbed = new EmbedBuilder()
        .setColor("#2ECC71")
        .setTitle(localizer(locale, "tool.teach.convo_success_title"))
        .setDescription(
          localizer(locale, "tool.teach.convo_success_description", {
            convo: convertedText,
          })
        );

      await interaction.followUp({ embeds: [successEmbed], ephemeral: false });
    });

  } catch (error) {
    console.error("Error in handleConvoAdd:", error);
    const errorEmbed = new EmbedBuilder()
      .setColor("#E74C3C")
      .setTitle(localizer(locale, "tool.teach.error_title"))
      .setDescription(localizer(locale, "tool.teach.error_description"));

    await interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
  }
}

async function handleConvoRemove(
  interaction: ChatInputCommandInteraction,
  botData: IBot,
  locale: string
): Promise<void> {
  if (botData.conversationExamples.length === 0) {
    const emptyEmbed = new EmbedBuilder()
      .setColor("#E74C3C")
      .setTitle(localizer(locale, "tool.teach.convo_empty_title"))
      .setDescription(localizer(locale, "tool.teach.convo_empty_description"));

    await interaction.reply({ embeds: [emptyEmbed], ephemeral: false });
    return;
  }

  const listEmbed = new EmbedBuilder()
    .setColor("#3498DB")
    .setTitle(localizer(locale, "tool.teach.convo_list_title"))
    .setDescription(
      botData.conversationExamples
        .map(
          (convo, index) =>
            `${index + 1}.\nQ: ${convo.input}\nA: ${convo.output}`
        )
        .join("\n\n")
    )
    .setFooter({
      text: localizer(locale, "tool.teach.remove_prompt"),
    });

  await interaction.reply({ embeds: [listEmbed], components: [createCancelButton()] });

  try {
    if (!(interaction.channel instanceof TextChannel)) return;
    const messageFilter = (m: any) =>
      m.author.id === interaction.user.id &&
      !isNaN(parseInt(m.content)) &&
      parseInt(m.content) > 0 &&
      parseInt(m.content) <= botData.conversationExamples.length;

    const buttonFilter = (i: any) => 
      i.user.id === interaction.user.id && i.customId === 'cancel';

    const messageCollector = interaction.channel.createMessageCollector({
      filter: messageFilter,
      max: 1,
      time: 30000
    });

    const buttonCollector = interaction.channel.createMessageComponentCollector({
      filter: buttonFilter,
      componentType: ComponentType.Button,
      time: 30000
    });

    buttonCollector.on('collect', async () => {
      messageCollector.stop('cancelled');
      buttonCollector.stop();
      const cancelEmbed = new EmbedBuilder()
        .setColor("#E74C3C")
        .setTitle(localizer(locale, "tool.teach.cancelled_title"))
        .setDescription(localizer(locale, "tool.teach.cancelled_description"));
      await interaction.editReply({ 
        embeds: [cancelEmbed], 
        components: [] 
      });
    });

    messageCollector.on('collect', async (message) => {
      buttonCollector.stop();
      const index = parseInt(message.content) - 1;
      const removedConvo = botData.conversationExamples[index];
      botData.conversationExamples.splice(index, 1);
      await botData.save();

      const successEmbed = new EmbedBuilder()
        .setColor("#2ECC71")
        .setTitle(localizer(locale, "tool.teach.convo_remove_success_title"))
        .setDescription(
          localizer(locale, "tool.teach.convo_remove_success_description", {
            question: removedConvo.input,
            answer: removedConvo.output,
          })
        );

      await interaction.followUp({ embeds: [successEmbed], ephemeral: false });
    });

  } catch (error) {
    const errorEmbed = new EmbedBuilder()
      .setColor("#E74C3C")
      .setTitle(localizer(locale, "tool.teach.error_title"))
      .setDescription(localizer(locale, "tool.teach.error_description"));

    await interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
  }
}

async function handleTriggerAdd(
  interaction: ChatInputCommandInteraction,
  botData: IBot,
  locale: string
): Promise<void> {
  const triggerWord = interaction.options.getString("triggerword");
  
  if (!triggerWord) {
    const errorEmbed = new EmbedBuilder()
      .setColor("#E74C3C")
      .setTitle(localizer(locale, "tool.teach.trigger_error_title"))
      .setDescription(localizer(locale, "tool.teach.trigger_missing_word"));
    await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
    return;
  }

  if (botData.triggers.includes(triggerWord.toLowerCase())) {
    const errorEmbed = new EmbedBuilder()
      .setColor("#E74C3C")
      .setTitle(localizer(locale, "tool.teach.trigger_error_title"))
      .setDescription(localizer(locale, "tool.teach.trigger_duplicate"));
    await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
    return;
  }

  botData.triggers.push(triggerWord.toLowerCase());
  await botData.save();

  const successEmbed = new EmbedBuilder()
    .setColor("#2ECC71")
    .setTitle(localizer(locale, "tool.teach.trigger_success_title"))
    .setDescription(
      localizer(locale, "tool.teach.trigger_success_description", {
        trigger: triggerWord,
      })
    );

  await interaction.reply({ embeds: [successEmbed], ephemeral: false });
}

async function handleTriggerRemove(
  interaction: ChatInputCommandInteraction,
  botData: IBot,
  locale: string
): Promise<void> {
  if (botData.triggers.length === 0) {
    const emptyEmbed = new EmbedBuilder()
      .setColor("#E74C3C")
      .setTitle(localizer(locale, "tool.teach.trigger_empty_title"))
      .setDescription(localizer(locale, "tool.teach.trigger_empty_description"));

    await interaction.reply({ embeds: [emptyEmbed], ephemeral: false });
    return;
  }

  const listEmbed = new EmbedBuilder()
    .setColor("#3498DB")
    .setTitle(localizer(locale, "tool.teach.trigger_list_title"))
    .setDescription(
      botData.triggers
        .map((trigger, index) => `${index + 1}. ${trigger}`)
        .join("\n")
    )
    .setFooter({
      text: localizer(locale, "tool.teach.remove_prompt"),
    });

  await interaction.reply({ embeds: [listEmbed], components: [createCancelButton()] });

  try {
    const messageFilter = (m: any) =>
      m.author.id === interaction.user.id &&
      !isNaN(parseInt(m.content)) &&
      parseInt(m.content) > 0 &&
      parseInt(m.content) <= botData.triggers.length;

    const buttonFilter = (i: any) => 
      i.user.id === interaction.user.id && i.customId === 'cancel';

    if (!(interaction.channel instanceof TextChannel)) return;

    const messageCollector = interaction.channel.createMessageCollector({
      filter: messageFilter,
      max: 1,
      time: 30000
    });

    const buttonCollector = interaction.channel.createMessageComponentCollector({
      filter: buttonFilter,
      componentType: ComponentType.Button,
      time: 30000
    });

    buttonCollector.on('collect', async () => {
      messageCollector.stop('cancelled');
      buttonCollector.stop();
      const cancelEmbed = new EmbedBuilder()
        .setColor("#E74C3C")
        .setTitle(localizer(locale, "tool.teach.cancelled_title"))
        .setDescription(localizer(locale, "tool.teach.cancelled_description"));
      await interaction.editReply({ 
        embeds: [cancelEmbed], 
        components: [] 
      });
    });

    messageCollector.on('collect', async (message) => {
      buttonCollector.stop();
      const index = parseInt(message.content) - 1;
      const removedTrigger = botData.triggers[index];
      botData.triggers.splice(index, 1);
      await botData.save();

      const successEmbed = new EmbedBuilder()
        .setColor("#2ECC71")
        .setTitle(localizer(locale, "tool.teach.trigger_remove_success_title"))
        .setDescription(
          localizer(locale, "tool.teach.trigger_remove_success_description", {
            trigger: removedTrigger,
          })
        );

      await interaction.followUp({ embeds: [successEmbed], ephemeral: false });
    });

  } catch (error) {
    const errorEmbed = new EmbedBuilder()
      .setColor("#E74C3C")
      .setTitle(localizer(locale, "tool.teach.error_title"))
      .setDescription(localizer(locale, "tool.teach.error_description"));

    await interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
  }
}

async function handleNickname(
  interaction: ChatInputCommandInteraction,
  userData: IUser,
  locale: string
): Promise<void> {
  const newNickname = interaction.options.getString("name", true);

  try {
    await UserModel.updateOne(
      { userID: interaction.user.id },
      { $set: { nickname: newNickname } },
      { upsert: true }
    );

    const embed = new EmbedBuilder()
      .setColor("#2ECC71")
      .setTitle(localizer(locale, "tool.teach.nickname_success_title"))
      .setDescription(
        localizer(locale, "tool.teach.nickname_success_description", {
          nickname: newNickname,
        })
      );

    await interaction.reply({ embeds: [embed], ephemeral: false });
  } catch (err) {
    console.error("Error in nickname command:", err);
    const embed = new EmbedBuilder()
      .setColor("#E74C3C")
      .setTitle(localizer(locale, "tool.teach.nickname_error_title"))
      .setDescription(localizer(locale, "tool.teach.nickname_error_description"));

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
}

async function handleBotname(
  interaction: ChatInputCommandInteraction,
  botData: IBot,
  locale: string
): Promise<void> {
  const newName = interaction.options.getString("name", true);

  try {
    botData.botName = newName;
    await botData.save();

    const embed = new EmbedBuilder()
      .setColor("#2ECC71")
      .setTitle(localizer(locale, "tool.teach.botname_success_title"))
      .setDescription(
        localizer(locale, "tool.teach.botname_success_description", {
          name: newName,
        })
      );

    await interaction.reply({ embeds: [embed], ephemeral: false });
  } catch (err) {
    console.error("Error in botname command:", err);
    const embed = new EmbedBuilder()
      .setColor("#E74C3C")
      .setTitle(localizer(locale, "tool.teach.botname_error_title"))
      .setDescription(localizer(locale, "tool.teach.botname_error_description"));

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
}
async function handlePersonality(
  interaction: ChatInputCommandInteraction,
  botData: IBot,
  locale: string
): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
    const embed = new EmbedBuilder()
      .setColor("#E74C3C")
      .setDescription(localizer(locale, "tool.teach.no_permission"));
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  const promptEmbed = new EmbedBuilder()
    .setColor("#3498DB")
    .setTitle(localizer(locale, "tool.teach.personality_prompt_title"))
    .setDescription(localizer(locale, "tool.teach.personality_prompt_description"))
    .setFooter({
      text: localizer(locale, "tool.teach.personality_warning")
    });

  await interaction.reply({
    embeds: [promptEmbed],
    components: [createCancelButton()],
    ephemeral: false
  });

  if (!(interaction.channel instanceof TextChannel)) return;

  try {
    const messageFilter = (m: { author: { id: string }; content: string }) =>
      m.author.id === interaction.user.id;
    const buttonFilter = (i: { user: { id: string }; customId: string }) =>
      i.user.id === interaction.user.id && i.customId === 'cancel';

    const messageCollector = interaction.channel.createMessageCollector({
      filter: messageFilter,
      time: 300000,
      max: 1
    });

    const buttonCollector = interaction.channel.createMessageComponentCollector({
      filter: buttonFilter,
      componentType: ComponentType.Button,
      time: 300000
    });

    buttonCollector.on('collect', async () => {
      messageCollector.stop('cancelled');
      buttonCollector.stop();
      const cancelEmbed = new EmbedBuilder()
        .setColor("#E74C3C")
        .setTitle(localizer(locale, "tool.teach.cancelled_title"))
        .setDescription(localizer(locale, "tool.teach.cancelled_description"));
      await interaction.editReply({
        embeds: [cancelEmbed],
        components: []
      });
    });

    messageCollector.on('collect', async (message) => {
      buttonCollector.stop();
      const personalityText = message.content;
      const convertedText = await convertMentionsToNicknames(
        personalityText,
        interaction.guild?.id || ''
      );

      // Create backup before updating
      const oldPersonality = botData.botPersonality;

      // Update personality
      botData.botPersonality = convertedText;
      await botData.save();

      const backupAttachment = new AttachmentBuilder(
        Buffer.from(JSON.stringify({ oldPersonality }, null, 2)),
        { name: 'personality_backup.json' }
      );

      const successEmbed = new EmbedBuilder()
        .setColor("#2ECC71")
        .setTitle(localizer(locale, "tool.teach.personality_success_title"))
        .setDescription(
          localizer(locale, "tool.teach.personality_success_description")
        );

      await interaction.editReply({
        embeds: [successEmbed],
        components: [],
        files: [backupAttachment]
      });
    });

    messageCollector.on('end', async (collected) => {
      if (collected.size === 0) {
        const timeoutEmbed = new EmbedBuilder()
          .setColor("#E74C3C")
          .setTitle(localizer(locale, "tool.teach.preset_timeout_title"))
          .setDescription(localizer(locale, "tool.teach.preset_timeout_description"));

        await interaction.editReply({
          embeds: [timeoutEmbed],
          components: []
        });
      }
    });
  } catch (error) {
    console.error("Error in personality command:", error);
    const errorEmbed = new EmbedBuilder()
      .setColor("#E74C3C")
      .setTitle(localizer(locale, "tool.teach.error_title"))
      .setDescription(localizer(locale, "tool.teach.error_description"));

    if (!interaction.replied) {
      await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
    } else {
      await interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
    }
  }
}

async function handlePreset(
  interaction: ChatInputCommandInteraction,
  botData: IBot,
  locale: string
): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
    const embed = new EmbedBuilder()
      .setColor("#E74C3C")
      .setDescription(localizer(locale, "tool.teach.no_permission"));
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  const personality = interaction.options.getString("personality", true);
  const personaFilePath = locale === "ja"
    ? path.resolve(__dirname, "../../defaults/jaPersona.json")
    : path.resolve(__dirname, "../../defaults/enPersona.json");

  try {
    const defaultData = JSON.parse(fs.readFileSync(personaFilePath, "utf-8"));
    const personalityData = defaultData[personality];
    const generalInfo = Array.isArray(defaultData.generalInfo) ? defaultData.generalInfo : [];

    if (!personalityData || !Array.isArray(personalityData.botPersonality) || !Array.isArray(personalityData.conversationExamples)) {
      throw new Error("Invalid personality preset data");
    }

    // Save old data for backup
    const oldData = {
      conversationExamples: botData.conversationExamples,
      botPersonality: botData.botPersonality,
    };

    // Create confirmation buttons
    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('confirm')
          .setLabel('✔ Confirm')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('cancel')
          .setLabel('✖ Cancel')
          .setStyle(ButtonStyle.Danger)
      );

    // Create confirmation embed
    const confirmEmbed = new EmbedBuilder()
      .setColor("#3498DB")
      .setTitle(localizer(locale, "tool.teach.preset_confirm_title"))
      .setDescription(localizer(locale, "tool.teach.preset_confirm_description", {
        personality: personality
      }));

    const response = await interaction.reply({
      embeds: [confirmEmbed],
      components: [row],
      ephemeral: false
    });

    const collector = response.createMessageComponentCollector<ComponentType.Button>({
      filter: (i) => i.user.id === interaction.user.id,
      time: 30000,
      max: 1
    });

    collector.on('collect', async (i) => {
      if (i.customId === 'confirm') {
        // Update with new personality
        botData.conversationExamples = personalityData.conversationExamples;
        botData.botPersonality = [...generalInfo, ...personalityData.botPersonality].join('\n');
        await botData.save();

        // Create backup file
        const backupData = JSON.stringify(oldData, null, 2);
        const backupAttachment = new AttachmentBuilder(
          Buffer.from(backupData),
          { name: 'personality_backup.json' }
        );

        // Send success message with backup file
        const successEmbed = new EmbedBuilder()
          .setColor("#2ECC71")
          .setTitle(localizer(locale, "tool.teach.preset_success_title"))
          .setDescription(localizer(locale, "tool.teach.preset_success_description", {
            personality: personality
          }));

        await i.update({
          embeds: [successEmbed],
          components: [],
          files: [backupAttachment]
        });
      } else {
        const cancelEmbed = new EmbedBuilder()
          .setColor("#E74C3C")
          .setTitle(localizer(locale, "tool.teach.cancelled_title"))
          .setDescription(localizer(locale, "tool.teach.cancelled_description"));

        await i.update({
          embeds: [cancelEmbed],
          components: []
        });
      }
    });

    collector.on('end', async (collected) => {
      if (collected.size === 0) {
        const timeoutEmbed = new EmbedBuilder()
          .setColor("#E74C3C")
          .setTitle(localizer(locale, "tool.teach.preset_timeout_title"))
          .setDescription(localizer(locale, "tool.teach.preset_timeout_description"));

        await interaction.editReply({
          embeds: [timeoutEmbed],
          components: []
        });
      }
    });
  } catch (error) {
    console.error("Error in preset command:", error);
    const errorEmbed = new EmbedBuilder()
      .setColor("#E74C3C")
      .setTitle(localizer(locale, "tool.teach.preset_error_title"))
      .setDescription(localizer(locale, "tool.teach.preset_error_description"));

    await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
  }
}

export default command;

