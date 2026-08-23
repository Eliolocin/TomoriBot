-- Migration 068: Split custom endpoints into connection and model registration rows.
--
-- A logical connection is scoped by (owner, label, capability) with connection metadata
-- (api_style, endpoint_url, requires_auth). Model registrations under custom_endpoints
-- retain only model-specific fields and reference custom_endpoint_connections via connection_id.
-- Encrypted credentials and key_version remain canonical in saved_provider_configs and
-- user_saved_provider_configs.

CREATE TABLE IF NOT EXISTS custom_endpoint_connections (
  connection_id SERIAL PRIMARY KEY,
  server_id INT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
  user_id INT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  capability TEXT NOT NULL,
  api_style TEXT NOT NULL,
  endpoint_url TEXT NOT NULL,
  requires_auth BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CHECK ((server_id IS NULL) <> (user_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_custom_endpoint_connections_server ON custom_endpoint_connections(server_id);
CREATE INDEX IF NOT EXISTS idx_custom_endpoint_connections_user ON custom_endpoint_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_custom_endpoint_connections_label ON custom_endpoint_connections(label);

CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_endpoint_connections_server_unique
  ON custom_endpoint_connections(server_id, label, capability, api_style, endpoint_url)
  WHERE user_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_endpoint_connections_user_unique
  ON custom_endpoint_connections(user_id, label, capability, api_style, endpoint_url)
  WHERE server_id IS NULL;

DROP TRIGGER IF EXISTS update_custom_endpoint_connections_timestamp ON custom_endpoint_connections;
CREATE TRIGGER update_custom_endpoint_connections_timestamp
  BEFORE UPDATE ON custom_endpoint_connections
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

ALTER TABLE custom_endpoints
  ADD COLUMN IF NOT EXISTS connection_id INT REFERENCES custom_endpoint_connections(connection_id) ON DELETE CASCADE;

-- Backfill connections and link model rows only while legacy columns exist.
-- Distinct (api_style, endpoint_url) pairs preserve divergent connections as distinct IDs.
-- Disagreements on requires_auth use bool_or to preserve the stricter requirement.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'custom_endpoints'
      AND column_name = 'endpoint_url'
  ) THEN
    INSERT INTO custom_endpoint_connections (
      server_id,
      user_id,
      label,
      capability,
      api_style,
      endpoint_url,
      requires_auth,
      created_at,
      updated_at
    )
    SELECT
      server_id,
      user_id,
      label,
      capability,
      api_style,
      endpoint_url,
      bool_or(COALESCE(requires_auth, false)) AS requires_auth,
      MIN(created_at) AS created_at,
      MAX(updated_at) AS updated_at
    FROM custom_endpoints
    GROUP BY server_id, user_id, label, capability, api_style, endpoint_url
    ON CONFLICT DO NOTHING;

    UPDATE custom_endpoints ce
    SET connection_id = cec.connection_id
    FROM custom_endpoint_connections cec
    WHERE (
      (ce.server_id IS NOT NULL AND ce.server_id = cec.server_id AND cec.user_id IS NULL)
      OR (ce.user_id IS NOT NULL AND ce.user_id = cec.user_id AND cec.server_id IS NULL)
    )
    AND ce.label = cec.label
    AND ce.capability = cec.capability
    AND ce.api_style = cec.api_style
    AND ce.endpoint_url = cec.endpoint_url
    AND ce.connection_id IS NULL;
  END IF;
END $$;

ALTER TABLE custom_endpoints
  ALTER COLUMN connection_id SET NOT NULL;

DROP INDEX IF EXISTS idx_custom_endpoints_server;
DROP INDEX IF EXISTS idx_custom_endpoints_user;
DROP INDEX IF EXISTS idx_custom_endpoints_label;
DROP INDEX IF EXISTS idx_custom_endpoints_server_label_capability_unique;
DROP INDEX IF EXISTS idx_custom_endpoints_user_label_capability_unique;
DROP INDEX IF EXISTS idx_custom_endpoints_server_label_capability_model_unique;
DROP INDEX IF EXISTS idx_custom_endpoints_user_label_capability_model_unique;

CREATE INDEX IF NOT EXISTS idx_custom_endpoints_connection ON custom_endpoints(connection_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_endpoints_connection_model_unique
  ON custom_endpoints(connection_id, COALESCE(model_name, ''));

ALTER TABLE custom_endpoints
  DROP COLUMN IF EXISTS server_id,
  DROP COLUMN IF EXISTS user_id,
  DROP COLUMN IF EXISTS label,
  DROP COLUMN IF EXISTS capability,
  DROP COLUMN IF EXISTS api_style,
  DROP COLUMN IF EXISTS endpoint_url,
  DROP COLUMN IF EXISTS requires_auth;
