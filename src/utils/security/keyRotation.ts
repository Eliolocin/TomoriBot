/**
 * API Key Rotation Utility
 * Provides load balancing (round-robin) and failover capabilities for LLM API keys.
 *
 * Key Features:
 * - Round-robin distribution across multiple API keys
 * - Automatic failover on API errors
 * - Cooldown-based recovery (60s for rate limits, 5min for other errors)
 * - Main key pointer design (uses the server model config api_key as virtual key in pool)
 *
 * Schema split (migration 014): config columns live in api_key_rotation; telemetry lives in
 * api_key_rotation_runtime_state. Selection queries LEFT JOIN both tables so callers receive the
 * full ApiKeyRotationRow shape. Telemetry writes target only the runtime state table.
 */

import { sql } from "@/utils/db/client";
import { log } from "../misc/logger";
import { encryptApiKey, decryptApiKey } from "./crypto";
import {
  type ApiKeyRotationRow,
  type ApiKeyRotationErrorType,
  type TomoriState,
  apiKeyRotationSchema,
} from "@/types/db/schema";

/** Cooldown duration for rate limit errors (429) in milliseconds */
const RATE_LIMIT_COOLDOWN_MS = (() => {
  const parsed = Number.parseInt(process.env.KEY_ROTATION_RATE_LIMIT_COOLDOWN_MS || "60000", 10);
  return Number.isFinite(parsed) ? Math.max(1000, parsed) : 60000;
})();

/** Cooldown duration for other API errors (401, 403, etc.) in milliseconds */
const API_ERROR_COOLDOWN_MS = (() => {
  const parsed = Number.parseInt(process.env.KEY_ROTATION_ERROR_COOLDOWN_MS || "300000", 10);
  return Number.isFinite(parsed) ? Math.max(1000, parsed) : 300000;
})();

/** Maximum number of key attempts per request before giving up */
export const MAX_KEY_ATTEMPTS = 3;

/**
 * Result of selecting an API key for use
 */
export interface SelectedKeyResult {
  /** The decrypted API key ready for use */
  apiKey: string;
  /** The rotation_key_id to use for recording success/error (null for main key without pointer) */
  rotationKeyId: number | null;
  /** Whether this is the main key from the assembled server config */
  isMainKey: boolean;
}

/**
 * Checks if a key is currently in cooldown based on its last error
 * @param lastErrorAt - Timestamp of the last error
 * @param lastErrorType - Type of the last error ('rate_limit' or 'api_error')
 * @returns True if the key is still in cooldown
 */
function isKeyInCooldown(
  lastErrorAt: Date | null | undefined,
  lastErrorType: ApiKeyRotationErrorType | null | undefined,
): boolean {
  if (!lastErrorAt || !lastErrorType) {
    return false;
  }

  const now = Date.now();
  const errorTime = lastErrorAt.getTime();
  const cooldownMs = lastErrorType === "rate_limit" ? RATE_LIMIT_COOLDOWN_MS : API_ERROR_COOLDOWN_MS;

  return now - errorTime < cooldownMs;
}

/**
 * Selects the next available API key using round-robin with cooldown filtering.
 * If rotation is not active (< 2 keys), returns null to signal using main key directly.
 *
 * Selection Algorithm:
 * 1. Query api_key_rotation JOIN api_key_rotation_runtime_state for server_id
 * 2. If 0-1 rows → no rotation, return null (use the assembled server config api_key directly)
 * 3. If 2+ rows → rotation active:
 *    a. Filter: is_enabled = true AND cooldown expired
 *    b. Sort by: usage_count ASC (round-robin)
 *    c. Select first key not in excludeKeyIds
 *    d. Decrypt and return
 *
 * @param excludeKeyIds - Array of rotation_key_ids to exclude (already tried and failed)
 * @returns Selected key result, or null if rotation not active or all keys exhausted
 */
