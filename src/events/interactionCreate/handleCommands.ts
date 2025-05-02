import { MessageFlags, type Client, type Interaction } from "discord.js";
import { sql } from "bun";
import { replyInfoEmbed } from "../../utils/discord/interactionHelper";
import { ColorCode, log } from "../../utils/misc/logger";
import {
	userSchema,
	type UserRow,
	type ErrorContext,
} from "../../types/db/schema";
import { localizer } from "../../utils/text/localizer";
import { registerUser } from "../../utils/db/dbWrite";
import {
	loadCommandData,
	type CommandExecutionMap,
	type CommandCooldownMap,
} from "../../utils/discord/commandLoader";

// Define constants at the top (Rule #20)
const TIMEOUT_DURATION = 100000; // 100 Seconds
const COOLDOWN_MAP = new Map<string, number>([
	["economy", 2000],
	["scrape", 10000],
	["tool", 1000],
	["fun", 2000],
	["config", 5000], // Add cooldown for config category
	["teach", 5000], // Add cooldown for config category
]);

// Cache for command execution maps - stored at module level
let executionMap: CommandExecutionMap | null = null;
let cooldownMap: CommandCooldownMap | null = null;

/**
 * Checks if a command is on cooldown for a user
 * @param userId - Discord user ID
 * @param category - Command category
 * @returns Boolean indicating if command is on cooldown
 */
async function checkCooldown(
	userId: string,
	category: string,
): Promise<boolean> {
	const now = Date.now();
	const [cooldown] = await sql`
    SELECT expiry_time 
    FROM cooldowns 
    WHERE user_disc_id = ${userId} 
    AND command_category = ${category}
    AND expiry_time > ${now}
  `;

	return Boolean(cooldown);
}

/**
 * Gets the remaining cooldown time in seconds
 * @param userId - Discord user ID
 * @param category - Command category
 * @returns Remaining cooldown time in seconds
 */
