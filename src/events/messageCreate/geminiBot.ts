import fs from "fs";
import {
	GenerationConfig,
	GoogleGenerativeAI,
	HarmBlockThreshold,
	HarmCategory,
} from "@google/generative-ai";
// geminiBot.ts
import { Client, EmbedBuilder, Message, TextChannel } from "discord.js";
import { config } from "dotenv";
import BotModel from "../../models/botSchema"; // Adjust import path if needed
import UserModel from "../../models/userSchema";
import { IBot, IUser } from "../../types/global"; // Adjust if you have a separate IBot interface file
import { convertMentionsToNicknames } from "../../utils/mentionConverter";
import { localizer } from "../../utils/textLocalizer";

config(); // Ensure .env is loaded

const memoryLimit = 80; // Number of messages retained
const autoMsgTrigger = 50; // Number of messages until bot talks by itself
const safetySettings = [
	{
		category: HarmCategory.HARM_CATEGORY_HARASSMENT,
		threshold: HarmBlockThreshold.BLOCK_NONE,
	},
	{
		category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
		threshold: HarmBlockThreshold.BLOCK_NONE,
	},
	{
		category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
		threshold: HarmBlockThreshold.BLOCK_NONE,
	},
	{
		category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
		threshold: HarmBlockThreshold.BLOCK_NONE,
	},
];
// const googleModel = "gemini-2.0-flash-exp"; // Google model to use
const googleModel = "gemini-2.5-pro-exp-03-25"; // Google model to use 

