-- Initialize pg_cron extension for PostgreSQL in Docker
-- This script runs automatically when the PostgreSQL container starts up

-- Enable pg_cron extension (requires shared_preload_libraries to be set)
-- Note: pg_cron requires the extension to be available in the PostgreSQL installation
-- For production deployments, consider using a PostgreSQL image with pg_cron pre-installed
-- or a managed database service that supports pg_cron

-- Attempt to create the extension if it's available
DO $$
BEGIN
    -- Try to create the pg_cron extension
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    RAISE NOTICE 'pg_cron extension enabled successfully';
EXCEPTION 
    WHEN OTHERS THEN
        RAISE NOTICE 'pg_cron extension not available: %', SQLERRM;
        RAISE NOTICE 'Cooldown cleanup will be handled by application startup instead';
END $$;