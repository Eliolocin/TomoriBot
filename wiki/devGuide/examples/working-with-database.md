# Working with Database

This tutorial covers **PostgreSQL database operations** in TomoriBot, including CRUD operations, encrypted storage, migrations, and Zod validation. We'll use real examples from the server setup process and memory management systems.

## Overview

TomoriBot uses PostgreSQL with:
- **Direct SQL queries** using Bun's `sql` template
- **Type safety** with Zod schemas for validation
- **Encrypted storage** using pgcrypto for sensitive data
- **JSONB columns** for flexible configuration storage
- **Transactions** for data consistency

## Step 1: Understanding the Database Architecture

### Connection Setup

**File**: `src/utils/db/connection.ts`

```typescript
/**
 * Database connection utilities
 * Uses Bun's built-in SQL capabilities with PostgreSQL
 */

import { sql } from "bun";
import { log } from "../misc/logger";

// Database connection is automatically handled by Bun using DATABASE_URL
// No manual connection pooling needed - Bun handles it

/**
 * Test database connectivity
 * @returns Promise<boolean> - True if connection successful
 */
export async function testDatabaseConnection(): Promise<boolean> {
  try {
    const result = await sql`SELECT 1 as test`;
    log.info("Database connection test successful");
    return result.length > 0;
  } catch (error) {
    log.error("Database connection test failed:", error as Error);
    return false;
  }
}

/**
 * Get database version and stats
 * @returns Promise<Record<string, unknown>> - Database information
 */
export async function getDatabaseInfo(): Promise<Record<string, unknown>> {
  try {
    const versionResult = await sql`SELECT version() as version`;
    const statsResult = await sql`
      SELECT 
        schemaname,
        tablename,
        n_tup_ins as inserts,
        n_tup_upd as updates,
        n_tup_del as deletes
      FROM pg_stat_user_tables 
      ORDER BY schemaname, tablename
    `;
    
    return {
      version: versionResult[0]?.version,
      tableStats: statsResult,
      connectionTime: new Date().toISOString(),
    };
  } catch (error) {
    log.error("Failed to get database info:", error as Error);
    return { error: "Failed to retrieve database information" };
  }
}
```

### Schema Definition with Types

**File**: `src/types/db/schema.ts`

```typescript
/**
 * Database schema types with Zod validation
 * Provides both TypeScript types and runtime validation
 */

import { z } from "zod";

// Server Configuration Schema
export const serverConfigSchema = z.object({
  llm_provider: z.string(),
  llm_codename: z.string(),
  llm_temperature: z.number().min(0.1).max(2.0),
  sticker_usage_enabled: z.boolean(),
  google_search_enabled: z.boolean(),
  self_teaching_enabled: z.boolean(),
  emoji_usage_enabled: z.boolean(),
  humanizer_degree: z.number().min(0).max(3),
  auto_counter_chance: z.number().min(0).max(100),
  embed_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  // Add other configuration fields as needed
});

export type ServerConfig = z.infer<typeof serverConfigSchema>;

// Complete Server Row Schema
export const serverRowSchema = z.object({
  server_id: z.number(),
  discord_server_id: z.string(),
  config: serverConfigSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type ServerRow = z.infer<typeof serverRowSchema>;

// Memory Schema
export const personalMemorySchema = z.object({
  memory_id: z.number(),
  user_id: z.number(), 
  server_id: z.number(),
  memory_content: z.string().min(1).max(1000),
  memory_type: z.string().default("general"),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type PersonalMemory = z.infer<typeof personalMemorySchema>;

// Setup Configuration (for initialization)
export const setupConfigSchema = z.object({
  serverId: z.string(),
  encryptedApiKey: z.string(),
  presetId: z.number(),
  humanizer: z.number().min(0).max(3),
  tomoriName: z.string().min(1).max(100),
  locale: z.string(),
});

export type SetupConfig = z.infer<typeof setupConfigSchema>;

// Preset Schema
export const tomoriPresetSchema = z.object({
  tomori_preset_id: z.number(),
  tomori_preset_name: z.string(),
  tomori_preset_desc: z.string(),
  preset_language: z.string(),
  personality_data: z.record(z.unknown()).optional(),
});

export type TomoriPresetRow = z.infer<typeof tomoriPresetSchema>;
```

