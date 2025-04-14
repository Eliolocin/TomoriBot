import { Client, Message } from "discord.js";
import UserModel from "../../models/userSchema";

const handler = async (_client: Client, message: Message): Promise<void> => {
	if (message.author.bot) return;

	try {
		const serverLocale = message.guild?.preferredLocale;
		//console.log(`Server language detected: ${serverLocale}`);

		const userLanguage = serverLocale?.startsWith("ja") ? "ja" : "en";

		let user = await UserModel.findOne({
			userID: message.author.id,
			serverID: message.guild?.id,
		});
		if (!user && message.guild) {
			user = await UserModel.create({
				userID: message.author.id,
				serverID: message.guild.id,
				nickname: message.author.displayName,
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
