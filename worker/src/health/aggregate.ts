import { dailyCalorieExpenditure, workoutDisplayName, type HealthRecordMetadata } from "@fitlogr/shared";
import { recomputeDailyIntake } from "../db/summaries";

interface HealthRow {
  id: string;
  platform: "healthkit" | "health_connect" | "manual";
  record_type: string;
  source_record_id: string;
  source_app_id: string | null;
  source_device_name: string | null;
  start_time: string;
  end_time: string;
  local_date: string;
  timezone: string;
  value_num: number;
  unit: string;
  metadata_json: string | null;
  is_user_edited: number;
}

export async function recomputeHealthDates(db: D1Database, userId: string, dates: Iterable<string>, now: string): Promise<void> {
  const settings = await db
    .prepare("SELECT timezone FROM user_settings WHERE user_id = ?")
    .bind(userId)
    .first<{ timezone: string }>();
  for (const localDate of new Set(dates)) {
    await recomputeOneDate(db, userId, localDate, settings?.timezone ?? "UTC", now);
  }
}

async function recomputeOneDate(db: D1Database, userId: string, localDate: string, settingsTimezone: string, now: string): Promise<void> {
  const rows = await db
    .prepare(
      `SELECT id, platform, record_type, source_record_id, source_app_id, source_device_name, start_time, end_time,
              local_date, timezone, value_num, unit, metadata_json, is_user_edited
       FROM health_records
       WHERE user_id = ? AND local_date = ? AND deleted_at IS NULL`,
    )
    .bind(userId, localDate)
    .all<HealthRow>();
  const records = rows.results;
  const timezone = recordTimezone(records) ?? settingsTimezone;
  await recomputeDailyIntake(db, userId, localDate, timezone, now);

  const activeRows = records.filter((row) => row.record_type === "active_calories");
  const restingRows = records.filter((row) => row.record_type === "resting_calories");
  const workouts = records.filter((row) => row.record_type === "workout");
  const energy = dailyCalorieExpenditure({
    activeCaloriesKcal: activeRows.length > 0 ? sum(activeRows) : null,
    restingCaloriesKcal: restingRows.length > 0 ? sum(restingRows) : null,
    workoutCaloriesKcal: workouts.reduce((total, row) => total + workoutKcal(row), 0),
  });
  const steps = Math.round(sum(records.filter((row) => row.record_type === "steps")));
  const heart = latest(records.filter((row) => row.record_type === "heart_rate_summary"));
  const restingHeart = latest(records.filter((row) => row.record_type === "resting_heart_rate"));
  const weights = records.filter((row) => row.record_type === "weight");
  const manual = latest(weights.filter((row) => row.platform === "manual" || row.is_user_edited === 1));
  const weight = manual ?? latest(weights.filter((row) => row.platform !== "manual" && row.is_user_edited !== 1));

  await db
    .prepare(
      `UPDATE daily_summaries SET
         timezone = ?,
         active_calories_kcal = ?,
         resting_calories_kcal = ?,
         total_calories_out_kcal = ?,
         calorie_balance_kcal = calories_in_kcal - ?,
         steps = ?,
         workout_count = ?,
         workout_minutes = ?,
         avg_heart_rate_bpm = ?,
         resting_heart_rate_bpm = ?,
         updated_at = ?
       WHERE user_id = ? AND local_date = ?`,
    )
    .bind(
      timezone,
      energy.activeCaloriesKcal,
      energy.restingCaloriesKcal,
      energy.totalBurnedKcal,
      energy.totalBurnedKcal,
      steps,
      workouts.length,
      workouts.reduce((total, row) => total + durationMinutes(row), 0),
      heart ? heart.value_num : null,
      restingHeart ? restingHeart.value_num : null,
      now,
      userId,
      localDate,
    )
    .run();
  if (weight) {
    await db
      .prepare("UPDATE daily_summaries SET weight_kg = ?, updated_at = ? WHERE user_id = ? AND local_date = ?")
      .bind(weight.value_num, now, userId, localDate)
      .run();
  }
}

export function workoutKcal(row: { metadata_json: string | null }): number {
  const kcal = metadataOf(row.metadata_json).workout_kcal;
  return typeof kcal === "number" && kcal > 0 ? kcal : 0;
}

export function durationMinutes(row: { value_num: number; unit: string }): number {
  const seconds = row.unit === "sec" || row.unit === "s" ? row.value_num : row.unit === "min" ? row.value_num * 60 : 0;
  if (seconds <= 0) return 0;
  return Math.max(1, Math.round(seconds / 60));
}

export function metadataOf(json: string | null): HealthRecordMetadata {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as HealthRecordMetadata;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function activityName(row: { metadata_json: string | null; source_device_name: string | null }): { activity: string; name: string; source: string } {
  const activity = metadataOf(row.metadata_json).activity_type || "Workout";
  return {
    activity,
    name: workoutDisplayName(activity),
    source: row.source_device_name || "Apple Health",
  };
}

function recordTimezone(records: HealthRow[]): string | null {
  return records.find((row) => row.timezone)?.timezone ?? null;
}

function sum(rows: HealthRow[]): number {
  return rows.reduce((total, row) => total + row.value_num, 0);
}

function latest(rows: HealthRow[]): HealthRow | null {
  return rows.reduce<HealthRow | null>((best, row) => (!best || row.end_time > best.end_time ? row : best), null);
}
