import { z } from "zod";

export const HealthPlatformSchema = z.enum(["healthkit", "health_connect", "manual"]);
export const HealthRecordTypeSchema = z.enum([
  "weight",
  "active_calories",
  "resting_calories",
  "workout",
  "steps",
  "heart_rate_summary",
  "resting_heart_rate",
]);

export const WeightWriteSchema = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,80}$/)
    .optional(),
  weight_kg: z.number().positive().max(500),
  recorded_at: z.iso.datetime(),
  local_date: z.iso.date(),
  timezone: z.string().min(1).max(80),
  source_record_id: z.string().min(1).max(200).optional(),
});
export type WeightWrite = z.infer<typeof WeightWriteSchema>;

export const WeightQuerySchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});
export type WeightQuery = z.infer<typeof WeightQuerySchema>;

export const HealthRecordSchema = z.object({
  id: z.string(),
  platform: HealthPlatformSchema,
  record_type: HealthRecordTypeSchema,
  source_record_id: z.string(),
  start_time: z.string(),
  end_time: z.string(),
  local_date: z.string(),
  timezone: z.string(),
  value_num: z.number(),
  unit: z.string(),
  metadata_json: z.string().nullable(),
  is_user_edited: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
});
export type HealthRecord = z.infer<typeof HealthRecordSchema>;
