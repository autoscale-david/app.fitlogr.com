import type { Hono } from "hono";
import { z } from "zod";
import { TrendsQuerySchema } from "@fitlogr/shared";
import { currentAuth, requireAuth } from "../auth/middleware";
import { ApiError, errorBody, readQuery, requireDb } from "../http";
import { InsightRateLimitError, getDailyInsight } from "../review/insights";
import { reviewTrends } from "../review/trends";
import type { AppEnv } from "../types";

const DayParamSchema = z.iso.date();

export function registerReviewRoutes(app: Hono<AppEnv>): void {
  app.get("/api/insights/:date", requireAuth(), async (c) => {
    const parsed = DayParamSchema.safeParse(c.req.param("date"));
    if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "Date must be YYYY-MM-DD");
    try {
      const insight = await getDailyInsight(
        requireDb(c.env.DB),
        c.env,
        c.get("deps").fetch,
        currentAuth(c.get("auth")).userId,
        parsed.data,
        c.get("deps").now(),
      );
      return c.json(insight);
    } catch (error) {
      if (error instanceof InsightRateLimitError) {
        return c.json(errorBody(error.code, error.message, c.get("requestId")), 429, {
          "retry-after": String(error.retryAfter),
        });
      }
      throw error;
    }
  });

  app.get("/api/review/trends", requireAuth(), async (c) => {
    const query = readQuery({ days: c.req.query("days") }, TrendsQuerySchema);
    const days = Number(query.days ?? "30") as 7 | 14 | 30;
    const trends = await reviewTrends(requireDb(c.env.DB), currentAuth(c.get("auth")).userId, days, c.get("deps").now());
    return c.json(trends);
  });
}
