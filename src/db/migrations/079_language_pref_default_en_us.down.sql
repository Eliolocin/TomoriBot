-- Down-migration 079: Restore the historical users.language_pref default of 'en'.
--
-- Row values are not rewritten, matching the up migration's row-preserving boundary.

ALTER TABLE users ALTER COLUMN language_pref SET DEFAULT 'en';
