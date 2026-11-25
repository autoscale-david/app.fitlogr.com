import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { caloriePlanToApi, caloriesRemaining, defaultCaloriePlan, parseSnapshotJson, type CaloriePlanSettings } from "@fitlogr/shared";
import { createApp } from "../app";
import { issueSession } from "../auth/sessions";
import { createTestDb } from "../test/d1";

const SESSION_SECRET = "plan-session-secret-with-enough-entropy";
const MONDAY_NOON = new Date("2026-11-23T20:00:00.000Z");
const TUESDAY_NOON = new Date("2026-11-24T20:00:00.000Z");
const migrations = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");

let database: D1Database;
let clock = TUESDAY_NOON;
const app = createApp({ fetch: () => Promise.resolve(new Response("unexpected", { status: 500 })), now: () => clock });

beforeEach(() => {
  database = createTestDb();
  clock = TUESDAY_NOON;
});

function weeklyPlan(startDate: string): CaloriePlanSettings {
  return {
    ...defaultCaloriePlan(1900, startDate),
    planType: "weekly",
    weeklyPlan: {
      startDate,
      endDate: null,
      days: {
        mon: { type: "deficit", amount: 500 },
        tue: { type: "deficit", amount: 500 },
        wed: { type: "fast" },
        thu: { type: "surplus", amount: 500 },
        fri: { type: "maintain" },
        sat: { type: "maintain" },
        sun: { type: "surplus", amount: 500 },
      },
    },
  };
}

describe("D1 migration 0002", () => {
  it("copies existing base calories into maintenance and leaves the plan unset", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(readFileSync(join(migrations, "0001_initial.sql"), "utf8"));
    const stamp = TUESDAY_NOON.toISOString();
    sqlite.prepare("INSERT INTO users (id, google_sub, email, created_at, updated_at) VALUES ('u1', 's1', 'a@example.com', ?, ?)").run(stamp, stamp);
    sqlite.prepare("INSERT INTO users (id, google_sub, email, created_at, updated_at) VALUES ('u2', 's2', 'b@example.com', ?, ?)").run(stamp, stamp);
    sqlite
      .prepare("INSERT INTO user_settings (user_id, timezone, unit_system, daily_calorie_target_kcal, updated_at) VALUES ('u1', 'UTC', 'imperial', 2150, ?)")
      .run(stamp);
    sqlite.prepare("INSERT INTO user_settings (user_id, timezone, unit_system, updated_at) VALUES ('u2', 'UTC', 'imperial', ?)").run(stamp);
    sqlite.exec(readFileSync(join(migrations, "0002_calorie_plan.sql"), "utf8"));
    const rows = sqlite.prepare("SELECT user_id, maintenance_calories_kcal, calorie_plan_json FROM user_settings ORDER BY user_id").all();
    expect(rows.map((row) => ({ ...row }))).toEqual([
      { user_id: "u1", maintenance_calories_kcal: 2150, calorie_plan_json: null },
      { user_id: "u2", maintenance_calories_kcal: null, calorie_plan_json: null },
    ]);
    expect(sqlite.prepare("SELECT plan_snapshot_json FROM daily_summaries").all()).toEqual([]);
  });
});

