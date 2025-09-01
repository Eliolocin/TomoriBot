/**
 * TypeScript types for Discord's raw API data structures
 * 
 * This module provides proper type definitions for Discord API data that doesn't
 * have complete TypeScript support in Discord.js, particularly for custom components
 * and raw WebSocket message handling.
 */

/**
 * Raw Discord API component structure for Component Type 18 (Label wrapper)
 * This is used internally by Discord for complex component layouts.
 */
export interface RawDiscordComponent {
	/** Component type identifier */
	type: number;
	/** Component ID */
	id?: number;
	/** Custom ID for the component */
	custom_id?: string;
	/** Component style (varies by type) */
	style?: number;
	/** Whether the component is required (for inputs) */
	required?: boolean;
	/** Component placeholder text */
	placeholder?: string;
	/** Minimum length for text inputs */
	min_length?: number;
	/** Maximum length for text inputs */
	max_length?: number;
	/** Component label text */
	label?: string;
	/** Component description text */
	description?: string;
	/** Component value (for text inputs) */
	value?: string;
	/** Selected values (for select menus) */
	values?: string[];
	/** Nested component (for type 18 wrappers) */
	component?: RawDiscordComponent;
	/** Child components array (for containers) */
	components?: RawDiscordComponent[];
	/** Select menu options */
	options?: Array<{
		label: string;
		value: string;
		description?: string;
		emoji?: {
			id?: string;
			name?: string;
			animated?: boolean;
		};
		default?: boolean;
	}>;
}

/**
 * Raw Discord WebSocket packet structure
 * Used for intercepting and handling WebSocket messages at a low level.
 */
export interface RawDiscordWebSocketPacket {
	/** WebSocket operation code */
	op: number;
	/** Sequence number */
	s?: number;
	/** Event type */
	t?: string;
	/** Event data */
	d?: {
		/** Interaction ID */
		id?: string;
		/** Interaction data */
		data?: {
			/** Component interaction data */
			components?: RawDiscordComponent[];
			/** Custom ID */
			custom_id?: string;
			/** Component type */
			component_type?: number;
			/** Values array for select menus */
			values?: string[];
		};
		/** Interaction type */
		type?: number;
		/** Application ID */
		application_id?: string;
		/** Interaction token */
		token?: string;
		/** Guild ID */
		guild_id?: string;
		/** Channel ID */
		channel_id?: string;
		/** User object */
		user?: {
			id: string;
			username: string;
			discriminator: string;
			avatar?: string;
		};
		/** Member object (in guilds) */
		member?: {
			user: {
				id: string;
				username: string;
				discriminator: string;
				avatar?: string;
			};
			nick?: string;
			roles: string[];
		};
		/** Message object */
		message?: {
			id: string;
			content: string;
			components?: RawDiscordComponent[];
		};
	};
}

/**
 * Discord.js Client interface extension for internal properties
 * Used for accessing WebSocket manager and other internal features.
 */
export interface ExtendedDiscordClient {
	/** WebSocket manager with handlePacket method */
	ws?: {
		handlePacket?: (packet: RawDiscordWebSocketPacket, shard: RawDiscordShard) => void;
		[key: string]: unknown;
	} & Record<string, unknown>;
	/** Additional client properties */
	[key: string]: unknown;
}

/**
 * Discord WebSocket shard information
 * Used for WebSocket packet handling with shard context.
 */
export interface RawDiscordShard {
	/** Shard ID */
	id: number;
	/** Additional shard properties */
	[key: string]: unknown;
}

/**
 * Global state tracking interface for patch management
 * Used to track whether WebSocket interception patches have been applied.
 */
export interface GlobalDiscordState {
	/** Whether WebSocket patching has been applied */
	__webSocketPatched?: boolean;
	/** Additional global state properties */
	[key: string]: unknown;
}