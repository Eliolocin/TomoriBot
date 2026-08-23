-- Migration 069: Backfill ComfyUI model_name from display_name and drop custom_endpoints.display_name.
--
-- ComfyUI endpoints historically stored the checkpoint name in display_name while leaving model_name NULL.
-- Backfill model_name from display_name for ComfyUI rows via the joined custom_endpoint_connections table,
-- then drop the display_name column.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'custom_endpoints'
      AND column_name = 'display_name'
  ) THEN
    UPDATE custom_endpoints ce
    SET model_name = ce.display_name
    FROM custom_endpoint_connections cec
    WHERE ce.connection_id = cec.connection_id
      AND ce.model_name IS NULL
      AND cec.api_style = 'comfyui'
      AND ce.display_name IS NOT NULL;
  END IF;
END $$;

ALTER TABLE custom_endpoints
  DROP COLUMN IF EXISTS display_name;