## Step 2: Basic CRUD Operations

### Create Operations

**File**: `src/utils/db/dbWrite.ts` (key functions)

```typescript
/**
 * Database write operations with validation
 */

import { sql } from "bun";
import type { PersonalMemory, SetupConfig } from "../../types/db/schema";
import { personalMemorySchema } from "../../types/db/schema";
import { log } from "../misc/logger";

/**
 * Add a personal memory for a user
 * Demonstrates: INSERT with validation, user/server lookups
 */
export async function addPersonalMemoryByTomori(
  userDiscordId: string,
  guildId: string,
  memoryContent: string
): Promise<void> {
  try {
    // Validate input
    if (!memoryContent.trim()) {
      throw new Error("Memory content cannot be empty");
    }

    if (memoryContent.length > 1000) {
      throw new Error("Memory content too long (max 1000 characters)");
    }

    // Insert with JOIN to get user_id and server_id
    const result = await sql`
      INSERT INTO personal_memories (user_id, server_id, memory_content, memory_type)
      SELECT u.user_id, s.server_id, ${memoryContent}, 'learned_by_tomori'
      FROM users u, servers s
      WHERE u.discord_user_id = ${userDiscordId} 
        AND s.discord_server_id = ${guildId}
      RETURNING *
    `;

    if (result.length === 0) {
      throw new Error("Failed to create memory - user or server not found");
    }

    // Validate the returned data
    const memory = personalMemorySchema.parse(result[0]);
    log.info(`Personal memory created: ID ${memory.memory_id} for user ${userDiscordId}`);

  } catch (error) {
    log.error(`Failed to add personal memory for user ${userDiscordId}:`, error as Error);
    throw error;
  }
}

/**
 * Create server memory 
 * Demonstrates: Simple INSERT with server lookup
 */
export async function addServerMemoryByTomori(
  guildId: string,
  memoryContent: string
): Promise<void> {
  try {
    // Input validation
    if (!memoryContent.trim() || memoryContent.length > 1000) {
      throw new Error("Invalid memory content");
    }

    const result = await sql`
      INSERT INTO server_memories (server_id, memory_content, memory_type)
      SELECT s.server_id, ${memoryContent}, 'learned_by_tomori'
      FROM servers s
      WHERE s.discord_server_id = ${guildId}
      RETURNING memory_id
    `;

    if (result.length === 0) {
      throw new Error("Server not found");
    }

    log.info(`Server memory created: ID ${result[0].memory_id} for guild ${guildId}`);

  } catch (error) {
    log.error(`Failed to add server memory for guild ${guildId}:`, error as Error);
    throw error;
  }
}

/**
 * Complete server setup with transaction
 * Demonstrates: Multi-table operations, transactions, encrypted data
 */
export async function setupServer(
  guild: any, // Discord.js Guild object
  config: SetupConfig
): Promise<void> {
  try {
    log.info(`Starting server setup for guild ${config.serverId}`);

    // Use transaction for data consistency
    await sql.begin(async (trx) => {
      // 1. Create or update server record
      const serverResult = await trx`
        INSERT INTO servers (discord_server_id, config)
        VALUES (${config.serverId}, ${JSON.stringify({
          llm_provider: "google",
          llm_codename: "gemini-2.0-flash-preview-05-20",
          llm_temperature: 0.7,
          sticker_usage_enabled: true,
          google_search_enabled: true,
          self_teaching_enabled: true,
          emoji_usage_enabled: true,
          humanizer_degree: config.humanizer,
          auto_counter_chance: 10,
          embed_color: "#9370DB",
        })})
        ON CONFLICT (discord_server_id) DO UPDATE SET
          config = EXCLUDED.config,
          updated_at = CURRENT_TIMESTAMP
        RETURNING server_id
      `;

      const serverId = serverResult[0].server_id;

      // 2. Store encrypted API key
      await trx`
        INSERT INTO encrypted_api_keys (server_id, provider_name, encrypted_key)
        VALUES (${serverId}, 'google', ${config.encryptedApiKey})
        ON CONFLICT (server_id, provider_name) DO UPDATE SET
          encrypted_key = EXCLUDED.encrypted_key,
          updated_at = CURRENT_TIMESTAMP
      `;

      // 3. Get personality preset data
      const presetResult = await trx`
        SELECT personality_data
        FROM tomori_presets
        WHERE tomori_preset_id = ${config.presetId}
      `;

      if (presetResult.length === 0) {
        throw new Error(`Preset ${config.presetId} not found`);
      }

      // 4. Create Tomori instance
      await trx`
        INSERT INTO tomori_instances (server_id, personality_data, llm_config)
        VALUES (
          ${serverId},
          ${JSON.stringify(presetResult[0].personality_data)},
          ${JSON.stringify({
            llm_provider: "google",
            llm_codename: "gemini-2.0-flash-preview-05-20",
            llm_temperature: 0.7,
          })}
        )
        ON CONFLICT (server_id) DO UPDATE SET
          personality_data = EXCLUDED.personality_data,
          llm_config = EXCLUDED.llm_config,
          updated_at = CURRENT_TIMESTAMP
      `;

      log.info(`Server setup completed for guild ${config.serverId}`);
    });

  } catch (error) {
    log.error(`Server setup failed for guild ${config.serverId}:`, error as Error);
    throw error;
  }
}
```