export async function selectApiKey(
  tomoriState: TomoriState,
  excludeKeyIds: number[] = [],
): Promise<SelectedKeyResult | null> {
  const serverId = tomoriState.server_id;
  const provider = tomoriState.llm.llm_provider.toLowerCase();

  try {
    const rotationKeys = await sql`
      SELECT
        akr.rotation_key_id, akr.server_id, akr.provider, akr.api_key, akr.key_version,
        akr.is_main_key_pointer, akr.is_enabled, akr.created_at, akr.updated_at,
        COALESCE(rs.usage_count, 0)  AS usage_count,
        COALESCE(rs.error_count, 0)  AS error_count,
        rs.last_used_at, rs.last_error_at, rs.last_error_type, rs.last_error_message
      FROM api_key_rotation akr
      LEFT JOIN api_key_rotation_runtime_state rs USING (rotation_key_id)
      WHERE akr.server_id = ${serverId}
        AND akr.provider = ${provider}
      ORDER BY COALESCE(rs.usage_count, 0) ASC, akr.rotation_key_id ASC
    `;

    // If less than 2 keys, rotation is not active
    if (!rotationKeys || rotationKeys.length < 2) {
      log.info(`Key rotation not active for server ${serverId} (${rotationKeys?.length || 0} keys)`);
      return null;
    }

    for (const row of rotationKeys) {
      const parsed = apiKeyRotationSchema.safeParse(row);
      if (!parsed.success) {
        const errorDetails = JSON.stringify(parsed.error.flatten(), null, 2);
        log.warn(`Invalid rotation key row for server ${serverId}:\n${errorDetails}`);
        continue;
      }
      const key = parsed.data;

      // Skip disabled keys
      if (!key.is_enabled) {
        continue;
      }

      if (key.rotation_key_id && excludeKeyIds.includes(key.rotation_key_id)) {
        continue;
      }

      if (isKeyInCooldown(key.last_error_at, key.last_error_type)) {
        log.info(`Skipping rotation key ${key.rotation_key_id} (in cooldown: ${key.last_error_type})`);
        continue;
      }

      // Decrypt and return this key
      let decryptedKey: string;

      if (key.is_main_key_pointer) {
        // Main key pointer: decrypt from the assembled server config api_key
        if (!tomoriState.config.api_key) {
          log.warn(`Main key pointer exists but server config api_key is null for server ${serverId}`);
          continue;
        }
        const keyVersion = tomoriState.config.key_version || 1;
        decryptedKey = await decryptApiKey(tomoriState.config.api_key, keyVersion);
      } else {
        // Regular rotation key: decrypt from row's api_key
        if (!key.api_key) {
          log.warn(`Rotation key ${key.rotation_key_id} has null api_key for server ${serverId}`);
          continue;
        }
        decryptedKey = await decryptApiKey(key.api_key, key.key_version);
      }

      if (!decryptedKey) {
        log.warn(`Failed to decrypt rotation key ${key.rotation_key_id} for server ${serverId}`);
        continue;
      }

      log.info(
        `Selected rotation key ${key.rotation_key_id} for server ${serverId} (usage: ${key.usage_count}, main: ${key.is_main_key_pointer})`,
      );

      return {
        apiKey: decryptedKey,
        rotationKeyId: key.rotation_key_id ?? null,
        isMainKey: key.is_main_key_pointer,
      };
    }

    log.warn(`All rotation keys exhausted or in cooldown for server ${serverId}`);
    return null;
  } catch (error) {
    log.error(`Error selecting API key for server ${serverId}:`, error);
    return null;
  }
}

/**
 * Checks if there is at least one available rotation key (excluding provided IDs).
 * This avoids decrypting keys and skips user-facing logging for peek checks.
 *
 * @param excludeKeyIds - Array of rotation_key_ids to exclude (already tried and failed)
 * @returns True if another usable rotation key exists
 */
