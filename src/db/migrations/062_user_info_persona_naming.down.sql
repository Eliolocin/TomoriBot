-- Restore the former users-table ownership before removing persona-aware naming.

ALTER TABLE users ADD COLUMN IF NOT EXISTS user_nickname TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS personal_deliberate_tool_mode TEXT DEFAULT 'follow';
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone_offset SMALLINT;

DO $$
BEGIN
  IF to_regclass('public.user_personalization_configs') IS NOT NULL THEN
    UPDATE users u
    SET
      user_nickname = COALESCE(upc.user_nickname, u.user_disc_id),
      personal_deliberate_tool_mode = COALESCE(upc.personal_deliberate_tool_mode, 'follow'),
      timezone_offset = upc.timezone_offset
    FROM user_personalization_configs upc
    WHERE upc.user_id = u.user_id;
  END IF;

  UPDATE users
  SET user_nickname = user_disc_id
  WHERE user_nickname IS NULL;
END $$;

ALTER TABLE users ALTER COLUMN user_nickname SET NOT NULL;

ALTER TABLE server_capabilities_configs DROP COLUMN IF EXISTS user_info_updates_enabled;
ALTER TABLE persona_presets DROP COLUMN IF EXISTS preset_naming_config;
DROP TABLE IF EXISTS persona_naming_configs;
DROP TABLE IF EXISTS user_persona_naming_preferences;

ALTER TABLE user_personalization_configs
  DROP COLUMN IF EXISTS addressing_style,
  DROP COLUMN IF EXISTS pronouns,
  DROP COLUMN IF EXISTS gender_identity,
  DROP COLUMN IF EXISTS suffix_override,
  DROP COLUMN IF EXISTS prefix_override,
  DROP COLUMN IF EXISTS timezone_offset,
  DROP COLUMN IF EXISTS personal_deliberate_tool_mode,
  DROP COLUMN IF EXISTS user_nickname;
