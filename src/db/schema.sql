CREATE TABLE IF NOT EXISTS servers (
  server_id SERIAL PRIMARY KEY,
  server_disc_id TEXT UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tomoris (
  tomori_id SERIAL PRIMARY KEY,
  server_id INT NOT NULL UNIQUE,
  tomori_nickname TEXT NOT NULL,
  server_memories TEXT[] DEFAULT '{}',
  attribute_list TEXT[] DEFAULT '{}',
  sample_dialogues_in TEXT[] DEFAULT '{}', -- array index is soft id of sample dialogue pairs
  sample_dialogues_out TEXT[] DEFAULT '{}',
  autoch_counter INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (server_id) REFERENCES servers(server_id)
);

CREATE TABLE IF NOT EXISTS llms (
  llm_id SERIAL PRIMARY KEY,
  llm_provider TEXT NOT NULL,
  llm_codename TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tomori_configs (
  tomori_config_id SERIAL PRIMARY KEY,
  tomori_id INT NOT NULL UNIQUE,
  llm_id INT NOT NULL,
  llm_temperature REAL NOT NULL DEFAULT 1.5 CHECK (llm_temperature >= 1.0 AND llm_temperature <= 2.0),
  api_key BYTEA, -- encrypted
  trigger_words TEXT[] DEFAULT '{}',
  autoch_disc_ids TEXT[] DEFAULT '{}',
  autoch_threshold INT DEFAULT 0, -- set to 0 for no autoch
  personal_memories_enabled BOOLEAN DEFAULT true,
  humanizer_enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tomori_id) REFERENCES tomoris(tomori_id),
  FOREIGN KEY (llm_id) REFERENCES llms(llm_id)
);

CREATE TABLE IF NOT EXISTS tomori_presets (
  tomori_preset_id SERIAL PRIMARY KEY,
  tomori_preset_name TEXT NOT NULL UNIQUE,
  tomori_preset_desc TEXT NOT NULL,
  preset_attribute_list TEXT[] DEFAULT '{}',
  preset_sample_dialogues_in TEXT[] DEFAULT '{}', -- array index is soft id of sample dialogue pairs
  preset_sample_dialogues_out TEXT[] DEFAULT '{}',
  preset_language TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tomori_emojis (
  tomori_emoji_id SERIAL PRIMARY KEY,
  tomori_id INT NOT NULL,
  emotion_key TEXT NOT NULL, -- e.g. "happy", "smug", "embarrassed"
  emoji_code TEXT NOT NULL, -- e.g. <:TomoriGiggle:123456789>
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tomori_id, emoji_code),
  FOREIGN KEY (tomori_id) REFERENCES tomoris(tomori_id)
);

CREATE TABLE IF NOT EXISTS users (
  user_id SERIAL PRIMARY KEY,
  user_disc_id TEXT UNIQUE NOT NULL,
  user_nickname TEXT NOT NULL,
  tomocoins_held INT DEFAULT 0,
  tomocoins_deposited INT DEFAULT 0,
  language_pref TEXT DEFAULT 'en',
  personal_memories TEXT[] DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS personalization_blacklist (
  server_id INT NOT NULL,
  user_id INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (server_id, user_id), -- composite key
  FOREIGN KEY (server_id) REFERENCES servers(server_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS error_logs (
  error_log_id SERIAL PRIMARY KEY,
  tomori_id INT NOT NULL,
  user_id INT NOT NULL,
  server_id INT NOT NULL,
  error_type TEXT NOT NULL,
  error_message TEXT NOT NULL,
  error_metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tomori_id) REFERENCES tomoris(tomori_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  FOREIGN KEY (server_id) REFERENCES servers(server_id)
);

-- Unlogged table for command cooldowns
CREATE UNLOGGED TABLE IF NOT EXISTS cooldowns (
    user_disc_id TEXT NOT NULL,
    command_category TEXT NOT NULL,
    expiry_time BIGINT NOT NULL,
    PRIMARY KEY (user_disc_id, command_category)
);