-- Migration 079: Correct the users.language_pref database default to 'en-US'.
--
-- The DDL default was 'en', which is not a locale the localizer resolves: every
-- application path writes and expects 'en-US'. Aligning the database default lets a
-- reset assign SQL DEFAULT without writing a value the runtime cannot use.
-- Existing rows are left alone because a stored value is a user's own choice.

ALTER TABLE users ALTER COLUMN language_pref SET DEFAULT 'en-US';
