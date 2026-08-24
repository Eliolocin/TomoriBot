BEGIN;

DROP TRIGGER IF EXISTS enforce_custom_endpoint_group_url ON custom_endpoint_connections;
DROP FUNCTION IF EXISTS enforce_custom_endpoint_group_url();

COMMIT;
