import type { AccountExport, HealthRecord, Meal, MealItem } from "@fitlogr/shared";
import { getSettings } from "../db/settings";
import { flag } from "../db/rows";
import { ApiError } from "../http";
import { nowIso } from "../ids";

interface MealRow {
  id: string;
  photo_id: string | null;
  name: string;
  meal_type: Meal["meal_type"];
  eaten_at: string;
  local_date: string;
  timezone: string;
  calories_kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  is_ai_estimate: number;
  is_user_edited: number;
  user_edited_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface ItemRow {
  id: string;
  meal_id: string;
  sort_order: number;
  name: string;
  quantity: number;
  unit: string;
  estimated_grams: number | null;
  calories_kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  is_user_edited: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface PhotoRow {
  id: string;
  content_sha256: string;
  perceptual_hash: string | null;
  captured_at: string;
  local_date: string;
  timezone: string;
  source: string;
  status: string;
  is_meal: number;
  google_media_item_id: string | null;
  google_album_id: string | null;
  google_status: string;
  duplicate_of_photo_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

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

interface SummaryRow {
  local_date: string;
  timezone: string;
  calories_in_kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  meal_count: number;
  active_calories_kcal: number;
  resting_calories_kcal: number;
  total_calories_out_kcal: number;
  calorie_balance_kcal: number;
  steps: number;
  workout_count: number;
  workout_minutes: number;
  weight_kg: number | null;
  resting_heart_rate_bpm: number | null;
  avg_heart_rate_bpm: number | null;
  ai_insight: string | null;
  insight_generated_at: string | null;
  updated_at: string;
}

/**
 * Structured export of the user's fitlogr records.
 * Selects explicit columns so OAuth ciphertext, session hashes, and PKCE payloads cannot leak.
 */
export async function exportAccount(db: D1Database, userId: string, now: Date): Promise<AccountExport> {
  const profile = await db
    .prepare("SELECT id, email, display_name, avatar_url, created_at, updated_at FROM users WHERE id = ?")
    .bind(userId)
    .first<{
      id: string;
      email: string;
      display_name: string | null;
      avatar_url: string | null;
      created_at: string;
      updated_at: string;
    }>();
  if (!profile) throw new ApiError(404, "NOT_FOUND", "Account not found");
  const settings = await getSettings(db, userId);
  const meals = await db
    .prepare(
      `SELECT id, photo_id, name, meal_type, eaten_at, local_date, timezone, calories_kcal, protein_g, carbs_g, fat_g,
              is_ai_estimate, is_user_edited, user_edited_at, created_at, updated_at, deleted_at
       FROM meals WHERE user_id = ? ORDER BY local_date, eaten_at, id`,
    )
    .bind(userId)
    .all<MealRow>();
  const items = await db
    .prepare(
      `SELECT id, meal_id, sort_order, name, quantity, unit, estimated_grams, calories_kcal, protein_g, carbs_g, fat_g,
              is_user_edited, created_at, updated_at, deleted_at
       FROM meal_items WHERE user_id = ? ORDER BY meal_id, sort_order, id`,
    )
    .bind(userId)
    .all<ItemRow>();
  const photos = await db
    .prepare(
      `SELECT id, content_sha256, perceptual_hash, captured_at, local_date, timezone, source, status, is_meal,
              google_media_item_id, google_album_id, google_status, duplicate_of_photo_id, created_at, updated_at, deleted_at
       FROM photos WHERE user_id = ? ORDER BY captured_at, id`,
    )
    .bind(userId)
    .all<PhotoRow>();
  const health = await db
    .prepare(
      `SELECT id, platform, record_type, source_record_id, start_time, end_time, local_date, timezone,
              value_num, unit, metadata_json, is_user_edited, created_at, updated_at, deleted_at
       FROM health_records WHERE user_id = ? ORDER BY local_date, start_time, id`,
    )
    .bind(userId)
    .all<HealthRow>();
  const summaries = await db
    .prepare(
      `SELECT local_date, timezone, calories_in_kcal, protein_g, carbs_g, fat_g, meal_count,
              active_calories_kcal, resting_calories_kcal, total_calories_out_kcal, calorie_balance_kcal,
              steps, workout_count, workout_minutes, weight_kg, resting_heart_rate_bpm, avg_heart_rate_bpm,
              ai_insight, insight_generated_at, updated_at
       FROM daily_summaries WHERE user_id = ? ORDER BY local_date`,
    )
    .bind(userId)
    .all<SummaryRow>();

  const itemsByMeal = new Map<string, MealItem[]>();
  for (const item of items.results) {
    const list = itemsByMeal.get(item.meal_id) ?? [];
    list.push({
      id: item.id,
      meal_id: item.meal_id,
      sort_order: item.sort_order,
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
      estimated_grams: item.estimated_grams,
      calories_kcal: item.calories_kcal,
      protein_g: item.protein_g,
      carbs_g: item.carbs_g,
      fat_g: item.fat_g,
      is_user_edited: flag(item.is_user_edited),
      created_at: item.created_at,
      updated_at: item.updated_at,
      deleted_at: item.deleted_at,
    });
    itemsByMeal.set(item.meal_id, list);
  }

  return {
    exported_at: nowIso(now),
    profile,
    settings,
    meals: meals.results.map((meal) => ({
      id: meal.id,
      name: meal.name,
      meal_type: meal.meal_type,
      eaten_at: meal.eaten_at,
      local_date: meal.local_date,
      timezone: meal.timezone,
      calories_kcal: meal.calories_kcal,
      protein_g: meal.protein_g,
      carbs_g: meal.carbs_g,
      fat_g: meal.fat_g,
      is_ai_estimate: flag(meal.is_ai_estimate),
      is_user_edited: flag(meal.is_user_edited),
      user_edited_at: meal.user_edited_at,
      created_at: meal.created_at,
      updated_at: meal.updated_at,
      deleted_at: meal.deleted_at,
      photo_id: meal.photo_id,
      items: itemsByMeal.get(meal.id) ?? [],
    })),
    photos: photos.results.map((photo) => ({
      id: photo.id,
      content_sha256: photo.content_sha256,
      perceptual_hash: photo.perceptual_hash,
      captured_at: photo.captured_at,
      local_date: photo.local_date,
      timezone: photo.timezone,
      source: photo.source,
      status: photo.status,
      is_meal: flag(photo.is_meal),
      google_media_item_id: photo.google_media_item_id,
      google_album_id: photo.google_album_id,
      google_status: photo.google_status,
      duplicate_of_photo_id: photo.duplicate_of_photo_id,
      created_at: photo.created_at,
      updated_at: photo.updated_at,
      deleted_at: photo.deleted_at,
    })),
    health_records: health.results.map((row) => ({
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
    })),
    daily_summaries: summaries.results,
  };
}
