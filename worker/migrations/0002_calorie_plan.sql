-- Calorie Plan: maintenance calories plus a Daily / Weekly / Custom plan.

-- Maintenance replaces the single base calorie number. daily_calorie_target_kcal stays as a
-- mirror for app builds that predate the plan.
ALTER TABLE user_settings ADD COLUMN maintenance_calories_kcal INTEGER;
UPDATE user_settings SET maintenance_calories_kcal = daily_calorie_target_kcal WHERE maintenance_calories_kcal IS NULL;

-- Full plan (all three plan types with their own dates). NULL means Maintenance every day,
-- which is identical to the old single-target behavior.
ALTER TABLE user_settings ADD COLUMN calorie_plan_json TEXT;

-- What the day was judged against (resolved day type, amount, maintenance, tolerance), written
-- when the day is first logged and frozen once the day is in the past.
ALTER TABLE daily_summaries ADD COLUMN plan_snapshot_json TEXT;
