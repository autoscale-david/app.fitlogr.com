import type { Hono } from "hono";
import { MaintenanceQuerySchema, SettingsUpdateSchema } from "@fitlogr/shared";
import { currentAuth, requireAuth } from "../auth/middleware";
import { getSettings, updateSettings } from "../db/settings";
import { nowIso } from "../ids";
import { readJson, readQuery, requireDb } from "../http";
import { maintenanceEstimate } from "../settings/maintenance";
import type { AppEnv } from "../types";

export function registerSettingsRoutes(app: Hono<AppEnv>): void {
  app.get("/api/settings/maintenance-estimate", requireAuth(), async (c) => {
    const query = readQuery({ days: c.req.query("days") }, MaintenanceQuerySchema);
    const estimate = await maintenanceEstimate(
      requireDb(c.env.DB),
      currentAuth(c.get("auth")).userId,
      query.days ? Number(query.days) : undefined,
      c.get("deps").now(),
    );
    return c.json(estimate);
  });

  app.get("/api/settings", requireAuth(), async (c) => {
    return c.json(await getSettings(requireDb(c.env.DB), currentAuth(c.get("auth")).userId));
  });

  app.put("/api/settings", requireAuth(), async (c) => {
    const patch = await readJson(c.req.raw, SettingsUpdateSchema);
    const settings = await updateSettings(requireDb(c.env.DB), currentAuth(c.get("auth")).userId, patch, nowIso(c.get("deps").now()));
    return c.json(settings);
  });
}
