import {
	type ApplicationCommand,
	ApplicationCommandOptionData,
} from "discord.js";
import type {
	LocalCommand,
	CommandChoice,
	CommandOption,
} from "../types/global";

/**
 * Compares an existing application command with a local command definition to determine if they are different.
 * @param existingCommand - The command currently registered with Discord.
 * @param localCommand - The local command definition.
 * @returns True if the commands differ, false otherwise.
 */
const areCommandsDifferent = (
	existingCommand: ApplicationCommand,
	localCommand: LocalCommand,
): boolean => {
	const areChoicesDifferent = (
		existingChoices?: CommandChoice[],
		localChoices?: CommandChoice[],
	): boolean => {
		if (!localChoices) return false;

		for (const localChoice of localChoices) {
			const existingChoice = existingChoices?.find(
				(choice) => choice.name === localChoice.name,
			);

			if (!existingChoice) return true;
			if (localChoice.value !== existingChoice.value) return true;
		}
		return false;
	};

	const areOptionsDifferent = (
		existingOptions?: CommandOption[],
		localOptions?: CommandOption[],
	): boolean => {
		if (!localOptions) return false;

		for (const localOption of localOptions) {
			const existingOption = existingOptions?.find(
				(option) => option.name === localOption.name,
			) as CommandOption | undefined;

			if (!existingOption) return true;

			if (
				localOption.description !== existingOption.description ||
				localOption.type !== existingOption.type ||
				(localOption.required || false) !==
					(existingOption.required || false) ||
				(localOption.choices?.length || 0) !==
					(existingOption.choices?.length || 0) ||
				areChoicesDifferent(existingOption.choices, localOption.choices)
			) {
				return true;
			}
		}
		return false;
	};

	return (
		existingCommand.description !== localCommand.description ||
		(existingCommand.options?.length || 0) !==
			(localCommand.options?.length || 0) ||
		areOptionsDifferent(
			existingCommand.options as CommandOption[],
			localCommand.options as CommandOption[],
		)
	);
};

export default areCommandsDifferent;
