import {
  HealthRecordError,
  canonicalizeHealthRecord,
  type HealthSyncRequest,
  type HealthSyncResponse,
} from "@fitlogr/shared";
import { ApiError } from "../http";
import { nowIso, uuidv7 } from "../ids";
import { recomputeHealthDates } from "./aggregate";

/**
 * Upserts a batch of health records. A record that fails a range check is skipped, not the whole batch,
 * so one odd HealthKit sample cannot block every later sync. A re-sent record whose values have not
 * changed is left alone, so the daily totals the phone re-sends each time cost no summary rebuild.
 */
export async function syncHealth(
  db: D1Database,
  userId: string,
  body: HealthSyncRequest,
  now: Date,
  rejected = 0,
): Promise<HealthSyncResponse> {
  await ensureDevice(db, userId, body.device_id, now);
  const stamp = nowIso(now);
  const dates = new Set<string>();
  let skipped = rejected;
  const upserts: D1PreparedStatement[] = [];

  for (const record of body.records) {
    let canonical;
    try {
      canonical = canonicalizeHealthRecord(record);
    } catch (error) {
      if (error instanceof HealthRecordError) {
        skipped += 1;
        continue;
      }
      throw error;
    }
    upserts.push(
      db
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
           WHERE health_records.is_user_edited = 0
             AND (
               (health_records.deleted_at IS NULL) IS NOT (excluded.deleted_at IS NULL)
               OR (
                 excluded.deleted_at IS NULL AND (
                   health_records.value_num IS NOT excluded.value_num
                   OR health_records.unit IS NOT excluded.unit
                   OR health_records.local_date IS NOT excluded.local_date
                   OR health_records.start_time IS NOT excluded.start_time
                   OR health_records.end_time IS NOT excluded.end_time
                   OR health_records.metadata_json IS NOT excluded.metadata_json
                 )
               )
             )
           RETURNING local_date`,
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
        ),
    );
  }

  const checkpoints = body.checkpoints.map((checkpoint) =>
    db
      .prepare(
        `INSERT INTO sync_checkpoints (user_id, device_id, source, cursor_value, last_synced_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, device_id, source) DO UPDATE SET
           cursor_value = excluded.cursor_value,
           last_synced_at = excluded.last_synced_at,
           updated_at = excluded.updated_at`,
      )
      .bind(userId, body.device_id, checkpoint.source, checkpoint.cursor, stamp, stamp),
  );

  let upserted = 0;
  const statements = [...upserts, ...checkpoints];
  if (statements.length > 0) {
    const results = await db.batch<{ local_date: string }>(statements);
    for (const result of results.slice(0, upserts.length)) {
      // RETURNING yields the stored date: for a deletion that is the day the record used to count toward.
      const row = result.results?.[0];
      if (row) {
        upserted += 1;
        dates.add(row.local_date);
      } else skipped += 1;
    }
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
