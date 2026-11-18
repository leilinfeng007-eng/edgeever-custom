ALTER TABLE inbox_classification_jobs ADD COLUMN destination_id TEXT;
ALTER TABLE inbox_classification_jobs ADD COLUMN reason TEXT;
ALTER TABLE inbox_classification_jobs ADD COLUMN result_revision INTEGER;
ALTER TABLE inbox_classification_jobs ADD COLUMN suggested_tags TEXT;
