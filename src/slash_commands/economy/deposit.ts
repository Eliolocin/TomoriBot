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
	name: "deposit",
	description:
		"Deposit your TomoCoins into your bank | トモコインを銀行に預けます",
	category: "economy",
	options: [
		{
			name: "amount",
			description:
				"The amount of TomoCoins you wish to deposit | 預金したいTomoCoinsの金額",
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
		const depositAmount = interaction.options.getInteger("amount", true);

		if (depositAmount <= 0) {
			const embed = new EmbedBuilder()
				.setColor("#FF0000")
				.setTitle(localizer(locale, "economy.deposit.invalid_amount_title"))
				.setDescription(
					localizer(locale, "economy.deposit.invalid_amount_description"),
				)
				.setFooter({
					text: localizer(locale, "economy.deposit.invalid_amount_footer"),
				});

			await interaction.editReply({ embeds: [embed] });
			return;
		}

		if (depositAmount > userData.coins) {
			const embed = new EmbedBuilder()
				.setColor("#FF0000")
				.setTitle(localizer(locale, "economy.deposit.insufficient_funds_title"))
				.setDescription(
					localizer(locale, "economy.deposit.insufficient_funds_description", {
						wallet_balance: userData.coins,
						attempted: depositAmount,
					}),
				)
				.setFooter({
					text: localizer(locale, "economy.deposit.insufficient_funds_footer"),
				});

			await interaction.editReply({ embeds: [embed] });
			return;
		}

		await UserModel.updateOne(
			{ userID: interaction.user.id },
			{
				$inc: {
					coins: -depositAmount,
					bank: depositAmount,
				},
			},
		);

		const embed = new EmbedBuilder()
			.setColor("#00FF00")
			.setAuthor({
				name: interaction.user.username,
				iconURL: interaction.user.displayAvatarURL({ forceStatic: false }),
			})
			.setTitle(localizer(locale, "economy.deposit.success_title"))
			.setDescription(
				localizer(locale, "economy.deposit.success_description", {
					amount: depositAmount,
					wallet_balance: userData.coins - depositAmount,
					bank_balance: userData.bank + depositAmount,
				}),
			)
			.setFooter({ text: localizer(locale, "economy.deposit.success_footer") });

		await interaction.editReply({ embeds: [embed] });
	},
} as const;

export default command;
