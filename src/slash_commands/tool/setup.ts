import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	type ChatInputCommandInteraction,
	type Client,
	EmbedBuilder,
	ModalBuilder,
	PermissionsBitField,
	StringSelectMenuBuilder,
	TextInputBuilder,
	TextInputStyle,
	ComponentType, // Import ComponentType for button collector filter
	InteractionCollector, // Import InteractionCollector for button handling
	type ButtonInteraction, // Import ButtonInteraction type
	// Add other necessary discord.js types like TextChannel, ComponentType etc.
} from "discord.js";
import { sql } from "bun";
import type { Command } from "../../types/global";
import type {
	UserRow,
	TomoriPresetRow,
	ServerRow,
	TomoriRow,
	LlmRow,
} from "../../types/db"; // Import necessary DB types
import { localizer } from "../../utils/textLocalizer";
import { log } from "../../utils/logBeautifier";

// Define the structure for temporarily storing setup data
interface SetupData {
	encryptedApiKey: Buffer | null;
	presetId: number | null;
	autochChannelIds: string[];
	autochThreshold: number;
	humanizerEnabled: boolean;
	serverId: number | null; // To store server_id if we insert it early
}

/**
 * @description Command to guide users through the initial setup of TomoriBot for their server.
 */
const command: Command = {
	name: "setup",
	description: localizer("en", "tool.setup.command_description"), // Use a default locale for the base description
	category: "tool",
	// Require 'Manage Server' permission
	permissionsRequired: [
		new PermissionsBitField(PermissionsBitField.Flags.ManageGuild),
	],

	/**
	 * @description Executes the multi-step setup process for TomoriBot.
	 * @param client The Discord client instance.
	 * @param interaction The ChatInputCommandInteraction object.
	 * @param _userData User data (not typically needed for server setup).
	 */
	callback: async (
		client: Client,
		interaction: ChatInputCommandInteraction,
		_userData: UserRow, // Mark as unused if not needed
	): Promise<void> => {
		// 0. Ensure command is run in a guild
		if (!interaction.guild || !interaction.channel) {
			// Should theoretically not happen for guild commands, but good practice
			await interaction.reply({
				content: "This command can only be used in a server.",
				ephemeral: true,
			});
			return;
		}

		// Determine locale for responses (use interaction locale or guild preferred locale if available, fallback to 'en')
		const locale = interaction.locale ?? interaction.guildLocale ?? "en";

		// Check user permissions again (belt-and-suspenders)
		const memberPermissions = interaction.member?.permissions;
		if (
			!memberPermissions ||
			!(memberPermissions instanceof PermissionsBitField) || // Type guard
			!memberPermissions.has(PermissionsBitField.Flags.ManageGuild)
		) {
			const embed = new EmbedBuilder()
				.setColor("#E74C3C") // Red
				.setTitle(localizer(locale, "tool.setup.error_title"))
				.setDescription(localizer(locale, "tool.setup.no_permission"));
			await interaction.reply({ embeds: [embed], ephemeral: true });
			return;
		}

		// Check if Tomori already exists for this server
		try {
			const [existingServer] = await sql`
				SELECT s.server_id
				FROM servers s
				JOIN tomoris t ON s.server_id = t.server_id
				WHERE s.server_disc_id = ${interaction.guild.id}
			`;

			if (existingServer) {
				const embed = new EmbedBuilder()
					.setColor("#E74C3C") // Red
					.setTitle(localizer(locale, "tool.setup.error_title"))
					// TODO: Add locale string 'tool.setup.already_exists'
					.setDescription(
						localizer(
							locale,
							"tool.setup.already_exists" /*"Tomori is already set up on this server! Use /settings or /teach to modify."*/,
						),
					);
				await interaction.reply({ embeds: [embed], ephemeral: true });
				return;
			}
		} catch (error) {
			log.error("Error checking for existing Tomori during setup:", error);
			const embed = new EmbedBuilder()
				.setColor("#E74C3C") // Red
				.setTitle(localizer(locale, "tool.setup.error_title"))
				.setDescription(localizer(locale, "general.errors.generic_error"));
			await interaction.reply({ embeds: [embed], ephemeral: true });
			return;
		}

		// Initialize temporary storage for setup data
		const setupData: SetupData = {
			encryptedApiKey: null,
			presetId: null,
			autochChannelIds: [],
			autochThreshold: 0,
			humanizerEnabled: true, // Default to true
			serverId: null,
		};

		// Defer reply to allow time for multi-step interaction
		await interaction.deferReply({ ephemeral: true });

		try {
			// --- Step 1: API Key Prep ---
			// 1. Create the explanation embed
			const apiKeyPrepEmbed = new EmbedBuilder()
				.setColor("#FEE75C") // Yellow
				.setTitle(localizer(locale, "tool.setup.api_prep_title"))
				.setDescription(localizer(locale, "tool.setup.api_prep_description"));

			// 2. Create Continue and Cancel buttons
			const continueButton = new ButtonBuilder()
				.setCustomId("setup_api_continue")
				.setLabel(localizer(locale, "tool.setup.button_continue"))
				.setStyle(ButtonStyle.Success); // Green for continue

			const cancelButton = new ButtonBuilder()
				.setCustomId("setup_api_cancel")
				.setLabel(localizer(locale, "tool.setup.button_cancel"))
				.setStyle(ButtonStyle.Danger); // Red for cancel

			// 3. Create an action row for the buttons
			const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
				continueButton,
				cancelButton,
			);

			// 4. Send the embed and buttons as the initial reply edit
			const prepMessage = await interaction.editReply({
				embeds: [apiKeyPrepEmbed],
				components: [buttonRow],
			});

			// 5. Create a collector to wait for the user's button click
			// Filter ensures only the original command user can interact
			const buttonCollectorFilter = (i: ButtonInteraction) => {
				// Defer update to prevent "interaction failed" message
				i.deferUpdate();
				// Check if the interaction is from the original user
				return i.user.id === interaction.user.id;
			};

			let proceedToApiKey = false; // Flag to control flow

			try {
				// Wait for a button interaction for 15 seconds
				const buttonInteraction = await prepMessage.awaitMessageComponent({
					filter: buttonCollectorFilter,
					componentType: ComponentType.Button,
					time: 15000, // 15 seconds timeout
				});

				// 6. Handle the button click
				if (buttonInteraction.customId === "setup_api_continue") {
					proceedToApiKey = true;
					// (We'll proceed to Step 2 after this block)
				} else if (buttonInteraction.customId === "setup_api_cancel") {
					// User cancelled
					const cancelEmbed = new EmbedBuilder()
						.setColor("#E74C3C") // Red
						.setTitle(localizer(locale, "tool.setup.cancel_title"))
						.setDescription(localizer(locale, "tool.setup.cancel_description"));
					await interaction.editReply({
						embeds: [cancelEmbed],
						components: [],
					});
					return; // End setup
				}
			} catch (timeoutError) {
				// Handle timeout specifically
				const timeoutEmbed = new EmbedBuilder()
					.setColor("#E74C3C") // Red
					.setTitle(localizer(locale, "tool.setup.timeout_title"))
					.setDescription(localizer(locale, "tool.setup.timeout_description"));
				await interaction.editReply({ embeds: [timeoutEmbed], components: [] });
				return; // End setup due to timeout
			}

			// --- Step 2: API Key Input (Modal) ---
			if (proceedToApiKey) {
				// TODO: Implement Modal for API Key Input
				// Show the modal using interaction.showModal()
				// Await modal submission using interaction.awaitModalSubmit()
				// Encrypt the key and store in setupData.encryptedApiKey
				// Edit the reply to confirm key receipt (tool.setup.api_modal_success)
				log.info("Proceeding to API Key Input Modal..."); // Placeholder
			} else {
				// This case should ideally not be reached if cancel/timeout is handled
				log.warn(
					"API Key Prep step ended without proceeding or explicit cancel/timeout.",
				);
				return;
			}
			// --- Step 3: Preset Selection ---
			// TODO: Fetch presets matching locale
			// TODO: Show Preset Selection Embed + Reactions (1, 2, 3..., Cancel)
			// TODO: Store chosen presetId in setupData
			// --- Step 4: Autoch Channels ---
			// TODO: Show Autoch Channel Embed + Message Collector + Skip Button
			// TODO: Store channel IDs in setupData
			// --- Step 5: Autoch Threshold ---
			// TODO: Show Autoch Threshold Embed + Message Collector
			// TODO: Store threshold in setupData
			// --- Step 6: Humanizer ---
			// TODO: Show Humanizer Embed + Yes/No Buttons
			// TODO: Store boolean in setupData
			// --- Step 7: Confirmation & Saving ---
			// TODO: Show Confirmation Embed summarizing choices + Confirm/Cancel Buttons
			// TODO: If confirmed, perform DB transaction:
			//      1. INSERT INTO servers ... RETURNING server_id
			//      2. INSERT INTO tomoris ... RETURNING tomori_id
			//      3. INSERT INTO tomori_configs ...
			// --- Step 8: Final Message ---
			// TODO: Edit reply with Success/Cancelled/Timeout/Error embed based on outcome
		} catch (error) {
			// Handle timeouts or other errors during the interaction flow
			if (error instanceof Error && error.message.includes("time")) {
				// Basic timeout check
				const embed = new EmbedBuilder()
					.setColor("#E74C3C") // Red
					.setTitle(localizer(locale, "tool.setup.timeout_title"))
					.setDescription(localizer(locale, "tool.setup.timeout_description"));
				await interaction.editReply({ embeds: [embed], components: [] }); // Clear components
			} else {
				log.error("Error during setup command execution:", error);
				const embed = new EmbedBuilder()
					.setColor("#E74C3C") // Red
					.setTitle(localizer(locale, "tool.setup.error_title"))
					.setDescription(localizer(locale, "general.errors.generic_error"));
				// Attempt to edit reply, might fail if interaction already ended
				try {
					await interaction.editReply({ embeds: [embed], components: [] });
				} catch (editError) {
					log.error("Failed to edit reply after setup error:", editError);
				}
			}
		}
	},
} as const; // Use 'as const' for stricter typing

export default command;
