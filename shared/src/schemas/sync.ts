import { z } from "zod";
import { HealthRecordSchema } from "./health";
import { MealSchema } from "./meals";
import { SettingsSchema } from "./settings";

export const SyncQuerySchema = z.object({
  since: z.string().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
export type SyncQuery = z.infer<typeof SyncQuerySchema>;

export const SyncChangesResponseSchema = z.object({
  cursor: z.string(),
  has_more: z.boolean(),
  settings: SettingsSchema.nullable(),
  meals: z.array(MealSchema),
  health_records: z.array(HealthRecordSchema),
});
export type SyncChangesResponse = z.infer<typeof SyncChangesResponseSchema>;
