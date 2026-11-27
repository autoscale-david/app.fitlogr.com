import { openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import {
  addCalendarDays,
  caloriePlanFromApi,
  caloriePlanToApi,
  dailyCalorieExpenditure,
  defaultCaloriePlan,
  parseCaloriePlanJson,
  parseSnapshotJson,
  snapshotForDate,
  type CaloriePlanSettings,
  type DayPlanSnapshot,
  type UnitSystem,
} from "@fitlogr/shared";
import { LB_PER_KG } from "../theme";
import { addDays, atLocalTime, calendarDay, localDateISO } from "./dates";

let openingDatabase: Promise<SQLiteDatabase> | null = null;

/** One shared connection so the engine and the screen use the same database. */
export function openFitlogrDatabase(): Promise<SQLiteDatabase> {
  openingDatabase ??= openDatabaseAsync("fitlogr.db").then(async (database) => {
    await migrate(database);
    return database;
  });
  return openingDatabase;
}

export interface Goals {
  unitSystem: UnitSystem;
  proteinTarget: number;
  carbsTarget: number;
  fatTarget: number;
  /** Maintenance calories live on the plan. */
  plan: CaloriePlanSettings;
}

export interface WeekDayStatus {
  eatenKcal: number;
  burnedKcal: number;
  hasLog: boolean;
  snapshot: DayPlanSnapshot | null;
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
  /** Plan the day was judged against, frozen once the day is in the past. */
  planSnapshot: DayPlanSnapshot | null;
}

export const DEFAULT_MAINTENANCE_KCAL = 1900;

export function defaultGoals(today = localDateISO()): Goals {
  return {
    unitSystem: "imperial",
    proteinTarget: 140,
    carbsTarget: 210,
    fatTarget: 65,
    plan: defaultCaloriePlan(DEFAULT_MAINTENANCE_KCAL, today),
  };
}

/** Past days older than this resolve from the current plan instead of a stored snapshot. */
const SNAPSHOT_WINDOW_DAYS = 400;

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
    CREATE TABLE IF NOT EXISTS day_plans (
      local_date TEXT PRIMARY KEY NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  // Kept so existing installs open. The iPhone app no longer queues album uploads.
  await addColumn(db, "ALTER TABLE local_media_assets ADD COLUMN google_pending INTEGER NOT NULL DEFAULT 0");
  for (const statement of [
    "ALTER TABLE local_media_assets ADD COLUMN capture_date TEXT",
    "ALTER TABLE local_media_assets ADD COLUMN photo_source TEXT",
    "ALTER TABLE local_media_assets ADD COLUMN verdict TEXT",
    "ALTER TABLE local_media_assets ADD COLUMN labels_json TEXT",
    "ALTER TABLE local_media_assets ADD COLUMN classifier_id TEXT",
    "ALTER TABLE local_media_assets ADD COLUMN policy_version TEXT",
    "ALTER TABLE local_media_assets ADD COLUMN classified_at TEXT",
    "ALTER TABLE local_media_assets ADD COLUMN ai_classification TEXT",
    "ALTER TABLE local_media_assets ADD COLUMN ai_confidence REAL",
    "ALTER TABLE local_media_assets ADD COLUMN ai_estimate_json TEXT",
    "ALTER TABLE local_media_assets ADD COLUMN ai_at TEXT",
    "ALTER TABLE local_media_assets ADD COLUMN meal_id TEXT",
    "ALTER TABLE local_media_assets ADD COLUMN thumb_uri TEXT",
    "ALTER TABLE local_media_assets ADD COLUMN last_error TEXT",
  ]) {
    await addColumn(db, statement);
  }
  await db.execAsync("CREATE INDEX IF NOT EXISTS idx_local_media_capture_date ON local_media_assets(capture_date)");
  const seeded = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    "seeded",
  );
  if (!seeded) {
    await seedSample(db);
  }
  if (!(await readSetting(db, "calorie_plan"))) {
    // Migration from base calories: Maintenance every day from today, and past days sealed as Maintenance.
    const migrated = await readGoals(db);
    await sealPlanSnapshots(db, migrated);
    await writeGoals(db, migrated, { seal: false });
  }
  const mode = await readSetting(db, "data_mode");
  if (!mode) await writeSetting(db, "data_mode", "demo");
}