### Read Operations

**File**: `src/utils/db/dbRead.ts` (key functions)

```typescript
/**
 * Database read operations with type validation
 */

import { sql } from "bun";
import type { TomoriState, PersonalMemory } from "../../types/db/schema";
import { personalMemorySchema } from "../../types/db/schema";
import { log } from "../misc/logger";

/**
 * Load complete Tomori state for a guild
 * Demonstrates: Complex JOIN query, JSONB handling, type validation
 */
export async function loadTomoriState(guildId: string): Promise<TomoriState | null> {
  try {
    const result = await sql`
      SELECT 
        s.server_id,
        s.discord_server_id,
        s.config as server_config,
        t.personality_data,
        t.llm_config,
        s.created_at,
        s.updated_at
      FROM servers s
      JOIN tomori_instances t ON s.server_id = t.server_id
      WHERE s.discord_server_id = ${guildId}
      LIMIT 1
    `;

    if (result.length === 0) {
      log.warn(`No Tomori state found for guild ${guildId}`);
      return null;
    }

    const row = result[0];

    // Build TomoriState object with proper typing
    const tomoriState: TomoriState = {
      server_id: row.server_id,
      discord_server_id: row.discord_server_id,
      config: row.server_config, // JSONB automatically parsed
      llm: row.llm_config, // JSONB automatically parsed  
      personality: row.personality_data, // JSONB automatically parsed
      tomori_nickname: row.server_config.tomori_nickname || "Tomori",
    };

    log.debug(`Loaded Tomori state for guild ${guildId}`);
    return tomoriState;

  } catch (error) {
    log.error(`Failed to load Tomori state for guild ${guildId}:`, error as Error);
    return null;
  }
}

/**
 * Get personal memories for a user
 * Demonstrates: Pagination, filtering, validation
 */
export async function getPersonalMemoriesPaginated(
  userDiscordId: string,
  guildId: string,
  limit: number = 10,
  offset: number = 0
): Promise<PersonalMemory[]> {
  try {
    // Input validation
    if (limit < 1 || limit > 100) {
      throw new Error("Limit must be between 1 and 100");
    }
    
    if (offset < 0) {
      throw new Error("Offset must be non-negative");
    }

    const result = await sql`
      SELECT 
        pm.memory_id,
        pm.user_id,
        pm.server_id,
        pm.memory_content,
        pm.memory_type,
        pm.created_at,
        pm.updated_at
      FROM personal_memories pm
      JOIN users u ON pm.user_id = u.user_id
      JOIN servers s ON pm.server_id = s.server_id
      WHERE u.discord_user_id = ${userDiscordId}
        AND s.discord_server_id = ${guildId}
      ORDER BY pm.created_at DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `;

    // Validate each memory record
    const memories: PersonalMemory[] = result.map(row => 
      personalMemorySchema.parse(row)
    );

    log.debug(`Retrieved ${memories.length} personal memories for user ${userDiscordId}`);
    return memories;

  } catch (error) {
    log.error(`Failed to get personal memories for user ${userDiscordId}:`, error as Error);
    throw error;
  }
}

/**
 * Search memories by content
 * Demonstrates: Full-text search, ILIKE patterns
 */
export async function searchMemoriesByContent(
  guildId: string,
  searchTerm: string,
  memoryType: 'personal' | 'server' = 'server',
  limit: number = 20
): Promise<Array<Record<string, unknown>>> {
  try {
    if (!searchTerm.trim()) {
      throw new Error("Search term cannot be empty");
    }

    // Sanitize search term for ILIKE
    const sanitizedTerm = `%${searchTerm.trim()}%`;

    if (memoryType === 'personal') {
      const result = await sql`
        SELECT 
          pm.memory_id,
          pm.memory_content,
          pm.memory_type,
          pm.created_at,
          u.discord_user_id
        FROM personal_memories pm
        JOIN users u ON pm.user_id = u.user_id
        JOIN servers s ON pm.server_id = s.server_id
        WHERE s.discord_server_id = ${guildId}
          AND pm.memory_content ILIKE ${sanitizedTerm}
        ORDER BY pm.created_at DESC
        LIMIT ${limit}
      `;
      return result;
    } else {
      const result = await sql`
        SELECT 
          sm.memory_id,
          sm.memory_content,
          sm.memory_type,
          sm.created_at
        FROM server_memories sm
        JOIN servers s ON sm.server_id = s.server_id
        WHERE s.discord_server_id = ${guildId}
          AND sm.memory_content ILIKE ${sanitizedTerm}
        ORDER BY sm.created_at DESC
        LIMIT ${limit}
      `;
      return result;
    }

  } catch (error) {
    log.error(`Failed to search memories in guild ${guildId}:`, error as Error);
    throw error;
  }
}
```