export async function hasAvailableRotationKey(
  tomoriState: TomoriState,
  excludeKeyIds: number[] = [],
): Promise<boolean> {
  const serverId = tomoriState.server_id;
  const provider = tomoriState.llm.llm_provider.toLowerCase();

  try {
    const rotationKeys = await sql`
      SELECT
        akr.rotation_key_id, akr.server_id, akr.provider, akr.api_key, akr.key_version,
        akr.is_main_key_pointer, akr.is_enabled, akr.created_at, akr.updated_at,
        COALESCE(rs.usage_count, 0)  AS usage_count,
        COALESCE(rs.error_count, 0)  AS error_count,
        rs.last_used_at, rs.last_error_at, rs.last_error_type, rs.last_error_message
      FROM api_key_rotation akr
      LEFT JOIN api_key_rotation_runtime_state rs USING (rotation_key_id)
      WHERE akr.server_id = ${serverId}
        AND akr.provider = ${provider}
      ORDER BY COALESCE(rs.usage_count, 0) ASC, akr.rotation_key_id ASC
    `;

    if (!rotationKeys || rotationKeys.length < 2) {
      return false;
    }

    for (const row of rotationKeys) {
      const parsed = apiKeyRotationSchema.safeParse(row);
      if (!parsed.success) {
        const errorDetails = JSON.stringify(parsed.error.flatten(), null, 2);
        log.warn(`Invalid rotation key row for server ${serverId}:\n${errorDetails}`);
        continue;
      }
      const key = parsed.data;

      if (!key.is_enabled) {
        continue;
      }

      if (key.rotation_key_id && excludeKeyIds.includes(key.rotation_key_id)) {
        continue;
      }

      if (isKeyInCooldown(key.last_error_at, key.last_error_type)) {
        continue;
      }

      if (key.is_main_key_pointer && !tomoriState.config.api_key) {
        continue;
      }

      if (!key.is_main_key_pointer && !key.api_key) {
        continue;
      }

      return true;
    }

    return false;
  } catch (error) {
    log.error(`Error checking available rotation keys for server ${serverId}:`, error);
    return false;
  }
}

/**
 * Records a successful API call for a rotation key.
 * Increments usage_count, resets error_count and cooldown fields in the runtime state table.
 * Uses UPSERT to ensure the runtime row exists even if somehow absent after migration.
 *
 * @param rotationKeyId - The rotation_key_id to update
 */
export async function recordKeySuccess(rotationKeyId: number): Promise<void> {
  try {
    await sql`
      INSERT INTO api_key_rotation_runtime_state
        (rotation_key_id, usage_count, error_count, last_used_at, last_error_at, last_error_type, last_error_message)
      VALUES
        (${rotationKeyId}, 1, 0, CURRENT_TIMESTAMP, NULL, NULL, NULL)
      ON CONFLICT (rotation_key_id) DO UPDATE SET
        usage_count      = api_key_rotation_runtime_state.usage_count + 1,
        error_count      = 0,
        last_used_at     = CURRENT_TIMESTAMP,
        last_error_at    = NULL,
        last_error_type  = NULL,
        last_error_message = NULL
    `;

    log.info(`Recorded success for rotation key ${rotationKeyId}`);
  } catch (error) {
    log.error(`Error recording key success for ${rotationKeyId}:`, error);
  }
}

/**
 * Sets cooldown based on error type and increments error_count in the runtime state table.
 * Uses UPSERT to ensure the runtime row exists even if somehow absent after migration.
 *
 * @param rotationKeyId - The rotation_key_id to update
 * @param errorType - Type of error ('rate_limit' for 429, 'api_error' for others)
 * @param errorMessage - Human-readable error message
 */
export async function recordKeyError(
  rotationKeyId: number,
  errorType: ApiKeyRotationErrorType,
  errorMessage: string,
): Promise<void> {
  try {
    await sql`
      INSERT INTO api_key_rotation_runtime_state
        (rotation_key_id, usage_count, error_count, last_error_at, last_error_type, last_error_message)
      VALUES
        (${rotationKeyId}, 0, 1, CURRENT_TIMESTAMP, ${errorType}, ${errorMessage.substring(0, 500)})
      ON CONFLICT (rotation_key_id) DO UPDATE SET
        error_count        = api_key_rotation_runtime_state.error_count + 1,
        last_error_at      = CURRENT_TIMESTAMP,
        last_error_type    = ${errorType},
        last_error_message = ${errorMessage.substring(0, 500)}
    `;

    const cooldownSecs = errorType === "rate_limit" ? RATE_LIMIT_COOLDOWN_MS / 1000 : API_ERROR_COOLDOWN_MS / 1000;

    log.warn(
      `Recorded ${errorType} error for rotation key ${rotationKeyId} (cooldown: ${cooldownSecs}s): ${errorMessage.substring(0, 100)}`,
    );
  } catch (error) {
    log.error(`Error recording key error for ${rotationKeyId}:`, error);
  }
}

/**
 * Also creates the main key pointer if this is the first rotation key.
 * Each api_key_rotation insert is followed by a runtime state row insert.
 *
 * @param provider - The LLM provider name (must match current provider)
 * @param apiKey - The raw API key to encrypt and store
 * @returns True if the key was added successfully
 */
