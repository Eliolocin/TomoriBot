import { ChatInputCommandInteraction, Client, EmbedBuilder } from "discord.js";
import { Command, IUser } from "../../types/global";
import { localizer } from "../../utils/textLocalizer";

const command: Command = {
	name: "balance",
	description: "Check your current balance | 現在の残高を確認します",
	category: "economy",
	callback: async (
		client: Client,
		interaction: ChatInputCommandInteraction,
		userData: IUser,
	): Promise<void> => {
		await interaction.deferReply();

		const locale = userData.language || "en";

		const title = localizer(locale, "economy.balance.title");
		const description = localizer(locale, "economy.balance.description", {
			coins: userData.coins,
			bank: userData.bank,
		});
		const footer = localizer(locale, "economy.balance.footer");

		const embed = new EmbedBuilder()
			.setColor("#FFFFFF")
			.setAuthor({
				name: interaction.user.username,
				iconURL: interaction.user.displayAvatarURL({ forceStatic: false }),
			})
			.setTitle(title)
			.setDescription(description)
			.setFooter({ text: footer });

		await interaction.editReply({ embeds: [embed] });
	},
} as const;

export default command;
