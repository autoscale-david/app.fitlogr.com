import { z } from "zod";
import { GoogleConnectionSchema, UserProfileSchema, DeviceSummarySchema } from "./auth";
import { SettingsSchema } from "./settings";

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  db_ok: z.boolean(),
  environment: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ApiErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    request_id: z.string().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

export const MeResponseSchema = z.object({
  user: UserProfileSchema,
  settings: SettingsSchema,
  google: GoogleConnectionSchema,
  devices: z.array(DeviceSummarySchema),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;
