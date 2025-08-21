import { log } from "../misc/logger";
import { sql } from "bun";
import type { McpApiKeyRow } from "../../types/db/schema";

/**
 * Secret key used for symmetric encryption/decryption of API keys
 * IMPORTANT: In production, this should be stored in environment variables, not hardcoded
 */
const CRYPTO_SECRET = process.env.CRYPTO_SECRET;

/**
 * Encrypts an API key before storing it in the database using pgcrypto's PGP symmetric encryption.
 *
 * @param apiKey - The raw API key to encrypt
 * @returns Promise<Buffer> - The encrypted API key as a Buffer for database storage
 */
export const encryptApiKey = async (apiKey: string): Promise<Buffer> => {
	if (!apiKey) {
		log.warn("Empty API key provided for encryption");
		return Buffer.from("");
	}

	try {
		// Use PostgreSQL's pgp_sym_encrypt function with armor option to encrypt the API key
		// Note: The bytea output is directly compatible with Buffer
		const [result] = await sql`
      SELECT pgp_sym_encrypt(${apiKey.trim()}, ${CRYPTO_SECRET}, 'compress-algo=1, cipher-algo=aes256') AS encrypted_key
    `;

		if (!result || !result.encrypted_key) {
			throw new Error("Encryption failed");
		}

		log.success("API key encrypted successfully");

		// PostgreSQL already returns bytea as Buffer - don't convert to string first
		return result.encrypted_key;
	} catch (error) {
		log.error("Failed to encrypt API key", error);
		throw new Error("API key encryption failed");
	}
};

/**
 * Decrypts an API key retrieved from the database using pgcrypto's PGP symmetric decryption.
 *
 * @param encryptedKey - The encrypted API key Buffer from the database
 * @returns Promise<string> - The decrypted API key
 */
export const decryptApiKey = async (encryptedKey: Buffer): Promise<string> => {
	if (!encryptedKey || encryptedKey.length === 0) {
		log.warn("Empty encrypted key provided for decryption");
		return "";
	}

	try {
		// Use PostgreSQL's pgp_sym_decrypt function to decrypt the API key
		// No need for typecasting to bytea since encryptedKey is already a Buffer
		const [result] = await sql`
      SELECT pgp_sym_decrypt(${encryptedKey}, ${CRYPTO_SECRET}) AS decrypted_key
    `;

		if (!result || !result.decrypted_key) {
			throw new Error("Decryption failed");
		}

		// Convert the result to a string for use in the application
		return result.decrypted_key.toString();
	} catch (error) {
		log.error("Failed to decrypt API key", error);
		throw new Error("API key decryption failed");
	}
};

/**
 * Store an encrypted MCP API key in the database
 * @param serverId - Server ID to associate the key with
 * @param mcpName - Name of the MCP server (e.g., 'brave-search', 'duckduckgo-search')
 * @param apiKey - The raw API key to encrypt and store
 * @returns Promise<boolean> - True if stored successfully
 */
export const storeMcpApiKey = async (
	serverId: number,
	mcpName: string,
	apiKey: string,
): Promise<boolean> => {
	if (!apiKey || !mcpName || !serverId) {
		log.warn("Missing required parameters for MCP API key storage");
		return false;
	}

	try {
		log.info(
			`Storing encrypted MCP API key for server ${serverId}, MCP: ${mcpName}`,
		);

		// Encrypt the API key using the existing encryption function
		const encryptedKey = await encryptApiKey(apiKey);

		// Store in database with ON CONFLICT update for idempotent operation
		await sql`
			INSERT INTO mcp_api_keys (server_id, mcp_name, api_key)
			VALUES (${serverId}, ${mcpName}, ${encryptedKey})
			ON CONFLICT (server_id, mcp_name)
			DO UPDATE SET 
				api_key = EXCLUDED.api_key,
				updated_at = CURRENT_TIMESTAMP
		`;

		log.success(
			`MCP API key stored successfully for ${mcpName} on server ${serverId}`,
		);
		return true;
	} catch (error) {
		log.error(`Failed to store MCP API key for ${mcpName}`, error as Error);
		return false;
	}
};

