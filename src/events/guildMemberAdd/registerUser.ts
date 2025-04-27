import type { Client, GuildMember } from "discord.js";
import { registerUser } from "../../utils/db/dbWrite";
import { log } from "../../utils/misc/logger";

/**
 * Handles registration of new users when they join a guild.
 * Creates user record if new, and logs the action.
 * @param client - The Discord client instance
 * @param member - The guild member who joined
 * @returns Promise<void>
 */
const handler = async (_client: Client, member: GuildMember): Promise<void> => {
	try {
		// 1. Determine the server and user's preferred language
		const serverLocale = member.guild.preferredLocale;
		const userLanguage = serverLocale.startsWith("ja") ? "ja" : "en";
		log.info(
			`New user ${member.user.tag} joined server, registering with language: ${userLanguage}`,
		);

		// 2. Register user using our centralized function (Rule #17)
		const userData = await registerUser(
			member.id,
			member.displayName,
			userLanguage,
		);

		if (userData) {
			log.success(`User ${member.user.tag} registered successfully`);
		} else {
			log.error(`Failed to register user ${member.user.tag}`);
		}
	} catch (error) {
		log.error(`Error in guildMemberAdd handler for ${member.user.tag}:`, error);
	}
};

export default handler;
