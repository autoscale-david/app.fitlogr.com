import type { Hono } from "hono";
import { WeightQuerySchema, WeightWriteSchema } from "@fitlogr/shared";
import { currentAuth, requireAuth } from "../auth/middleware";
import { listWeight, upsertWeight } from "../db/health";
import { readJson, readQuery, requireDb } from "../http";
import type { AppEnv } from "../types";

export function registerWeightRoutes(app: Hono<AppEnv>): void {
  app.get("/api/weight", requireAuth(), async (c) => {
    const query = readQuery({ from: c.req.query("from"), to: c.req.query("to") }, WeightQuerySchema);
    const weights = await listWeight(requireDb(c.env.DB), currentAuth(c.get("auth")).userId, query);
    return c.json({ weights });
  });

  app.post("/api/weight", requireAuth(), async (c) => {
    const body = await readJson(c.req.raw, WeightWriteSchema);
    const weight = await upsertWeight(requireDb(c.env.DB), currentAuth(c.get("auth")).userId, body, c.get("deps").now());
    return c.json(weight, 201);
  });
}
