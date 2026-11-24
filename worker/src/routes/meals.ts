import type { Hono } from "hono";
import { MealPatchSchema, MealWriteSchema, MealsQuerySchema } from "@fitlogr/shared";
import { currentAuth, requireAuth } from "../auth/middleware";
import { deleteMeal, getMeal, listMeals, patchMeal, saveMeal } from "../db/meals";
import { readJson, readQuery, requireDb } from "../http";
import type { AppEnv } from "../types";

export function registerMealRoutes(app: Hono<AppEnv>): void {
  app.get("/api/meals", requireAuth(), async (c) => {
    const query = readQuery({ from: c.req.query("from"), to: c.req.query("to") }, MealsQuerySchema);
    const meals = await listMeals(requireDb(c.env.DB), currentAuth(c.get("auth")).userId, query.from, query.to);
    return c.json({ meals });
  });

  app.post("/api/meals", requireAuth(), async (c) => {
    const body = await readJson(c.req.raw, MealWriteSchema);
    const meal = await saveMeal(requireDb(c.env.DB), currentAuth(c.get("auth")).userId, body, c.get("deps").now());
    return c.json(meal, 201);
  });

  app.get("/api/meals/:id", requireAuth(), async (c) => {
    const meal = await getMeal(requireDb(c.env.DB), currentAuth(c.get("auth")).userId, c.req.param("id"));
    return c.json(meal);
  });

  app.patch("/api/meals/:id", requireAuth(), async (c) => {
    const body = await readJson(c.req.raw, MealPatchSchema);
    const meal = await patchMeal(requireDb(c.env.DB), currentAuth(c.get("auth")).userId, c.req.param("id"), body, c.get("deps").now());
    return c.json(meal);
  });

  app.delete("/api/meals/:id", requireAuth(), async (c) => {
    await deleteMeal(requireDb(c.env.DB), currentAuth(c.get("auth")).userId, c.req.param("id"), c.get("deps").now());
    return c.json({ ok: true as const });
  });
}
