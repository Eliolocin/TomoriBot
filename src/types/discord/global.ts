import type {
	Client,
	Guild,
	GuildMember,
	Interaction,
	Message,
	PermissionsBitField,
	Presence,
	VoiceState,
	ApplicationCommandOptionData,
	ApplicationCommandOptionType,
	ChatInputCommandInteraction,
	GuildEmoji,
	Sticker,
} from "discord.js";
import type { UserRow } from "../db/schema";

export interface CommandChoice {
	name: string;
	value: string | number;
}

export interface CommandOption {
	name: string;
	description: string;
	type: ApplicationCommandOptionType;
	required?: boolean;
	choices?: CommandChoice[];
	options?: CommandOption[];
}

// Base command interface
export interface BaseCommand {
	name: string;
	description: string;
	category: string;
	options?: ApplicationCommandOptionData[];
	permissionsRequired?: PermissionsBitField[];
	callback: (
		client: Client,
		interaction: ChatInputCommandInteraction,
		userData: UserRow,
	) => Promise<void>;
}

// Local command interface (for file loading)
export interface LocalCommand extends BaseCommand {
	deleted?: boolean;
}

// Extended command interface (for runtime with additional properties)
export interface ExtendedCommand extends BaseCommand {
	devOnly?: boolean;
	testOnly?: boolean;
	botPermissions?: bigint[];
}

export interface EventFile {
	name: string;
	path: string;
	function: EventFunction;
}

export type EventFunction = (
	client: Client,
	...args: EventArg[] // Use rest parameters for flexibility across different events
) => Promise<void>;

export type EventArg =
	| VoiceState
	| Presence
	| Client
	| Guild
	| GuildMember
	| Interaction
	| Message
	| GuildEmoji
	| Sticker;

// i18n
export interface LocaleObject {
	[key: string]: LocaleValue;
}

export type LocaleValue = string | LocaleObject;

export interface Locales {
	[locale: string]: LocaleObject;
}
export interface LocalizerVariables {
	[key: string]: string | number | boolean;
}