export async function readGoals(db: SQLiteDatabase): Promise<Goals> {
  const rows = await db.getAllAsync<{ key: string; value: string }>("SELECT key, value FROM settings");
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const defaults = defaultGoals();
  const maintenance = numberOr(values.maintenance_kcal, numberOr(values.base_kcal, DEFAULT_MAINTENANCE_KCAL));
  return {
    unitSystem: values.unit_system === "metric" ? "metric" : "imperial",
    proteinTarget: numberOr(values.protein_target, defaults.proteinTarget),
    carbsTarget: numberOr(values.carbs_target, defaults.carbsTarget),
    fatTarget: numberOr(values.fat_target, defaults.fatTarget),
    plan: caloriePlanFromApi(maintenance, parseCaloriePlanJson(values.calorie_plan), localDateISO()),
  };
}

/**
 * Plan changes affect today and later only, so every past day is sealed with the settings that were
 * in effect before a change is written.
 */
export async function writeGoals(db: SQLiteDatabase, goals: Goals, options: { seal: boolean } = { seal: true }): Promise<void> {
  if (options.seal) await sealPlanSnapshots(db, await readGoals(db));
  const entries: [string, string][] = [
    ["unit_system", goals.unitSystem],
    ["maintenance_kcal", String(goals.plan.maintenanceCalories)],
    ["base_kcal", String(goals.plan.maintenanceCalories)],
    ["calorie_plan", JSON.stringify(caloriePlanToApi(goals.plan))],
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
  const day = calendarDay(localDate) || localDate;
  const meals = await db.getAllAsync<MealRecord>(
    `SELECT id, substr(local_date, 1, 10) as localDate, name, eaten_at as eatenAt, calories_kcal as caloriesKcal,
            protein_g as proteinG, carbs_g as carbsG, fat_g as fatG, badge, photo_id as photoId
     FROM meals WHERE substr(local_date, 1, 10) = ? ORDER BY eaten_at`,
    day,
  );
  const workouts = await db.getAllAsync<WorkoutRecord>(
    `SELECT id, substr(local_date, 1, 10) as localDate, name, start_time as startTime, calories_kcal as caloriesKcal,
            duration_min as durationMin, source
     FROM workouts WHERE substr(local_date, 1, 10) = ? ORDER BY start_time`,
    day,
  );
  const weight = await db.getFirstAsync<{ weight_kg: number }>(
    "SELECT weight_kg FROM weights WHERE substr(local_date, 1, 10) <= ? ORDER BY local_date DESC LIMIT 1",
    day,
  );
  const activity = await db.getFirstAsync<{
    active_kcal: number | null;
    resting_kcal: number | null;
    steps: number | null;
    avg_hr: number | null;
  }>("SELECT active_kcal, resting_kcal, steps, avg_hr FROM daily_activity WHERE substr(local_date, 1, 10) = ?", day);
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
    planSnapshot: await readPlanSnapshot(db, day),
  };
}

async function readPlanSnapshot(db: SQLiteDatabase, localDate: string): Promise<DayPlanSnapshot | null> {
  const row = await db.getFirstAsync<{ snapshot_json: string }>("SELECT snapshot_json FROM day_plans WHERE local_date = ?", localDate);
  return parseSnapshotJson(row?.snapshot_json);
}