async function getRemainingCooldown(
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

	if (!cooldown) return 0;
	return Math.ceil((Number(cooldown.expiry_time) - now) / 1000);
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

	// Determine locale early for potential error messages
	const initialLocale =
		interaction.locale ?? interaction.guildLocale ?? "en-US";

	try {
		// 1. Load command data on first run if cache is empty
		if (!executionMap || !cooldownMap) {
			log.info("Initializing command execution maps...");
			const loadedData = await loadCommandData();
			executionMap = loadedData.executionMap;
			cooldownMap = loadedData.cooldownMap;

			// Use our existing cooldown values if none were provided from commands
			if (cooldownMap.size === 0) {
				for (const [category, duration] of COOLDOWN_MAP.entries()) {
					cooldownMap.set(category, duration);
				}
			}

			log.success("Command execution maps initialized.");
		}

		// 2. Get command and subcommand names
		const commandName = interaction.commandName; // The top-level command (category)
		const subcommandName = interaction.options.getSubcommand(false); // The specific subcommand (may be null)

		// 3. Find the execute function
		const subcommandMap = executionMap.get(commandName);
		if (!subcommandMap) {
			// Top-level command not found
			log.warn(`Command category not found: ${commandName}`);
			await replyInfoEmbed(
				interaction,
				initialLocale,
				{
					titleKey: "general.errors.unknown_error_title",
					descriptionKey: "general.errors.unknown_error_description",
					color: ColorCode.ERROR,
				},
				MessageFlags.Ephemeral,
			);
			return;
		}

		// If no subcommand was specified but we require one
		if (!subcommandName) {
			log.warn(`No subcommand specified for category: ${commandName}`);
			await replyInfoEmbed(
				interaction,
				initialLocale,
				{
					titleKey: "general.errors.unknown_error_title",
					descriptionKey: "general.errors.unknown_error_description",
					color: ColorCode.ERROR,
				},
				MessageFlags.Ephemeral,
			);
			return;
		}

		// Get the execute function for this subcommand
		const executeFunction = subcommandMap.get(subcommandName);
		if (!executeFunction) {
			log.warn(`Subcommand not found: ${commandName} ${subcommandName}`);
			await replyInfoEmbed(
				interaction,
				initialLocale,
				{
					titleKey: "general.errors.unknown_error_title",
					descriptionKey: "general.errors.unknown_error_description",
					color: ColorCode.ERROR,
				},
				MessageFlags.Ephemeral,
			);
			return;
		}

		// --- Start of main logic execution with timeout ---
		const mainLogicPromise = async () => {
			// 4. Check cooldowns based on the category (top-level command)
			// biome-ignore lint/style/noNonNullAssertion: We've checked it's not null before entering this block
			const cooldownDuration = cooldownMap!.get(commandName);

			if (cooldownDuration) {
				const isOnCooldown = await checkCooldown(
					interaction.user.id,
					commandName,
				);
				if (isOnCooldown) {
					const remainingSeconds = await getRemainingCooldown(
						interaction.user.id,
						commandName,
					);
					await replyInfoEmbed(
						interaction,
						initialLocale,
						{
							titleKey: "general.cooldown_title",
							descriptionKey: "general.cooldown",
							descriptionVars: {
								seconds: remainingSeconds,
								category: commandName,
							},
							color: ColorCode.WARN,
						},
						MessageFlags.Ephemeral,
					);
					return;
				}

				// Set new cooldown if not on cooldown
				await setCooldown(interaction.user.id, commandName, cooldownDuration);
			}

			// 5. Get or create user data
			let userData: UserRow | undefined;
			const [existingUser] = await sql`
        SELECT * FROM users WHERE user_disc_id = ${interaction.user.id}
      `;

			if (existingUser) {
				userData = userSchema.parse(existingUser);
			} else if (interaction.guild) {
				// Get locale to use for new user
				const userLanguage = interaction.locale;

				// Use the registerUser helper (Rule #17)
				const registeredUser = await registerUser(
					interaction.user.id,
					interaction.user.displayName || interaction.user.username,
					userLanguage,
				);

				if (registeredUser) {
					userData = registeredUser;
				}
			}

			// Get the final locale once user data is potentially available
			const finalLocale =
				userData?.language_pref ?? interaction.guildLocale ?? "en-US";

			// 6. Execute command
			if (userData) {
				await executeFunction(client, interaction, userData, finalLocale);
			} else {
				// Handle case where user data couldn't be obtained
				const context: ErrorContext = {
					errorType: "UserDataError",
					metadata: {
						userDiscordId: interaction.user.id,
						command: `${commandName} ${subcommandName}`,
					},
				};
				await log.error(
					"User data unavailable for command execution",
					undefined,
					context,
				);

				await replyInfoEmbed(interaction, finalLocale, {
					titleKey: "general.errors.unknown_error_title",
					descriptionKey: "general.errors.unknown_error_description",
					color: ColorCode.ERROR,
				});
			}
		};

		// Race main logic against timeout
		await Promise.race([
			mainLogicPromise(),
			new Promise((_, reject) =>
				setTimeout(
					() =>
						reject(
							new Error(
								localizer(initialLocale, "general.errors.command_timeout"),
							),
						),
					TIMEOUT_DURATION,
				),
			),
		]);
	} catch (error) {
		// Log error with structured context (Rule #22)
		const context: ErrorContext = {
			errorType: "CommandHandlingError",
			metadata: {
				commandName: interaction.commandName,
				subcommandName: interaction.options.getSubcommand(false),
				userDiscordId: interaction.user.id,
				guildDiscordId: interaction.guild?.id ?? "DM",
			},
		};
		await log.error(
			`Error in command handler for: ${interaction.commandName}`,
			error,
			context,
		);

		// Reply to user if possible
		if (!interaction.replied && !interaction.deferred) {
			await replyInfoEmbed(interaction, initialLocale, {
				titleKey: "general.errors.unknown_error_title",
				descriptionKey: "general.errors.unknown_error_description",
				color: ColorCode.ERROR,
			});
		}
	}
};

export default handler;
