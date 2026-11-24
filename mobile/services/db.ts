import type { SQLiteDatabase } from "expo-sqlite";
import type { UnitSystem } from "@fitlogr/shared";
import { LB_PER_KG } from "../theme";
import { addDays, atLocalTime, localDateISO } from "./dates";

export interface Goals {
  unitSystem: UnitSystem;
  baseKcal: number;
  proteinTarget: number;
  carbsTarget: number;
  fatTarget: number;
}

export interface MealRecord {
  id: string;
  localDate: string;
  name: string;
  eatenAt: string;
  caloriesKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  badge: "ai" | "edited";
}

export interface WorkoutRecord {
  id: string;
  localDate: string;
  name: string;
  startTime: string;
  caloriesKcal: number;
  durationMin: number;
  source: string;
}

export interface DayLog {
  meals: MealRecord[];
  workouts: WorkoutRecord[];
  weightKg: number | null;
  eatenKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  activeBurnedKcal: number;
}

export const DEFAULT_GOALS: Goals = {
  unitSystem: "imperial",
  baseKcal: 1900,
  proteinTarget: 140,
  carbsTarget: 210,
  fatTarget: 65,
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meals (
  id TEXT PRIMARY KEY NOT NULL,
  local_date TEXT NOT NULL,
  name TEXT NOT NULL,
  eaten_at TEXT NOT NULL,
  calories_kcal REAL NOT NULL,
  protein_g REAL NOT NULL,
  carbs_g REAL NOT NULL,
  fat_g REAL NOT NULL,
  badge TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workouts (
  id TEXT PRIMARY KEY NOT NULL,
  local_date TEXT NOT NULL,
  name TEXT NOT NULL,
  start_time TEXT NOT NULL,
  calories_kcal REAL NOT NULL,
  duration_min INTEGER NOT NULL,
  source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS weights (
  local_date TEXT PRIMARY KEY NOT NULL,
  weight_kg REAL NOT NULL
);
`;

export async function migrate(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(SCHEMA);
  const seeded = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    "seeded",
  );
  if (!seeded) {
    await seedSample(db);
  }
}

export async function readGoals(db: SQLiteDatabase): Promise<Goals> {
  const rows = await db.getAllAsync<{ key: string; value: string }>("SELECT key, value FROM settings");
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return {
    unitSystem: values.unit_system === "metric" ? "metric" : "imperial",
    baseKcal: numberOr(values.base_kcal, DEFAULT_GOALS.baseKcal),
    proteinTarget: numberOr(values.protein_target, DEFAULT_GOALS.proteinTarget),
    carbsTarget: numberOr(values.carbs_target, DEFAULT_GOALS.carbsTarget),
    fatTarget: numberOr(values.fat_target, DEFAULT_GOALS.fatTarget),
  };
}

export async function writeGoals(db: SQLiteDatabase, goals: Goals): Promise<void> {
  const entries: [string, string][] = [
    ["unit_system", goals.unitSystem],
    ["base_kcal", String(goals.baseKcal)],
    ["protein_target", String(goals.proteinTarget)],
    ["carbs_target", String(goals.carbsTarget)],
    ["fat_target", String(goals.fatTarget)],
  ];
  for (const [key, value] of entries) {
    await db.runAsync(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }
}

export async function loadDay(db: SQLiteDatabase, localDate: string): Promise<DayLog> {
  const meals = await db.getAllAsync<MealRecord>(
    `SELECT id, local_date as localDate, name, eaten_at as eatenAt, calories_kcal as caloriesKcal,
            protein_g as proteinG, carbs_g as carbsG, fat_g as fatG, badge
     FROM meals WHERE local_date = ? ORDER BY eaten_at`,
    localDate,
  );
  const workouts = await db.getAllAsync<WorkoutRecord>(
    `SELECT id, local_date as localDate, name, start_time as startTime, calories_kcal as caloriesKcal,
            duration_min as durationMin, source
     FROM workouts WHERE local_date = ? ORDER BY start_time`,
    localDate,
  );
  const weight = await db.getFirstAsync<{ weight_kg: number }>(
    "SELECT weight_kg FROM weights WHERE local_date <= ? ORDER BY local_date DESC LIMIT 1",
    localDate,
  );

  // Workout calories stand in for the day's active burn until HealthKit /
  // Health Connect daily totals arrive. They are not added a second time.
  const activeBurnedKcal = Math.round(workouts.reduce((sum, workout) => sum + workout.caloriesKcal, 0));
  return {
    meals,
    workouts,
    weightKg: weight?.weight_kg ?? null,
    eatenKcal: Math.round(meals.reduce((sum, meal) => sum + meal.caloriesKcal, 0)),
    proteinG: Math.round(meals.reduce((sum, meal) => sum + meal.proteinG, 0)),
    carbsG: Math.round(meals.reduce((sum, meal) => sum + meal.carbsG, 0)),
    fatG: Math.round(meals.reduce((sum, meal) => sum + meal.fatG, 0)),
    activeBurnedKcal,
  };
}

export async function loggedDates(db: SQLiteDatabase): Promise<string[]> {
  const rows = await db.getAllAsync<{ local_date: string }>(
    `SELECT local_date FROM meals
     UNION SELECT local_date FROM workouts
     ORDER BY local_date`,
  );
  return rows.map((row) => row.local_date);
}

export async function restoreSample(db: SQLiteDatabase): Promise<void> {
  await db.execAsync("DELETE FROM meals; DELETE FROM workouts; DELETE FROM weights;");
  await seedSample(db);
}

async function seedSample(db: SQLiteDatabase): Promise<void> {
  const today = localDateISO();
  const yesterday = addDays(today, -1);
  await writeGoals(db, DEFAULT_GOALS);

  const meals: MealRecord[] = [
    meal("avocado", today, "Avocado Toast & Eggs", 8, 14, 410, 18, 36, 22, "ai"),
    meal("chicken", today, "Chicken & Rice Bowl", 13, 15, 620, 54, 78, 16, "edited"),
    meal("shake", today, "Protein Shake", 15, 40, 470, 40, 31, 14, "ai"),
    meal("oats", yesterday, "Oatmeal & Berries", 9, 5, 540, 18, 82, 12, "ai"),
  ];
  for (const item of meals) {
    await db.runAsync(
      `INSERT INTO meals (id, local_date, name, eaten_at, calories_kcal, protein_g, carbs_g, fat_g, badge)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      item.id,
      item.localDate,
      item.name,
      item.eatenAt,
      item.caloriesKcal,
      item.proteinG,
      item.carbsG,
      item.fatG,
      item.badge,
    );
  }

  await db.runAsync(
    `INSERT INTO workouts (id, local_date, name, start_time, calories_kcal, duration_min, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    "run-today",
    today,
    "Outdoor Run",
    atLocalTime(today, 12, 30),
    391,
    35,
    "Apple Health",
  );

  await db.runAsync(
    "INSERT INTO weights (local_date, weight_kg) VALUES (?, ?)",
    yesterday,
    174.6 / LB_PER_KG,
  );
  await db.runAsync(
    "INSERT INTO weights (local_date, weight_kg) VALUES (?, ?)",
    today,
    174.2 / LB_PER_KG,
  );
  await db.runAsync(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    "seeded",
    "1",
  );
}

function meal(
  id: string,
  localDate: string,
  name: string,
  hours: number,
  minutes: number,
  caloriesKcal: number,
  proteinG: number,
  carbsG: number,
  fatG: number,
  badge: "ai" | "edited",
): MealRecord {
  return {
    id,
    localDate,
    name,
    eatenAt: atLocalTime(localDate, hours, minutes),
    caloriesKcal,
    proteinG,
    carbsG,
    fatG,
    badge,
  };
}

function numberOr(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
