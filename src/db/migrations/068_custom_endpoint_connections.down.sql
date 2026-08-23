-- Migration 068 rollback: Revert custom endpoint connections and model split.

ALTER TABLE custom_endpoints
  ADD COLUMN IF NOT EXISTS server_id INT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS user_id INT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS label TEXT,
  ADD COLUMN IF NOT EXISTS capability TEXT,
  ADD COLUMN IF NOT EXISTS api_style TEXT,
  ADD COLUMN IF NOT EXISTS endpoint_url TEXT,
  ADD COLUMN IF NOT EXISTS requires_auth BOOLEAN DEFAULT false;

UPDATE custom_endpoints ce
SET
  server_id = cec.server_id,
  user_id = cec.user_id,
  label = cec.label,
  capability = cec.capability,
  api_style = cec.api_style,
  endpoint_url = cec.endpoint_url,
  requires_auth = cec.requires_auth
FROM custom_endpoint_connections cec
WHERE ce.connection_id = cec.connection_id;

ALTER TABLE custom_endpoints
  ALTER COLUMN label SET NOT NULL,
  ALTER COLUMN capability SET NOT NULL,
  ALTER COLUMN api_style SET NOT NULL,
  ALTER COLUMN endpoint_url SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_custom_endpoints_server ON custom_endpoints(server_id);
CREATE INDEX IF NOT EXISTS idx_custom_endpoints_user ON custom_endpoints(user_id);
CREATE INDEX IF NOT EXISTS idx_custom_endpoints_label ON custom_endpoints(label);
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_endpoints_server_label_capability_model_unique
  ON custom_endpoints(server_id, label, capability, COALESCE(model_name, ''))
  WHERE user_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_endpoints_user_label_capability_model_unique
  ON custom_endpoints(user_id, label, capability, COALESCE(model_name, ''))
  WHERE server_id IS NULL;

DROP INDEX IF EXISTS idx_custom_endpoints_connection_model_unique;
DROP INDEX IF EXISTS idx_custom_endpoints_connection;

ALTER TABLE custom_endpoints DROP COLUMN IF EXISTS connection_id;
DROP TABLE IF EXISTS custom_endpoint_connections CASCADE;
