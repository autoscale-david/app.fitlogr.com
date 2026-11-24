import { z } from "zod";

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  db_ok: z.boolean(),
  environment: z.string(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const UnitSystemSchema = z.enum(["metric", "imperial"]);
export type UnitSystem = z.infer<typeof UnitSystemSchema>;
