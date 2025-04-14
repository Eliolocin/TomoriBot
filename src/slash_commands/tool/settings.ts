import {
	ApplicationCommandOptionType,
	ChatInputCommandInteraction,
	Client,
	EmbedBuilder,
	PermissionFlagsBits,
} from "discord.js";
import BotModel from "../../models/botSchema";
import UserModel from "../../models/userSchema";
import { Command, IUser, TeachPerms } from "../../types/global";
import { localizer } from "../../utils/textLocalizer";

const command: Command = {
	name: "settings",
	description: "Configure bot settings",
	category: "tool",
	options: [
		{
			name: "language",
			description: "Set your preferred language",
			type: ApplicationCommandOptionType.Subcommand,
			options: [
				{
					name: "pick",
					description: "Choose your language",
					type: ApplicationCommandOptionType.String,
					required: true,
					choices: [
						{ name: "English", value: "en" },
						{ name: "日本語 (Japanese)", value: "ja" },
					],
				},
			],
		},
		{
			name: "automsg",
			description: "Set auto-message frequency (0=disabled, min=30)",
			type: ApplicationCommandOptionType.Subcommand,
			options: [
				{
					name: "count",
					description: "Messages between auto-responses",
					type: ApplicationCommandOptionType.Integer,
					required: true,
				},
			],
		},
		{
			name: "teachperms",
			description: "Set who can use teaching commands",
			type: ApplicationCommandOptionType.Subcommand,
			options: [
				{
					name: "mode",
					description: "Permission mode",
					type: ApplicationCommandOptionType.String,
					required: true,
					choices: [
						{ name: "Channel Manager Only", value: TeachPerms.CHANNEL_MANAGER },
						{ name: "Priced (Costs TomoCoins)", value: TeachPerms.PRICED },
						{ name: "Free for All", value: TeachPerms.FREE },
					],
				},
			],
		},
		{
			name: "inputsanitizer",
			description: "Toggle input sanitization in chat responses",
			type: ApplicationCommandOptionType.Subcommand,
			options: [
				{
					name: "enabled",
					description: "Enable or disable input sanitization",
					type: ApplicationCommandOptionType.Boolean,
					required: true,
				},
			],
		},
	],

	callback: async (
		client: Client,
		interaction: ChatInputCommandInteraction,
		userData: IUser,
	): Promise<void> => {
		const subcommand = interaction.options.getSubcommand();
		const locale = userData.language || "en";

		try {
			switch (subcommand) {
				case "language":
					await handleLanguage(interaction, userData, locale);
					break;
				case "automsg":
					await handleAutomsg(interaction, locale);
					break;
				case "teachperms":
					await handleTeachPerms(interaction, locale);
					break;
				case "inputsanitizer":
					await handleInputSanitizer(interaction, locale);
					break;
			}
		} catch (error) {
			console.error("Settings Error:", error);
			const errorEmbed = new EmbedBuilder()
				.setColor("#E74C3C")
				.setTitle(localizer(locale, "tool.settings.error_title"))
				.setDescription(localizer(locale, "tool.settings.error_description"));
			await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
		}
	},
};

async function handleLanguage(
	interaction: ChatInputCommandInteraction,
	userData: IUser,
	locale: string,
): Promise<void> {
	const newLanguage = interaction.options.getString("pick", true);

	try {
		await UserModel.updateOne(
			{ userID: interaction.user.id },
			{ $set: { language: newLanguage } },
			{ upsert: true },
		);

		const embed = new EmbedBuilder()
			.setColor("#2ECC71")
			.setTitle(localizer(newLanguage, "tool.settings.language_success_title"))
			.setDescription(
				localizer(newLanguage, "tool.settings.language_success_description"),
			);

		await interaction.reply({ embeds: [embed], ephemeral: true });
	} catch (error) {
		throw error;
	}
}

async function handleAutomsg(
	interaction: ChatInputCommandInteraction,
	locale: string,
): Promise<void> {
	if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
		const embed = new EmbedBuilder()
			.setColor("#E74C3C")
			.setDescription(localizer(locale, "tool.settings.no_permission"));
		await interaction.reply({ embeds: [embed], ephemeral: true });
		return;
	}

	const count = interaction.options.getInteger("count", true);
	if (count !== 0 && count < 30) {
		const embed = new EmbedBuilder()
			.setColor("#E74C3C")
			.setDescription(localizer(locale, "tool.settings.automsg_minimum"));
		await interaction.reply({ embeds: [embed], ephemeral: true });
		return;
	}

	try {
		await BotModel.updateOne(
			{ serverID: interaction.guildId },
			{
				$set: {
					"settings.$[elem].value": count,
				},
			},
			{
				arrayFilters: [{ "elem.key": "automsg" }],
			},
		);

		const embed = new EmbedBuilder()
			.setColor("#2ECC71")
			.setTitle(localizer(locale, "tool.settings.automsg_success_title"))
			.setDescription(
				localizer(locale, "tool.settings.automsg_success_description", {
					count: count.toString(),
				}),
			);

		await interaction.reply({ embeds: [embed], ephemeral: true });
	} catch (error) {
		throw error;
	}
}

async function handleTeachPerms(
	interaction: ChatInputCommandInteraction,
	locale: string,
): Promise<void> {
	if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
		const embed = new EmbedBuilder()
			.setColor("#E74C3C")
			.setDescription(localizer(locale, "tool.settings.no_permission"));
		await interaction.reply({ embeds: [embed], ephemeral: true });
		return;
	}

	const mode = interaction.options.getString("mode", true) as TeachPerms;

	try {
		await BotModel.updateOne(
			{ serverID: interaction.guildId },
			{
				$set: {
					"settings.$[elem].value": mode,
				},
			},
			{
				arrayFilters: [{ "elem.key": "teachperms" }],
			},
		);

		const embed = new EmbedBuilder()
			.setColor("#2ECC71")
			.setTitle(localizer(locale, "tool.settings.teachperms_success_title"))
			.setDescription(
				localizer(locale, "tool.settings.teachperms_success_description", {
					mode,
				}),
			);

		await interaction.reply({ embeds: [embed], ephemeral: true });
	} catch (error) {
		throw error;
	}
}

async function handleInputSanitizer(
	interaction: ChatInputCommandInteraction,
	locale: string,
): Promise<void> {
	if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
		const embed = new EmbedBuilder()
			.setColor("#E74C3C")
			.setDescription(localizer(locale, "tool.settings.no_permission"));
		await interaction.reply({ embeds: [embed], ephemeral: true });
		return;
	}

	const enabled = interaction.options.getBoolean("enabled", true);

	try {
		await BotModel.updateOne(
			{ serverID: interaction.guildId },
			{
				$set: {
					"settings.$[elem].value": enabled,
				},
			},
			{
				arrayFilters: [{ "elem.key": "inputsanitizer" }],
			},
		);

		const embed = new EmbedBuilder()
			.setColor("#2ECC71")
			.setTitle(localizer(locale, "tool.settings.sanitizer_success_title"))
			.setDescription(
				localizer(locale, "tool.settings.sanitizer_success_description", {
					state: enabled ? "enabled" : "disabled",
				}),
			);

		await interaction.reply({ embeds: [embed], ephemeral: true });
	} catch (error) {
		throw error;
	}
}

export default command;
