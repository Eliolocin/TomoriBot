-- A panel endpoint label represents one URL across all of its capability connections.

BEGIN;

DROP TRIGGER IF EXISTS enforce_custom_endpoint_group_url ON custom_endpoint_connections;

DO $$
DECLARE
  rec RECORD;
  suffix INT;
  candidate TEXT;
  base_length INT;
BEGIN
  FOR rec IN (
    WITH divergent_labels AS (
      SELECT server_id, user_id, label
      FROM custom_endpoint_connections
      GROUP BY server_id, user_id, label
      HAVING COUNT(DISTINCT endpoint_url) > 1
    ),
    url_groups AS (
      SELECT
        cec.server_id,
        cec.user_id,
        cec.label,
        cec.endpoint_url,
        MIN(cec.connection_id) AS first_connection_id
      FROM custom_endpoint_connections cec
      JOIN divergent_labels divergent
        ON cec.server_id IS NOT DISTINCT FROM divergent.server_id
        AND cec.user_id IS NOT DISTINCT FROM divergent.user_id
        AND cec.label = divergent.label
      GROUP BY cec.server_id, cec.user_id, cec.label, cec.endpoint_url
    )
    SELECT
      server_id,
      user_id,
      label,
      endpoint_url,
      ROW_NUMBER() OVER (
        PARTITION BY server_id, user_id, label
        ORDER BY first_connection_id
      ) AS url_index
    FROM url_groups
    ORDER BY COALESCE(server_id, -1), COALESCE(user_id, -1), label, first_connection_id
  ) LOOP
    suffix := rec.url_index;
    LOOP
      base_length := 40 - LENGTH('-' || suffix);
      candidate := SUBSTRING(rec.label FROM 1 FOR base_length) || '-' || suffix;

      IF NOT EXISTS (
        SELECT 1
        FROM custom_endpoint_connections existing
        WHERE existing.server_id IS NOT DISTINCT FROM rec.server_id
          AND existing.user_id IS NOT DISTINCT FROM rec.user_id
          AND existing.label = candidate
      ) THEN
        EXIT;
      END IF;
      suffix := suffix + 1;
    END LOOP;

    UPDATE custom_endpoint_connections cec
    SET label = candidate, updated_at = CURRENT_TIMESTAMP
    WHERE cec.server_id IS NOT DISTINCT FROM rec.server_id
      AND cec.user_id IS NOT DISTINCT FROM rec.user_id
      AND cec.label = rec.label
      AND cec.endpoint_url = rec.endpoint_url;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION enforce_custom_endpoint_group_url()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM custom_endpoint_connections sibling
    WHERE sibling.connection_id <> NEW.connection_id
      AND sibling.server_id IS NOT DISTINCT FROM NEW.server_id
      AND sibling.user_id IS NOT DISTINCT FROM NEW.user_id
      AND sibling.label = NEW.label
      AND sibling.endpoint_url <> NEW.endpoint_url
  ) THEN
    RAISE EXCEPTION 'Custom endpoint capabilities grouped by one label must share one URL'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER enforce_custom_endpoint_group_url
  AFTER INSERT OR UPDATE ON custom_endpoint_connections
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_custom_endpoint_group_url();

COMMIT;
