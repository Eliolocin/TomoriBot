import { log } from "../misc/logger";
import { sql } from "bun";

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
