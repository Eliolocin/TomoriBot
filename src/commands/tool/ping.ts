import type { SlashCommandSubcommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction, Client } from "discord.js";
import { EmbedBuilder } from "discord.js";
import { ColorCode } from "../../utils/misc/logger";
import { localizer } from "../../utils/text/localizer";
import type { UserRow } from "../../types/db/schema";

// Define how the subcommand is configured
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("ping")
		.setDescription(localizer("en-US", "commands.tool.ping.description"));

// Command logic with the UserRow parameter
export async function execute(
	client: Client,
	interaction: ChatInputCommandInteraction,
	_userData: UserRow,
	locale: string,
): Promise<void> {
	// Use userData for locale preference
	// Special case: defer needed for timing measurement, then use helper for response
	await interaction.deferReply();

	const reply = await interaction.fetchReply();
	const responseTime = reply.createdTimestamp - interaction.createdTimestamp;
	const discordPing = client.ws.ping;

	// Now use editReply directly since we already deferred - avoid helper conflict
	const isLaggy = responseTime > 250;
	const embed = new EmbedBuilder()
		.setColor(isLaggy ? ColorCode.WARN : ColorCode.SUCCESS)
		.setTitle(localizer(locale, "commands.tool.ping.description"))
		.setDescription(localizer(locale, isLaggy
			? "commands.tool.ping.response_slow"
			: "commands.tool.ping.response_fast", {
				response_time: responseTime,
				discord_response: discordPing,
			}));

	await interaction.editReply({ embeds: [embed] });
}
