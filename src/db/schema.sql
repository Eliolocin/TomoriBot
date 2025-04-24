-- Create function for updated_at trigger
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = CURRENT_TIMESTAMP;
   RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create a function to add columns if they don't exist
CREATE OR REPLACE FUNCTION add_column_if_not_exists(
    _table TEXT, 
    _column TEXT, 
    _datatype TEXT,
    _default_value TEXT DEFAULT NULL,
    _constraint TEXT DEFAULT NULL
) RETURNS VOID AS $$
DECLARE
    _column_exists BOOLEAN;
BEGIN
    -- Check if the column already exists
    SELECT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = _table 
        AND column_name = _column
    ) INTO _column_exists;
    
    -- If it doesn't exist, add it
    IF NOT _column_exists THEN
        IF _default_value IS NULL AND _constraint IS NULL THEN
            EXECUTE format('ALTER TABLE %I ADD COLUMN %I %s', 
                         _table, _column, _datatype);
        ELSIF _constraint IS NULL THEN
            EXECUTE format('ALTER TABLE %I ADD COLUMN %I %s DEFAULT %s', 
                         _table, _column, _datatype, _default_value);
        ELSIF _default_value IS NULL THEN
            EXECUTE format('ALTER TABLE %I ADD COLUMN %I %s %s', 
                         _table, _column, _datatype, _constraint);
        ELSE
            EXECUTE format('ALTER TABLE %I ADD COLUMN %I %s DEFAULT %s %s', 
                         _table, _column, _datatype, _default_value, _constraint);
        END IF;
        
        RAISE NOTICE 'Added column %.% of type %', _table, _column, _datatype;
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS servers (
  server_id SERIAL PRIMARY KEY,
  server_disc_id TEXT UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_servers_disc_id ON servers(server_disc_id);

-- Create updated_at trigger for servers table
DROP TRIGGER IF EXISTS update_servers_timestamp ON servers;
CREATE TRIGGER update_servers_timestamp
BEFORE UPDATE ON servers
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TABLE IF NOT EXISTS tomoris (
  tomori_id SERIAL PRIMARY KEY,
  server_id INT NOT NULL UNIQUE,
  tomori_nickname TEXT NOT NULL,
  attribute_list TEXT[] DEFAULT '{}',
  sample_dialogues_in TEXT[] DEFAULT '{}', -- array index is soft id of sample dialogue pairs
  sample_dialogues_out TEXT[] DEFAULT '{}',
  autoch_counter INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (server_id) REFERENCES servers(server_id) ON DELETE CASCADE
);

-- Create updated_at trigger for tomoris table
DROP TRIGGER IF EXISTS update_tomoris_timestamp ON tomoris;
CREATE TRIGGER update_tomoris_timestamp
BEFORE UPDATE ON tomoris
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TABLE IF NOT EXISTS llms (
  llm_id SERIAL PRIMARY KEY,
  llm_provider TEXT NOT NULL,
  llm_codename TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create updated_at trigger for llms table
DROP TRIGGER IF EXISTS update_llms_timestamp ON llms;
CREATE TRIGGER update_llms_timestamp
BEFORE UPDATE ON llms
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TABLE IF NOT EXISTS tomori_configs (
  tomori_config_id SERIAL PRIMARY KEY,
  tomori_id INT NOT NULL UNIQUE,
  llm_id INT NOT NULL,
  llm_temperature REAL NOT NULL DEFAULT 1.5 CHECK (llm_temperature >= 1.0 AND llm_temperature <= 2.0),
  api_key BYTEA, -- encrypted
  trigger_words TEXT[] DEFAULT '{}',
  autoch_disc_ids TEXT[] DEFAULT '{}',
  autoch_threshold INT DEFAULT 0, -- set to 0 for no autoch
  teach_cost INT DEFAULT 1000, 
  gamba_limit INT DEFAULT 3,
  personal_memories_enabled BOOLEAN DEFAULT true,
  humanizer_enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tomori_id) REFERENCES tomoris(tomori_id) ON DELETE CASCADE,
  FOREIGN KEY (llm_id) REFERENCES llms(llm_id) ON DELETE RESTRICT
);

-- Create updated_at trigger for tomori_configs table
DROP TRIGGER IF EXISTS update_tomori_configs_timestamp ON tomori_configs;
CREATE TRIGGER update_tomori_configs_timestamp
BEFORE UPDATE ON tomori_configs
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TABLE IF NOT EXISTS tomori_presets (
  tomori_preset_id SERIAL PRIMARY KEY,
  tomori_preset_name TEXT NOT NULL UNIQUE,
  tomori_preset_desc TEXT NOT NULL,
  preset_attribute_list TEXT[] DEFAULT '{}',
  preset_sample_dialogues_in TEXT[] DEFAULT '{}', -- array index is soft id of sample dialogue pairs
  preset_sample_dialogues_out TEXT[] DEFAULT '{}',
  preset_language TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create updated_at trigger for tomori_presets table
DROP TRIGGER IF EXISTS update_tomori_presets_timestamp ON tomori_presets;
CREATE TRIGGER update_tomori_presets_timestamp
BEFORE UPDATE ON tomori_presets
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TABLE IF NOT EXISTS server_emojis (
  server_emoji_id SERIAL PRIMARY KEY,
  server_id INT NOT NULL,
  emoji_disc_id TEXT NOT NULL,
  emoji_name TEXT NOT NULL, -- e.g. TomoriGiggle -- Combine with emoji_disc_id for <:TomoriGiggle:123456789>
  emotion_key TEXT NOT NULL, -- e.g. "happy", "smug", "embarrassed"
  is_global BOOLEAN DEFAULT false, -- If emoji is a Tomori global
  is_animated BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (server_id, emoji_disc_id),
  FOREIGN KEY (server_id) REFERENCES servers(server_id) ON DELETE CASCADE
);

-- Create updated_at trigger for server_emojis table
DROP TRIGGER IF EXISTS update_server_emojis_timestamp ON server_emojis;
CREATE TRIGGER update_server_emojis_timestamp
BEFORE UPDATE ON server_emojis
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TABLE IF NOT EXISTS server_stickers (
  server_sticker_id SERIAL PRIMARY KEY,
  server_id INT NOT NULL,
  sticker_disc_id TEXT NOT NULL,
  sticker_name TEXT NOT NULL, -- e.g. Send as message payload
  sticker_desc TEXT DEFAULT '',
  emotion_key TEXT NOT NULL, -- e.g. "happy", "smug", "embarrassed"
  is_global BOOLEAN DEFAULT false, -- If sticker is a Tomori global
  is_animated BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (server_id, sticker_disc_id),
  FOREIGN KEY (server_id) REFERENCES servers(server_id) ON DELETE CASCADE
);

-- Create updated_at trigger for server_stickers table
DROP TRIGGER IF EXISTS update_server_stickers_timestamp ON server_stickers;
CREATE TRIGGER update_server_stickers_timestamp
BEFORE UPDATE ON server_stickers
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TABLE IF NOT EXISTS users (
  user_id SERIAL PRIMARY KEY,
  user_disc_id TEXT UNIQUE NOT NULL,
  user_nickname TEXT NOT NULL,
  tomocoins_held INT DEFAULT 0,
  tomocoins_deposited INT DEFAULT 0,
  language_pref TEXT DEFAULT 'en',
  personal_memories TEXT[] DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_users_disc_id ON users(user_disc_id);

-- Create updated_at trigger for users table
DROP TRIGGER IF EXISTS update_users_timestamp ON users;
CREATE TRIGGER update_users_timestamp
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TABLE IF NOT EXISTS server_memories (
  server_memory_id SERIAL PRIMARY KEY,
  server_id INT NOT NULL,
  user_id INT NOT NULL, -- Creator of this server memory
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (server_id) REFERENCES servers(server_id) ON DELETE CASCADE
);

-- Create updated_at trigger for server_memories table
DROP TRIGGER IF EXISTS update_server_memories_timestamp ON server_memories;
CREATE TRIGGER update_server_memories_timestamp
BEFORE UPDATE ON server_memories
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TABLE IF NOT EXISTS personalization_blacklist (
  server_id INT NOT NULL,
  user_id INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (server_id, user_id), -- composite key
  FOREIGN KEY (server_id) REFERENCES servers(server_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- Create updated_at trigger for personalization_blacklist table
DROP TRIGGER IF EXISTS update_personalization_blacklist_timestamp ON personalization_blacklist;
CREATE TRIGGER update_personalization_blacklist_timestamp
BEFORE UPDATE ON personalization_blacklist
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

CREATE TABLE IF NOT EXISTS error_logs (
  error_log_id SERIAL PRIMARY KEY,
  tomori_id INT NOT NULL,
  user_id INT NOT NULL,
  server_id INT NOT NULL,
  error_type TEXT NOT NULL,
  error_message TEXT NOT NULL,
  error_metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tomori_id) REFERENCES tomoris(tomori_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (server_id) REFERENCES servers(server_id) ON DELETE CASCADE
);

-- Create updated_at trigger for error_logs table
DROP TRIGGER IF EXISTS update_error_logs_timestamp ON error_logs;
CREATE TRIGGER update_error_logs_timestamp
BEFORE UPDATE ON error_logs
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

-- Unlogged table for command cooldowns
CREATE UNLOGGED TABLE IF NOT EXISTS cooldowns (
    user_disc_id TEXT NOT NULL,
    command_category TEXT NOT NULL,
    expiry_time BIGINT NOT NULL,
    PRIMARY KEY (user_disc_id, command_category)
);

-- Function to periodically clean up expired cooldowns
CREATE OR REPLACE FUNCTION cleanup_expired_cooldowns()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM cooldowns
    WHERE expiry_time < EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000
    RETURNING COUNT(*) INTO deleted_count;
    
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Make sure pgcrypto extension is enabled
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Example usage - This shows how to add columns to existing tables
-- You can add these calls whenever you need to introduce schema changes
-- SELECT add_column_if_not_exists('tomori_configs', 'new_feature_flag', 'BOOLEAN', 'false');
-- SELECT add_column_if_not_exists('users', 'avatar_url', 'TEXT');
-- SELECT add_column_if_not_exists('tomoris', 'response_count', 'INT', '0');