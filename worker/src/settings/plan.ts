import {
  caloriePlanFromApi,
  effectiveSnapshot,
  parseCaloriePlanJson,
  parseSnapshotJson,
  snapshotForDate,
  type CaloriePlanSettings,
  type DayPlanSnapshot,
} from "@fitlogr/shared";
import { localDateInTimeZone } from "../review/dates";

export const DEFAULT_MAINTENANCE_KCAL = 1900;

export interface UserPlan {
  timezone: string;
  today: string;
  plan: CaloriePlanSettings;
}

export async function loadUserPlan(db: D1Database, userId: string, now: Date): Promise<UserPlan> {
  const row = await db
    .prepare(
      `SELECT timezone, COALESCE(maintenance_calories_kcal, daily_calorie_target_kcal) AS maintenance, calorie_plan_json
       FROM user_settings WHERE user_id = ?`,
    )
    .bind(userId)
    .first<{ timezone: string | null; maintenance: number | null; calorie_plan_json: string | null }>();
  const timezone = row?.timezone || "UTC";
  const today = localDateInTimeZone(now, timezone);
  const plan = caloriePlanFromApi(row?.maintenance ?? DEFAULT_MAINTENANCE_KCAL, parseCaloriePlanJson(row?.calorie_plan_json), today);
  return { timezone, today, plan };
}

/** The snapshot a day is judged against: stored for past days, live for today and later. */
export async function daySnapshot(db: D1Database, userId: string, date: string, now: Date): Promise<DayPlanSnapshot> {
  const user = await loadUserPlan(db, userId, now);
  const stored = await db
    .prepare("SELECT plan_snapshot_json FROM daily_summaries WHERE user_id = ? AND local_date = ?")
    .bind(userId, date)
    .first<{ plan_snapshot_json: string | null }>();
  return effectiveSnapshot(user.plan, date, user.today, parseSnapshotJson(stored?.plan_snapshot_json));
}

/** Snapshot JSON for a summary row write, plus the user's today so frozen days stay frozen. */
export async function snapshotForWrite(db: D1Database, userId: string, date: string, now: Date): Promise<{ json: string; today: string }> {
  const user = await loadUserPlan(db, userId, now);
  return { json: JSON.stringify(snapshotForDate(user.plan, date)), today: user.today };
}

/** After a plan or maintenance change, re-resolve today's and later summary rows; past rows keep their snapshot. */
export async function refreshCurrentSnapshots(db: D1Database, userId: string, now: Date): Promise<void> {
  const user = await loadUserPlan(db, userId, now);
  const rows = await db
    .prepare("SELECT local_date FROM daily_summaries WHERE user_id = ? AND local_date >= ?")
    .bind(userId, user.today)
    .all<{ local_date: string }>();
  for (const row of rows.results) {
    await db
      .prepare("UPDATE daily_summaries SET plan_snapshot_json = ? WHERE user_id = ? AND local_date = ?")
      .bind(JSON.stringify(snapshotForDate(user.plan, row.local_date)), userId, row.local_date)
      .run();
  }
}
