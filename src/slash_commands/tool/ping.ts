import {
	ChatInputCommandInteraction,
	Client,
	EmbedBuilder,
	PermissionsBitField,
} from "discord.js";
import { Command, IUser } from "../../types/global";
import { localizer } from "../../utils/textLocalizer";

const command: Command = {
	name: "ping",
	description: "Check the bot's ping",
	category: "tool",
	permissionsRequired: [
		new PermissionsBitField(PermissionsBitField.Flags.KickMembers),
	],

	callback: async (
		client: Client,
		interaction: ChatInputCommandInteraction,
		userData: IUser,
	): Promise<void> => {
		const locale = userData.language || "en";
		await interaction.deferReply();

		const reply = await interaction.fetchReply();
		const responseTime = reply.createdTimestamp - interaction.createdTimestamp;
		const discordPing = client.ws.ping;

		const isLaggy = responseTime > 250;
		const responseEmbed = new EmbedBuilder()
			.setColor(isLaggy ? "#E74C3C" : "#2ECC71")
			.setTitle(localizer(locale, "tool.ping.description"))
			.setDescription(
				isLaggy
					? localizer(locale, "tool.ping.response_slow", {
							response_time: responseTime,
							discord_response: discordPing,
						})
					: localizer(locale, "tool.ping.response_fast", {
							response_time: responseTime,
							discord_response: discordPing,
						}),
			);

		await interaction.editReply({ embeds: [responseEmbed] });
	},
} as const;

export default command;