## Step 3: Encrypted Data Handling

**File**: `src/utils/security/crypto.ts`

```typescript
/**
 * Cryptographic operations for sensitive data
 * Uses PostgreSQL's pgcrypto extension
 */

import { sql } from "bun";
import { log } from "../misc/logger";

/**
 * Encrypt and store API key
 * Demonstrates: pgcrypto encryption, UPSERT pattern
 */
export async function encryptAndStoreApiKey(
  serverId: number,
  providerName: string,
  apiKey: string
): Promise<void> {
  try {
    const cryptoSecret = process.env.CRYPTO_SECRET;
    if (!cryptoSecret) {
      throw new Error("CRYPTO_SECRET environment variable not set");
    }

    // Encrypt API key using pgcrypto
    await sql`
      INSERT INTO encrypted_api_keys (server_id, provider_name, encrypted_key)
      VALUES (${serverId}, ${providerName}, pgp_sym_encrypt(${apiKey}, ${cryptoSecret}))
      ON CONFLICT (server_id, provider_name) 
      DO UPDATE SET 
        encrypted_key = pgp_sym_encrypt(${apiKey}, ${cryptoSecret}),
        updated_at = CURRENT_TIMESTAMP
    `;

    log.info(`API key encrypted and stored for server ${serverId}, provider ${providerName}`);

  } catch (error) {
    log.error(`Failed to encrypt API key for server ${serverId}:`, error as Error);
    throw error;
  }
}

/**
 * Decrypt and retrieve API key
 * Demonstrates: pgcrypto decryption, null handling
 */
export async function decryptApiKey(
  serverId: number,
  providerName: string
): Promise<string | null> {
  try {
    const cryptoSecret = process.env.CRYPTO_SECRET;
    if (!cryptoSecret) {
      throw new Error("CRYPTO_SECRET environment variable not set");
    }

    const result = await sql`
      SELECT pgp_sym_decrypt(encrypted_key, ${cryptoSecret}) as decrypted_key
      FROM encrypted_api_keys
      WHERE server_id = ${serverId} 
        AND provider_name = ${providerName}
    `;

    if (result.length === 0) {
      log.warn(`No API key found for server ${serverId}, provider ${providerName}`);
      return null;
    }

    const decryptedKey = result[0].decrypted_key;
    if (!decryptedKey) {
      log.error(`Failed to decrypt API key for server ${serverId}`);
      return null;
    }

    log.debug(`API key successfully decrypted for server ${serverId}`);
    return decryptedKey;

  } catch (error) {
    log.error(`Failed to decrypt API key for server ${serverId}:`, error as Error);
    return null;
  }
}

/**
 * Utility function to encrypt data without storing
 * Used for one-off encryption operations
 */
export async function encryptApiKey(apiKey: string): Promise<string> {
  try {
    const cryptoSecret = process.env.CRYPTO_SECRET;
    if (!cryptoSecret) {
      throw new Error("CRYPTO_SECRET environment variable not set");
    }

    const result = await sql`
      SELECT pgp_sym_encrypt(${apiKey}, ${cryptoSecret}) as encrypted_key
    `;

    return result[0].encrypted_key;

  } catch (error) {
    log.error("Failed to encrypt API key:", error as Error);
    throw error;
  }
}
```

