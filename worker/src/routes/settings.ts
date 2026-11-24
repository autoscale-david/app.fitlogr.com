import type { Hono } from "hono";
import { SettingsUpdateSchema } from "@fitlogr/shared";
import { currentAuth, requireAuth } from "../auth/middleware";
import { getSettings, updateSettings } from "../db/settings";
import { nowIso } from "../ids";
import { readJson, requireDb } from "../http";
import type { AppEnv } from "../types";

export function registerSettingsRoutes(app: Hono<AppEnv>): void {
  app.get("/api/settings", requireAuth(), async (c) => {
    return c.json(await getSettings(requireDb(c.env.DB), currentAuth(c.get("auth")).userId));
  });

  app.put("/api/settings", requireAuth(), async (c) => {
    const patch = await readJson(c.req.raw, SettingsUpdateSchema);
    const settings = await updateSettings(requireDb(c.env.DB), currentAuth(c.get("auth")).userId, patch, nowIso(c.get("deps").now()));
    return c.json(settings);
  });
}
