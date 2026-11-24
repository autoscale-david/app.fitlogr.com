import {
  HealthRecordError,
  canonicalizeHealthRecord,
  type HealthSyncRequest,
  type HealthSyncResponse,
} from "@fitlogr/shared";
import { ApiError } from "../http";
import { nowIso, uuidv7 } from "../ids";
import { recomputeHealthDates } from "./aggregate";

export async function syncHealth(db: D1Database, userId: string, body: HealthSyncRequest, now: Date): Promise<HealthSyncResponse> {
  await ensureDevice(db, userId, body.device_id, now);
  const stamp = nowIso(now);
  const dates = new Set<string>();
  let upserted = 0;
  let skipped = 0;

  for (const record of body.records) {
    let canonical;
    try {
      canonical = canonicalizeHealthRecord(record);
    } catch (error) {
      if (error instanceof HealthRecordError) throw new ApiError(400, "VALIDATION_ERROR", error.message);
      throw error;
    }
    const existing = await db
      .prepare(
        `SELECT local_date, is_user_edited FROM health_records
         WHERE user_id = ? AND platform = ? AND record_type = ? AND source_record_id = ?`,
      )
      .bind(userId, canonical.platform, canonical.record_type, canonical.source_record_id)
      .first<{ local_date: string; is_user_edited: number }>();
    if (existing) dates.add(existing.local_date);
    if (!canonical.deleted) dates.add(canonical.local_date);

    const result = await db
      .prepare(
        `INSERT INTO health_records (
           id, user_id, device_id, platform, record_type, source_record_id, source_app_id, source_device_name,
           start_time, end_time, local_date, timezone, value_num, unit, metadata_json, is_user_edited,
           created_at, updated_at, deleted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
         ON CONFLICT(user_id, platform, record_type, source_record_id) DO UPDATE SET
           device_id = excluded.device_id,
           source_app_id = excluded.source_app_id,
           source_device_name = excluded.source_device_name,
           start_time = CASE WHEN excluded.deleted_at IS NULL THEN excluded.start_time ELSE health_records.start_time END,
           end_time = CASE WHEN excluded.deleted_at IS NULL THEN excluded.end_time ELSE health_records.end_time END,
           local_date = CASE WHEN excluded.deleted_at IS NULL THEN excluded.local_date ELSE health_records.local_date END,
           timezone = CASE WHEN excluded.deleted_at IS NULL THEN excluded.timezone ELSE health_records.timezone END,
           value_num = CASE WHEN excluded.deleted_at IS NULL THEN excluded.value_num ELSE health_records.value_num END,
           unit = CASE WHEN excluded.deleted_at IS NULL THEN excluded.unit ELSE health_records.unit END,
           metadata_json = CASE WHEN excluded.deleted_at IS NULL THEN excluded.metadata_json ELSE health_records.metadata_json END,
           updated_at = excluded.updated_at,
           deleted_at = excluded.deleted_at
         WHERE health_records.is_user_edited = 0`,
      )
      .bind(
        uuidv7(now.getTime()),
        userId,
        body.device_id,
        canonical.platform,
        canonical.record_type,
        canonical.source_record_id,
        canonical.source_app_id,
        canonical.source_device_name,
        canonical.start_time,
        canonical.end_time,
        canonical.local_date,
        canonical.timezone,
        canonical.value_num,
        canonical.unit,
        canonical.metadata ? JSON.stringify(canonical.metadata) : null,
        stamp,
        stamp,
        canonical.deleted ? stamp : null,
      )
      .run();
    if ((result.meta.changes ?? 0) > 0) upserted += 1;
    else skipped += 1;
  }

  for (const checkpoint of body.checkpoints) {
    await db
      .prepare(
        `INSERT INTO sync_checkpoints (user_id, device_id, source, cursor_value, last_synced_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, device_id, source) DO UPDATE SET
           cursor_value = excluded.cursor_value,
           last_synced_at = excluded.last_synced_at,
           updated_at = excluded.updated_at`,
      )
      .bind(userId, body.device_id, checkpoint.source, checkpoint.cursor, stamp, stamp)
      .run();
  }

  await recomputeHealthDates(db, userId, dates, stamp);
  return { upserted, skipped, dates: [...dates].sort() };
}

async function ensureDevice(db: D1Database, userId: string, deviceId: string, now: Date): Promise<void> {
  const existing = await db.prepare("SELECT user_id FROM user_devices WHERE id = ?").bind(deviceId).first<{ user_id: string }>();
  if (existing && existing.user_id !== userId) {
    throw new ApiError(400, "VALIDATION_ERROR", "Device is not registered to this account");
  }
  const stamp = nowIso(now);
  if (existing) {
    await db.prepare("UPDATE user_devices SET last_seen_at = ? WHERE id = ? AND user_id = ?").bind(stamp, deviceId, userId).run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO user_devices (id, user_id, platform, device_name, app_version, os_version, last_seen_at, created_at)
       VALUES (?, ?, 'ios', NULL, NULL, NULL, ?, ?)`,
    )
    .bind(deviceId, userId, stamp, stamp)
    .run();
}
