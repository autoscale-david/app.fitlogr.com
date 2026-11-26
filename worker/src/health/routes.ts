import type { Hono } from "hono";
import { HealthSyncRecordSchema, HealthSyncRequestSchema, type HealthSyncRecord } from "@fitlogr/shared";
import { z } from "zod";
import { currentAuth, requireAuth } from "../auth/middleware";
import { ApiError, readJson, requireDb } from "../http";
import { buildDay } from "./day";
import { syncHealth } from "./sync";
import type { AppEnv } from "../types";

const DayParamSchema = z.iso.date();

/** Same envelope as HealthSyncRequestSchema, but records are checked one at a time. */
const HealthSyncEnvelopeSchema = z.object({
  device_id: HealthSyncRequestSchema.shape.device_id,
  records: z.array(z.unknown()).max(250),
  checkpoints: HealthSyncRequestSchema.shape.checkpoints,
});

export function registerHealthRoutes(app: Hono<AppEnv>): void {
  app.post("/api/health/sync", requireAuth(), async (c) => {
    const body = await readJson(c.req.raw, HealthSyncEnvelopeSchema);
    // An invalid record is skipped instead of failing the batch; otherwise the phone would resend it forever.
    const records: HealthSyncRecord[] = [];
    let rejected = 0;
    for (const raw of body.records) {
      const parsed = HealthSyncRecordSchema.safeParse(raw);
      if (parsed.success) records.push(parsed.data);
      else rejected += 1;
    }
    const result = await syncHealth(
      requireDb(c.env.DB),
      currentAuth(c.get("auth")).userId,
      { device_id: body.device_id, records, checkpoints: body.checkpoints },
      c.get("deps").now(),
      rejected,
    );
    return c.json(result);
  });

  app.get("/api/days/:date", requireAuth(), async (c) => {
    const parsed = DayParamSchema.safeParse(c.req.param("date"));
    if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "Date must be YYYY-MM-DD");
    const day = await buildDay(requireDb(c.env.DB), currentAuth(c.get("auth")).userId, parsed.data, c.get("deps").now());
    return c.json(day);
  });
}
