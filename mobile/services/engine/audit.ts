import type { SQLiteDatabase } from "expo-sqlite";
import type { PipelineLabel, PipelineRow } from "./pipeline";

interface AuditSqlRow {
  local_asset_id: string;
  captured_at: string | null;
  capture_date: string | null;
  photo_source: string | null;
  scan_status: string;
  verdict: string | null;
  labels_json: string | null;
  classifier_id: string | null;
  policy_version: string | null;
  classified_at: string | null;
  ai_classification: string | null;
  ai_confidence: number | null;
  ai_estimate_json: string | null;
  remote_photo_id: string | null;
  meal_id: string | null;
  last_error: string | null;
  thumb_uri: string | null;
}

const COLUMNS = `local_asset_id, captured_at, capture_date, photo_source, scan_status, verdict, labels_json,
  classifier_id, policy_version, classified_at, ai_classification, ai_confidence, ai_estimate_json,
  remote_photo_id, meal_id, last_error, thumb_uri`;

/** Known rows for these ids, plus anything still queued or failed, in batches of 80. */
export async function loadAuditMap(db: SQLiteDatabase, ids: string[]): Promise<Map<string, PipelineRow>> {
  const map = new Map<string, PipelineRow>();
  for (let start = 0; start < ids.length; start += 80) {
    const chunk = ids.slice(start, start + 80);
    const rows = await db.getAllAsync<AuditSqlRow>(
      `SELECT ${COLUMNS} FROM local_media_assets WHERE local_asset_id IN (${chunk.map(() => "?").join(", ")})`,
      ...chunk,
    );
    for (const row of rows) map.set(row.local_asset_id, toPipeline(row));
  }
  const open = await db.getAllAsync<AuditSqlRow>(
    `SELECT ${COLUMNS} FROM local_media_assets WHERE scan_status IN ('queued', 'error', 'pending')`,
  );
  for (const row of open) map.set(row.local_asset_id, toPipeline(row));
  return map;
}

export async function saveAuditRow(db: SQLiteDatabase, row: PipelineRow, thumbUri?: string | null): Promise<void> {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO local_media_assets (
       local_asset_id, captured_at, capture_date, photo_source, scan_status, verdict, labels_json,
       classifier_id, policy_version, classified_at, ai_classification, ai_confidence, ai_estimate_json,
       remote_photo_id, meal_id, last_error, thumb_uri, google_pending, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(local_asset_id) DO UPDATE SET
       captured_at = excluded.captured_at,
       capture_date = excluded.capture_date,
       photo_source = excluded.photo_source,
       scan_status = excluded.scan_status,
       verdict = excluded.verdict,
       labels_json = excluded.labels_json,
       classifier_id = excluded.classifier_id,
       policy_version = excluded.policy_version,
       classified_at = excluded.classified_at,
       ai_classification = excluded.ai_classification,
       ai_confidence = excluded.ai_confidence,
       ai_estimate_json = excluded.ai_estimate_json,
       remote_photo_id = COALESCE(excluded.remote_photo_id, local_media_assets.remote_photo_id),
       meal_id = COALESCE(excluded.meal_id, local_media_assets.meal_id),
       last_error = excluded.last_error,
       thumb_uri = COALESCE(excluded.thumb_uri, local_media_assets.thumb_uri),
       updated_at = excluded.updated_at`,
    row.id,
    new Date(row.capturedAtMs).toISOString(),
    row.captureDate,
    row.source,
    row.aiState,
    row.verdict,
    JSON.stringify(row.labels),
    row.classifierId,
    row.policyVersion,
    row.classifiedAt,
    row.classification,
    row.confidence,
    row.estimate === null || row.estimate === undefined ? null : JSON.stringify(row.estimate),
    row.remotePhotoId,
    row.mealId,
    row.error,
    thumbUri ?? null,
    now,
  );
}

function toPipeline(row: AuditSqlRow): PipelineRow {
  const capturedAtMs = row.captured_at ? Date.parse(row.captured_at) : 0;
  return {
    id: row.local_asset_id,
    capturedAtMs: Number.isFinite(capturedAtMs) ? capturedAtMs : 0,
    captureDate: row.capture_date ?? "",
    source: row.photo_source === "camera" || row.photo_source === "picker" ? row.photo_source : "library",
    verdict: row.verdict,
    labels: parseLabels(row.labels_json),
    classifierId: row.classifier_id,
    policyVersion: row.policy_version,
    classifiedAt: row.classified_at,
    aiState: toState(row.scan_status),
    classification: row.ai_classification,
    confidence: row.ai_confidence,
    estimate: parseJson(row.ai_estimate_json),
    remotePhotoId: row.remote_photo_id,
    mealId: row.meal_id,
    error: row.last_error,
  };
}

function toState(status: string): PipelineRow["aiState"] {
  if (
    status === "not_sent" ||
    status === "queued" ||
    status === "meal" ||
    status === "workout" ||
    status === "ignore" ||
    status === "duplicate" ||
    status === "excluded" ||
    status === "error" ||
    status === "pending"
  ) {
    return status === "pending" ? "error" : status;
  }
  if (status === "not_meal") return "ignore";
  return "not_sent";
}

function parseLabels(raw: string | null): PipelineLabel[] {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is PipelineLabel => {
    if (!item || typeof item !== "object") return false;
    const label = item as { id?: unknown; confidence?: unknown };
    return typeof label.id === "string" && typeof label.confidence === "number";
  });
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
