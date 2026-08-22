-- Migration 066 down: Restore default true for member server-memory management.

ALTER TABLE server_member_permissions_configs
  ALTER COLUMN server_memteaching_enabled SET DEFAULT true;
