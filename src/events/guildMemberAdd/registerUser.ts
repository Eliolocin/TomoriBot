import { Client, GuildMember } from "discord.js";
import UserModel from "../../models/userSchema";

const handler = async (_client: Client, member: GuildMember): Promise<void> => {
	try {
		// Determine the server's language from preferredLocale
		const serverLocale = member.guild.preferredLocale;
		console.log(`Server language detected: ${serverLocale}`);

		// Default to "en" unless the locale indicates Japanese
		const userLanguage = serverLocale.startsWith("ja") ? "ja" : "en";

		// Check if the user exists
		let user = await UserModel.findOne({
			userID: member.id,
			serverID: member.guild.id,
		});
		if (!user) {
			user = await UserModel.create({
				userID: member.id,
				serverID: member.guild.id,
				nickname: member.displayName,
				language: userLanguage,
			});
			await user.save();
			console.log(`User created with language set to ${userLanguage}`);
		}
	} catch (err) {
		console.error("Error handling user creation:", err);
	}
};

export default handler;
