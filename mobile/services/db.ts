import type { SQLiteDatabase } from "expo-sqlite";
import { dailyCalorieExpenditure, type UnitSystem } from "@fitlogr/shared";
import { LB_PER_KG } from "../theme";
import { addDays, atLocalTime, localDateISO } from "./dates";

export interface Goals {
  unitSystem: UnitSystem;
  baseKcal: number;
  proteinTarget: number;
  carbsTarget: number;
  fatTarget: number;
}

export interface MealItemRecord {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  estimatedGrams: number | null;
  caloriesKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  isUserEdited: boolean;
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
  photoId?: string | null;
  items?: MealItemRecord[];
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
  restingBurnedKcal: number;
  steps: number | null;
  heartRateBpm: number | null;
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
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS meal_items (
      id TEXT PRIMARY KEY NOT NULL,
      meal_id TEXT NOT NULL,
      name TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 1,
      unit TEXT NOT NULL DEFAULT 'serving',
      calories_kcal REAL NOT NULL,
      protein_g REAL NOT NULL,
      carbs_g REAL NOT NULL,
      fat_g REAL NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS daily_activity (
      local_date TEXT PRIMARY KEY NOT NULL,
      active_kcal REAL,
      resting_kcal REAL,
      steps INTEGER,
      avg_hr REAL,
      min_hr REAL,
      max_hr REAL,
      resting_hr REAL
    );
    CREATE TABLE IF NOT EXISTS health_checkpoints (
      source TEXT PRIMARY KEY NOT NULL,
      cursor_value TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_outbox (
      id TEXT PRIMARY KEY NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      created_at TEXT NOT NULL
    );
  `);
  for (const statement of [
    "ALTER TABLE meals ADD COLUMN meal_type TEXT NOT NULL DEFAULT 'meal'",
    "ALTER TABLE meals ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'",
    "ALTER TABLE meals ADD COLUMN is_user_edited INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE meals ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE meals ADD COLUMN pending_create INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE meals ADD COLUMN photo_id TEXT",
    "ALTER TABLE meal_items ADD COLUMN estimated_grams REAL",
    "ALTER TABLE meal_items ADD COLUMN is_user_edited INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE weights ADD COLUMN source_record_id TEXT",
  ]) {
    await addColumn(db, statement);
  }
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS local_media_assets (
      local_asset_id TEXT PRIMARY KEY NOT NULL,
      uri TEXT,
      content_sha256 TEXT,
      perceptual_hash TEXT,
      captured_at TEXT,
      scan_status TEXT NOT NULL,
      remote_photo_id TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  const seeded = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    "seeded",
  );
  if (!seeded) {
    await seedSample(db);
  }
  const mode = await readSetting(db, "data_mode");
  if (!mode) await writeSetting(db, "data_mode", "demo");
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
            protein_g as proteinG, carbs_g as carbsG, fat_g as fatG, badge, photo_id as photoId
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
  const activity = await db.getFirstAsync<{
    active_kcal: number | null;
    resting_kcal: number | null;
    steps: number | null;
    avg_hr: number | null;
  }>("SELECT active_kcal, resting_kcal, steps, avg_hr FROM daily_activity WHERE local_date = ?", localDate);
  const workoutKcal = workouts.reduce((sum, workout) => sum + workout.caloriesKcal, 0);
  // A daily active-energy total already includes workout calories. Workouts fill in only when that total is absent.
  const energy = dailyCalorieExpenditure({
    activeCaloriesKcal: activity ? activity.active_kcal : null,
    restingCaloriesKcal: activity?.resting_kcal ?? null,
    workoutCaloriesKcal: workoutKcal,
  });
  return {
    meals,
    workouts,
    weightKg: weight?.weight_kg ?? null,
    eatenKcal: Math.round(meals.reduce((sum, meal) => sum + meal.caloriesKcal, 0)),
    proteinG: Math.round(meals.reduce((sum, meal) => sum + meal.proteinG, 0)),
    carbsG: Math.round(meals.reduce((sum, meal) => sum + meal.carbsG, 0)),
    fatG: Math.round(meals.reduce((sum, meal) => sum + meal.fatG, 0)),
    activeBurnedKcal: energy.activeCaloriesKcal,
    restingBurnedKcal: energy.restingCaloriesKcal,
    steps: activity?.steps ?? null,
    heartRateBpm: activity?.avg_hr ?? null,
  };
}

export async function listWeights(
  db: SQLiteDatabase,
  from: string,
  to: string,
): Promise<{ localDate: string; weightKg: number }[]> {
  return db.getAllAsync<{ localDate: string; weightKg: number }>(
    `SELECT local_date as localDate, weight_kg as weightKg
     FROM weights WHERE local_date >= ? AND local_date <= ? ORDER BY local_date`,
    from,
    to,
  );
}

export async function loggedDates(db: SQLiteDatabase): Promise<string[]> {
  const rows = await db.getAllAsync<{ local_date: string }>(
    `SELECT local_date FROM meals
     UNION SELECT local_date FROM workouts
     UNION SELECT local_date FROM daily_activity
     ORDER BY local_date`,
  );
  return rows.map((row) => row.local_date);
}

export async function restoreSample(db: SQLiteDatabase): Promise<void> {
  await db.execAsync("DELETE FROM meals; DELETE FROM workouts; DELETE FROM weights; DELETE FROM daily_activity;");
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

export type DataMode = "demo" | "account";

export async function readSetting(db: SQLiteDatabase, key: string): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
  return row?.value ?? null;
}

export async function writeSetting(db: SQLiteDatabase, key: string, value: string): Promise<void> {
  await db.runAsync(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    value,
  );
}

export async function readMode(db: SQLiteDatabase): Promise<DataMode> {
  return (await readSetting(db, "data_mode")) === "account" ? "account" : "demo";
}

export async function readAccount(db: SQLiteDatabase): Promise<{ email: string; displayName: string | null } | null> {
  const email = await readSetting(db, "account_email");
  if (!email) return null;
  return { email, displayName: await readSetting(db, "account_display_name") };
}

export async function writeAccount(db: SQLiteDatabase, email: string, displayName: string | null): Promise<void> {
  await writeSetting(db, "account_email", email);
  await writeSetting(db, "account_display_name", displayName ?? "");
}

export async function enterAccountMode(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(
    "DELETE FROM meals; DELETE FROM meal_items; DELETE FROM workouts; DELETE FROM weights; DELETE FROM daily_activity; DELETE FROM health_checkpoints; DELETE FROM sync_outbox; DELETE FROM local_media_assets;",
  );
  await writeSetting(db, "data_mode", "account");
  await writeSetting(db, "sync_cursor", "");
  await writeSetting(db, "health_synced_at", "");
  await writeSetting(db, "seeded", "1");
}

export async function enterDemoMode(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(
    "DELETE FROM meals; DELETE FROM meal_items; DELETE FROM workouts; DELETE FROM weights; DELETE FROM daily_activity; DELETE FROM health_checkpoints; DELETE FROM sync_outbox; DELETE FROM local_media_assets;",
  );
  await writeSetting(db, "health_synced_at", "");
  await writeSetting(db, "account_email", "");
  await writeSetting(db, "account_display_name", "");
  await writeSetting(db, "sync_cursor", "");
  await writeSetting(db, "settings_updated_at", "");
  await seedSample(db);
  await writeSetting(db, "data_mode", "demo");
}

export async function readMeal(db: SQLiteDatabase, id: string): Promise<(MealRecord & { pendingCreate: boolean }) | null> {
  const row = await db.getFirstAsync<MealRecord & { pendingCreate: number }>(
    `SELECT id, local_date as localDate, name, eaten_at as eatenAt, calories_kcal as caloriesKcal,
            protein_g as proteinG, carbs_g as carbsG, fat_g as fatG, badge, photo_id as photoId,
            pending_create as pendingCreate
     FROM meals WHERE id = ?`,
    id,
  );
  if (!row) return null;
  const items = await readMealItems(db, id);
  return { ...row, pendingCreate: Boolean(row.pendingCreate), items };
}

export async function readMealItems(db: SQLiteDatabase, mealId: string): Promise<MealItemRecord[]> {
  const rows = await db.getAllAsync<{
    id: string;
    name: string;
    quantity: number;
    unit: string;
    estimatedGrams: number | null;
    caloriesKcal: number;
    proteinG: number;
    carbsG: number;
    fatG: number;
    isUserEdited: number;
  }>(
    `SELECT id, name, quantity, unit, estimated_grams as estimatedGrams, calories_kcal as caloriesKcal,
            protein_g as proteinG, carbs_g as carbsG, fat_g as fatG, is_user_edited as isUserEdited
     FROM meal_items WHERE meal_id = ? ORDER BY sort_order`,
    mealId,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    quantity: row.quantity,
    unit: row.unit,
    estimatedGrams: row.estimatedGrams,
    caloriesKcal: row.caloriesKcal,
    proteinG: row.proteinG,
    carbsG: row.carbsG,
    fatG: row.fatG,
    isUserEdited: Boolean(row.isUserEdited),
  }));
}

export async function writeMeal(db: SQLiteDatabase, meal: MealRecord, pendingCreate: boolean): Promise<void> {
  const updatedAt = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO meals (
       id, local_date, name, eaten_at, calories_kcal, protein_g, carbs_g, fat_g, badge,
       meal_type, timezone, is_user_edited, updated_at, pending_create
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'meal', 'UTC', 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       local_date = excluded.local_date,
       name = excluded.name,
       eaten_at = excluded.eaten_at,
       calories_kcal = excluded.calories_kcal,
       protein_g = excluded.protein_g,
       carbs_g = excluded.carbs_g,
       fat_g = excluded.fat_g,
       badge = excluded.badge,
       is_user_edited = 1,
       updated_at = excluded.updated_at,
       pending_create = excluded.pending_create`,
    meal.id,
    meal.localDate,
    meal.name,
    meal.eatenAt,
    meal.caloriesKcal,
    meal.proteinG,
    meal.carbsG,
    meal.fatG,
    meal.badge,
    updatedAt,
    pendingCreate ? 1 : 0,
  );
  if (meal.items) await replaceMealItems(db, meal.id, meal.items);
}

export async function writeServerMeal(
  db: SQLiteDatabase,
  meal: MealRecord & { mealType?: string; timezone?: string; isUserEdited?: boolean; updatedAt?: string },
): Promise<void> {
  const updatedAt = meal.updatedAt || new Date().toISOString();
  await db.runAsync(
    `INSERT INTO meals (
       id, local_date, name, eaten_at, calories_kcal, protein_g, carbs_g, fat_g, badge,
       meal_type, timezone, is_user_edited, updated_at, pending_create, photo_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(id) DO UPDATE SET
       local_date = excluded.local_date,
       name = excluded.name,
       eaten_at = excluded.eaten_at,
       calories_kcal = excluded.calories_kcal,
       protein_g = excluded.protein_g,
       carbs_g = excluded.carbs_g,
       fat_g = excluded.fat_g,
       badge = excluded.badge,
       meal_type = excluded.meal_type,
       timezone = excluded.timezone,
       is_user_edited = excluded.is_user_edited,
       updated_at = excluded.updated_at,
       pending_create = 0,
       photo_id = excluded.photo_id`,
    meal.id,
    meal.localDate,
    meal.name,
    meal.eatenAt,
    meal.caloriesKcal,
    meal.proteinG,
    meal.carbsG,
    meal.fatG,
    meal.badge,
    meal.mealType ?? "meal",
    meal.timezone ?? "UTC",
    meal.isUserEdited ? 1 : 0,
    updatedAt,
    meal.photoId ?? null,
  );
  if (meal.items) await replaceMealItems(db, meal.id, meal.items);
}

async function replaceMealItems(db: SQLiteDatabase, mealId: string, items: MealItemRecord[]): Promise<void> {
  await db.runAsync("DELETE FROM meal_items WHERE meal_id = ?", mealId);
  for (const [index, item] of items.entries()) {
    await db.runAsync(
      `INSERT INTO meal_items (
         id, meal_id, name, quantity, unit, estimated_grams, calories_kcal, protein_g, carbs_g, fat_g, sort_order, is_user_edited
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      item.id,
      mealId,
      item.name,
      item.quantity,
      item.unit,
      item.estimatedGrams,
      item.caloriesKcal,
      item.proteinG,
      item.carbsG,
      item.fatG,
      index,
      item.isUserEdited ? 1 : 0,
    );
  }
}

export async function removeMeal(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync("DELETE FROM meal_items WHERE meal_id = ?", id);
  await db.runAsync("DELETE FROM meals WHERE id = ?", id);
}

export async function writeWeightKg(db: SQLiteDatabase, localDate: string, weightKg: number): Promise<void> {
  await db.runAsync(
    "INSERT INTO weights (local_date, weight_kg, source_record_id) VALUES (?, ?, NULL) ON CONFLICT(local_date) DO UPDATE SET weight_kg = excluded.weight_kg, source_record_id = NULL",
    localDate,
    weightKg,
  );
}

export async function pendingChanges(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM sync_outbox");
  return row?.n ?? 0;
}

async function addColumn(db: SQLiteDatabase, sql: string): Promise<void> {
  try {
    await db.execAsync(sql);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/duplicate column/i.test(message)) throw error;
  }
}
