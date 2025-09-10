import { translate } from "bing-translate-api";
import type { Client, Message } from "discord.js";
import deepl from "deepl";
import { translate as googleTranslate } from "google-translate-api-x";
import { log } from "../../utils/misc/logger";
import { sendTranslationEmbed } from "../../utils/discord/embedHelper";
import type {
	BingResponse,
	DeeplResponse,
	GoogleResponse,
} from "../../types/misc/translation";
import { TranslationProvider } from "../../types/discord/embed";

/**
 * Automatically translates Japanese messages to English using multiple providers.
 * @param client - The Discord client instance
 * @param message - The message to potentially translate
 * @returns Promise<void>
 */
const handler = async (_client: Client, message: Message): Promise<void> => {
	//return;
	try {
		// Skip if message has translation flag or is from a bot
		// EXPERIMENTAL FEATURE ONLY FOR TESTING
		if (
			message.content.includes("><") ||
			message.author.bot ||
			(message.guildId !== process.env.TESTSRV_ID &&
				message.guildId !== process.env.HAVENSRV_ID) ||
			message.channelId === process.env.TESTCH_ID
		) {
			return;
		}

		// Check for Japanese text using a native regex (matches Kanji, Hiragana, or Katakana)
		// 1. Kanji: \u4E00-\u9FFF
		// 2. Hiragana: \u3040-\u309F
		// 3. Katakana: \u30A0-\u30FF
		// This ensures we only proceed if any Japanese character is present.
		if (!/[\u3040-\u30FF\u4E00-\u9FFF]/.test(message.content)) {
			return;
		}

		log.info("Japanese message detected, translating...");

		// Get translations from each provider
		const [bingResult, deeplResult, googleResult] = await Promise.all([
			translate(message.content, undefined, "en") as Promise<BingResponse>,
			deepl({
				free_api: true,
				text: message.content,
				target_lang: "EN",
				auth_key: process.env.DEEPL_KEY || "",
			}) as Promise<DeeplResponse>,
			googleTranslate(message.content, {
				to: "en",
				forceBatch: false,
			}) as Promise<GoogleResponse>,
		]);

		// Show translations with swappable buttons
		await sendTranslationEmbed(message, {
			text: message.content,
			translations: {
				[TranslationProvider.GOOGLE]: googleResult.text,
				[TranslationProvider.DEEPL]: deeplResult.data.translations[0].text,
				[TranslationProvider.BING]: bingResult.translation,
			},
			initialProvider: TranslationProvider.GOOGLE,
			timeout: 90000,
		});
	} catch (_error) {
		log.error("Translation error");
	}
};

export default handler;
