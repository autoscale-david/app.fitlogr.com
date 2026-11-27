import { parseCaloriePlanJson, type Settings, type SettingsUpdate } from "@fitlogr/shared";
import { ApiError } from "../http";
import { DEFAULT_MAINTENANCE_KCAL, refreshCurrentSnapshots } from "../settings/plan";
import { flag } from "./rows";

interface SettingsRow {
  timezone: string;
  unit_system: "metric" | "imperial";
  target_weight_kg: number | null;
  daily_calorie_target_kcal: number | null;
  daily_calorie_delta_target_kcal: number | null;
  daily_protein_target_g: number | null;
  daily_carbs_target_g: number | null;
  daily_fat_target_g: number | null;
  maintenance_calories_kcal: number | null;
  calorie_plan_json: string | null;
  auto_scan_photos: number;
  wifi_only_uploads: number;
  confirm_before_ai: number;
  photo_scan_since: string | null;
  ai_consent_version: string | null;
  ai_consent_accepted_at: string | null;
  updated_at: string;
}

const COLUMNS = `timezone, unit_system, target_weight_kg, daily_calorie_target_kcal, daily_calorie_delta_target_kcal,
  daily_protein_target_g, daily_carbs_target_g, daily_fat_target_g, maintenance_calories_kcal, calorie_plan_json,
  auto_scan_photos, wifi_only_uploads, confirm_before_ai, photo_scan_since, ai_consent_version, ai_consent_accepted_at, updated_at`;

export async function getSettings(db: D1Database, userId: string): Promise<Settings> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM user_settings WHERE user_id = ?`).bind(userId).first<SettingsRow>();
  if (!row) throw new ApiError(404, "NOT_FOUND", "Settings not found");
  return toSettings(row);
}

export async function updateSettings(db: D1Database, userId: string, patch: SettingsUpdate, now: string): Promise<Settings> {
  const assignments: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown) => {
    assignments.push(`${column} = ?`);
    values.push(value);
  };
  if (patch.timezone !== undefined) set("timezone", patch.timezone);
  if (patch.unit_system !== undefined) set("unit_system", patch.unit_system);
  if (patch.target_weight_kg !== undefined) set("target_weight_kg", patch.target_weight_kg);
  // Maintenance and the legacy base calorie column always hold the same number.
  if (patch.maintenance_calories_kcal !== undefined) {
    set("maintenance_calories_kcal", patch.maintenance_calories_kcal);
    set("daily_calorie_target_kcal", patch.maintenance_calories_kcal);
  } else if (patch.daily_calorie_target_kcal !== undefined) {
    set("daily_calorie_target_kcal", patch.daily_calorie_target_kcal);
    if (patch.daily_calorie_target_kcal !== null) set("maintenance_calories_kcal", patch.daily_calorie_target_kcal);
  }
  if (patch.calorie_plan !== undefined) set("calorie_plan_json", JSON.stringify(patch.calorie_plan));
  if (patch.daily_calorie_delta_target_kcal !== undefined) set("daily_calorie_delta_target_kcal", patch.daily_calorie_delta_target_kcal);
  if (patch.daily_protein_target_g !== undefined) set("daily_protein_target_g", patch.daily_protein_target_g);
  if (patch.daily_carbs_target_g !== undefined) set("daily_carbs_target_g", patch.daily_carbs_target_g);
  if (patch.daily_fat_target_g !== undefined) set("daily_fat_target_g", patch.daily_fat_target_g);
  if (patch.auto_scan_photos !== undefined) set("auto_scan_photos", patch.auto_scan_photos ? 1 : 0);
  if (patch.wifi_only_uploads !== undefined) set("wifi_only_uploads", patch.wifi_only_uploads ? 1 : 0);
  if (patch.confirm_before_ai !== undefined) set("confirm_before_ai", patch.confirm_before_ai ? 1 : 0);
  if (patch.photo_scan_since !== undefined) set("photo_scan_since", patch.photo_scan_since);
  if (patch.ai_consent_version !== undefined) set("ai_consent_version", patch.ai_consent_version);
  if (patch.accept_ai_consent) {
    set("ai_consent_accepted_at", now);
    if (patch.ai_consent_version === undefined) set("ai_consent_version", "1");
  }
  set("updated_at", now);

  const expected = patch.expected_updated_at;
  const where = expected ? "user_id = ? AND updated_at = ?" : "user_id = ?";
  const result = await db
    .prepare(`UPDATE user_settings SET ${assignments.join(", ")} WHERE ${where}`)
    .bind(...values, userId, ...(expected ? [expected] : []))
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    const current = await db.prepare("SELECT updated_at FROM user_settings WHERE user_id = ?").bind(userId).first<{ updated_at: string }>();
    if (!current) throw new ApiError(404, "NOT_FOUND", "Settings not found");
    throw new ApiError(409, "CONFLICT", "Settings were updated on another device");
  }
  const planChanged =
    patch.calorie_plan !== undefined ||
    patch.maintenance_calories_kcal !== undefined ||
    patch.daily_calorie_target_kcal !== undefined ||
    patch.timezone !== undefined;
  if (planChanged) await refreshCurrentSnapshots(db, userId, new Date(now));
  return getSettings(db, userId);
}

export function toSettings(row: SettingsRow): Settings {
  return {
    timezone: row.timezone,
    unit_system: row.unit_system,
    target_weight_kg: row.target_weight_kg,
    daily_calorie_target_kcal: row.daily_calorie_target_kcal,
    daily_calorie_delta_target_kcal: row.daily_calorie_delta_target_kcal,
    daily_protein_target_g: row.daily_protein_target_g,
    daily_carbs_target_g: row.daily_carbs_target_g,
    daily_fat_target_g: row.daily_fat_target_g,
    maintenance_calories_kcal: row.maintenance_calories_kcal ?? row.daily_calorie_target_kcal ?? DEFAULT_MAINTENANCE_KCAL,
    calorie_plan: parseCaloriePlanJson(row.calorie_plan_json),
    auto_scan_photos: flag(row.auto_scan_photos),
    wifi_only_uploads: flag(row.wifi_only_uploads),
    confirm_before_ai: flag(row.confirm_before_ai),
    photo_scan_since: row.photo_scan_since,
    ai_consent_version: row.ai_consent_version,
    ai_consent_accepted_at: row.ai_consent_accepted_at,
    updated_at: row.updated_at,
  };
}

export async function settingsIfChanged(
  db: D1Database,
  userId: string,
  cursor: { t: string; id: string },
): Promise<{ settings: Settings; updated_at: string; id: string } | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM user_settings WHERE user_id = ? AND (updated_at > ? OR (updated_at = ? AND user_id > ?))`)
    .bind(userId, cursor.t, cursor.t, cursor.id)
    .first<SettingsRow>();
  if (!row) return null;
  return { settings: toSettings(row), updated_at: row.updated_at, id: userId };
}
