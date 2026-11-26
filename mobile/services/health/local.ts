import type { SQLiteDatabase } from "expo-sqlite";
import type { HealthSyncRecord } from "@fitlogr/shared";
import { writeSyncedWeight } from "../db";

export async function applyHealthRecords(db: SQLiteDatabase, records: HealthSyncRecord[]): Promise<void> {
  if (records.length === 0) return;
  const byDate = new Map<string, HealthSyncRecord[]>();
  for (const record of records) {
    const list = byDate.get(record.local_date) ?? [];
    list.push(record);
    byDate.set(record.local_date, list);
  }
  await db.withTransactionAsync(async () => {
    for (const [localDate, dayRecords] of byDate) {
      await applyDay(db, localDate, dayRecords);
    }
  });
}

async function applyDay(db: SQLiteDatabase, localDate: string, records: HealthSyncRecord[]): Promise<void> {
  for (const record of records) {
    if (record.record_type === "workout" && record.deleted) {
      await db.runAsync("DELETE FROM workouts WHERE id = ?", record.external_id);
    } else if (record.record_type === "weight" && record.deleted) {
      await db.runAsync("DELETE FROM weights WHERE local_date = ? AND source_record_id = ?", localDate, record.external_id);
    }
  }
  const live = records.filter((record) => !record.deleted);
  for (const record of live.filter((entry) => entry.record_type === "workout")) {
    const seconds = record.unit === "min" ? record.value * 60 : record.value;
    const minutes = seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : 0;
    const name = record.metadata?.activity_type ?? "Workout";
    await db.runAsync(
      `INSERT INTO workouts (id, local_date, name, start_time, calories_kcal, duration_min, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         local_date = excluded.local_date,
         name = excluded.name,
         start_time = excluded.start_time,
         calories_kcal = excluded.calories_kcal,
         duration_min = excluded.duration_min,
         source = excluded.source`,
      record.external_id,
      localDate,
      name,
      record.start_time,
      Math.round(record.metadata?.workout_kcal ?? 0),
      minutes,
      record.source_device_name || "Apple Health",
    );
  }
  const weights = live.filter((record) => record.record_type === "weight").sort((a, b) => a.end_time.localeCompare(b.end_time));
  const weight = weights.at(-1);
  if (weight) {
    const kg = weight.unit.toLowerCase() === "lb" ? weight.value / 2.2046226218 : weight.value;
    // A weight typed in by hand for this day stays; the scale reading only fills an empty day.
    await writeSyncedWeight(db, localDate, kg, weight.external_id);
  }
  await writeAggregate(db, localDate, "active_kcal", sum(live, "active_calories"));
  await writeAggregate(db, localDate, "resting_kcal", sum(live, "resting_calories"));
  await writeAggregate(db, localDate, "steps", sum(live, "steps"));
  const heart = latest(live.filter((record) => record.record_type === "heart_rate"));
  if (heart) {
    await writeAggregate(db, localDate, "avg_hr", heart.value);
    await writeAggregate(db, localDate, "min_hr", heart.metadata?.min_bpm ?? null);
    await writeAggregate(db, localDate, "max_hr", heart.metadata?.max_bpm ?? null);
  }
  const restingHeart = latest(live.filter((record) => record.record_type === "resting_heart_rate"));
  if (restingHeart) await writeAggregate(db, localDate, "resting_hr", restingHeart.value);
}

async function writeAggregate(
  db: SQLiteDatabase,
  localDate: string,
  column: "active_kcal" | "resting_kcal" | "steps" | "avg_hr" | "min_hr" | "max_hr" | "resting_hr",
  value: number | null,
): Promise<void> {
  if (value == null) return;
  await db.runAsync(
    `INSERT INTO daily_activity (local_date, ${column}) VALUES (?, ?)
     ON CONFLICT(local_date) DO UPDATE SET ${column} = excluded.${column}`,
    localDate,
    value,
  );
}

function sum(records: HealthSyncRecord[], type: HealthSyncRecord["record_type"]): number | null {
  const matches = records.filter((record) => record.record_type === type);
  if (matches.length === 0) return null;
  return matches.reduce((total, record) => total + record.value, 0);
}

function latest(records: HealthSyncRecord[]): HealthSyncRecord | null {
  return records.reduce<HealthSyncRecord | null>((best, record) => (!best || record.end_time > best.end_time ? record : best), null);
}
