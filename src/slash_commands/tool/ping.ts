import {
	type ChatInputCommandInteraction,
	type Client,
	PermissionsBitField,
} from "discord.js";
import type { BaseCommand } from "../../types/discord/global";
import type { UserRow } from "../../types/db/schema";
import { showInfoEmbed } from "../../utils/discord/interactionHelper";
import { ColorCode } from "../../utils/misc/logger";

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
			color: isLaggy ? ColorCode.ERROR : ColorCode.SUCCESS,
		});
	},
} as const;

export default command;
