import type {
	ChatInputCommandInteraction,
	Client,
	SlashCommandSubcommandBuilder,
} from "discord.js";
import { sql } from "bun";
import { loadTomoriState } from "../../utils/db/dbRead";
import { tomoriConfigSchema } from "../../types/db/schema";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import { replyInfoEmbed } from "../../utils/discord/interactionHelper";
import type { UserRow, ErrorContext } from "../../types/db/schema";

// Constants for threshold limits (Rule #20)
const MIN_THRESHOLD = 0; // The absolute minimum value allowed (0)
const RANGE_START_THRESHOLD = 30; // The start of the allowed upper range
const MAX_THRESHOLD = 100; // The absolute maximum value allowed

// Configure the subcommand (Rule #21)
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("autochthreshold")
		.setDescription(
			localizer("en-US", "commands.config.autochthreshold.description"),
		)
		.addIntegerOption((option) =>
			option
				.setName("threshold")
				.setDescription(
					localizer(
						"en-US",
						"commands.config.autochthreshold.threshold_description_v2",
					),
				)
				.setMinValue(MIN_THRESHOLD)
				.setMaxValue(MAX_THRESHOLD)
				.setRequired(true),
		);

/**

Configures auto-chat threshold settings for Tomori.
Once threshold is exceeded or met, Tomori will automatically chat.
Setting to '0' will disable auto-chat
@param _client - Discord client instance
@param interaction - Command interaction
@param userData - User data from database
@param locale - Locale of the interaction */ export async function execute(
	_client: Client,
	interaction: ChatInputCommandInteraction,
	userData: UserRow,
	locale: string,
): Promise<void> {
	// Ensure command is run in a guild
	if (!interaction.guild || !interaction.channel) {
		await replyInfoEmbed(interaction, userData.language_pref, {
			titleKey: "general.errors.guild_only_title",
			descriptionKey: "general.errors.guild_only_description",
			color: ColorCode.ERROR,
		});
		return;
	}
	try {
		// Get the threshold value from options
		const threshold = interaction.options.getInteger("threshold", true);

		// Validate the threshold against the specific allowed ranges (0 OR 30-100)
		const isValidThreshold =
			threshold === MIN_THRESHOLD ||
			(threshold >= RANGE_START_THRESHOLD && threshold <= MAX_THRESHOLD);

		if (!isValidThreshold) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.autochthreshold.invalid_range_title",
				descriptionKey:
					"commands.config.autochthreshold.invalid_range_specific_description",
				descriptionVars: {
					min: MIN_THRESHOLD.toString(),
					range_start: RANGE_START_THRESHOLD.toString(),
					max: MAX_THRESHOLD.toString(),
				},
				color: ColorCode.ERROR,
			});
			return;
		}

		// Load the Tomori state for this server - let helper functions manage interaction state
		const tomoriState = await loadTomoriState(interaction.guild.id);
		if (!tomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.tomori_not_setup_title",
				descriptionKey: "general.errors.tomori_not_setup_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// Update the threshold in the database with direct SQL (Rule #4, #15)
		const [updatedRow] = await sql`
  UPDATE tomori_configs
  SET autoch_threshold = ${threshold}
  WHERE tomori_id = ${tomoriState.tomori_id}
  RETURNING *
`;

		if (!updatedRow) {
			const context: ErrorContext = {
				tomoriId: tomoriState.tomori_id,
				serverId: tomoriState.server_id,
				userId: userData.user_id,
				errorType: "DatabaseUpdateError",
				metadata: {
					command: "config autochthreshold",
					threshold,
					targetTable: "tomori_config",
				},
			};
			await log.error(
				"Failed to update autoch_threshold config",
				new Error("Database update returned no rows"),
				context,
			);

			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.update_failed_title",
				descriptionKey: "general.errors.update_failed_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// Validate the returned data (Rules #3, #5)
		const validatedConfig = tomoriConfigSchema.safeParse(updatedRow);
		if (!validatedConfig.success) {
			const context: ErrorContext = {
				tomoriId: tomoriState.tomori_id,
				serverId: tomoriState.server_id,
				errorType: "SchemaValidationError",
				metadata: {
					command: "config autochthreshold",
					validationErrors: validatedConfig.error.flatten(),
				},
			};
			await log.error(
				"Failed to validate updated config",
				validatedConfig.error,
				context,
			);

			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.update_failed_title",
				descriptionKey: "general.errors.update_failed_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// Success message based on auto-chat state
		const isAutoChatEnabled = threshold > 0;
		await replyInfoEmbed(interaction, locale, {
			titleKey: isAutoChatEnabled
				? "commands.config.autochthreshold.success_title"
				: "commands.config.autochthreshold.success_disabled_title",
			descriptionKey: isAutoChatEnabled
				? "commands.config.autochthreshold.success_description"
				: "commands.config.autochthreshold.success_disabled_description",
			descriptionVars: {
				threshold: threshold.toString(),
			},
			color: isAutoChatEnabled ? ColorCode.SUCCESS : ColorCode.WARN,
		});
	} catch (error) {
		const context: ErrorContext = {
			userId: userData.user_id,
			serverId: (await loadTomoriState(interaction.guild.id))?.server_id,
			errorType: "CommandExecutionError",
			metadata: {
				command: "config autochthreshold",
				options: interaction.options?.data,
			},
		};
		await log.error(
			"Error in /config autochthreshold command",
			error as Error,
			context,
		);

		await replyInfoEmbed(interaction, locale, {
			titleKey: "general.errors.unknown_error_title",
			descriptionKey: "general.errors.unknown_error_description",
			color: ColorCode.ERROR,
		});
	}
}
