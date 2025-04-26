import type { Client, Interaction } from "discord.js";
import { sql } from "bun";
import { replyInfoEmbed } from "../../utils/discord/interactionHelper";
import { ColorCode, log } from "../../utils/misc/logger";
import { userSchema, type UserRow } from "../../types/db/schema";
import { localizer } from "../../utils/text/localizer";
import { registerUser } from "../../utils/db/configHelper";
import { loadCommandModules } from "../../utils/discord/commandLoader";
import type { Command } from "../../utils/discord/commandLoader"; // Import Command type

const TIMEOUT_DURATION = 100000; // 100 Seconds
const COOLDOWN_MAP = new Map<string, number>([
	["economy", 2000],
	["scrape", 10000],
	["tool", 10000],
	["fun", 2000],
	["config", 5000], // Add cooldown for config category
]);

// Cache for commands - stored at module level
let commandCache: Map<string, Command> | null = null; // Use the Command type

/**
 * Checks if a command is on cooldown for a user
 * @param userId - Discord user ID
 * @param category - Command category
 * @returns Time remaining in milliseconds, or 0 if no cooldown
 */
async function checkCooldown(
	userId: string,
	category: string,
): Promise<number> {
	const now = Date.now();
	const [cooldown] = await sql`
    SELECT expiry_time 
    FROM cooldowns 
    WHERE user_disc_id = ${userId} 
    AND command_category = ${category}
    AND expiry_time > ${now}
  `;

	return cooldown ? Number(cooldown.expiry_time) - now : 0;
}

/**
 * Sets a cooldown for a command category
 * @param userId - Discord user ID
 * @param category - Command category
 * @param duration - Cooldown duration in milliseconds
 */
async function setCooldown(
	userId: string,
	category: string,
	duration: number,
): Promise<void> {
	const expiryTime = Date.now() + duration;

	await sql`
    INSERT INTO cooldowns (user_disc_id, command_category, expiry_time)
    VALUES (${userId}, ${category}, ${expiryTime})
    ON CONFLICT (user_disc_id, command_category) DO UPDATE
    SET expiry_time = ${expiryTime}
  `;
}

const handler = async (
	client: Client,
	interaction: Interaction,
): Promise<void> => {
	if (!interaction.isChatInputCommand()) return;

	const locale = interaction.locale || interaction.guildLocale || "en";

	try {
		// Load commands on first use if cache is empty
		if (!commandCache) {
			commandCache = await loadCommandModules();
		}

		const commandObject = commandCache.get(interaction.commandName);
		if (!commandObject) {
			log.warn(`Command not found in cache: ${interaction.commandName}`);
			// Optionally reply to user
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.command_not_found_title",
				descriptionKey: "general.errors.command_not_found_desc",
				color: ColorCode.ERROR,
			});
			return;
		}

		// Command execution logic with timeout
		const mainLogicPromise = async () => {
			// Get command category directly from the command object
			const category = commandObject.category;

			// 1. Check for command category-based cooldowns
			if (category) {
				const cooldownDuration = COOLDOWN_MAP.get(category);
				if (cooldownDuration) {
					const timeLeft = await checkCooldown(interaction.user.id, category);

					if (timeLeft > 0) {
						const timeLeftSeconds = Math.ceil(timeLeft / 1000);
						await replyInfoEmbed(interaction, locale, {
							titleKey: "general.cooldown",
							descriptionKey: "general.cooldown",
							descriptionVars: { seconds: timeLeftSeconds },
							color: ColorCode.WARN,
						});
						return;
					}

					// Set new cooldown if no active one exists
					await setCooldown(interaction.user.id, category, cooldownDuration);
				}
			}

			// 2. Get or create user data
			let userData: UserRow | undefined;
			const [existingUser] = await sql`
        SELECT * FROM users WHERE user_disc_id = ${interaction.user.id}
      `;

			if (existingUser) {
				userData = userSchema.parse(existingUser);
			} else if (interaction.guild) {
				const serverLocale = interaction.guild.preferredLocale;
				const userLanguage = serverLocale.startsWith("ja") ? "ja" : "en";

				// Use the centralized registerUser function from configHelper (Rule #17)
				const registeredUser = await registerUser(
					interaction.user.id,
					interaction.user.displayName,
					userLanguage,
				);

				// Only assign if not null
				if (registeredUser) {
					userData = registeredUser;
				}
			}

			// 3. Execute command
			if (userData) {
				await commandObject.execute(client, interaction, userData);
			} else {
				log.error("No user data available for command execution");
				await replyInfoEmbed(interaction, locale, {
					titleKey: "general.errors.generic_error",
					descriptionKey: "general.errors.generic_error",
					color: ColorCode.ERROR,
				});
			}
		};

		await Promise.race([
			mainLogicPromise(),
			new Promise((_, reject) =>
				setTimeout(
					() =>
						reject(
							new Error(localizer(locale, "general.errors.command_timeout")),
						),
					TIMEOUT_DURATION,
				),
			),
		]);
	} catch (error) {
		log.error("Error in command execution:", error);

		if (!interaction.replied && !interaction.deferred) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.generic_error",
				descriptionKey: "general.errors.generic_error",
				color: ColorCode.ERROR,
			});
		}
	}
};

export default handler;
