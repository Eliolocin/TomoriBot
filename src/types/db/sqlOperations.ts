/**
 * TypeScript types for SQL operation utilities
 *
 * This module provides proper type definitions for database operations,
 * particularly for dynamic SQL query construction with Bun's sql.unsafe.
 */

/**
 * Union type representing all possible SQL parameter values that can be safely
 * passed to database queries. This includes primitive types, complex types,
 * and PostgreSQL-specific types.
 */
export type SqlValue =
	| string
	| number
	| boolean
	| Date
	| string[]
	| number[]
	| boolean[]
	| Buffer
	| null
	| undefined;

/**
 * Array type for SQL query parameters used with sql.unsafe spread operations.
 * This ensures compatibility with Bun's sql.unsafe spread argument signature.
 * Uses any[] to match the expected function signature while maintaining SqlValue documentation.
 *
 * @example
 * const values: SqlParameterArray = [userId, userName, isActive];
 * const query = sql.unsafe`UPDATE users SET name = $2, active = $3 WHERE id = $1`(...values);
 */

// biome-ignore lint/suspicious/noExplicitAny: Required for dynamic SQL parameter arrays
export type SqlParameterArray = any[];

/**
 * Generic type for SQL UPDATE operation field-value pairs.
 * Used for dynamic UPDATE query construction with validated schema data.
 *
 * @template T - The schema type being updated (e.g., UserRow, TomoriRow)
 */
export type SqlUpdateValues<T> = Array<T[keyof T]>;

/**
 * Type for dynamic SQL SET clause construction.
 * Represents the parts of a SET clause before parameter substitution.
 *
 * @example
 * const setParts: SqlSetClause = ["name = $1", "email = $2", "updated_at = $3"];
 */
export type SqlSetClause = string[];

/**
 * Security-validated field name arrays for dynamic SQL operations.
 * These types represent field names that have been validated against whitelists
 * to prevent SQL injection in dynamic UPDATE operations.
 * 
 * Field validation is performed by functions in src/utils/db/sqlSecurity.ts
 * which maintain whitelists derived from Zod schemas.
 */

/**
 * Array of whitelisted field names for User table operations.
 * All field names must pass validation via validateUserFields() before use.
 */
export type ValidatedUserFields = string[];

/**
 * Array of whitelisted field names for Tomori table operations.
 * All field names must pass validation via validateTomoriFields() before use.
 */
export type ValidatedTomoriFields = string[];

/**
 * Array of whitelisted field names for TomoriConfig table operations.
 * All field names must pass validation via validateTomoriConfigFields() before use.
 */
export type ValidatedTomoriConfigFields = string[];

/**
 * Security context for SQL operations that use dynamic field names.
 * Provides metadata for security logging and error tracking.
 */
export type SqlSecurityContext = {
	/** The table being operated on */
	tableName: "users" | "tomoris" | "tomori_configs";
	/** Field names that passed whitelist validation */
	validatedFields: string[];
	/** The operation being performed */
	operation: "UPDATE" | "SELECT" | "INSERT" | "DELETE";
	/** Whether sql.unsafe was used in the operation */
	usedUnsafeQuery: boolean;
};
