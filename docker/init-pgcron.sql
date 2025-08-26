-- Initialize pg_cron extension for PostgreSQL in Docker
-- This script runs automatically when the PostgreSQL container starts up
-- pg_cron extension should be available since we built it into the image

-- Create the pg_cron extension
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Grant usage on cron schema to tomori user
GRANT USAGE ON SCHEMA cron TO tomori;

-- Note: The cleanup job will be scheduled by TomoriBot application startup
-- This ensures proper database connection parameters are used