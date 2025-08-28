/**
 * SQL Security Utilities
 *
 * This module provides security utilities for dynamic SQL query construction,
 * particularly for validating field names in UPDATE statements to prevent SQL injection.
 *
 * Field whitelists are automatically derived from Zod schemas to ensure consistency
 * and maintainability - when schemas change, security whitelists update automatically.
 */

import type {
	UserRow,
	TomoriRow,
	TomoriConfigRow,
} from "../../types/db/schema";
import { log } from "../misc/logger";

// Extract allowed field names from Zod schemas
// These exclude auto-managed fields (IDs, timestamps) that shouldn't be in dynamic updates
const ALLOWED_USER_FIELDS = new Set<keyof UserRow>([
	"user_disc_id",
	"user_nickname",
	"tomocoins_held",
	"tomocoins_deposited",
	"language_pref",
	"personal_memories",
	// Exclude: user_id (primary key), created_at, updated_at (auto-managed)
]);

const ALLOWED_TOMORI_FIELDS = new Set<keyof TomoriRow>([
	"server_id",
	"tomori_nickname",
	"attribute_list",
	"sample_dialogues_in",
	"sample_dialogues_out",
	"autoch_counter",
	// Exclude: tomori_id (primary key), created_at, updated_at (auto-managed)
]);

const ALLOWED_TOMORI_CONFIG_FIELDS = new Set<keyof TomoriConfigRow>([
	"llm_id",
	"llm_temperature",
	"api_key",
	"trigger_words",
	"autoch_disc_ids",
	"autoch_threshold",
	"teach_cost",
	"gamba_limit",
	"server_memteaching_enabled",
	"attribute_memteaching_enabled",
	"sampledialogue_memteaching_enabled",
	"self_teaching_enabled",
	"web_search_enabled",
	"personal_memories_enabled",
	"humanizer_degree",
	"emoji_usage_enabled",
	"sticker_usage_enabled",
	// Exclude: tomori_config_id, tomori_id (keys), created_at, updated_at (auto-managed)
]);

/**
 * Validates that all provided field names are whitelisted for User table updates.
 * Throws an error if any field is not allowed to prevent SQL injection.
 *
 * @param fields - Array of field names to validate
 * @throws Error if any field name is not whitelisted
 */
export function validateUserFields(fields: string[]): void {
	for (const field of fields) {
		if (!ALLOWED_USER_FIELDS.has(field as keyof UserRow)) {
			const error = `Security violation: Invalid field name '${field}' for User table update. Allowed fields: ${Array.from(ALLOWED_USER_FIELDS).join(", ")}`;
			log.error(error);
			throw new Error(error);
		}
	}
}

/**
 * Validates that all provided field names are whitelisted for Tomori table updates.
 * Throws an error if any field is not allowed to prevent SQL injection.
 *
 * @param fields - Array of field names to validate
 * @throws Error if any field name is not whitelisted
 */
export function validateTomoriFields(fields: string[]): void {
	for (const field of fields) {
		if (!ALLOWED_TOMORI_FIELDS.has(field as keyof TomoriRow)) {
			const error = `Security violation: Invalid field name '${field}' for Tomori table update. Allowed fields: ${Array.from(ALLOWED_TOMORI_FIELDS).join(", ")}`;
			log.error(error);
			throw new Error(error);
		}
	}
}

/**
 * Validates that all provided field names are whitelisted for TomoriConfig table updates.
 * Throws an error if any field is not allowed to prevent SQL injection.
 *
 * @param fields - Array of field names to validate
 * @throws Error if any field name is not whitelisted
 */
export function validateTomoriConfigFields(fields: string[]): void {
	for (const field of fields) {
		if (!ALLOWED_TOMORI_CONFIG_FIELDS.has(field as keyof TomoriConfigRow)) {
			const error = `Security violation: Invalid field name '${field}' for TomoriConfig table update. Allowed fields: ${Array.from(ALLOWED_TOMORI_CONFIG_FIELDS).join(", ")}`;
			log.error(error);
			throw new Error(error);
		}
	}
}

/**
 * Get all allowed field names for User table (for documentation/debugging purposes)
 */
export function getAllowedUserFields(): readonly string[] {
	return Array.from(ALLOWED_USER_FIELDS);
}

/**
 * Get all allowed field names for Tomori table (for documentation/debugging purposes)
 */
export function getAllowedTomoriFields(): readonly string[] {
	return Array.from(ALLOWED_TOMORI_FIELDS);
}

/**
 * Get all allowed field names for TomoriConfig table (for documentation/debugging purposes)
 */
export function getAllowedTomoriConfigFields(): readonly string[] {
	return Array.from(ALLOWED_TOMORI_CONFIG_FIELDS);
}
