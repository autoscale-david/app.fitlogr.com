import { z } from "zod";
import { CaloriePlanApiSchema, MaintenanceCaloriesSchema } from "../caloriePlan";
import { UnitSystemSchema } from "./auth-units";

export const SettingsSchema = z.object({
  timezone: z.string(),
  unit_system: UnitSystemSchema,
  target_weight_kg: z.number().nullable(),
  daily_calorie_target_kcal: z.number().int().nullable(),
  daily_calorie_delta_target_kcal: z.number().int().nullable(),
  daily_protein_target_g: z.number().int().nullable(),
  daily_carbs_target_g: z.number().int().nullable(),
  daily_fat_target_g: z.number().int().nullable(),
  maintenance_calories_kcal: z.number().int(),
  /** Null until the user first saves a plan; clients then use Maintenance every day. */
  calorie_plan: CaloriePlanApiSchema.nullable(),
  auto_scan_photos: z.boolean(),
  wifi_only_uploads: z.boolean(),
  confirm_before_ai: z.boolean(),
  photo_scan_since: z.string().nullable(),
  ai_consent_version: z.string().nullable(),
  ai_consent_accepted_at: z.string().nullable(),
  updated_at: z.string(),
});
export type Settings = z.infer<typeof SettingsSchema>;

const optionalInt = z.number().int().min(0).max(20000).nullable();

export const SettingsUpdateSchema = z
  .object({
    timezone: z.string().min(1).max(80).optional(),
    unit_system: UnitSystemSchema.optional(),
    target_weight_kg: z.number().positive().max(500).nullable().optional(),
    /** Legacy base calories; mirrored into maintenance_calories_kcal for older app builds. */
    daily_calorie_target_kcal: optionalInt.optional(),
    daily_calorie_delta_target_kcal: z.number().int().min(-10000).max(10000).nullable().optional(),
    daily_protein_target_g: z.number().int().min(0).max(2000).nullable().optional(),
    daily_carbs_target_g: z.number().int().min(0).max(2000).nullable().optional(),
    daily_fat_target_g: z.number().int().min(0).max(2000).nullable().optional(),
    maintenance_calories_kcal: MaintenanceCaloriesSchema.optional(),
    calorie_plan: CaloriePlanApiSchema.optional(),
    auto_scan_photos: z.boolean().optional(),
    wifi_only_uploads: z.boolean().optional(),
    confirm_before_ai: z.boolean().optional(),
    photo_scan_since: z.iso.datetime().nullable().optional(),
    ai_consent_version: z.string().min(1).max(40).nullable().optional(),
    accept_ai_consent: z.boolean().optional(),
    expected_updated_at: z.iso.datetime().optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== "expected_updated_at"), {
    message: "No settings to update",
  });
export type SettingsUpdate = z.infer<typeof SettingsUpdateSchema>;
