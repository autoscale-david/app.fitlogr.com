-- Classification and estimate for photos the model did not log as meals (workouts, ignores).
-- status stays analyzed_non_meal: the CHECK constraint cannot grow without rebuilding the table.
ALTER TABLE photos ADD COLUMN ai_classification TEXT;
ALTER TABLE photos ADD COLUMN ai_estimate_json TEXT;
ALTER TABLE photos ADD COLUMN device_verdict TEXT;
ALTER TABLE photos ADD COLUMN device_labels_json TEXT;
