import {
	ApplicationCommandOptionType,
	ChatInputCommandInteraction,
	Client,
	EmbedBuilder,
} from "discord.js";
import UserModel from "../../models/userSchema";
import { Command, IUser } from "../../types/global";
import { localizer } from "../../utils/textLocalizer";

const command: Command = {
	name: "donate",
	description:
		"Donate TomoCoins to another user's bank | 他のユーザーの銀行にTomoCoinsを寄付します",
	category: "economy",
	options: [
		{
			name: "recipient",
			description: "User you want to donate to | 寄付したいユーザー",
			type: ApplicationCommandOptionType.User,
			required: true,
		},
		{
			name: "amount",
			description: "Amount to be donated | 寄付する金額",
			type: ApplicationCommandOptionType.Integer,
			required: true,
		},
	],

	callback: async (
		client: Client,
		interaction: ChatInputCommandInteraction,
		userData: IUser,
	): Promise<void> => {
		await interaction.deferReply();
		const locale = userData.language || "en";

		const recipient = interaction.options.getUser("recipient", true);
		const donationAmount = interaction.options.getInteger("amount", true);

		if (donationAmount <= 0) {
			const embed = new EmbedBuilder()
				.setColor("#FF0000")
				.setTitle(localizer(locale, "economy.donate.invalid_amount_title"))
				.setDescription(
					localizer(locale, "economy.donate.invalid_amount_description"),
				)
				.setFooter({
					text: localizer(locale, "economy.donate.invalid_amount_footer"),
				});

			await interaction.editReply({ embeds: [embed] });
			return;
		}

		if (donationAmount > userData.coins) {
			const embed = new EmbedBuilder()
				.setColor("#FF0000")
				.setTitle(localizer(locale, "economy.donate.insufficient_funds_title"))
				.setDescription(
					localizer(locale, "economy.donate.insufficient_funds_description", {
						wallet_balance: userData.coins,
						attempted: donationAmount,
					}),
				)
				.setFooter({
					text: localizer(locale, "economy.donate.insufficient_funds_footer"),
				});

			await interaction.editReply({ embeds: [embed] });
			return;
		}

		let recipientUser = await UserModel.findOne({
			userID: recipient.id,
			serverID: interaction.guildId,
		});

		if (!recipientUser) {
			recipientUser = await UserModel.create({
				userID: recipient.id,
				serverID: interaction.guildId,
				nickname: recipient.username,
				coins: 0,
				bank: 0,
			});
		}

		await UserModel.bulkWrite([
			{
				updateOne: {
					filter: { userID: interaction.user.id },
					update: { $inc: { coins: -donationAmount } },
				},
			},
			{
				updateOne: {
					filter: { userID: recipient.id },
					update: { $inc: { bank: donationAmount } },
				},
			},
		]);

		const embed = new EmbedBuilder()
			.setColor("#00FF00")
			.setAuthor({
				name: interaction.user.username,
				iconURL: interaction.user.displayAvatarURL({ forceStatic: false }),
			})
			.setTitle(localizer(locale, "economy.donate.success_title"))
			.setDescription(
				localizer(locale, "economy.donate.success_description", {
					amount: donationAmount,
					recipient: recipient.username,
					wallet_balance: userData.coins - donationAmount,
				}),
			)
			.setFooter({ text: localizer(locale, "economy.donate.success_footer") });

		await interaction.editReply({ embeds: [embed] });
	},
} as const;

export default command;
