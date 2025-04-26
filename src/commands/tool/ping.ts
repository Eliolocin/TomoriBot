import { SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction, Client } from "discord.js";
import { replyInfoEmbed } from "../../utils/discord/interactionHelper";
import { ColorCode } from "../../utils/misc/logger";
import { localizer } from "../../utils/text/localizer";

// Build the command data using SlashCommandBuilder
export const data = new SlashCommandBuilder()
	.setName("ping")
	.setDescription(localizer("en", "commands.tool.ping.description"))
	.setDescriptionLocalizations({
		ja: localizer("ja", "commands.tool.ping.description"),
	})
	.toJSON();

// Separate execute function containing the command logic
export async function execute(
	client: Client,
	interaction: ChatInputCommandInteraction,
): Promise<void> {
	const locale = interaction.locale ?? interaction.guildLocale ?? "en";
	await interaction.deferReply();

	const reply = await interaction.fetchReply();
	const responseTime = reply.createdTimestamp - interaction.createdTimestamp;
	const discordPing = client.ws.ping;

	const isLaggy = responseTime > 250;
	await replyInfoEmbed(interaction, locale, {
		titleKey: "commands.tool.ping.description",
		descriptionKey: isLaggy
			? "commands.tool.ping.response_slow"
			: "commands.tool.ping.response_fast",
		descriptionVars: {
			response_time: responseTime,
			discord_response: discordPing,
		},
		color: isLaggy ? ColorCode.ERROR : ColorCode.SUCCESS,
	});
}
