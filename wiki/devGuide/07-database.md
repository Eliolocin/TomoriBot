# Database Architecture

TomoriBot uses **PostgreSQL** as its primary database with a sophisticated schema designed for scalability, security, and rich AI functionality. The database supports encrypted sensitive data, comprehensive memory systems, and modular configuration management.

## Database Stack

- **Database**: PostgreSQL with pgcrypto extension
- **Connection**: Direct SQL queries using Bun's built-in SQLite driver
- **Validation**: Zod schemas for runtime type checking
- **Encryption**: pgcrypto for sensitive data (API keys, secrets)
- **Migration**: Manual schema management via SQL files

## Schema Overview

### Core Tables

**servers** - Guild configuration and settings
```sql
CREATE TABLE servers (
    server_id SERIAL PRIMARY KEY,
    discord_server_id TEXT UNIQUE NOT NULL,
    config JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**users** - User profiles and preferences  
```sql
CREATE TABLE users (
    user_id SERIAL PRIMARY KEY,
    discord_user_id TEXT UNIQUE NOT NULL,
    preferences JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**tomori_instances** - Per-server AI configurations
```sql
CREATE TABLE tomori_instances (
    instance_id SERIAL PRIMARY KEY,
    server_id INT REFERENCES servers(server_id),
    personality_data JSONB NOT NULL,
    llm_config JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Memory System

**personal_memories** - User-specific AI memories
```sql
CREATE TABLE personal_memories (
    memory_id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(user_id),
    server_id INT REFERENCES servers(server_id),
    memory_content TEXT NOT NULL,
    memory_type VARCHAR(50) DEFAULT 'general',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**server_memories** - Server-wide AI memories
```sql
CREATE TABLE server_memories (
    memory_id SERIAL PRIMARY KEY,
    server_id INT REFERENCES servers(server_id),
    memory_content TEXT NOT NULL,
    memory_type VARCHAR(50) DEFAULT 'general',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Security & API Management

**encrypted_api_keys** - Secure API key storage
```sql
CREATE TABLE encrypted_api_keys (
    key_id SERIAL PRIMARY KEY,
    server_id INT REFERENCES servers(server_id),
    provider_name TEXT NOT NULL,
    encrypted_key BYTEA NOT NULL, -- pgcrypto encrypted
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(server_id, provider_name)
);
```

**mcp_api_keys** - MCP server API key storage
```sql
CREATE TABLE mcp_api_keys (
    mcp_api_key_id SERIAL PRIMARY KEY,
    server_id INT REFERENCES servers(server_id),
    mcp_name TEXT NOT NULL,
    api_key BYTEA, -- Encrypted using pgcrypto
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (server_id, mcp_name)
);
```

### Operational Tables

**error_logs** - Comprehensive error tracking
```sql
CREATE TABLE error_logs (
    log_id SERIAL PRIMARY KEY,
    server_id INT REFERENCES servers(server_id),
    error_type VARCHAR(100) NOT NULL,
    error_message TEXT NOT NULL,
    error_context JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**cooldowns** - Rate limiting and cooldown management
```sql
CREATE TABLE cooldowns (
    cooldown_id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(user_id),
    server_id INT REFERENCES servers(server_id),
    cooldown_type VARCHAR(50) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## Database Access Patterns

### Connection Management

```typescript
// src/utils/db/connection.ts
import Database from 'bun:sqlite';

// Connection pooling handled by Bun
const db = new Database(process.env.DATABASE_URL);
```

### Query Utilities

**Reading Operations** (`src/utils/db/dbRead.ts`)
```typescript
export async function getTomoriStateByGuildId(guildId: string): Promise<TomoriState | null> {
    const query = `
        SELECT 
            s.server_id,
            s.discord_server_id,
            s.config,
            t.personality_data,
            t.llm_config
        FROM servers s
        JOIN tomori_instances t ON s.server_id = t.server_id
        WHERE s.discord_server_id = ?
    `;
    
    const result = await db.query(query).get(guildId);
    return result ? TomoriStateSchema.parse(result) : null;
}
```

**Writing Operations** (`src/utils/db/dbWrite.ts`)
```typescript
export async function addPersonalMemoryByTomori(
    userDiscordId: string,
    guildId: string,
    memoryContent: string
): Promise<void> {
    const query = `
        INSERT INTO personal_memories (user_id, server_id, memory_content, memory_type)
        SELECT u.user_id, s.server_id, ?, 'learned_by_tomori'
        FROM users u, servers s
        WHERE u.discord_user_id = ? AND s.discord_server_id = ?
    `;
    
    await db.query(query).run(memoryContent, userDiscordId, guildId);
}
```

### Security Operations

**API Key Encryption** (`src/utils/security/crypto.ts`)
```typescript
export async function encryptApiKey(apiKey: string, serverId: number): Promise<void> {
    const query = `
        INSERT INTO encrypted_api_keys (server_id, provider_name, encrypted_key)
        VALUES (?, ?, pgp_sym_encrypt(?, ?))
        ON CONFLICT (server_id, provider_name) 
        DO UPDATE SET encrypted_key = pgp_sym_encrypt(?, ?)
    `;
    
    const secret = process.env.CRYPTO_SECRET;
    await db.query(query).run(serverId, 'google', apiKey, secret, apiKey, secret);
}

export async function decryptApiKey(serverId: number, provider: string): Promise<string | null> {
    const query = `
        SELECT pgp_sym_decrypt(encrypted_key, ?) as decrypted_key
        FROM encrypted_api_keys
        WHERE server_id = ? AND provider_name = ?
    `;
    
    const result = await db.query(query).get(process.env.CRYPTO_SECRET, serverId, provider);
    return result?.decrypted_key || null;
}
```

## Configuration Management

### Server Configuration Schema

Stored as JSONB in the `servers.config` column:

```typescript
interface ServerConfig {
    // LLM Settings
    llm_provider: 'google' | 'openai' | 'anthropic';
    llm_codename: string;
    llm_temperature: number;
    
    // Feature Flags
    sticker_usage_enabled: boolean;
    google_search_enabled: boolean;
    self_teaching_enabled: boolean;
    emoji_usage_enabled: boolean;
    
    // Behavior Settings
    humanizer_degree: number;
    auto_counter_chance: number;
    
    // UI Settings
    tomori_nickname: string;
    embed_color: string;
}
```

### Personality Configuration

Stored as JSONB in `tomori_instances.personality_data`:

```typescript
interface PersonalityData {
    personality_name: string;
    personality_description: string;
    personality_attributes: Record<string, any>;
    sample_dialogue: Array<{
        role: 'user' | 'assistant';
        content: string;
    }>;
}
```

## Database Initialization

### Schema Setup

**Primary Schema** (`src/db/schema.sql`)
- Creates all tables with proper relationships
- Sets up indexes for performance
- Configures pgcrypto extension

**Seed Data** (`src/db/seed.sql`)
- Default personality presets
- Example server configurations
- Initial feature flag settings

### Migration Strategy

```bash
# Initialize database from scratch
bun run seed-db

# Development database reset
bun run nuke-db  # ⚠️ Destructive operation

# Production deployment
# Manual SQL execution with careful migration planning
```

## Performance Considerations

### Indexing Strategy

```sql
-- Core lookups
CREATE INDEX idx_servers_discord_id ON servers(discord_server_id);
CREATE INDEX idx_users_discord_id ON users(discord_user_id);

-- Memory queries
CREATE INDEX idx_personal_memories_user_server ON personal_memories(user_id, server_id);
CREATE INDEX idx_server_memories_server ON server_memories(server_id);

-- Operational queries  
CREATE INDEX idx_cooldowns_user_type ON cooldowns(user_id, cooldown_type);
CREATE INDEX idx_error_logs_server_type ON error_logs(server_id, error_type);
```

### Query Optimization

- **JSONB Indexes**: GIN indexes on configuration columns for efficient JSON queries
- **Partial Indexes**: Indexes on active/unexpired records only
- **Connection Pooling**: Bun handles connection management automatically

### Data Retention

```sql
-- Automatic cleanup of expired cooldowns
DELETE FROM cooldowns WHERE expires_at < CURRENT_TIMESTAMP;

-- Error log rotation (keep last 30 days)
DELETE FROM error_logs WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '30 days';
```

## Security Architecture

### Encryption at Rest
- API keys encrypted with pgcrypto
- Database-level encryption for sensitive columns
- Environment variable protection for encryption keys

### Access Control
- No direct database access from Discord users
- All operations through application layer
- Parameterized queries prevent SQL injection

### Data Privacy
- Personal memories scoped to user and server
- No cross-server data leakage
- Configurable data retention policies

---

**Next**: Learn about [Deployment & CI/CD](08-deployment.md) and production considerations.