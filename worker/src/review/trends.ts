import { dailyCalorieExpenditure, parseSnapshotJson, round1, type TrendsResponse } from "@fitlogr/shared";
import { durationMinutes, workoutKcal } from "../health/aggregate";
import { datesEnding, localDateInTimeZone } from "./dates";

interface MealTotals {
  local_date: string;
  calories_kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  meal_count: number;
}

interface HealthRow {
  local_date: string;
  record_type: string;
  value_num: number;
  unit: string;
  metadata_json: string | null;
  end_time: string;
}

interface SummaryRow {
  local_date: string;
  weight_kg: number | null;
  plan_snapshot_json: string | null;
}

export async function reviewTrends(db: D1Database, userId: string, days: 7 | 14 | 30, now: Date): Promise<TrendsResponse> {
  const settings = await db
    .prepare("SELECT timezone, COALESCE(maintenance_calories_kcal, daily_calorie_target_kcal) AS maintenance FROM user_settings WHERE user_id = ?")
    .bind(userId)
    .first<{ timezone: string; maintenance: number | null }>();
  const timezone = settings?.timezone || "UTC";
  const target = settings?.maintenance ?? null;
  const end = localDateInTimeZone(now, timezone);
  const dates = datesEnding(end, days);
  const from = dates[0] ?? end;

  const meals = await db
    .prepare(
      `SELECT local_date,
              COALESCE(SUM(calories_kcal), 0) AS calories_kcal,
              COALESCE(SUM(protein_g), 0) AS protein_g,
              COALESCE(SUM(carbs_g), 0) AS carbs_g,
              COALESCE(SUM(fat_g), 0) AS fat_g,
              COUNT(*) AS meal_count
       FROM meals
       WHERE user_id = ? AND deleted_at IS NULL AND local_date >= ? AND local_date <= ?
       GROUP BY local_date`,
    )
    .bind(userId, from, end)
    .all<MealTotals>();
  const health = await db
    .prepare(
      `SELECT local_date, record_type, value_num, unit, metadata_json, end_time
       FROM health_records
       WHERE user_id = ? AND deleted_at IS NULL AND local_date >= ? AND local_date <= ?`,
    )
    .bind(userId, from, end)
    .all<HealthRow>();
  const summaryWeights = await db
    .prepare(
      `SELECT local_date, weight_kg, plan_snapshot_json FROM daily_summaries
       WHERE user_id = ? AND local_date >= ? AND local_date <= ?`,
    )
    .bind(userId, from, end)
    .all<SummaryRow>();

  const mealByDate = new Map(meals.results.map((row) => [row.local_date, row]));
  const healthByDate = new Map<string, HealthRow[]>();
  for (const row of health.results) {
    const list = healthByDate.get(row.local_date) ?? [];
    list.push(row);
    healthByDate.set(row.local_date, list);
  }
  const summaryWeight = new Map(summaryWeights.results.map((row) => [row.local_date, row.weight_kg]));
  const pastMaintenance = new Map(
    summaryWeights.results
      .filter((row) => row.local_date < end)
      .map((row) => [row.local_date, parseSnapshotJson(row.plan_snapshot_json)?.maintenanceCalories ?? null]),
  );

  return {
    timezone,
    days,
    from,
    to: end,
    calorie_target_kcal: target,
    points: dates.map((date) => {
      const meal = mealByDate.get(date);
      const rows = healthByDate.get(date) ?? [];
      const active = rows.filter((row) => row.record_type === "active_calories");
      const resting = rows.filter((row) => row.record_type === "resting_calories");
      const workouts = rows.filter((row) => row.record_type === "workout");
      const energy = dailyCalorieExpenditure({
        activeCaloriesKcal: active.length > 0 ? sum(active) : null,
        restingCaloriesKcal: resting.length > 0 ? sum(resting) : null,
        workoutCaloriesKcal: workouts.reduce((total, row) => total + workoutKcal(row), 0),
      });
      const intake = round1(meal?.calories_kcal ?? 0);
      const burned = energy.totalBurnedKcal;
      const weightRow = latest(rows.filter((row) => row.record_type === "weight"));
      const summary = summaryWeight.get(date);
      const maintenance = pastMaintenance.get(date) ?? target;
      return {
        date,
        calories_in_kcal: intake,
        calories_burned_kcal: burned,
        surplus_deficit_kcal: maintenance == null ? Math.round(intake - burned) : Math.round(intake - maintenance),
        protein_g: round1(meal?.protein_g ?? 0),
        carbs_g: round1(meal?.carbs_g ?? 0),
        fat_g: round1(meal?.fat_g ?? 0),
        workout_minutes: workouts.reduce((total, row) => total + durationMinutes(row), 0),
        workout_count: workouts.length,
        meal_count: meal?.meal_count ?? 0,
        weight_kg: weightRow ? round1(weightRow.value_num) : summary == null ? null : round1(summary),
      };
    }),
  };
}

function sum(rows: HealthRow[]): number {
  return rows.reduce((total, row) => total + row.value_num, 0);
}

function latest(rows: HealthRow[]): HealthRow | null {
  return rows.reduce<HealthRow | null>((best, row) => (!best || row.end_time > best.end_time ? row : best), null);
}
