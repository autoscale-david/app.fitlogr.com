import type { Hono } from "hono";
import { AccountDeleteRequestSchema, AccountExportSchema } from "@fitlogr/shared";
import { deleteAccount } from "../account/delete";
import { exportAccount } from "../account/export";
import { currentAuth, requireAuth } from "../auth/middleware";
import { readJson, requireDb } from "../http";
import type { AppEnv } from "../types";

export function registerAccountRoutes(app: Hono<AppEnv>): void {
  app.get("/api/account/export", requireAuth(), async (c) => {
    const body = AccountExportSchema.parse(
      await exportAccount(requireDb(c.env.DB), currentAuth(c.get("auth")).userId, c.get("deps").now()),
    );
    return c.json(body, 200, {
      "content-disposition": 'attachment; filename="fitlogr-export.json"',
    });
  });

  app.delete("/api/account", requireAuth(), async (c) => {
    await readJson(c.req.raw, AccountDeleteRequestSchema);
    const userId = currentAuth(c.get("auth")).userId;
    // Intentionally does not call Google Photos. Album photos stay in the user's library.
    await deleteAccount(requireDb(c.env.DB), userId, c.get("deps").now());
    return c.json({ deleted: true as const, google_photos_preserved: true as const });
  });
}
