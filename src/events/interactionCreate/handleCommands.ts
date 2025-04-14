import { ChatInputCommandInteraction, Client, Interaction } from "discord.js";
import UserModel from "../../models/userSchema";
import { IUser } from "../../types/global";
import getLocalCommands from "../../utils/getLocalCommands";
import { localizer } from "../../utils/textLocalizer";

interface ExtendedCommand {
	name: string;
	description: string;
	devOnly?: boolean;
	testOnly?: boolean;
	deleted?: boolean;
	permissionsRequired?: bigint[];
	botPermissions?: bigint[];
	category?: string;
	callback: (
		client: Client,
		interaction: ChatInputCommandInteraction,
		userData: IUser,
	) => Promise<void>;
}

const TIMEOUT_DURATION = 30000;
const cooldownDurations = new Map<string, number>([
	["economy", 2000],
	["scrape", 10000],
	["tool", 10000],
	["fun", 2000],
]);

const handler = async (
	client: Client,
	interaction: Interaction,
): Promise<void> => {
	if (!interaction.isChatInputCommand()) return;

	const userModel = UserModel;
	const { TESTSRV_ID, DEV_ID } = process.env;
	let userData = await userModel.findOne({ userID: interaction.user.id });

	try {
		const localCommands = (await getLocalCommands()) as ExtendedCommand[];
		const commandObject = localCommands.find(
			(cmd) => cmd.name === interaction.commandName,
		);

		if (!commandObject) return;

		// Command execution logic with timeout
		const mainLogicPromise = async () => {
			// Initialize userData if it doesn't exist
			if (!userData && interaction.guild) {
				const serverLocale = interaction.guild.preferredLocale;
				const userLanguage = serverLocale.startsWith("ja") ? "ja" : "en";

				userData = await userModel.create({
					userID: interaction.user.id,
					serverID: interaction.guildId,
					nickname: interaction.user.displayName,
					language: userLanguage,
				});
				await userData.save();
			}

			if (commandObject.devOnly && interaction.user.id !== DEV_ID) {
				try {
					await interaction.reply({
						content: localizer(
							userData?.language || "en",
							"general.errors.dev_only",
						),
						ephemeral: true,
					});
				} catch (error: any) {
					if (error.code === 10062) {
						// Interaction expired or invalid after bot restart; ignore
						return;
					}
					console.error("Reply error:", error);
				}
				return;
			}

			if (commandObject.testOnly && interaction.guildId !== TESTSRV_ID) {
				try {
					await interaction.reply({
						content: localizer(
							userData?.language || "en",
							"general.errors.test_only",
						),
						ephemeral: true,
					});
				} catch (error: any) {
					if (error.code === 10062) {
						// Interaction expired or invalid after bot restart; ignore
						return;
					}
					console.error("Reply error:", error);
				}
				return;
			}

			// Permission checks
			if (commandObject.permissionsRequired?.length) {
				for (const permission of commandObject.permissionsRequired) {
					if (!interaction.memberPermissions?.has(permission)) {
						try {
							await interaction.reply({
								content: localizer(
									userData?.language || "en",
									"general.errors.insufficient_permissions",
								),
								ephemeral: true,
							});
						} catch (error: any) {
							if (error.code === 10062) {
								// Interaction expired or invalid after bot restart; ignore
								return;
							}
							console.error("Reply error:", error);
						}
						return;
					}
				}
			}

			// Cooldown check
			if (userData && commandObject.category) {
				const cooldownDuration = cooldownDurations.get(commandObject.category);
				if (cooldownDuration) {
					const now = Date.now();
					const userCooldowns = userData.cooldowns || new Map<string, number>();

					if (
						userCooldowns.has(commandObject.category) &&
						userCooldowns.get(commandObject.category)! > now
					) {
						const remaining = Math.ceil(
							(userCooldowns.get(commandObject.category)! - now) / 1000,
						);
						try {
							await interaction.reply({
								content: localizer(
									userData?.language || "en",
									"general.cooldown",
									{ seconds: remaining },
								),
								ephemeral: true,
							});
						} catch (error: any) {
							if (error.code === 10062) {
								// Interaction expired or invalid after bot restart; ignore
								return;
							}
							console.error("Reply error:", error);
						}
						return;
					}

					userCooldowns.set(commandObject.category, now + cooldownDuration);
					userData.cooldowns = userCooldowns;
					await userData.save();
				}
			}

			await commandObject.callback(client, interaction, userData!);
		};

		await Promise.race([
			mainLogicPromise(),
			new Promise((_, reject) =>
				setTimeout(
					() =>
						reject(
							localizer(
								userData?.language || "en",
								"general.errors.command_timeout",
							),
						),
					TIMEOUT_DURATION,
				),
			),
		]);
	} catch (error) {
		console.error("Error in command execution:", error);
		if (!interaction.replied && !interaction.deferred) {
			try {
				await interaction.reply({
					content: localizer(
						userData?.language || "en",
						"general.errors.generic_error",
					),
					ephemeral: true,
				});
			} catch (error: any) {
				if (error.code === 10062) {
					// Interaction expired or invalid after bot restart; ignore
					return;
				}
				console.error("Reply error:", error);
			}
		}
	}
};

export default handler;
