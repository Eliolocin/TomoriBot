import BotModel from "../models/botSchema";
import UserModel from "../models/userSchema";

async function convertMentionsToNicknames(
	text: string,
	serverID: string,
): Promise<string> {
	try {
		// Find all mentions in the text using regex
		const mentionRegex = /<@!?(\d+)>/g;
		let matches = [...text.matchAll(mentionRegex)];
		let convertedText = text;
		const botData = await BotModel.findOne({ serverID });

		// Process each mention
		for (const match of matches) {
			const userID = match[1];
			const fullMention = match[0];

			// Special case for bot ID
			if (userID === process.env.TOMO_ID) {
				if (botData && botData.botName) {
					convertedText = convertedText.replace(
						new RegExp(fullMention, "g"),
						botData.botName,
					);
				}
			} else {
				// Find user in database
				const userData = await UserModel.findOne({ userID, serverID });

				if (userData && userData.nickname) {
					// Replace mention with nickname, preserving ML tags
					convertedText = convertedText.replace(
						new RegExp(fullMention, "g"), // Use global flag to replace all instances
						userData.nickname,
					);
				}
			}
		}

		return convertedText;
	} catch (error) {
		console.error("Error in convertMentionsToNicknames:", error);
		return text;
	}
}

export { convertMentionsToNicknames };
