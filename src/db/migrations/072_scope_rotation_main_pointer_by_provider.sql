-- Make each provider rotation pool own its main-key pointer.

BEGIN;

DROP INDEX IF EXISTS idx_api_key_rotation_main_pointer;

INSERT INTO api_key_rotation (
  server_id, provider, api_key, key_version, is_main_key_pointer, is_enabled
)
SELECT DISTINCT keys.server_id, keys.provider, NULL::bytea, 1, true, true
FROM api_key_rotation keys
WHERE keys.is_main_key_pointer = false
  AND NOT EXISTS (
    SELECT 1
    FROM api_key_rotation pointer
    WHERE pointer.server_id = keys.server_id
      AND pointer.provider = keys.provider
      AND pointer.is_main_key_pointer = true
  );

CREATE UNIQUE INDEX idx_api_key_rotation_main_pointer
  ON api_key_rotation(server_id, provider) WHERE is_main_key_pointer = true;

INSERT INTO api_key_rotation_runtime_state (rotation_key_id)
SELECT rotation_key_id
FROM api_key_rotation
WHERE is_main_key_pointer = true
ON CONFLICT (rotation_key_id) DO NOTHING;

COMMIT;
