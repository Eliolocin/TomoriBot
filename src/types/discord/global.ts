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
	arg1?: EventArg,
	arg2?: EventArg,
) => Promise<void>;

export type EventArg =
	| VoiceState
	| Presence
	| Client
	| Guild
	| GuildMember
	| Interaction
	| Message;

export interface Locales {
	[key: string]: {
		[key: string]: string;
	};
}

export interface LocalizerVariables {
	[key: string]: string | number;
}

export enum TeachPerms {
	CHANNEL_MANAGER = "chmanager",
	PRICED = "priced",
	FREE = "free",
}