## Step 4: Update and Delete Operations

**File**: `src/utils/db/dbWrite.ts` (additional functions)

```typescript
/**
 * Update server configuration
 * Demonstrates: JSONB updates, path-based modifications
 */
export async function updateServerConfig(
  guildId: string,
  configPath: string,
  newValue: unknown
): Promise<void> {
  try {
    // Update specific JSONB field using path notation
    const result = await sql`
      UPDATE servers
      SET 
        config = jsonb_set(config, ${`{${configPath}}`}, to_jsonb(${newValue})),
        updated_at = CURRENT_TIMESTAMP
      WHERE discord_server_id = ${guildId}
      RETURNING server_id
    `;

    if (result.length === 0) {
      throw new Error(`Server not found: ${guildId}`);
    }

    log.info(`Updated server config ${configPath} for guild ${guildId}`);

  } catch (error) {
    log.error(`Failed to update server config for guild ${guildId}:`, error as Error);
    throw error;
  }
}

/**
 * Delete personal memory by ID
 * Demonstrates: DELETE with ownership verification
 */
export async function deletePersonalMemory(
  memoryId: number,
  userDiscordId: string,
  guildId: string
): Promise<boolean> {
  try {
    const result = await sql`
      DELETE FROM personal_memories
      WHERE memory_id = ${memoryId}
        AND user_id IN (
          SELECT u.user_id 
          FROM users u
          WHERE u.discord_user_id = ${userDiscordId}
        )
        AND server_id IN (
          SELECT s.server_id
          FROM servers s
          WHERE s.discord_server_id = ${guildId}
        )
      RETURNING memory_id
    `;

    const success = result.length > 0;
    
    if (success) {
      log.info(`Deleted personal memory ${memoryId} for user ${userDiscordId}`);
    } else {
      log.warn(`Failed to delete memory ${memoryId} - not found or no permission`);
    }

    return success;

  } catch (error) {
    log.error(`Failed to delete personal memory ${memoryId}:`, error as Error);
    throw error;
  }
}

/**
 * Bulk delete old memories
 * Demonstrates: Date-based deletion, batch operations
 */
export async function cleanupOldMemories(
  daysOld: number = 365,
  memoryType: string = 'temporary'
): Promise<number> {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await sql`
      DELETE FROM personal_memories
      WHERE memory_type = ${memoryType}
        AND created_at < ${cutoffDate.toISOString()}
      RETURNING memory_id
    `;

    const deletedCount = result.length;
    log.info(`Cleaned up ${deletedCount} old memories of type ${memoryType}`);

    return deletedCount;

  } catch (error) {
    log.error(`Failed to cleanup old memories:`, error as Error);
    throw error;
  }
}
```

