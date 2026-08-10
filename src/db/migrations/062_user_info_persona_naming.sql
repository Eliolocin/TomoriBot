-- Move durable user settings to their personalization owner and add the
-- persona-relative naming model used by commands, tools, and context rendering.

ALTER TABLE user_personalization_configs
  ADD COLUMN IF NOT EXISTS user_nickname TEXT,
  ADD COLUMN IF NOT EXISTS personal_deliberate_tool_mode TEXT NOT NULL DEFAULT 'follow',
  ADD COLUMN IF NOT EXISTS timezone_offset SMALLINT,
  ADD COLUMN IF NOT EXISTS prefix_override TEXT,
  ADD COLUMN IF NOT EXISTS suffix_override TEXT,
  ADD COLUMN IF NOT EXISTS gender_identity TEXT,
  ADD COLUMN IF NOT EXISTS pronouns TEXT,
  ADD COLUMN IF NOT EXISTS orientation TEXT,
  ADD COLUMN IF NOT EXISTS addressing_style TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_personalization_configs_addressing_style_check'
  ) THEN
    ALTER TABLE user_personalization_configs
      ADD CONSTRAINT user_personalization_configs_addressing_style_check
      CHECK (addressing_style IS NULL OR addressing_style IN ('masculine', 'feminine', 'neutral'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_personalization_configs_timezone_offset_check'
  ) THEN
    ALTER TABLE user_personalization_configs
      ADD CONSTRAINT user_personalization_configs_timezone_offset_check
      CHECK (timezone_offset IS NULL OR timezone_offset BETWEEN -12 AND 14);
  END IF;
END $$;

INSERT INTO user_personalization_configs (user_id)
SELECT user_id FROM users
ON CONFLICT (user_id) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'user_nickname'
  ) THEN
    EXECUTE $backfill$
      UPDATE user_personalization_configs upc
      SET user_nickname = u.user_nickname
      FROM users u
      WHERE upc.user_id = u.user_id
    $backfill$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'personal_deliberate_tool_mode'
  ) THEN
    EXECUTE $backfill$
      UPDATE user_personalization_configs upc
      SET personal_deliberate_tool_mode = COALESCE(u.personal_deliberate_tool_mode, 'follow')
      FROM users u
      WHERE upc.user_id = u.user_id
    $backfill$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'timezone_offset'
  ) THEN
    EXECUTE $backfill$
      UPDATE user_personalization_configs upc
      SET timezone_offset = u.timezone_offset
      FROM users u
      WHERE upc.user_id = u.user_id
    $backfill$;
  END IF;
END $$;

ALTER TABLE users DROP COLUMN IF EXISTS user_nickname;
ALTER TABLE users DROP COLUMN IF EXISTS personal_deliberate_tool_mode;
ALTER TABLE users DROP COLUMN IF EXISTS timezone_offset;

CREATE TABLE IF NOT EXISTS user_persona_naming_preferences (
  user_id INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  persona_lineage_id BIGINT NOT NULL,
  nickname_override TEXT,
  prefix_override TEXT,
  suffix_override TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, persona_lineage_id)
);

DROP TRIGGER IF EXISTS update_user_persona_naming_preferences_timestamp
  ON user_persona_naming_preferences;
CREATE TRIGGER update_user_persona_naming_preferences_timestamp
  BEFORE UPDATE ON user_persona_naming_preferences
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TABLE IF NOT EXISTS persona_naming_configs (
  persona_id INT PRIMARY KEY REFERENCES personas(persona_id) ON DELETE CASCADE,
  prefixes JSONB NOT NULL DEFAULT '{}'::JSONB,
  suffixes JSONB NOT NULL DEFAULT '{}'::JSONB,
  address_terms JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS update_persona_naming_configs_timestamp ON persona_naming_configs;
CREATE TRIGGER update_persona_naming_configs_timestamp
  BEFORE UPDATE ON persona_naming_configs
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

INSERT INTO persona_naming_configs (persona_id)
SELECT persona_id FROM personas
ON CONFLICT (persona_id) DO NOTHING;

ALTER TABLE persona_presets
  ADD COLUMN IF NOT EXISTS preset_naming_config JSONB NOT NULL
  DEFAULT '{"prefixes":{},"suffixes":{},"addressTerms":{}}'::JSONB;

ALTER TABLE server_capabilities_configs
  ADD COLUMN IF NOT EXISTS user_info_updates_enabled BOOLEAN NOT NULL DEFAULT true;
