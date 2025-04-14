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
	name: "withdraw",
	description: "Withdraw TomoCoins from your bank to your wallet.",
	category: "economy",
	options: [
		{
			name: "amount",
			description: "The amount of TomoCoins you wish to withdraw",
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
		const withdrawAmount = interaction.options.getInteger("amount", true);

		if (withdrawAmount <= 0) {
			const embed = new EmbedBuilder()
				.setColor("#FF0000")
				.setTitle(localizer(locale, "economy.withdraw.invalid_amount_title"))
				.setDescription(
					localizer(locale, "economy.withdraw.invalid_amount_description"),
				)
				.setFooter({
					text: localizer(locale, "economy.withdraw.invalid_amount_footer"),
				});

			await interaction.editReply({ embeds: [embed] });
			return;
		}

		if (withdrawAmount > userData.bank) {
			const embed = new EmbedBuilder()
				.setColor("#FF0000")
				.setTitle(
					localizer(locale, "economy.withdraw.insufficient_balance_title"),
				)
				.setDescription(
					localizer(
						locale,
						"economy.withdraw.insufficient_balance_description",
						{
							bank_balance: userData.bank,
							attempted: withdrawAmount,
						},
					),
				)
				.setFooter({
					text: localizer(
						locale,
						"economy.withdraw.insufficient_balance_footer",
					),
				});

			await interaction.editReply({ embeds: [embed] });
			return;
		}

		// Update user's balance
		await UserModel.updateOne(
			{ userID: interaction.user.id },
			{
				$inc: {
					coins: withdrawAmount,
					bank: -withdrawAmount,
				},
			},
		);

		// Success embed
		const embed = new EmbedBuilder()
			.setColor("#00FF00")
			.setAuthor({
				name: interaction.user.username,
				iconURL: interaction.user.displayAvatarURL({ forceStatic: false }),
			})
			.setTitle(localizer(locale, "economy.withdraw.success_title"))
			.setDescription(
				localizer(locale, "economy.withdraw.success_description", {
					amount: withdrawAmount,
					wallet_balance: userData.coins + withdrawAmount,
					bank_balance: userData.bank - withdrawAmount,
				}),
			)
			.setFooter({
				text: localizer(locale, "economy.withdraw.success_footer"),
			});

		await interaction.editReply({ embeds: [embed] });
	},
} as const;

export default command;