## Step 5: Advanced Patterns

### Complex Queries with CTEs

```typescript
/**
 * Get memory statistics using Common Table Expressions
 * Demonstrates: CTEs, aggregation, complex analytics
 */
export async function getMemoryStatistics(guildId: string): Promise<Record<string, unknown>> {
  try {
    const result = await sql`
      WITH memory_stats AS (
        SELECT 
          'personal' as memory_category,
          pm.memory_type,
          COUNT(*) as count,
          AVG(LENGTH(pm.memory_content)) as avg_length,
          MAX(pm.created_at) as latest_created
        FROM personal_memories pm
        JOIN servers s ON pm.server_id = s.server_id
        WHERE s.discord_server_id = ${guildId}
        GROUP BY pm.memory_type
        
        UNION ALL
        
        SELECT 
          'server' as memory_category,
          sm.memory_type,
          COUNT(*) as count,
          AVG(LENGTH(sm.memory_content)) as avg_length,
          MAX(sm.created_at) as latest_created
        FROM server_memories sm
        JOIN servers s ON sm.server_id = s.server_id
        WHERE s.discord_server_id = ${guildId}
        GROUP BY sm.memory_type
      ),
      totals AS (
        SELECT 
          memory_category,
          SUM(count) as total_count,
          AVG(avg_length) as overall_avg_length
        FROM memory_stats
        GROUP BY memory_category
      )
      SELECT 
        ms.*,
        t.total_count,
        t.overall_avg_length
      FROM memory_stats ms
      JOIN totals t ON ms.memory_category = t.memory_category
      ORDER BY ms.memory_category, ms.memory_type
    `;

    return {
      guildId,
      statistics: result,
      generatedAt: new Date().toISOString(),
    };

  } catch (error) {
    log.error(`Failed to get memory statistics for guild ${guildId}:`, error as Error);
    throw error;
  }
}
```

### Transaction Examples