// Main exported function
export default async function geminiBot(
	client: Client,
	message: Message,
): Promise<void> {
	if (!(message.channel instanceof TextChannel)) return;
	if (!message.channel.permissionsFor(client.user!)?.has("SendMessages"))
		return;

	// Retrieve bot data from DB
	// Note: Adjust how you identify the serverID if needed, for example: message.guild?.id
	const botData: IBot | null = await BotModel.findOne({
		serverID: message.guild?.id,
	});
	const userData: IUser | null = await UserModel.findOne({
		userID: message.author?.id,
		serverID: message.guild?.id,
	});

	const locale = userData?.language || "en";

	try {
		// Safety check if no botData found; you may choose to create a default DB entry here
		if (!botData || !userData) return;

		// Auto Message system, using counters[0]
		let autoMsgActive = true;
		let newCount = -1;

		if (autoMsgActive && !message.author.bot) {
			newCount = botData.counters[0] ?? 0; // read existing count
			if (newCount === autoMsgTrigger) {
				newCount = 0;
			}
			botData.counters[0] = newCount + 1;
			await botData.save();
		}

		// Check if the message is a reply
		let referenceMessage: Message | undefined;
		if (message.reference?.messageId) {
			referenceMessage = message.channel.messages.cache.get(
				message.reference.messageId,
			);
		}

		// Build triggers condition from the DB triggers array
		const triggersActive = botData.triggers.some((trigger) => {
			// Check if trigger is a mention (starts with <@)
			if (trigger.startsWith("<@")) {
				const userId = trigger.replace(/[<@!>]/g, ""); // Extract user ID from mention format
				return message.mentions.users.has(userId);
			}
			// Check if trigger contains Japanese characters
			const isJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(
				trigger,
			);
			if (isJapanese) {
				return message.content.includes(trigger);
			} else {
				const regex = new RegExp(`\\b${trigger}\\b`, "i"); // Use word boundaries for English triggers
				return regex.test(message.content);
			}
		});

		// Condition to see if the newCount condition is met
		const isAutoMsgHit = (botData.counters[0] ?? 0) % autoMsgTrigger === 0;

		// Combined condition to see if we fire the Bot's generation
		if (
			((referenceMessage?.author.bot || triggersActive) &&
				!message.author.bot &&
				!message.content.startsWith("!") &&
				message.channel.isTextBased()) ||
			isAutoMsgHit
		) {
			if (
				botData.conversationExamples.length <= 1 &&
				botData.botDatabase.length <= 0
			) {
				const setupEmbed = new EmbedBuilder()
					.setColor("#FF0000")
					.setTitle(localizer(locale, "events.geminiBot.setup_required_title"))
					.setDescription(
						localizer(locale, "events.geminiBot.setup_required_description"),
					);
				message.channel.send({ embeds: [setupEmbed] });
				return;
			}

			const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY as string);

			const config: GenerationConfig = {
				temperature: 1.5,
				topK: 1,
				topP: 0.9,
			};

			

			await message.channel.sendTyping();

			const currentTime = getCurrentTime();
			const channelName = message.channel.name;
			const guildName = message.guild?.name;
			let user = message.author.username;
			const inputSanitizerSetting =
				botData.settings.find((setting) => setting.key === "inputsanitizer")
					?.value ?? true;
			if (!initialIsCapital(user) && inputSanitizerSetting) {
				user = capitalizeFirstLetter(user);
			}

			// Prepare the context as in the original code
			let context = `\n[The current date and time is ${currentTime}. ${botData.botName} is a Discord bot created to assist users. Currently lurking around the ${guildName} Discord server, specifically at the text channel named "${channelName}", chatting with server members there and assisting those in need.]\n`;
			let preamble = '\n[Additional Instructions: Unless a chat member explicitly asks you for comprehensive information or help, do not type messages that are too long, no one in a public chatroom wants to read a wall of text (unless they really ask for it!)]\n';
			if (isAutoMsgHit) {
				preamble = `\n[Additional Instructions: When voluntarily making a reply without being explicitly mentioned or called, do NOT send a reply that simply summarizes the conversation history and its old messages, focus on the most recent messages and make a short but engaging comment on that to keep the conversation going. Try to engage with the latest Discord member that sent a message instead of talking to everyone at once. No one in a public chatroom wants to read a wall of text (unless they really ask for it!)]\n`;
			}

			const sysStart = `<|im_start|>system\n`;
			const userStart = `<|im_start|>user\n`;
			const botStart = `<|im_start|>assistant\n`;
			const mlEnd = `<|im_end|>\n`;

			const model = genAI.getGenerativeModel({
				model: googleModel,
				generationConfig: config,
				safetySettings,
				systemInstruction: botData.botPersonality+context+preamble
			});

			// Build the injection
			let injection = sysStart;

			// 1) Add the DB's botDatabase
			if (botData.botDatabase && botData.botDatabase.length > 0) {
				let dbText = botData.botDatabase.map((item) => `[${item}]`).join("\n");

				// Replace placeholders in database text
				dbText = dbText
					.replace(/{user}/g, userData.nickname)
					.replace(/{bot}/g, botData.botName);

				injection += dbText + "\n";
			}

			injection += mlEnd;

			// 2) Add conversationExamples
			if (
				botData.conversationExamples &&
				botData.conversationExamples.length > 0
			) {
				botData.conversationExamples.forEach((example) => {
					const userInput = example.input
						.replace("{user}", userData.nickname)
						.replace("{bot}", botData.botName);
					const botOutput = example.output
						.replace("{bot}", botData.botName)
						.replace("{user}", userData.nickname);
					injection +=
						`${userStart}${userData.nickname}: ${userInput}\n${mlEnd}` +
						`${botStart}${botData.botName}: ${botOutput}\n${mlEnd}`;
				});
			}

			// 3) Then add recent conversation history
			// Reverse fetch
			const prevMessages = await message.channel.messages.fetch({
				limit: memoryLimit,
			});
			const reversed = [...prevMessages.values()].reverse();
			let chatInput = injection;

			reversed.forEach((msg) => {
				// Skip certain messages
				if (msg.content.startsWith("!") || msg.content.length <= 0) {
					return;
				}
				// Skip other bots except ours
				if (msg.author.id !== client.user?.id && msg.author.bot) return;

				let userContent = msg.content;
				const inputSanitizerSetting =
					botData.settings.find((setting) => setting.key === "inputsanitizer")
						?.value ?? true;
				if (!initialIsCapital(userContent) && inputSanitizerSetting) {
					userContent = capitalizeFirstLetter(userContent);
				}
				if (inputSanitizerSetting) userContent = addPeriod(userContent);

				let userName = `<@${msg.author.id}>`;
				/*
        if (!initialIsCapital(msg.author.username)) {
          userName = capitalizeFirstLetter(msg.author.username);
        }*/

				// If the message is from our Bot
				if (msg.author.id === client.user?.id) {
					// Replace with botName automatically if needed in old logs
					chatInput += `${botStart}${botData.botName}: ${msg.content}\n${mlEnd}`;
				} else {
					chatInput += `${userStart}${userName}: ${userContent}\n${mlEnd}`;
				}

				// Refresh or reset detection
				if (
					msg.content.startsWith("**======") // Special stopping 'token' generated by /refresh
				) {
					chatInput = injection;
				}
			});

			// Finally add the next assistant start
			chatInput += `${botStart}${botData.botName}: `;

			chatInput = await convertMentionsToNicknames(
				chatInput,
				message.guild?.id as string,
			);
			console.log(chatInput);
			// Generate from Google
			const reply = await model.generateContent(chatInput);

			console.log(`\n\n` + reply.response.text());

			// Chunk and send
			const chunkedMessage = chunkMessage(reply.response.text());
			chunkedMessage.forEach((chunk) => {
				if (chunk.length > 5) {
					if (message.channel instanceof TextChannel) {
						const cleanChunk = trimBotName(trimML(chunk), botData.botName);
						if (cleanChunk.length > 0) message.channel.send(cleanChunk);
					}
				}
			});
		}
	} catch (err) {
		const setupEmbed = new EmbedBuilder()
			.setColor("#FF0000")
			.setTitle(localizer(locale, "events.geminiBot.safety_error_title"))
			.setDescription(
				localizer(locale, "events.geminiBot.safety_error_description"),
			);
		message.channel.send({ embeds: [setupEmbed] });
		console.log(err);
	}
}

