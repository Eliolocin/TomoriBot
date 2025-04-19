import {
	type ChatInputCommandInteraction,
	type Client,
	PermissionsBitField,
} from "discord.js";
import type { BaseCommand } from "../../types/global";
import type { UserRow } from "../../types/db";
import { showInfoEmbed } from "../../utils/interactionHelpers";
import { ColorScheme } from "../../utils/logBeautifier";

const command: BaseCommand = {
	name: "ping",
	description: "Check the bot's ping",
	category: "tool",
	permissionsRequired: [
		new PermissionsBitField(PermissionsBitField.Flags.KickMembers),
	],

	callback: async (
		client: Client,
		interaction: ChatInputCommandInteraction,
		userData: UserRow,
	): Promise<void> => {
		const locale = userData.language_pref;
		await interaction.deferReply();

		const reply = await interaction.fetchReply();
		const responseTime = reply.createdTimestamp - interaction.createdTimestamp;
		const discordPing = client.ws.ping;

		const isLaggy = responseTime > 250;
		await showInfoEmbed(interaction, locale, {
			titleKey: "tool.ping.description",
			descriptionKey: isLaggy
				? "tool.ping.response_slow"
				: "tool.ping.response_fast",
			descriptionVars: {
				response_time: responseTime,
				discord_response: discordPing,
			},
			color: isLaggy ? ColorScheme.ERROR : ColorScheme.SUCCESS,
		});
	},
} as const;

export default command;
