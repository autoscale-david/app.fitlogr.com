import { clampEstimateDays, estimateMaintenance, type EstimateDay, type EstimateWeight, type MaintenanceEstimate } from "@fitlogr/shared";
import { localDateInTimeZone, addIsoDays } from "../review/dates";

interface IntakeRow {
  local_date: string;
  intake: number;
}

interface BurnRow {
  local_date: string;
  record_type: string;
  total: number;
}

interface WeightRow {
  local_date: string;
  kg: number;
}

export async function maintenanceEstimate(db: D1Database, userId: string, requestedDays: number | undefined, now: Date): Promise<MaintenanceEstimate> {
  const daysRequested = clampEstimateDays(requestedDays);
  const settings = await db.prepare("SELECT timezone FROM user_settings WHERE user_id = ?").bind(userId).first<{ timezone: string }>();
  const timezone = settings?.timezone || "UTC";
  const end = localDateInTimeZone(now, timezone);
  const start = addIsoDays(end, -(daysRequested - 1));
  const weightFrom = addIsoDays(start, -1);
  const weightTo = addIsoDays(end, 1);
  const [intake, burn, weights] = await Promise.all([
    db
      .prepare(
        `SELECT local_date, SUM(calories_kcal) AS intake
         FROM meals
         WHERE user_id = ? AND deleted_at IS NULL AND local_date >= ? AND local_date <= ?
         GROUP BY local_date`,
      )
      .bind(userId, start, end)
      .all<IntakeRow>(),
    db
      .prepare(
        `SELECT local_date, record_type, SUM(value_num) AS total
         FROM health_records
         WHERE user_id = ? AND deleted_at IS NULL AND local_date >= ? AND local_date <= ?
           AND record_type IN ('active_calories', 'resting_calories', 'workout')
         GROUP BY local_date, record_type`,
      )
      .bind(userId, start, end)
      .all<BurnRow>(),
    db
      .prepare(
        `SELECT local_date, AVG(value_num) AS kg
         FROM health_records
         WHERE user_id = ? AND deleted_at IS NULL AND record_type = 'weight'
           AND local_date >= ? AND local_date <= ?
         GROUP BY local_date`,
      )
      .bind(userId, weightFrom, weightTo)
      .all<WeightRow>(),
  ]);
  const intakeByDate = new Map(intake.results.map((row) => [row.local_date, row.intake]));
  const active = new Map<string, number>();
  const resting = new Map<string, number>();
  const workouts = new Set<string>();
  for (const row of burn.results) {
    if (row.record_type === "active_calories") active.set(row.local_date, row.total);
    else if (row.record_type === "resting_calories") resting.set(row.local_date, row.total);
    else if (row.record_type === "workout" && row.total > 0) workouts.add(row.local_date);
  }
  const days: EstimateDay[] = [];
  for (let date = start; date <= end; date = addIsoDays(date, 1)) {
    days.push({
      date,
      intakeKcal: intakeByDate.has(date) ? intakeByDate.get(date)! : null,
      activeKcal: active.has(date) ? active.get(date)! : null,
      restingKcal: resting.get(date) ?? 0,
      hasWorkout: workouts.has(date),
    });
  }
  const weightPoints: EstimateWeight[] = weights.results.map((row) => ({ date: row.local_date, kg: row.kg }));
  return estimateMaintenance({ daysRequested, days, weights: weightPoints });
}
