import { z } from "zod";
import { HealthRecordSchema } from "./health";
import { MealSchema } from "./meals";
import { SettingsSchema } from "./settings";

export const DailyInsightSchema = z.object({
  date: z.iso.date(),
  insight: z.string().min(1),
  cached: z.boolean(),
  generated_at: z.iso.datetime(),
  model: z.string().nullable(),
});
export type DailyInsight = z.infer<typeof DailyInsightSchema>;

export const TrendsQuerySchema = z.object({
  days: z.enum(["7", "14", "30"]).optional(),
});
export type TrendsQuery = z.infer<typeof TrendsQuerySchema>;

export const TrendPointSchema = z.object({
  date: z.iso.date(),
  calories_in_kcal: z.number(),
  calories_burned_kcal: z.number(),
  surplus_deficit_kcal: z.number(),
  protein_g: z.number(),
  carbs_g: z.number(),
  fat_g: z.number(),
  workout_minutes: z.number().int(),
  workout_count: z.number().int(),
  meal_count: z.number().int(),
  weight_kg: z.number().nullable(),
});
export type TrendPoint = z.infer<typeof TrendPointSchema>;

export const TrendsResponseSchema = z.object({
  timezone: z.string(),
  days: z.union([z.literal(7), z.literal(14), z.literal(30)]),
  from: z.iso.date(),
  to: z.iso.date(),
  calorie_target_kcal: z.number().nullable(),
  points: z.array(TrendPointSchema),
});
export type TrendsResponse = z.infer<typeof TrendsResponseSchema>;

export const AccountPhotoExportSchema = z.object({
  id: z.string(),
  content_sha256: z.string(),
  perceptual_hash: z.string().nullable(),
  captured_at: z.string(),
  local_date: z.string(),
  timezone: z.string(),
  source: z.string(),
  status: z.string(),
  is_meal: z.boolean(),
  google_media_item_id: z.string().nullable(),
  google_album_id: z.string().nullable(),
  google_status: z.string(),
  duplicate_of_photo_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
});
export type AccountPhotoExport = z.infer<typeof AccountPhotoExportSchema>;

export const AccountSummaryExportSchema = z.object({
  local_date: z.string(),
  timezone: z.string(),
  calories_in_kcal: z.number(),
  protein_g: z.number(),
  carbs_g: z.number(),
  fat_g: z.number(),
  meal_count: z.number().int(),
  active_calories_kcal: z.number(),
  resting_calories_kcal: z.number(),
  total_calories_out_kcal: z.number(),
  calorie_balance_kcal: z.number(),
  steps: z.number().int(),
  workout_count: z.number().int(),
  workout_minutes: z.number().int(),
  weight_kg: z.number().nullable(),
  resting_heart_rate_bpm: z.number().nullable(),
  avg_heart_rate_bpm: z.number().nullable(),
  ai_insight: z.string().nullable(),
  insight_generated_at: z.string().nullable(),
  updated_at: z.string(),
});
export type AccountSummaryExport = z.infer<typeof AccountSummaryExportSchema>;

export const AccountExportSchema = z.object({
  exported_at: z.iso.datetime(),
  profile: z.object({
    id: z.string(),
    email: z.string(),
    display_name: z.string().nullable(),
    avatar_url: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  }),
  settings: SettingsSchema,
  meals: z.array(MealSchema),
  photos: z.array(AccountPhotoExportSchema),
  health_records: z.array(HealthRecordSchema),
  daily_summaries: z.array(AccountSummaryExportSchema),
});
export type AccountExport = z.infer<typeof AccountExportSchema>;

export const AccountDeleteRequestSchema = z.object({
  confirm: z.literal(true),
});
export type AccountDeleteRequest = z.infer<typeof AccountDeleteRequestSchema>;

export const AccountDeleteResponseSchema = z.object({
  deleted: z.literal(true),
  google_photos_preserved: z.literal(true),
});
export type AccountDeleteResponse = z.infer<typeof AccountDeleteResponseSchema>;