export async function addRotationKey(serverId: number, provider: string, apiKey: string): Promise<boolean> {
  const normalizedProvider = provider.toLowerCase();

  try {
    const existingPointer = await sql`
      SELECT rotation_key_id FROM api_key_rotation
      WHERE server_id = ${serverId}
        AND provider = ${normalizedProvider}
        AND is_main_key_pointer = true
      LIMIT 1
    `;

    if (!existingPointer || existingPointer.length === 0) {
      log.info(`Creating main key pointer for server ${serverId} to enable rotation`);
      const pointerResult = await sql`
        INSERT INTO api_key_rotation (server_id, provider, api_key, is_main_key_pointer, is_enabled)
        VALUES (${serverId}, ${normalizedProvider}, NULL, true, true)
        RETURNING rotation_key_id
      `;
      const pointerId = pointerResult[0]?.rotation_key_id as number | undefined;
      if (pointerId) {
        await sql`
          INSERT INTO api_key_rotation_runtime_state (rotation_key_id)
          VALUES (${pointerId})
          ON CONFLICT (rotation_key_id) DO NOTHING
        `;
      }
    }

    // Encrypt and store the new rotation key, then seed runtime state
    const { encrypted, version } = await encryptApiKey(apiKey);

    const keyResult = await sql`
      INSERT INTO api_key_rotation (server_id, provider, api_key, key_version, is_main_key_pointer, is_enabled)
      VALUES (${serverId}, ${normalizedProvider}, ${encrypted}, ${version}, false, true)
      RETURNING rotation_key_id
    `;
    const keyId = keyResult[0]?.rotation_key_id as number | undefined;
    if (keyId) {
      await sql`
        INSERT INTO api_key_rotation_runtime_state (rotation_key_id)
        VALUES (${keyId})
        ON CONFLICT (rotation_key_id) DO NOTHING
      `;
    }

    log.success(`Added rotation key for server ${serverId} (provider: ${normalizedProvider})`);
    return true;
  } catch (error) {
    log.error(`Error adding rotation key for server ${serverId}:`, error);
    return false;
  }
}

/**
 * Purges all rotation keys for a server.
 * This includes the main key pointer and all additional rotation keys.
 * Runtime state rows cascade-delete automatically via FK ON DELETE CASCADE.
 *
 */
export async function purgeRotationKeys(serverId: number): Promise<number> {
  try {
    const result = await sql`
      DELETE FROM api_key_rotation
      WHERE server_id = ${serverId}
    `;

    const deletedCount = result.count || 0;
    log.success(`Purged ${deletedCount} rotation key(s) for server ${serverId}`);
    return deletedCount;
  } catch (error) {
    log.error(`Error purging rotation keys for server ${serverId}:`, error);
    return 0;
  }
}

/**
 * Purges all rotation keys for a specific server+provider pair.
 * Used when removing a saved provider config to ensure a clean break.
 * Runtime state rows cascade-delete automatically via FK ON DELETE CASCADE.
 *
 * @param provider - The provider name (lowercase) to purge keys for
 */
export async function purgeRotationKeysForProvider(serverId: number, provider: string): Promise<number> {
  try {
    const result = await sql`
      DELETE FROM api_key_rotation
      WHERE server_id = ${serverId}
        AND provider = ${provider.toLowerCase()}
    `;

    const deletedCount = result.count || 0;
    if (deletedCount > 0) {
      log.success(`Purged ${deletedCount} rotation key(s) for server ${serverId}, provider ${provider}`);
    }
    return deletedCount;
  } catch (error) {
    log.error(`Error purging rotation keys for server ${serverId}, provider ${provider}:`, error);
    return 0;
  }
}

/**
 * Gets the count of rotation keys for a server (excluding main key pointer).
 *
 * @returns The count of additional rotation keys (not including main key pointer)
 */
export async function getRotationKeyCount(serverId: number): Promise<number> {
  try {
    const result = await sql`
      SELECT COUNT(*) as count FROM api_key_rotation
      WHERE server_id = ${serverId} AND is_main_key_pointer = false
    `;

    return Number(result[0]?.count || 0);
  } catch (error) {
    log.error(`Error counting rotation keys for server ${serverId}:`, error);
    return 0;
  }
}

/** Returns the additional-key count for one provider pool. */
export async function getRotationKeyCountForProvider(serverId: number, provider: string): Promise<number> {
  try {
    const result = await sql`
      SELECT COUNT(*) as count FROM api_key_rotation
      WHERE server_id = ${serverId}
        AND provider = ${provider.toLowerCase()}
        AND is_main_key_pointer = false
    `;
    return Number(result[0]?.count || 0);
  } catch (error) {
    log.error(`Error counting rotation keys for server ${serverId}, provider ${provider}:`, error);
    return 0;
  }
}