```typescript
/**
 * Transfer memories between users (example of complex transaction)
 * Demonstrates: Multi-step transactions, rollback on error
 */
export async function transferUserMemories(
  fromUserDiscordId: string,
  toUserDiscordId: string,
  guildId: string,
  memoryIds?: number[]
): Promise<number> {
  try {
    let transferredCount = 0;

    await sql.begin(async (trx) => {
      // 1. Verify both users exist
      const users = await trx`
        SELECT u.user_id, u.discord_user_id
        FROM users u
        WHERE u.discord_user_id IN (${fromUserDiscordId}, ${toUserDiscordId})
      `;

      if (users.length !== 2) {
        throw new Error("One or both users not found");
      }

      const fromUserId = users.find(u => u.discord_user_id === fromUserDiscordId)?.user_id;
      const toUserId = users.find(u => u.discord_user_id === toUserDiscordId)?.user_id;

      // 2. Get server ID
      const serverResult = await trx`
        SELECT server_id FROM servers WHERE discord_server_id = ${guildId}
      `;

      if (serverResult.length === 0) {
        throw new Error("Server not found");
      }

      const serverId = serverResult[0].server_id;

      // 3. Build transfer query
      let transferQuery;
      if (memoryIds && memoryIds.length > 0) {
        // Transfer specific memories
        transferQuery = trx`
          UPDATE personal_memories
          SET 
            user_id = ${toUserId},
            updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ${fromUserId}
            AND server_id = ${serverId}
            AND memory_id = ANY(${memoryIds})
          RETURNING memory_id
        `;
      } else {
        // Transfer all memories
        transferQuery = trx`
          UPDATE personal_memories
          SET 
            user_id = ${toUserId},
            updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ${fromUserId}
            AND server_id = ${serverId}
          RETURNING memory_id
        `;
      }

      const transferResult = await transferQuery;
      transferredCount = transferResult.length;

      if (transferredCount === 0) {
        throw new Error("No memories found to transfer");
      }

      // 4. Log the transfer
      await trx`
        INSERT INTO error_logs (server_id, error_type, error_message, error_context)
        VALUES (
          ${serverId}, 
          'memory_transfer', 
          'Memory transfer completed',
          ${JSON.stringify({
            fromUser: fromUserDiscordId,
            toUser: toUserDiscordId,
            transferredCount,
            timestamp: new Date().toISOString(),
          })}
        )
      `;

      log.info(`Transferred ${transferredCount} memories from ${fromUserDiscordId} to ${toUserDiscordId}`);
    });

    return transferredCount;

  } catch (error) {
    log.error(`Memory transfer failed:`, error as Error);
    throw error;
  }
}
```

## Step 6: Database Migrations

### Schema Migration Function

**File**: `src/utils/db/migrations.ts`

```typescript
/**
 * Database migration utilities
 * Handles schema changes safely in production
 */

import { sql } from "bun";
import { log } from "../misc/logger";

interface Migration {
  version: number;
  name: string;
  up: () => Promise<void>;
  down?: () => Promise<void>;
}

/**
 * Add column if it doesn't exist (safe migration)
 */
export async function addColumnIfNotExists(
  table: string,
  column: string,
  dataType: string,
  defaultValue?: string,
  constraint?: string
): Promise<void> {
  try {
    await sql`
      SELECT add_column_if_not_exists(
        ${table}::text,
        ${column}::text,
        ${dataType}::text,
        ${defaultValue}::text,
        ${constraint}::text
      )
    `;

    log.info(`Added column ${table}.${column} if not exists`);

  } catch (error) {
    log.error(`Failed to add column ${table}.${column}:`, error as Error);
    throw error;
  }
}

/**
 * Example migration: Add new configuration options
 */
const migration_001: Migration = {
  version: 1,
  name: "add_advanced_config_options",
  up: async () => {
    // Add new JSONB fields to server config
    await sql`
      UPDATE servers 
      SET config = config || jsonb_build_object(
        'advanced_mode_enabled', false,
        'debug_logging_enabled', false,
        'custom_personality_enabled', true
      )
      WHERE NOT (config ? 'advanced_mode_enabled')
    `;

    log.info("Migration 001: Added advanced config options");
  },
  down: async () => {
    // Remove the added fields
    await sql`
      UPDATE servers
      SET config = config - 'advanced_mode_enabled' - 'debug_logging_enabled' - 'custom_personality_enabled'
    `;

    log.info("Migration 001: Removed advanced config options");
  },
};

/**
 * Run pending migrations
 */
export async function runMigrations(): Promise<void> {
  try {
    // Create migrations table if it doesn't exist
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    const migrations: Migration[] = [migration_001];

    for (const migration of migrations) {
      // Check if migration already applied
      const existing = await sql`
        SELECT version FROM schema_migrations WHERE version = ${migration.version}
      `;

      if (existing.length === 0) {
        log.info(`Applying migration ${migration.version}: ${migration.name}`);
        
        await sql.begin(async (trx) => {
          // Run the migration
          await migration.up();
          
          // Record migration as applied
          await trx`
            INSERT INTO schema_migrations (version, name)
            VALUES (${migration.version}, ${migration.name})
          `;
        });

        log.success(`Migration ${migration.version} completed`);
      }
    }

  } catch (error) {
    log.error("Migration failed:", error as Error);
    throw error;
  }
}
```

