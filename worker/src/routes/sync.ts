import type { Hono } from "hono";
import type { HealthRecord, Meal, Settings } from "@fitlogr/shared";
import { currentAuth, requireAuth } from "../auth/middleware";
import { changedHealth } from "../db/health";
import { changedMeals } from "../db/meals";
import { settingsIfChanged } from "../db/settings";
import { requireDb } from "../http";
import { decodeCursor, encodeCursor, type SyncCursor } from "../sync/cursor";
import type { AppEnv } from "../types";

interface Change {
  updated_at: string;
  id: string;
  settings?: Settings;
  meal?: Meal;
  record?: HealthRecord;
}

export function registerSyncRoutes(app: Hono<AppEnv>): void {
  app.get("/api/sync/changes", requireAuth(), async (c) => {
    const db = requireDb(c.env.DB);
    const userId = currentAuth(c.get("auth")).userId;
    const cursor = decodeCursor(c.req.query("since"));
    const requested = Number(c.req.query("limit") ?? "200");
    const limit = Number.isFinite(requested) ? Math.min(500, Math.max(1, Math.floor(requested))) : 200;
    const [settings, meals, health] = await Promise.all([
      settingsIfChanged(db, userId, cursor),
      changedMeals(db, userId, cursor, limit + 1),
      changedHealth(db, userId, cursor, limit + 1),
    ]);
    const changes: Change[] = [
      ...(settings ? [{ updated_at: settings.updated_at, id: settings.id, settings: settings.settings }] : []),
      ...meals.map((entry) => ({ updated_at: entry.updated_at, id: entry.id, meal: entry.meal })),
      ...health.map((entry) => ({ updated_at: entry.updated_at, id: entry.id, record: entry.record })),
    ].sort(compareChanges);
    const page = changes.slice(0, limit);
    const hasMore = changes.length > limit;
    const next = page.length > 0 ? { t: page[page.length - 1]!.updated_at, id: page[page.length - 1]!.id } : cursor;
    return c.json({
      cursor: encodeCursor(next),
      has_more: hasMore,
      settings: page.find((change) => change.settings)?.settings ?? null,
      meals: page.flatMap((change) => (change.meal ? [change.meal] : [])),
      health_records: page.flatMap((change) => (change.record ? [change.record] : [])),
    });
  });
}

function compareChanges(left: Change, right: Change): number {
  if (left.updated_at === right.updated_at) return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  return left.updated_at < right.updated_at ? -1 : 1;
}

export type { SyncCursor };