/**
 * Retrieve and decrypt an MCP API key from the database
 * @param serverId - Server ID to look up
 * @param mcpName - Name of the MCP server
 * @returns Promise<string | null> - Decrypted API key or null if not found
 */
export const getMcpApiKey = async (
	serverId: number,
	mcpName: string,
): Promise<string | null> => {
	if (!mcpName || !serverId) {
		log.warn("Missing required parameters for MCP API key retrieval");
		return null;
	}

	try {
		log.info(`Retrieving MCP API key for server ${serverId}, MCP: ${mcpName}`);

		const [result] = await sql`
			SELECT api_key 
			FROM mcp_api_keys 
			WHERE server_id = ${serverId} AND mcp_name = ${mcpName}
		`;

		if (!result || !result.api_key) {
			log.info(`No MCP API key found for ${mcpName} on server ${serverId}`);
			return null;
		}

		// Decrypt the API key using the existing decryption function
		const decryptedKey = await decryptApiKey(result.api_key);

		log.success(`MCP API key retrieved successfully for ${mcpName}`);
		return decryptedKey;
	} catch (error) {
		log.error(`Failed to retrieve MCP API key for ${mcpName}`, error as Error);
		return null;
	}
};

/**
 * Get all MCP API keys for a server (returns a map of mcpName -> decryptedKey)
 * @param serverId - Server ID to look up
 * @returns Promise<Record<string, string>> - Map of MCP names to decrypted API keys
 */
export const getAllMcpApiKeysForServer = async (
	serverId: number,
): Promise<Record<string, string>> => {
	if (!serverId) {
		log.warn("Missing serverId for MCP API key retrieval");
		return {};
	}

	try {
		log.info(`Retrieving all MCP API keys for server ${serverId}`);

		const results = (await sql`
			SELECT mcp_name, api_key 
			FROM mcp_api_keys 
			WHERE server_id = ${serverId}
		`) as McpApiKeyRow[];

		const apiKeys: Record<string, string> = {};

		for (const result of results) {
			if (result.api_key && result.mcp_name) {
				try {
					const decryptedKey = await decryptApiKey(result.api_key);
					apiKeys[result.mcp_name] = decryptedKey;
				} catch (error) {
					log.warn(
						`Failed to decrypt API key for MCP: ${result.mcp_name}`,
						error as Error,
					);
				}
			}
		}

		log.success(
			`Retrieved ${Object.keys(apiKeys).length} MCP API keys for server ${serverId}`,
		);
		return apiKeys;
	} catch (error) {
		log.error(
			`Failed to retrieve MCP API keys for server ${serverId}`,
			error as Error,
		);
		return {};
	}
};

/**
 * Delete an MCP API key from the database
 * @param serverId - Server ID
 * @param mcpName - Name of the MCP server
 * @returns Promise<boolean> - True if deleted successfully
 */
export const deleteMcpApiKey = async (
	serverId: number,
	mcpName: string,
): Promise<boolean> => {
	if (!mcpName || !serverId) {
		log.warn("Missing required parameters for MCP API key deletion");
		return false;
	}

	try {
		log.info(`Deleting MCP API key for server ${serverId}, MCP: ${mcpName}`);

		await sql`
			DELETE FROM mcp_api_keys 
			WHERE server_id = ${serverId} AND mcp_name = ${mcpName}
		`;

		log.success(
			`MCP API key deleted successfully for ${mcpName} on server ${serverId}`,
		);
		return true;
	} catch (error) {
		log.error(`Failed to delete MCP API key for ${mcpName}`, error as Error);
		return false;
	}
};

/**
 * Check if an MCP API key exists for a server
 * @param serverId - Server ID
 * @param mcpName - Name of the MCP server
 * @returns Promise<boolean> - True if key exists
 */
export const hasMcpApiKey = async (
	serverId: number,
	mcpName: string,
): Promise<boolean> => {
	if (!mcpName || !serverId) {
		return false;
	}

	try {
		const [result] = await sql`
			SELECT 1 
			FROM mcp_api_keys 
			WHERE server_id = ${serverId} AND mcp_name = ${mcpName}
		`;

		return !!result;
	} catch (error) {
		log.error(
			`Failed to check MCP API key existence for ${mcpName}`,
			error as Error,
		);
		return false;
	}
};