## Step 7: Testing Database Operations

### Test Utilities

```typescript
/**
 * Database testing utilities
 * For development and integration testing
 */

/**
 * Create test data for development
 */
export async function createTestData(): Promise<void> {
  try {
    await sql.begin(async (trx) => {
      // Create test server
      const serverResult = await trx`
        INSERT INTO servers (discord_server_id, config)
        VALUES ('123456789012345678', ${JSON.stringify({
          llm_provider: 'google',
          llm_codename: 'gemini-2.0-flash-preview-05-20',
          llm_temperature: 0.7,
          sticker_usage_enabled: true,
          google_search_enabled: true,
        })})
        ON CONFLICT (discord_server_id) DO NOTHING
        RETURNING server_id
      `;

      if (serverResult.length > 0) {
        const serverId = serverResult[0].server_id;

        // Create test user
        await trx`
          INSERT INTO users (discord_user_id, preferences)
          VALUES ('987654321098765432', ${JSON.stringify({
            language_pref: 'en-US',
            timezone: 'UTC',
          })})
          ON CONFLICT (discord_user_id) DO NOTHING
        `;

        // Create test memories
        await trx`
          INSERT INTO personal_memories (user_id, server_id, memory_content, memory_type)
          SELECT u.user_id, ${serverId}, 'Test personal memory', 'test'
          FROM users u
          WHERE u.discord_user_id = '987654321098765432'
        `;

        await trx`
          INSERT INTO server_memories (server_id, memory_content, memory_type)
          VALUES (${serverId}, 'Test server memory', 'test')
        `;
      }
    });

    log.info("Test data created successfully");

  } catch (error) {
    log.error("Failed to create test data:", error as Error);
    throw error;
  }
}

/**
 * Clean up test data
 */
export async function cleanupTestData(): Promise<void> {
  try {
    await sql`DELETE FROM personal_memories WHERE memory_type = 'test'`;
    await sql`DELETE FROM server_memories WHERE memory_type = 'test'`;
    await sql`DELETE FROM servers WHERE discord_server_id = '123456789012345678'`;
    await sql`DELETE FROM users WHERE discord_user_id = '987654321098765432'`;

    log.info("Test data cleaned up");

  } catch (error) {
    log.error("Failed to cleanup test data:", error as Error);
    throw error;
  }
}
```

## Best Practices

### 1. **Always Use Parameterized Queries**
```typescript
// ✅ Good - prevents SQL injection
await sql`SELECT * FROM users WHERE discord_user_id = ${userId}`;

// ❌ Bad - vulnerable to SQL injection
await sql`SELECT * FROM users WHERE discord_user_id = '${userId}'`;
```

### 2. **Validate Input and Output**
```typescript
// Validate inputs
if (!guildId || !userId) {
  throw new Error("Missing required parameters");
}

// Validate outputs with Zod
const memory = personalMemorySchema.parse(result[0]);
```

### 3. **Use Transactions for Multi-step Operations**
```typescript
await sql.begin(async (trx) => {
  // Multiple related operations here
  // All will be rolled back if any fail
});
```

### 4. **Handle Errors Gracefully**
```typescript
try {
  const result = await databaseOperation();
  return result;
} catch (error) {
  log.error("Database operation failed:", error as Error);
  throw error; // Re-throw for caller to handle
}
```

### 5. **Use Proper Indexing**
```sql
-- Add indexes for frequently queried columns
CREATE INDEX idx_personal_memories_user_server 
ON personal_memories(user_id, server_id);

CREATE INDEX idx_servers_discord_id 
ON servers(discord_server_id);
```

Your database operations are now robust, type-safe, and ready for production use! 🗄️

---

**Related Guides**:
- [Creating Slash Commands](creating-slash-commands.md)
- [Error Handling Patterns](error-handling-patterns.md)