describe("calorie plan settings", () => {
  it("keeps remaining calories identical for a migrated user (criterion 1)", async () => {
    const token = await signIn("user-migrated", 2150);
    const settings = await (await request("GET", "/api/settings", token)).json();
    expect(settings).toMatchObject({ maintenance_calories_kcal: 2150, daily_calorie_target_kcal: 2150, calorie_plan: null });
    expect((await logMeal(token, "2026-11-24", 1234)).status).toBe(201);
    const day = await (await request("GET", "/api/days/2026-11-24", token)).json();
    expect(day.summary.calories_remaining_kcal).toBe(caloriesRemaining(2150, day.summary.active_calories_kcal, 1234));
  });

  it("reads and writes the plan and mirrors the legacy base field", async () => {
    const token = await signIn("user-plan");
    const plan = weeklyPlan("2026-11-24");
    const saved = await request("PUT", "/api/settings", token, { maintenance_calories_kcal: 2000, calorie_plan: caloriePlanToApi(plan) });
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body.maintenance_calories_kcal).toBe(2000);
    expect(body.daily_calorie_target_kcal).toBe(2000);
    expect(body.calorie_plan).toEqual(caloriePlanToApi(plan));
    expect((await (await request("GET", "/api/settings", token)).json()).calorie_plan).toEqual(caloriePlanToApi(plan));

    const legacy = await (await request("PUT", "/api/settings", token, { daily_calorie_target_kcal: 1800 })).json();
    expect(legacy).toMatchObject({ maintenance_calories_kcal: 1800, daily_calorie_target_kcal: 1800 });
    expect(legacy.calorie_plan).toEqual(caloriePlanToApi(plan));

    const sync = await (await request("GET", "/api/sync/changes", token)).json();
    expect(sync.settings).toMatchObject({ maintenance_calories_kcal: 1800, calorie_plan: caloriePlanToApi(plan) });
  });

  it("rejects invalid maintenance and plans", async () => {
    const token = await signIn("user-invalid");
    const api = caloriePlanToApi(weeklyPlan("2026-11-24"));
    for (const body of [
      { maintenance_calories_kcal: 900 },
      { maintenance_calories_kcal: 6500 },
      { maintenance_calories_kcal: 1900.5 },
      { calorie_plan: { ...api, custom_plan: { ...api.custom_plan, length_days: 5 } } },
      { calorie_plan: { ...api, weekly_plan: { ...api.weekly_plan, end_date: "2026-11-01" } } },
      { calorie_plan: { ...api, weekly_plan: { ...api.weekly_plan, start_date: "2026-02-30" } } },
    ]) {
      const response = await request("PUT", "/api/settings", token, body);
      expect(response.status).toBe(400);
    }
  });

  it("freezes past days and re-resolves today after a plan change (criterion 11)", async () => {
    clock = MONDAY_NOON;
    const token = await signIn("user-history");
    const plan = weeklyPlan("2026-11-16");
    expect((await request("PUT", "/api/settings", token, { maintenance_calories_kcal: 1900, calorie_plan: caloriePlanToApi(plan) })).status).toBe(200);
    expect((await logMeal(token, "2026-11-23", 1300)).status).toBe(201);
    expect((await snapshotFor("user-history", "2026-11-23"))?.day).toEqual({ type: "deficit", amount: 500 });

    clock = TUESDAY_NOON;
    const tuesdayToken = (await issueSession(database, { userId: "user-history", deviceId: "device-user-history", sessionSecret: SESSION_SECRET, now: clock }))
      .accessToken;
    expect((await logMeal(tuesdayToken, "2026-11-24", 900)).status).toBe(201);
    const edited = {
      ...plan,
      maintenanceCalories: 2000,
      weeklyPlan: { ...plan.weeklyPlan, days: { ...plan.weeklyPlan.days, mon: { type: "surplus" as const, amount: 500 }, tue: { type: "maintain" as const } } },
    };
    expect((await request("PUT", "/api/settings", tuesdayToken, { maintenance_calories_kcal: 2000, calorie_plan: caloriePlanToApi(edited) })).status).toBe(200);

    const monday = await snapshotFor("user-history", "2026-11-23");
    expect(monday).toMatchObject({ day: { type: "deficit", amount: 500 }, maintenanceCalories: 1900 });
    expect((await logMeal(tuesdayToken, "2026-11-23", 50)).status).toBe(201);
    expect((await snapshotFor("user-history", "2026-11-23"))?.day).toEqual({ type: "deficit", amount: 500 });
    const mondayDay = await (await request("GET", "/api/days/2026-11-23", tuesdayToken)).json();
    expect(mondayDay.summary.calories_remaining_kcal).toBe(1400 + mondayDay.summary.active_calories_kcal - 1350);

    expect(await snapshotFor("user-history", "2026-11-24")).toMatchObject({ day: { type: "maintain" }, maintenanceCalories: 2000 });
    const tuesday = await (await request("GET", "/api/days/2026-11-24", tuesdayToken)).json();
    expect(tuesday.summary.calories_remaining_kcal).toBe(2000 + tuesday.summary.active_calories_kcal - 900);
  });

  it("resolves the plan in the trends and day views for a fast day", async () => {
    clock = new Date("2026-11-25T20:00:00.000Z");
    const token = await signIn("user-fast");
    expect((await request("PUT", "/api/settings", token, { calorie_plan: caloriePlanToApi(weeklyPlan("2026-11-16")) })).status).toBe(200);
    expect((await logMeal(token, "2026-11-25", 300)).status).toBe(201);
    const day = await (await request("GET", "/api/days/2026-11-25", token)).json();
    expect(day.summary.calories_remaining_kcal).toBe(-300);
    const trends = await (await request("GET", "/api/review/trends?days=7", token)).json();
    expect(trends.calorie_target_kcal).toBe(1900);
  });
});

async function snapshotFor(userId: string, date: string) {
  const row = await database
    .prepare("SELECT plan_snapshot_json FROM daily_summaries WHERE user_id = ? AND local_date = ?")
    .bind(userId, date)
    .first<{ plan_snapshot_json: string | null }>();
  return parseSnapshotJson(row?.plan_snapshot_json);
}

function logMeal(token: string, localDate: string, kcal: number) {
  return request("POST", "/api/meals", token, {
    name: "Bowl",
    eaten_at: `${localDate}T19:00:00.000Z`,
    local_date: localDate,
    timezone: "America/Los_Angeles",
    items: [{ name: "Bowl", calories_kcal: kcal, protein_g: 20, carbs_g: 30, fat_g: 10 }],
  });
}

async function signIn(userId: string, baseKcal = 1900): Promise<string> {
  const stamp = clock.toISOString();
  await database
    .prepare("INSERT INTO users (id, google_sub, email, display_name, avatar_url, created_at, updated_at) VALUES (?, ?, ?, 'Test', NULL, ?, ?)")
    .bind(userId, `sub-${userId}`, `${userId}@example.com`, stamp, stamp)
    .run();
  await database
    .prepare("INSERT INTO user_settings (user_id, timezone, unit_system, daily_calorie_target_kcal, updated_at) VALUES (?, 'America/Los_Angeles', 'imperial', ?, ?)")
    .bind(userId, baseKcal, stamp)
    .run();
  await database
    .prepare("INSERT INTO user_devices (id, user_id, platform, last_seen_at, created_at) VALUES (?, ?, 'ios', ?, ?)")
    .bind(`device-${userId}`, userId, stamp, stamp)
    .run();
  const session = await issueSession(database, { userId, deviceId: `device-${userId}`, sessionSecret: SESSION_SECRET, now: clock });
  return session.accessToken;
}

function request(method: string, path: string, token: string, body?: unknown) {
  return app.request(
    `https://fitlogr.com${path}`,
    {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    {
      DB: database,
      ENVIRONMENT: "test",
      GOOGLE_OAUTH_CLIENT_ID: "test-client",
      GOOGLE_OAUTH_CLIENT_SECRET: "test-secret",
      TOKEN_ENCRYPTION_KEY: btoa("0123456789abcdef0123456789abcdef"),
      SESSION_SECRET,
      OPENROUTER_API_KEY: "test-openrouter",
      OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
      GOOGLE_PHOTOS_ALBUM_NAME: "fitlogr",
      APP_URL: "https://fitlogr.com",
    },
  );
}
