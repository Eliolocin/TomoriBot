-- Migration 066: Default member server-memory and document management to opt-in.
--
-- Only the column default is updated. Existing stored rows are preserved so
-- explicit administrator configurations remain untouched.

ALTER TABLE server_member_permissions_configs
  ALTER COLUMN server_memteaching_enabled SET DEFAULT false;
