import {
	ChatInputCommandInteraction,
	Client,
	EmbedBuilder,
	InteractionReplyOptions,
} from "discord.js";
import UserModel from "../../models/userSchema";
import { Command, IUser } from "../../types/global";
import { localizer } from "../../utils/textLocalizer";

const command: Command = {
	name: "daily",
	description: "Claim your daily TomoCoins! | トモコインを毎日受け取ります！",
	category: "economy",

	callback: async (
		client: Client,
		interaction: ChatInputCommandInteraction,
		userData: IUser,
	): Promise<void> => {
		await interaction.deferReply();
		const locale = userData.language || "en";

		const now = Date.now();
		const cooldownKey = "daily";
		const dailyCooldownDuration = 12 * 60 * 60 * 1000;

		const userCooldowns = userData.cooldowns || new Map();

		if (
			userCooldowns.has(cooldownKey) &&
			userCooldowns.get(cooldownKey)! > now
		) {
			const remaining = Math.ceil(
				(userCooldowns.get(cooldownKey)! - now) / (60 * 60 * 1000),
			);
			const replyOptions: InteractionReplyOptions = {
				content: localizer(locale, "economy.daily.cooldown", {
					hours: remaining,
				}),
				ephemeral: true,
			};
			await interaction.editReply(replyOptions);
			return;
		}

		const randomNumber = Math.floor(Math.random() * (300 - 100 + 1)) + 100;

		await UserModel.updateOne(
			{ userID: interaction.user.id },
			{
				$inc: { coins: randomNumber },
				$set: { [`cooldowns.${cooldownKey}`]: now + dailyCooldownDuration },
			},
		);

		const embed = new EmbedBuilder()
			.setColor("#FFFFFF")
			.setAuthor({
				name: interaction.user.username,
				iconURL: interaction.user.displayAvatarURL({ forceStatic: false }),
			})
			.setTitle(localizer(locale, "economy.daily.title"))
			.setDescription(
				localizer(locale, "economy.daily.claim_success", {
					claimed: randomNumber,
					new_balance: userData.coins + randomNumber,
				}),
			)
			.setFooter({
				text: localizer(
					locale,
					randomNumber >= 200
						? "economy.daily.footer_lucky"
						: "economy.daily.footer",
				),
			});

		await interaction.editReply({ embeds: [embed] });
	},
} as const;

export default command;
