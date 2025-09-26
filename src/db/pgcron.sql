-- PostgreSQL pg_cron extension setup for production environments
-- This file is separate from schema.sql to allow optional execution
-- Run this only on PostgreSQL instances that support pg_cron extension

-- Enable pg_cron extension (requires superuser privileges)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Function to process due reminders and clean them up
-- This function is called by pg_cron but reminders are actually processed by the application
-- The function only cleans up expired reminders that are significantly past due
CREATE OR REPLACE FUNCTION cleanup_expired_reminders()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    -- Delete reminders that are more than 1 hour past due
    -- The application should handle reminders within reasonable time
    -- This is just cleanup for cases where the app was down for extended periods
    DELETE FROM reminders
    WHERE reminder_time < (CURRENT_TIMESTAMP - INTERVAL '1 hour');

    GET DIAGNOSTICS deleted_count = ROW_COUNT;

    -- Log cleanup activity if any reminders were deleted
    IF deleted_count > 0 THEN
        INSERT INTO error_logs (error_type, error_message, error_metadata)
        VALUES (
            'ReminderCleanup',
            'Cleaned up expired reminders that were more than 1 hour past due',
            jsonb_build_object('deleted_count', deleted_count, 'cleanup_time', CURRENT_TIMESTAMP)
        );
    END IF;

    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

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

-- Schedule the reminder cleanup function to run every hour as well
INSERT INTO cron.job (schedule, command, nodename, nodeport, database, username)
VALUES (
    '0 * * * *', -- Run at the start of every hour
    'SELECT cleanup_expired_reminders();',
    'localhost', -- Adjust if your DB host is different
    5432,        -- Adjust if your DB port is different
    current_database(),
    current_user
)
ON CONFLICT (command, database, username, nodename, nodeport)
DO UPDATE SET schedule = EXCLUDED.schedule; -- Update schedule if job already exists