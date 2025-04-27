import type { SlashCommandSubcommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction, Client } from "discord.js";
import { replyInfoEmbed } from "../../utils/discord/interactionHelper";
import { ColorCode } from "../../utils/misc/logger";
import { localizer } from "../../utils/text/localizer";
import type { UserRow } from "../../types/db/schema";

// Define how the subcommand is configured
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("ping")
		.setDescription(localizer("en", "commands.tool.ping.description"))
		.setDescriptionLocalizations({
			ja: localizer("ja", "commands.tool.ping.description"),
		});

// Command logic with the UserRow parameter
export async function execute(
	client: Client,
	interaction: ChatInputCommandInteraction,
	userData: UserRow,
): Promise<void> {
	// Use userData for locale preference
	const locale = userData.language_pref ?? interaction.guildLocale ?? "en";
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
