import type { HealthRecord, WeightQuery, WeightWrite } from "@fitlogr/shared";
import { nowIso, uuidv7 } from "../ids";
import { flag } from "./rows";
import { setDailyWeight } from "./summaries";

interface HealthRow {
  id: string;
  platform: HealthRecord["platform"];
  record_type: HealthRecord["record_type"];
  source_record_id: string;
  start_time: string;
  end_time: string;
  local_date: string;
  timezone: string;
  value_num: number;
  unit: string;
  metadata_json: string | null;
  is_user_edited: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const COLUMNS = `id, platform, record_type, source_record_id, start_time, end_time, local_date, timezone,
  value_num, unit, metadata_json, is_user_edited, created_at, updated_at, deleted_at`;

export async function upsertWeight(db: D1Database, userId: string, input: WeightWrite, now: Date): Promise<HealthRecord> {
  const stamp = nowIso(now);
  const sourceRecordId = input.source_record_id ?? `manual:weight:${input.local_date}`;
  const id = input.id ?? uuidv7(now.getTime());
  await db
    .prepare(
      `INSERT INTO health_records (
         id, user_id, device_id, platform, record_type, source_record_id, source_app_id, source_device_name,
         start_time, end_time, local_date, timezone, value_num, unit, metadata_json, is_user_edited,
         created_at, updated_at, deleted_at
       ) VALUES (?, ?, NULL, 'manual', 'weight', ?, NULL, NULL, ?, ?, ?, ?, ?, 'kg', NULL, 1, ?, ?, NULL)
       ON CONFLICT(user_id, platform, record_type, source_record_id) DO UPDATE SET
         value_num = excluded.value_num,
         start_time = excluded.start_time,
         end_time = excluded.end_time,
         local_date = excluded.local_date,
         timezone = excluded.timezone,
         is_user_edited = 1,
         updated_at = excluded.updated_at,
         deleted_at = NULL`,
    )
    .bind(id, userId, sourceRecordId, input.recorded_at, input.recorded_at, input.local_date, input.timezone, input.weight_kg, stamp, stamp)
    .run();
  await setDailyWeight(db, userId, input.local_date, input.timezone, input.weight_kg, stamp);
  const row = await db
    .prepare(
      `SELECT ${COLUMNS} FROM health_records
       WHERE user_id = ? AND platform = 'manual' AND record_type = 'weight' AND source_record_id = ?`,
    )
    .bind(userId, sourceRecordId)
    .first<HealthRow>();
  if (!row) throw new Error("weight write did not persist");
  return toRecord(row);
}

export async function listWeight(db: D1Database, userId: string, query: WeightQuery): Promise<HealthRecord[]> {
  const result = await db
    .prepare(
      `SELECT ${COLUMNS} FROM health_records
       WHERE user_id = ? AND record_type = 'weight' AND deleted_at IS NULL
         AND (? IS NULL OR local_date >= ?)
         AND (? IS NULL OR local_date <= ?)
       ORDER BY local_date, start_time`,
    )
    .bind(userId, query.from ?? null, query.from ?? null, query.to ?? null, query.to ?? null)
    .all<HealthRow>();
  return result.results.map(toRecord);
}

export async function changedHealth(
  db: D1Database,
  userId: string,
  cursor: { t: string; id: string },
  limit: number,
): Promise<Array<{ record: HealthRecord; updated_at: string; id: string }>> {
  const result = await db
    .prepare(
      `SELECT ${COLUMNS} FROM health_records
       WHERE user_id = ? AND (updated_at > ? OR (updated_at = ? AND id > ?))
       ORDER BY updated_at, id
       LIMIT ?`,
    )
    .bind(userId, cursor.t, cursor.t, cursor.id, limit)
    .all<HealthRow>();
  return result.results.map((row) => ({ record: toRecord(row), updated_at: row.updated_at, id: row.id }));
}

function toRecord(row: HealthRow): HealthRecord {
  return {
    id: row.id,
    platform: row.platform,
    record_type: row.record_type,
    source_record_id: row.source_record_id,
    start_time: row.start_time,
    end_time: row.end_time,
    local_date: row.local_date,
    timezone: row.timezone,
    value_num: row.value_num,
    unit: row.unit,
    metadata_json: row.metadata_json,
    is_user_edited: flag(row.is_user_edited),
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  };
}
