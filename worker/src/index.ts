import { Hono } from "hono";
import type { Env } from "./env";

export const APP_VERSION = "0.1.0";

const app = new Hono<{ Bindings: Env }>();

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

app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: "Not found",
        },
      },
      404,
    );
  }
  return c.text("Not found", 404);
});

export default app;