/** Stores the plan snapshot for every unsealed past day (through yesterday), never overwriting one. */
export async function sealPlanSnapshots(db: SQLiteDatabase, goals: Goals, today = localDateISO()): Promise<void> {
  const yesterday = addCalendarDays(today, -1);
  const sealed = await readSetting(db, "plan_sealed_through");
  let start: string;
  if (sealed) {
    start = addCalendarDays(sealed, 1);
  } else {
    const earliest = await db.getFirstAsync<{ local_date: string | null }>(
      `SELECT MIN(local_date) AS local_date FROM (
         SELECT local_date FROM meals UNION ALL SELECT local_date FROM workouts UNION ALL SELECT local_date FROM daily_activity
       )`,
    );
    start = earliest?.local_date && earliest.local_date < yesterday ? earliest.local_date : yesterday;
  }
  const floor = addCalendarDays(today, -SNAPSHOT_WINDOW_DAYS);
  if (start < floor) start = floor;
  if (start > yesterday) return;
  const createdAt = new Date().toISOString();
  for (let date = start; date <= yesterday; date = addCalendarDays(date, 1)) {
    await db.runAsync(
      "INSERT OR IGNORE INTO day_plans (local_date, snapshot_json, created_at) VALUES (?, ?, ?)",
      date,
      JSON.stringify(snapshotForDate(goals.plan, date)),
      createdAt,
    );
  }
  await writeSetting(db, "plan_sealed_through", yesterday);
}

/** Intake, burn, and stored plan per date for the week strip. "Logged" means at least one meal. */
export async function loadWeekStatus(db: SQLiteDatabase, from: string, to: string): Promise<Record<string, WeekDayStatus>> {
  const meals = await db.getAllAsync<{ local_date: string; eaten: number; n: number }>(
    `SELECT substr(local_date, 1, 10) AS local_date, SUM(calories_kcal) AS eaten, COUNT(*) AS n FROM meals
     WHERE substr(local_date, 1, 10) >= ? AND substr(local_date, 1, 10) <= ? GROUP BY substr(local_date, 1, 10)`,
    from,
    to,
  );
  const workouts = await db.getAllAsync<{ local_date: string; kcal: number }>(
    `SELECT substr(local_date, 1, 10) AS local_date, SUM(calories_kcal) AS kcal FROM workouts
     WHERE substr(local_date, 1, 10) >= ? AND substr(local_date, 1, 10) <= ? GROUP BY substr(local_date, 1, 10)`,
    from,
    to,
  );
  const activity = await db.getAllAsync<{ local_date: string; active_kcal: number | null; resting_kcal: number | null }>(
    "SELECT local_date, active_kcal, resting_kcal FROM daily_activity WHERE local_date >= ? AND local_date <= ?",
    from,
    to,
  );
  const snapshots = await db.getAllAsync<{ local_date: string; snapshot_json: string }>(
    "SELECT local_date, snapshot_json FROM day_plans WHERE local_date >= ? AND local_date <= ?",
    from,
    to,
  );
  const mealBy = new Map(meals.map((row) => [row.local_date, row]));
  const workoutBy = new Map(workouts.map((row) => [row.local_date, row.kcal]));
  const activityBy = new Map(activity.map((row) => [row.local_date, row]));
  const snapshotBy = new Map(snapshots.map((row) => [row.local_date, parseSnapshotJson(row.snapshot_json)]));
  const result: Record<string, WeekDayStatus> = {};
  for (let date = from; date <= to; date = addCalendarDays(date, 1)) {
    const meal = mealBy.get(date);
    const day = activityBy.get(date);
    const energy = dailyCalorieExpenditure({
      activeCaloriesKcal: day ? day.active_kcal : null,
      restingCaloriesKcal: day?.resting_kcal ?? null,
      workoutCaloriesKcal: workoutBy.get(date) ?? 0,
    });
    result[date] = {
      eatenKcal: Math.round(meal?.eaten ?? 0),
      burnedKcal: energy.activeCaloriesKcal,
      hasLog: (meal?.n ?? 0) > 0,
      snapshot: snapshotBy.get(date) ?? null,
    };
  }
  return result;
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
  await db.execAsync("DELETE FROM meals; DELETE FROM workouts; DELETE FROM weights; DELETE FROM daily_activity; DELETE FROM day_plans;");
  await writeSetting(db, "plan_sealed_through", "");
  await seedSample(db);
}

