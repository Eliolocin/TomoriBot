-- PostgreSQL pg_cron extension setup for production environments
-- This file is separate from schema.sql to allow optional execution
-- Run this only on PostgreSQL instances that support pg_cron extension

-- Enable pg_cron extension (requires superuser privileges)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Schedule the cleanup function to run every hour using pg_cron
-- Use ON CONFLICT to make this command idempotent (safe to run multiple times)
INSERT INTO cron.job (schedule, command, nodename, nodeport, database, username)
VALUES (
    '0 * * * *', -- Run at the start of every hour
    'SELECT cleanup_expired_cooldowns();',
    'localhost', -- Adjust if your DB host is different
    5432,        -- Adjust if your DB port is different
    current_database(),
    current_user
)
ON CONFLICT (command, database, username, nodename, nodeport)
DO UPDATE SET schedule = EXCLUDED.schedule; -- Update schedule if job already exists