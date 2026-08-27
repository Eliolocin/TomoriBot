-- Rollback for migration 065: drop the metric_samples sink.
--
-- The index is dropped explicitly ahead of the table so a partially applied migration
-- (index created, table creation rolled back by a later failure) still reverses cleanly.
DROP INDEX IF EXISTS idx_metric_samples_name_time;
DROP TABLE IF EXISTS metric_samples;