async function seedSample(db: SQLiteDatabase): Promise<void> {
  const today = localDateISO();
  const yesterday = addDays(today, -1);
  await writeGoals(db, defaultGoals(today), { seal: false });

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

/** A meal photo already on this phone: thumbnail, then the compressed file, then the library asset. */
export async function localMealPhoto(
  db: SQLiteDatabase,
  remotePhotoId: string,
): Promise<{ thumbUri: string | null; fileUri: string | null; libraryId: string | null }> {
  const row = await db.getFirstAsync<{ thumb_uri: string | null; uri: string | null; local_asset_id: string }>(
    "SELECT thumb_uri, uri, local_asset_id FROM local_media_assets WHERE remote_photo_id = ? ORDER BY updated_at DESC LIMIT 1",
    remotePhotoId,
  );
  if (!row) return { thumbUri: null, fileUri: null, libraryId: null };
  return {
    thumbUri: row.thumb_uri,
    fileUri: row.uri,
    libraryId: row.local_asset_id.startsWith("ph://") ? row.local_asset_id : null,
  };
}

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
    "DELETE FROM meals; DELETE FROM meal_items; DELETE FROM workouts; DELETE FROM weights; DELETE FROM daily_activity; DELETE FROM health_checkpoints; DELETE FROM sync_outbox; DELETE FROM local_media_assets; DELETE FROM day_plans;",
  );
  await writeSetting(db, "plan_sealed_through", "");
  await writeSetting(db, "data_mode", "account");
  await writeSetting(db, "sync_cursor", "");
  await writeSetting(db, "health_synced_at", "");
  await writeSetting(db, "seeded", "1");
}

export async function enterDemoMode(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(
    "DELETE FROM meals; DELETE FROM meal_items; DELETE FROM workouts; DELETE FROM weights; DELETE FROM daily_activity; DELETE FROM health_checkpoints; DELETE FROM sync_outbox; DELETE FROM local_media_assets; DELETE FROM day_plans;",
  );
  await writeSetting(db, "plan_sealed_through", "");
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
  const day = calendarDay(meal.localDate) || meal.localDate;
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
    day,
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
  const day = calendarDay(meal.localDate) || meal.localDate;
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
    day,
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

/**
 * A weight that came from sync. `sourceRecordId` null means the person typed it in. A manual weight is
 * never replaced by a scale reading for the same day, matching how the server picks the day's weight.
 */
export async function writeSyncedWeight(db: SQLiteDatabase, localDate: string, weightKg: number, sourceRecordId: string | null): Promise<void> {
  if (sourceRecordId === null) {
    await writeWeightKg(db, localDate, weightKg);
    return;
  }
  await db.runAsync(
    `INSERT INTO weights (local_date, weight_kg, source_record_id) VALUES (?, ?, ?)
     ON CONFLICT(local_date) DO UPDATE SET weight_kg = excluded.weight_kg, source_record_id = excluded.source_record_id
     WHERE weights.source_record_id IS NOT NULL`,
    localDate,
    weightKg,
    sourceRecordId,
  );
}

/** Removes the day's weight only if it is the record that was deleted. */
export async function deleteSyncedWeight(db: SQLiteDatabase, localDate: string, sourceRecordId: string | null): Promise<void> {
  if (sourceRecordId === null) {
    await db.runAsync("DELETE FROM weights WHERE local_date = ? AND source_record_id IS NULL", localDate);
    return;
  }
  await db.runAsync("DELETE FROM weights WHERE local_date = ? AND source_record_id = ?", localDate, sourceRecordId);
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
