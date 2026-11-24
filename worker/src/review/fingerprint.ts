import { round1 } from "@fitlogr/shared";
import { sha256Hex } from "../encoding";
import { activityName, durationMinutes, workoutKcal } from "../health/aggregate";

export interface InsightSnapshot {
  date: string;
  goals: {
    daily_calorie_target_kcal: number | null;
    daily_calorie_delta_target_kcal: number | null;
    daily_protein_target_g: number | null;
    daily_carbs_target_g: number | null;
    daily_fat_target_g: number | null;
    target_weight_kg: number | null;
  };
  meals: Array<{
    id: string;
    name: string;
    calories_kcal: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    items: Array<{
      id: string;
      name: string;
      quantity: number;
      calories_kcal: number;
      protein_g: number;
      carbs_g: number;
      fat_g: number;
    }>;
  }>;
  macros: {
    calories_kcal: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
  };
  workouts: Array<{
    id: string;
    activity: string;
    duration_min: number;
    calories_kcal: number;
  }>;
  active_calories_kcal: number;
  resting_calories_kcal: number;
  weight_kg: number | null;
}

interface MealRow {
  id: string;
  name: string;
  calories_kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

interface ItemRow {
  id: string;
  meal_id: string;
  name: string;
  quantity: number;
  calories_kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

interface HealthRow {
  id: string;
  record_type: string;
  value_num: number;
  unit: string;
  metadata_json: string | null;
  end_time: string;
}

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    return JSON.stringify(Math.round(value * 1000) / 1000);
  }
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return "null";
}

export async function hashInsightSnapshot(snapshot: InsightSnapshot): Promise<string> {
  return sha256Hex(canonicalJson(snapshot));
}

export async function loadInsightSnapshot(db: D1Database, userId: string, date: string): Promise<InsightSnapshot> {
  const goals = await db
    .prepare(
      `SELECT daily_calorie_target_kcal, daily_calorie_delta_target_kcal, daily_protein_target_g,
              daily_carbs_target_g, daily_fat_target_g, target_weight_kg
       FROM user_settings WHERE user_id = ?`,
    )
    .bind(userId)
    .first<{
      daily_calorie_target_kcal: number | null;
      daily_calorie_delta_target_kcal: number | null;
      daily_protein_target_g: number | null;
      daily_carbs_target_g: number | null;
      daily_fat_target_g: number | null;
      target_weight_kg: number | null;
    }>();
  const meals = await db
    .prepare(
      `SELECT id, name, calories_kcal, protein_g, carbs_g, fat_g
       FROM meals
       WHERE user_id = ? AND local_date = ? AND deleted_at IS NULL
       ORDER BY id`,
    )
    .bind(userId, date)
    .all<MealRow>();
  const items = meals.results.length
    ? await db
        .prepare(
          `SELECT id, meal_id, name, quantity, calories_kcal, protein_g, carbs_g, fat_g
           FROM meal_items
           WHERE user_id = ? AND deleted_at IS NULL AND meal_id IN (${meals.results.map(() => "?").join(", ")})
           ORDER BY id`,
        )
        .bind(userId, ...meals.results.map((meal) => meal.id))
        .all<ItemRow>()
    : { results: [] as ItemRow[] };
  const health = await db
    .prepare(
      `SELECT id, record_type, value_num, unit, metadata_json, end_time
       FROM health_records
       WHERE user_id = ? AND local_date = ? AND deleted_at IS NULL
       ORDER BY id`,
    )
    .bind(userId, date)
    .all<HealthRow>();
  const summaryWeight = await db
    .prepare("SELECT weight_kg FROM daily_summaries WHERE user_id = ? AND local_date = ?")
    .bind(userId, date)
    .first<{ weight_kg: number | null }>();

  const itemsByMeal = new Map<string, ItemRow[]>();
  for (const item of items.results) {
    const list = itemsByMeal.get(item.meal_id) ?? [];
    list.push(item);
    itemsByMeal.set(item.meal_id, list);
  }
  const mealSnapshots = meals.results.map((meal) => ({
    id: meal.id,
    name: meal.name,
    calories_kcal: round1(meal.calories_kcal),
    protein_g: round1(meal.protein_g),
    carbs_g: round1(meal.carbs_g),
    fat_g: round1(meal.fat_g),
    items: (itemsByMeal.get(meal.id) ?? [])
      .slice()
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map((item) => ({
        id: item.id,
        name: item.name,
        quantity: round1(item.quantity),
        calories_kcal: round1(item.calories_kcal),
        protein_g: round1(item.protein_g),
        carbs_g: round1(item.carbs_g),
        fat_g: round1(item.fat_g),
      })),
  }));
  const rows = health.results;
  const weight = latest(rows.filter((row) => row.record_type === "weight"));
  return {
    date,
    goals: {
      daily_calorie_target_kcal: goals?.daily_calorie_target_kcal ?? null,
      daily_calorie_delta_target_kcal: goals?.daily_calorie_delta_target_kcal ?? null,
      daily_protein_target_g: goals?.daily_protein_target_g ?? null,
      daily_carbs_target_g: goals?.daily_carbs_target_g ?? null,
      daily_fat_target_g: goals?.daily_fat_target_g ?? null,
      target_weight_kg: goals?.target_weight_kg ?? null,
    },
    meals: mealSnapshots,
    macros: {
      calories_kcal: round1(mealSnapshots.reduce((sum, meal) => sum + meal.calories_kcal, 0)),
      protein_g: round1(mealSnapshots.reduce((sum, meal) => sum + meal.protein_g, 0)),
      carbs_g: round1(mealSnapshots.reduce((sum, meal) => sum + meal.carbs_g, 0)),
      fat_g: round1(mealSnapshots.reduce((sum, meal) => sum + meal.fat_g, 0)),
    },
    workouts: rows
      .filter((row) => row.record_type === "workout")
      .map((row) => ({
        id: row.id,
        activity: activityName({ metadata_json: row.metadata_json, source_device_name: null }).activity,
        duration_min: durationMinutes(row),
        calories_kcal: Math.round(workoutKcal(row)),
      }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    active_calories_kcal: Math.round(sum(rows.filter((row) => row.record_type === "active_calories"))),
    resting_calories_kcal: Math.round(sum(rows.filter((row) => row.record_type === "resting_calories"))),
    weight_kg: weight ? round1(weight.value_num) : summaryWeight?.weight_kg == null ? null : round1(summaryWeight.weight_kg),
  };
}

function sum(rows: HealthRow[]): number {
  return rows.reduce((total, row) => total + row.value_num, 0);
}

function latest(rows: HealthRow[]): HealthRow | null {
  return rows.reduce<HealthRow | null>((best, row) => (!best || row.end_time > best.end_time ? row : best), null);
}
