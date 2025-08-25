import { log } from "../misc/logger";
import { sql } from "bun";
import type { OptApiKeyRow } from "../../types/db/schema";

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
 * Store an encrypted optional API key in the database
 * @param serverId - Server ID to associate the key with
 * @param serviceName - Name of the service (e.g., 'brave-search', 'duckduckgo-search')
 * @param apiKey - The raw API key to encrypt and store
 * @returns Promise<boolean> - True if stored successfully
 */
export const storeOptApiKey = async (
	serverId: number,
	serviceName: string,
	apiKey: string,
): Promise<boolean> => {
	if (!apiKey || !serviceName || !serverId) {
		log.warn("Missing required parameters for optional API key storage");
		return false;
	}

	try {
		log.info(
			`Storing encrypted optional API key for server ${serverId}, service: ${serviceName}`,
		);

		// Encrypt the API key using the existing encryption function
		const encryptedKey = await encryptApiKey(apiKey);

		// Store in database with ON CONFLICT update for idempotent operation
		await sql`
			INSERT INTO opt_api_keys (server_id, service_name, api_key)
			VALUES (${serverId}, ${serviceName}, ${encryptedKey})
			ON CONFLICT (server_id, service_name)
			DO UPDATE SET 
				api_key = EXCLUDED.api_key,
				updated_at = CURRENT_TIMESTAMP
		`;

		log.success(
			`Optional API key stored successfully for ${serviceName} on server ${serverId}`,
		);
		return true;
	} catch (error) {
		log.error(`Failed to store optional API key for ${serviceName}`, error as Error);
		return false;
	}
};

/**
 * Retrieve and decrypt an optional API key from the database
 * @param serverId - Server ID to look up
 * @param serviceName - Name of the service
 * @returns Promise<string | null> - Decrypted API key or null if not found
 */
export const getOptApiKey = async (
	serverId: number,
	serviceName: string,
): Promise<string | null> => {
	if (!serviceName || !serverId) {
		log.warn("Missing required parameters for optional API key retrieval");
		return null;
	}

	try {
		log.info(`Retrieving optional API key for server ${serverId}, service: ${serviceName}`);

		const [result] = await sql`
			SELECT api_key 
			FROM opt_api_keys 
			WHERE server_id = ${serverId} AND service_name = ${serviceName}
		`;

		if (!result || !result.api_key) {
			log.info(`No optional API key found for ${serviceName} on server ${serverId}`);
			return null;
		}

		// Decrypt the API key using the existing decryption function
		const decryptedKey = await decryptApiKey(result.api_key);

		log.success(`Optional API key retrieved successfully for ${serviceName}`);
		return decryptedKey;
	} catch (error) {
		log.error(`Failed to retrieve optional API key for ${serviceName}`, error as Error);
		return null;
	}
};

/**
 * Get all optional API keys for a server (returns a map of serviceName -> decryptedKey)
 * @param serverId - Server ID to look up
 * @returns Promise<Record<string, string>> - Map of service names to decrypted API keys
 */
export const getAllOptApiKeysForServer = async (
	serverId: number,
): Promise<Record<string, string>> => {
	if (!serverId) {
		log.warn("Missing serverId for optional API key retrieval");
		return {};
	}

	try {
		log.info(`Retrieving all optional API keys for server ${serverId}`);

		const results = (await sql`
			SELECT service_name, api_key 
			FROM opt_api_keys 
			WHERE server_id = ${serverId}
		`) as OptApiKeyRow[];

		const apiKeys: Record<string, string> = {};

		for (const result of results) {
			if (result.api_key && result.service_name) {
				try {
					const decryptedKey = await decryptApiKey(result.api_key);
					apiKeys[result.service_name] = decryptedKey;
				} catch (error) {
					log.warn(
						`Failed to decrypt API key for service: ${result.service_name}`,
						error as Error,
					);
				}
			}
		}

		log.success(
			`Retrieved ${Object.keys(apiKeys).length} optional API keys for server ${serverId}`,
		);
		return apiKeys;
	} catch (error) {
		log.error(
			`Failed to retrieve optional API keys for server ${serverId}`,
			error as Error,
		);
		return {};
	}
};

/**
 * Delete an optional API key from the database
 * @param serverId - Server ID
 * @param serviceName - Name of the service
 * @returns Promise<boolean> - True if deleted successfully
 */
export const deleteOptApiKey = async (
	serverId: number,
	serviceName: string,
): Promise<boolean> => {
	if (!serviceName || !serverId) {
		log.warn("Missing required parameters for optional API key deletion");
		return false;
	}

	try {
		log.info(`Deleting optional API key for server ${serverId}, service: ${serviceName}`);

		await sql`
			DELETE FROM opt_api_keys 
			WHERE server_id = ${serverId} AND service_name = ${serviceName}
		`;

		log.success(
			`Optional API key deleted successfully for ${serviceName} on server ${serverId}`,
		);
		return true;
	} catch (error) {
		log.error(`Failed to delete optional API key for ${serviceName}`, error as Error);
		return false;
	}
};

/**
 * Check if an optional API key exists for a server
 * @param serverId - Server ID
 * @param serviceName - Name of the service
 * @returns Promise<boolean> - True if key exists
 */
export const hasOptApiKey = async (
	serverId: number,
	serviceName: string,
): Promise<boolean> => {
	if (!serviceName || !serverId) {
		return false;
	}

	try {
		const [result] = await sql`
			SELECT 1 
			FROM opt_api_keys 
			WHERE server_id = ${serverId} AND service_name = ${serviceName}
		`;

		return !!result;
	} catch (error) {
		log.error(
			`Failed to check optional API key existence for ${serviceName}`,
			error as Error,
		);
		return false;
	}
};
