import { caloriesRemaining, dailyCalorieExpenditure, type DayResponse } from "@fitlogr/shared";
import { listMeals } from "../db/meals";
import { activityName, durationMinutes, metadataOf, workoutKcal } from "./aggregate";

interface SampleRow {
  id: string;
  platform: "healthkit" | "health_connect" | "manual";
  record_type: string;
  source_record_id: string;
  source_app_id: string | null;
  source_device_name: string | null;
  start_time: string;
  end_time: string;
  value_num: number;
  unit: string;
  metadata_json: string | null;
}

export async function buildDay(db: D1Database, userId: string, date: string): Promise<DayResponse> {
  const settings = await db
    .prepare("SELECT timezone, daily_calorie_target_kcal FROM user_settings WHERE user_id = ?")
    .bind(userId)
    .first<{ timezone: string; daily_calorie_target_kcal: number | null }>();
  const meals = await listMeals(db, userId, date, date);
  const samples = await db
    .prepare(
      `SELECT id, platform, record_type, source_record_id, source_app_id, source_device_name, start_time, end_time,
              value_num, unit, metadata_json
       FROM health_records
       WHERE user_id = ? AND local_date = ? AND deleted_at IS NULL
       ORDER BY start_time`,
    )
    .bind(userId, date)
    .all<SampleRow>();
  const weight = await db
    .prepare(
      `SELECT platform, value_num, end_time, local_date
       FROM health_records
       WHERE user_id = ? AND record_type = 'weight' AND deleted_at IS NULL AND local_date <= ?
       ORDER BY local_date DESC, end_time DESC
       LIMIT 1`,
    )
    .bind(userId, date)
    .first<{ platform: "healthkit" | "health_connect" | "manual"; value_num: number; end_time: string; local_date: string }>();

  const rows = samples.results;
  const activeRows = rows.filter((row) => row.record_type === "active_calories");
  const restingRows = rows.filter((row) => row.record_type === "resting_calories");
  const workoutRows = rows.filter((row) => row.record_type === "workout");
  const energy = dailyCalorieExpenditure({
    activeCaloriesKcal: activeRows.length > 0 ? sum(activeRows) : null,
    restingCaloriesKcal: restingRows.length > 0 ? sum(restingRows) : null,
    workoutCaloriesKcal: workoutRows.reduce((total, row) => total + workoutKcal(row), 0),
  });
  const eaten = meals.reduce((total, meal) => total + meal.calories_kcal, 0);
  const target = settings?.daily_calorie_target_kcal ?? null;
  const heart = latest(rows.filter((row) => row.record_type === "heart_rate_summary"));
  const restingHeart = latest(rows.filter((row) => row.record_type === "resting_heart_rate"));
  const heartMeta = metadataOf(heart?.metadata_json ?? null);
  const workouts = workoutRows.map((row) => {
    const display = activityName(row);
    return {
      id: row.id,
      external_id: row.source_record_id,
      activity_type: display.activity,
      name: display.name,
      start_time: row.start_time,
      end_time: row.end_time,
      duration_min: durationMinutes(row),
      calories_kcal: Math.round(workoutKcal(row)),
      source: display.source,
      source_app_id: row.source_app_id,
    };
  });

  return {
    date,
    timezone: settings?.timezone ?? "UTC",
    summary: {
      calories_in_kcal: round1(eaten),
      protein_g: round1(meals.reduce((total, meal) => total + meal.protein_g, 0)),
      carbs_g: round1(meals.reduce((total, meal) => total + meal.carbs_g, 0)),
      fat_g: round1(meals.reduce((total, meal) => total + meal.fat_g, 0)),
      meal_count: meals.length,
      active_calories_kcal: energy.activeCaloriesKcal,
      resting_calories_kcal: energy.restingCaloriesKcal,
      workout_calories_kcal: energy.workoutCaloriesKcal,
      total_calories_out_kcal: energy.totalBurnedKcal,
      calorie_balance_kcal: round1(eaten) - energy.totalBurnedKcal,
      calories_remaining_kcal: target == null ? null : caloriesRemaining(target, energy.activeCaloriesKcal, eaten),
      steps: Math.round(sum(rows.filter((row) => row.record_type === "steps"))),
      workout_count: workouts.length,
      workout_minutes: workouts.reduce((total, workout) => total + workout.duration_min, 0),
      weight_kg: weight?.value_num ?? null,
      resting_heart_rate_bpm: restingHeart?.value_num ?? null,
      avg_heart_rate_bpm: heart?.value_num ?? null,
      active_energy_source: energy.activeSource,
    },
    meals,
    workouts,
    weight: weight
      ? { weight_kg: weight.value_num, recorded_at: weight.end_time, local_date: weight.local_date, source_platform: weight.platform }
      : null,
    heart_rate: {
      avg_bpm: heart?.value_num ?? null,
      min_bpm: numberOrNull(heartMeta.min_bpm),
      max_bpm: numberOrNull(heartMeta.max_bpm),
      resting_bpm: restingHeart?.value_num ?? null,
    },
  };
}

function sum(rows: SampleRow[]): number {
  return rows.reduce((total, row) => total + row.value_num, 0);
}

function latest(rows: SampleRow[]): SampleRow | null {
  return rows.reduce<SampleRow | null>((best, row) => (!best || row.end_time > best.end_time ? row : best), null);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