/**
 * Gets all rotation keys for a server (for loading into TomoriState).
 * JOINs runtime state so the returned rows include usage/error telemetry.
 *
 * @returns Array of validated ApiKeyRotationRow objects
 */
export async function loadRotationKeys(serverId: number): Promise<ApiKeyRotationRow[]> {
  try {
    const rows = await sql<unknown[]>`
      SELECT
        akr.rotation_key_id, akr.server_id, akr.provider, akr.api_key, akr.key_version,
        akr.is_main_key_pointer, akr.is_enabled, akr.created_at, akr.updated_at,
        COALESCE(rs.usage_count, 0)  AS usage_count,
        COALESCE(rs.error_count, 0)  AS error_count,
        rs.last_used_at, rs.last_error_at, rs.last_error_type, rs.last_error_message
      FROM api_key_rotation akr
      LEFT JOIN api_key_rotation_runtime_state rs USING (rotation_key_id)
      WHERE akr.server_id = ${serverId}
      ORDER BY COALESCE(rs.usage_count, 0) ASC, akr.rotation_key_id ASC
    `;

    if (!rows || rows.length === 0) {
      return [];
    }

    const validatedKeys: ApiKeyRotationRow[] = [];
    for (const row of rows) {
      const parsed = apiKeyRotationSchema.safeParse(row);
      if (parsed.success) {
        validatedKeys.push(parsed.data);
      } else {
        const errorDetails = JSON.stringify(parsed.error.flatten(), null, 2);
        log.warn(`Invalid rotation key row for server ${serverId}:\n${errorDetails}`);
      }
    }

    return validatedKeys;
  } catch (error) {
    log.error(`Error loading rotation keys for server ${serverId}:`, error);
    return [];
  }
}

/** Loads the joined rotation pool for one provider. */
export async function loadRotationKeysForProvider(serverId: number, provider: string): Promise<ApiKeyRotationRow[]> {
  const normalizedProvider = provider.toLowerCase();
  try {
    const rows = await sql<unknown[]>`
      SELECT
        akr.rotation_key_id, akr.server_id, akr.provider, akr.api_key, akr.key_version,
        akr.is_main_key_pointer, akr.is_enabled, akr.created_at, akr.updated_at,
        COALESCE(rs.usage_count, 0) AS usage_count,
        COALESCE(rs.error_count, 0) AS error_count,
        rs.last_used_at, rs.last_error_at, rs.last_error_type, rs.last_error_message
      FROM api_key_rotation akr
      LEFT JOIN api_key_rotation_runtime_state rs USING (rotation_key_id)
      WHERE akr.server_id = ${serverId}
        AND akr.provider = ${normalizedProvider}
      ORDER BY COALESCE(rs.usage_count, 0) ASC, akr.rotation_key_id ASC
    `;
    return rows.flatMap((row) => {
      const parsed = apiKeyRotationSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
  } catch (error) {
    log.error(`Error loading rotation keys for server ${serverId}, provider ${provider}:`, error);
    return [];
  }
}

/**
 * Checks if API key rotation is active for a server.
 * Rotation is active when there are 2+ keys in the pool (main pointer + at least 1 rotation key).
 *
 * @returns True if rotation is active
 */
export async function isRotationActive(serverId: number): Promise<boolean> {
  try {
    const result = await sql`
      SELECT COUNT(*) as count FROM api_key_rotation
      WHERE server_id = ${serverId}
    `;

    return Number(result[0]?.count || 0) >= 2;
  } catch (error) {
    log.error(`Error checking rotation status for server ${serverId}:`, error);
    return false;
  }
}

/** Reports whether one provider has a pointer and at least one additional key. */
export async function isRotationActiveForProvider(serverId: number, provider: string): Promise<boolean> {
  try {
    const result = await sql`
      SELECT COUNT(*) as count FROM api_key_rotation
      WHERE server_id = ${serverId} AND provider = ${provider.toLowerCase()}
    `;
    return Number(result[0]?.count || 0) >= 2;
  } catch (error) {
    log.error(`Error checking rotation status for server ${serverId}, provider ${provider}:`, error);
    return false;
  }
}
