import type { SQLiteDatabase } from "expo-sqlite";

export interface AuditDay {
  date: string;
  photos: number;
  food: number;
  meals: number;
  workouts: number;
}

export type AuditFilter = "all" | "sent" | "meals" | "kept";

export interface AuditEntry {
  id: string;
  capturedAt: string | null;
  captureDate: string;
  verdict: string | null;
  labels: { id: string; confidence: number }[];
  aiState: string;
  classification: string | null;
  confidence: number | null;
  estimate: { name?: string; kcal?: number; items?: { name: string; kcal: number }[]; reason?: string; protein_g?: number; carbs_g?: number; fat_g?: number } | null;
  remotePhotoId: string | null;
  mealId: string | null;
  thumbUri: string | null;
  error: string | null;
  classifiedAt: string | null;
  aiAt: string | null;
}

export async function listAuditDays(db: SQLiteDatabase): Promise<AuditDay[]> {
  const rows = await db.getAllAsync<AuditDay>(
    `SELECT capture_date AS date,
            COUNT(*) AS photos,
            SUM(CASE WHEN verdict IN ('food', 'workout', 'uncertain') THEN 1 ELSE 0 END) AS food,
            SUM(CASE WHEN scan_status = 'meal' THEN 1 ELSE 0 END) AS meals,
            SUM(CASE WHEN scan_status = 'workout' OR ai_classification = 'workout' THEN 1 ELSE 0 END) AS workouts
     FROM local_media_assets
     WHERE capture_date IS NOT NULL AND capture_date != ''
     GROUP BY capture_date
     ORDER BY capture_date DESC`,
  );
  return rows.map((row) => ({
    date: row.date,
    photos: Number(row.photos) || 0,
    food: Number(row.food) || 0,
    meals: Number(row.meals) || 0,
    workouts: Number(row.workouts) || 0,
  }));
}

export async function listAuditEntries(db: SQLiteDatabase, date: string, filter: AuditFilter): Promise<AuditEntry[]> {
  const where =
    filter === "meals"
      ? "AND scan_status = 'meal'"
      : filter === "sent"
        ? "AND scan_status NOT IN ('not_sent', 'screenshot') AND IFNULL(verdict, '') NOT IN ('screenshot', 'unreadable', 'not_relevant')"
        : filter === "kept"
          ? "AND (scan_status = 'not_sent' OR verdict IN ('not_relevant', 'screenshot', 'unreadable'))"
          : "";
  const rows = await db.getAllAsync<{
    local_asset_id: string;
    captured_at: string | null;
    capture_date: string;
    verdict: string | null;
    labels_json: string | null;
    scan_status: string;
    ai_classification: string | null;
    ai_confidence: number | null;
    ai_estimate_json: string | null;
    remote_photo_id: string | null;
    meal_id: string | null;
    thumb_uri: string | null;
    last_error: string | null;
    classified_at: string | null;
    ai_at: string | null;
  }>(
    `SELECT local_asset_id, captured_at, capture_date, verdict, labels_json, scan_status, ai_classification,
            ai_confidence, ai_estimate_json, remote_photo_id, meal_id, thumb_uri, last_error, classified_at, ai_at
     FROM local_media_assets
     WHERE capture_date = ? ${where}
     ORDER BY captured_at DESC`,
    date,
  );
  return rows.map((row) => ({
    id: row.local_asset_id,
    capturedAt: row.captured_at,
    captureDate: row.capture_date,
    verdict: row.verdict,
    labels: parseLabels(row.labels_json),
    aiState: row.scan_status,
    classification: row.ai_classification,
    confidence: row.ai_confidence,
    estimate: parseEstimate(row.ai_estimate_json),
    remotePhotoId: row.remote_photo_id,
    mealId: row.meal_id,
    thumbUri: row.thumb_uri,
    error: row.last_error,
    classifiedAt: row.classified_at,
    aiAt: row.ai_at,
  }));
}

function parseLabels(raw: string | null): { id: string; confidence: number }[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is { id: string; confidence: number } => {
      if (!item || typeof item !== "object") return false;
      const label = item as { id?: unknown; confidence?: unknown };
      return typeof label.id === "string" && typeof label.confidence === "number";
    });
  } catch {
    return [];
  }
}

function parseEstimate(raw: string | null): AuditEntry["estimate"] {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuditEntry["estimate"];
  } catch {
    return null;
  }
}
