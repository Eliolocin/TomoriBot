-- Restore the legacy single main-key pointer per server.

BEGIN;

DROP INDEX IF EXISTS idx_api_key_rotation_main_pointer;

DELETE FROM api_key_rotation pointer
WHERE pointer.is_main_key_pointer = true
  AND EXISTS (
    SELECT 1
    FROM api_key_rotation retained
    WHERE retained.server_id = pointer.server_id
      AND retained.is_main_key_pointer = true
      AND retained.rotation_key_id < pointer.rotation_key_id
  );

CREATE UNIQUE INDEX idx_api_key_rotation_main_pointer
  ON api_key_rotation(server_id) WHERE is_main_key_pointer = true;

COMMIT;
