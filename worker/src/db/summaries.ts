import { snapshotForWrite } from "../settings/plan";

interface IntakeTotals {
  calories_kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  meal_count: number;
}

/** Keeps a past day's plan snapshot; today and later always take the current plan. */
const SNAPSHOT_ON_CONFLICT = `plan_snapshot_json = CASE
           WHEN daily_summaries.plan_snapshot_json IS NULL OR daily_summaries.local_date >= ? THEN excluded.plan_snapshot_json
           ELSE daily_summaries.plan_snapshot_json
         END`;

export async function recomputeDailyIntake(
  db: D1Database,
  userId: string,
  localDate: string,
  timezone: string,
  now: string,
): Promise<void> {
  const totals = await db
    .prepare(
      `SELECT
         COALESCE(SUM(calories_kcal), 0) AS calories_kcal,
         COALESCE(SUM(protein_g), 0) AS protein_g,
         COALESCE(SUM(carbs_g), 0) AS carbs_g,
         COALESCE(SUM(fat_g), 0) AS fat_g,
         COUNT(*) AS meal_count
       FROM meals
       WHERE user_id = ? AND local_date = ? AND deleted_at IS NULL`,
    )
    .bind(userId, localDate)
    .first<IntakeTotals>();
  const intake = totals ?? { calories_kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, meal_count: 0 };
  const snapshot = await snapshotForWrite(db, userId, localDate, new Date(now));
  await db
    .prepare(
      `INSERT INTO daily_summaries (
         user_id, local_date, timezone, calories_in_kcal, protein_g, carbs_g, fat_g, meal_count,
         calorie_balance_kcal, plan_snapshot_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, local_date) DO UPDATE SET
         timezone = excluded.timezone,
         calories_in_kcal = excluded.calories_in_kcal,
         protein_g = excluded.protein_g,
         carbs_g = excluded.carbs_g,
         fat_g = excluded.fat_g,
         meal_count = excluded.meal_count,
         calorie_balance_kcal = excluded.calories_in_kcal - daily_summaries.total_calories_out_kcal,
         ${SNAPSHOT_ON_CONFLICT},
         updated_at = excluded.updated_at`,
    )
    .bind(
      userId,
      localDate,
      timezone,
      intake.calories_kcal,
      intake.protein_g,
      intake.carbs_g,
      intake.fat_g,
      intake.meal_count,
      intake.calories_kcal,
      snapshot.json,
      now,
      snapshot.today,
    )
    .run();
}

export async function setDailyWeight(db: D1Database, userId: string, localDate: string, timezone: string, weightKg: number, now: string): Promise<void> {
  const snapshot = await snapshotForWrite(db, userId, localDate, new Date(now));
  await db
    .prepare(
      `INSERT INTO daily_summaries (user_id, local_date, timezone, weight_kg, plan_snapshot_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, local_date) DO UPDATE SET
         weight_kg = excluded.weight_kg,
         timezone = excluded.timezone,
         ${SNAPSHOT_ON_CONFLICT},
         updated_at = excluded.updated_at`,
    )
    .bind(userId, localDate, timezone, weightKg, snapshot.json, now, snapshot.today)
    .run();
}