// Helper function #1: getCurrentTime
function getCurrentTime(): string {
	const monthNames = [
		"January",
		"February",
		"March",
		"April",
		"May",
		"June",
		"July",
		"August",
		"September",
		"October",
		"November",
		"December",
	];
	const date = new Date();
	const weekday = getDayOfWeek(date);
	const day = date.getDate();
	const year = date.getFullYear();
	let hour = date.getHours();
	const minutes = date.getMinutes();
	let mid = "AM";

	if (hour === 0) {
		hour = 12;
	} else if (hour === 12) {
		mid = "PM";
	} else if (hour > 12) {
		hour = hour % 12;
		mid = "PM";
	}

	const month = monthNames[date.getMonth()];
	return `${month} ${day}, ${year} | ${hour}:${minutes} ${mid} | ${weekday}`;
}

// Helper function #2: chunkMessage
function chunkMessage(inputText: string): string[] {
	const nSplitMessage = inputText.split("\n");
	const chunkedMessage: string[] = [];
	let chunkIndex = 0;
	let tempMessage = "";

	nSplitMessage.forEach((msgLine) => {
		if (tempMessage.length >= 1500) {
			chunkedMessage[chunkIndex] = tempMessage;
			tempMessage = "";
			chunkIndex++;
		}
		tempMessage += msgLine + "\n";
	});

	if (tempMessage.length > 0) {
		chunkedMessage[chunkIndex] = tempMessage;
	}
	if (chunkedMessage.length === 0) {
		chunkedMessage[0] = tempMessage;
	}
	return chunkedMessage;
}

// Helper functions from your original code
function initialIsCapital(word: string): boolean {
	const hasLetter = /[a-zA-Z]/.test(word);
	if (!hasLetter) return false;
	return word[0] !== word[0].toLowerCase();
}

function capitalizeFirstLetter(text: string): string {
	const hasLetter = /[a-zA-Z]/.test(text);
	if (!hasLetter) {
		return text;
	}
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function addPeriod(sentence: string): string {
	if (typeof sentence === "string" && sentence.length > 0) {
		if (!sentence.match(/[.,:!?]$/)) {
			sentence = sentence + ".";
		}
	}
	return sentence;
}

function getDayOfWeek(date: Date): string {
	const dayOfWeek = new Date(date).getDay();
	return isNaN(dayOfWeek)
		? ""
		: [
				"Sunday",
				"Monday",
				"Tuesday",
				"Wednesday",
				"Thursday",
				"Friday",
				"Saturday",
			][dayOfWeek];
}

function trimML(text: string): string {
	// Trim whitespace first
	text = text.trim();
	// Remove any im_end tag and following whitespace
	return text
		.replace(/<\|im_end\|>(\s*)$/, "")
		.replace(/<\|file_separator\|>(\s*)$/, "");
}

function trimBotName(text: string, botName: string): string {
	// Match botName followed by colon and optional space
	const prefix = `${botName}: `;
	if (text.startsWith(prefix)) {
		return text.slice(prefix.length);
	}
	return text;
}
