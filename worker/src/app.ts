import { Hono } from "hono";
import { ApiError, errorBody, jsonError } from "./http";
import { registerHealthRoutes } from "./health/routes";
import { registerPhotoRoutes } from "./photos/routes";
import { registerAuthRoutes } from "./routes/auth";
import { registerMealRoutes } from "./routes/meals";
import { registerSettingsRoutes } from "./routes/settings";
import { registerSyncRoutes } from "./routes/sync";
import { registerWeightRoutes } from "./routes/weight";
import type { AppDeps, AppEnv } from "./types";

export const APP_VERSION = "0.1.0";

export function createApp(deps: AppDeps = { fetch: globalThis.fetch.bind(globalThis), now: () => new Date() }): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const started = Date.now();
    c.set("requestId", crypto.randomUUID());
    c.set("deps", deps);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    try {
      await next();
    } finally {
      if (c.req.path.startsWith("/api/")) {
        console.log(
          JSON.stringify({
            request_id: c.get("requestId"),
            method: c.req.method,
            path: c.req.path,
            status: c.res.status,
            ms: Date.now() - started,
          }),
        );
      }
    }
  });

  app.get("/api/health", async (c) => {
    let dbOk = false;
    try {
      const row = await c.env.DB?.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      dbOk = row?.ok === 1;
    } catch {
      dbOk = false;
    }
    return c.json({
      ok: true as const,
      version: APP_VERSION,
      db_ok: dbOk,
      environment: c.env.ENVIRONMENT ?? "development",
    });
  });

  registerAuthRoutes(app);
  registerSettingsRoutes(app);
  registerWeightRoutes(app);
  registerMealRoutes(app);
  registerPhotoRoutes(app);
  registerSyncRoutes(app);
  registerHealthRoutes(app);

  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) {
      return c.json(errorBody("NOT_FOUND", "Not found", c.get("requestId")), 404);
    }
    return c.text("Not found", 404);
  });

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      const payload = jsonError(c.get("requestId"), error);
      return c.json(payload.body, payload.status);
    }
    console.log(JSON.stringify({ request_id: c.get("requestId"), path: c.req.path, status: 500, error: "unhandled" }));
    return c.json(errorBody("INTERNAL_ERROR", "Something went wrong", c.get("requestId")), 500);
  });

  return app;
}

const app = createApp();
export default app;
