import type { Hono } from "hono";
import { HealthSyncRequestSchema } from "@fitlogr/shared";
import { z } from "zod";
import { currentAuth, requireAuth } from "../auth/middleware";
import { ApiError, readJson, requireDb } from "../http";
import { buildDay } from "./day";
import { syncHealth } from "./sync";
import type { AppEnv } from "../types";

const DayParamSchema = z.iso.date();

export function registerHealthRoutes(app: Hono<AppEnv>): void {
  app.post("/api/health/sync", requireAuth(), async (c) => {
    const body = await readJson(c.req.raw, HealthSyncRequestSchema);
    const result = await syncHealth(requireDb(c.env.DB), currentAuth(c.get("auth")).userId, body, c.get("deps").now());
    return c.json(result);
  });

  app.get("/api/days/:date", requireAuth(), async (c) => {
    const parsed = DayParamSchema.safeParse(c.req.param("date"));
    if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "Date must be YYYY-MM-DD");
    const day = await buildDay(requireDb(c.env.DB), currentAuth(c.get("auth")).userId, parsed.data, c.get("deps").now());
    return c.json(day);
  });
}
