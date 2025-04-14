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
	name: "gamba",
	description:
		"50/50 Chance to Double or Lose it all! | 50/50の確率で2倍になるか、すべて失います！",
	category: "fun",
	options: [
		{
			name: "amount",
			description: "TomoCoins you wish to gamble | 賭けたいTomoCoins",
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
		const gambleAmount = interaction.options.getInteger("amount", true);

		if (gambleAmount > userData.coins) {
			const embed = new EmbedBuilder()
				.setColor("#FF0000")
				.setTitle(localizer(locale, "fun.gamba.insufficient_funds_title"))
				.setDescription(
					localizer(locale, "fun.gamba.insufficient_funds_description", {
						balance: userData.coins,
						attempted: gambleAmount,
					}),
				)
				.setFooter({
					text: localizer(locale, "fun.gamba.insufficient_funds_footer"),
				});

			await interaction.editReply({ embeds: [embed] });
			return;
		}

		const isWin = Math.random() < 0.5;
		const winnings = isWin ? gambleAmount * 2 : 0;
		const finalAmount = isWin ? winnings - gambleAmount : -gambleAmount;

		await UserModel.updateOne(
			{ userID: interaction.user.id },
			{ $inc: { coins: finalAmount } },
		);

		const embed = new EmbedBuilder()
			.setColor(isWin ? "#00FF00" : "#FF0000")
			.setAuthor({
				name: interaction.user.username,
				iconURL: interaction.user.displayAvatarURL({ forceStatic: false }),
			})
			.setTitle(
				localizer(
					locale,
					isWin ? "fun.gamba.win_title" : "fun.gamba.lose_title",
				),
			)
			.setDescription(
				localizer(
					locale,
					isWin ? "fun.gamba.win_description" : "fun.gamba.lose_description",
					{
						winnings: isWin ? winnings : "",
						amount_lost: !isWin ? gambleAmount : "",
						new_balance: userData.coins + finalAmount,
					},
				),
			)
			.setFooter({
				text: localizer(
					locale,
					isWin ? "fun.gamba.win_footer" : "fun.gamba.lose_footer",
				),
			});

		await interaction.editReply({ embeds: [embed] });
	},
} as const;

export default command;
