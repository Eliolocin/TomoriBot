import type {
	ChatInputCommandInteraction,
	Client,
	Interaction,
} from "discord.js";
import { sql } from "bun";
import { showInfoEmbed } from "../../utils/interactionHelpers";
import { ColorScheme } from "../../utils/logBeautifier";
import type { ExtendedCommand } from "../../types/global";
import { userSchema, type UserRow } from "../../types/db";
import getLocalCommands from "../../utils/getLocalCommands";
import { localizer } from "../../utils/textLocalizer";
import { log } from "../../utils/logBeautifier";

const TIMEOUT_DURATION = 30000;
const COOLDOWN_MAP = new Map<string, number>([
	["economy", 2000],
	["scrape", 10000],
	["tool", 10000],
	["fun", 2000],
]);

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

	const { TESTSRV_ID, DEV_ID } = process.env;
	const locale = interaction.locale || "en";

	try {
		const localCommands = (await getLocalCommands()) as ExtendedCommand[];
		const commandObject = localCommands.find(
			(cmd) => cmd.name === interaction.commandName,
		);

		if (!commandObject) return;

		// Command execution logic with timeout
		const mainLogicPromise = async () => {
			// 1. Check for dev/test only restrictions
			if (commandObject.devOnly && interaction.user.id !== DEV_ID) {
				await showInfoEmbed(interaction, locale, {
					titleKey: "general.errors.dev_only",
					descriptionKey: "general.errors.dev_only",
					color: ColorScheme.ERROR,
				});
				return;
			}

			if (commandObject.testOnly && interaction.guildId !== TESTSRV_ID) {
				await showInfoEmbed(interaction, locale, {
					titleKey: "general.errors.test_only",
					descriptionKey: "general.errors.test_only",
					color: ColorScheme.ERROR,
				});
				return;
			}

			// 2. Check permissions
			if (commandObject.permissionsRequired?.length) {
				for (const permission of commandObject.permissionsRequired) {
					if (!interaction.memberPermissions?.has(permission)) {
						await showInfoEmbed(interaction, locale, {
							titleKey: "general.errors.insufficient_permissions",
							descriptionKey: "general.errors.insufficient_permissions",
							color: ColorScheme.ERROR,
						});
						return;
					}
				}
			}

			// 3. Check cooldowns if category exists
			if (commandObject.category) {
				const cooldownDuration = COOLDOWN_MAP.get(commandObject.category);
				if (cooldownDuration) {
					const timeLeft = await checkCooldown(
						interaction.user.id,
						commandObject.category,
					);

					if (timeLeft > 0) {
						const timeLeftSeconds = Math.ceil(timeLeft / 1000);
						await showInfoEmbed(interaction, locale, {
							titleKey: "general.cooldown",
							descriptionKey: "general.cooldown",
							descriptionVars: { seconds: timeLeftSeconds },
							color: ColorScheme.WARN,
						});
						return;
					}

					// Set new cooldown if no active one exists
					await setCooldown(
						interaction.user.id,
						commandObject.category,
						cooldownDuration,
					);
				}
			}

			// 4. Get or create user data with Bun SQL and Zod validation
			let userData: UserRow | undefined;
			const [existingUser] = await sql`
				SELECT * FROM users WHERE user_disc_id = ${interaction.user.id}
			`;

			if (existingUser) {
				userData = userSchema.parse(existingUser);
			} else if (interaction.guild) {
				const serverLocale = interaction.guild.preferredLocale;
				const userLanguage = serverLocale.startsWith("ja") ? "ja" : "en";

				const [newUser] = await sql`
					INSERT INTO users (
						user_disc_id,
						user_nickname,
						language_pref
					) VALUES (
						${interaction.user.id},
						${interaction.user.displayName},
						${userLanguage}
					)
					RETURNING *
				`;
				userData = userSchema.parse(newUser);
			}

			// 5. Execute command
			if (userData) {
				await commandObject.callback(client, interaction, userData);
			} else {
				log.error("No user data available for command execution");
				await showInfoEmbed(interaction, locale, {
					titleKey: "general.errors.generic_error",
					descriptionKey: "general.errors.generic_error",
					color: ColorScheme.ERROR,
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
			await showInfoEmbed(interaction, locale, {
				titleKey: "general.errors.generic_error",
				descriptionKey: "general.errors.generic_error",
				color: ColorScheme.ERROR,
			});
		}
	}
};

export default handler;
