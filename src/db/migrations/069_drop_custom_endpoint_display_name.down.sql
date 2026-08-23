-- Migration 069 rollback: Restore custom_endpoints.display_name column.

ALTER TABLE custom_endpoints
  ADD COLUMN IF NOT EXISTS display_name TEXT;

UPDATE custom_endpoints ce
SET display_name = COALESCE(ce.model_name, cec.label)
FROM custom_endpoint_connections cec
WHERE ce.connection_id = cec.connection_id;

ALTER TABLE custom_endpoints
  ALTER COLUMN display_name SET NOT NULL;
