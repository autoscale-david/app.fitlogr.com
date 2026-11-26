import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { issueSession } from "../auth/sessions";
import { createTestDb } from "../test/d1";

const SESSION_SECRET = "test-session-secret-with-enough-entropy";

let database: D1Database;
const app = createApp({ fetch: globalThis.fetch.bind(globalThis), now: () => new Date("2026-11-24T04:00:00.000Z") });

beforeEach(() => {
  database = createTestDb();
});

describe("health sync and daily rollup", () => {
  it("requires a signed-in user and a real local date", async () => {
    const anonymous = await post("/api/health/sync", { device_id: "device-health-a", records: [], checkpoints: [] });
    expect(anonymous.status).toBe(401);
    const token = await signIn("user-health-a", "a@example.com", "device-health-a");
    const badDate = await get("/api/days/11-23-2026", token);
    expect(badDate.status).toBe(400);
  });

  it("upserts idempotently, keeps workouts out of active totals, and isolates users", async () => {
    const tokenA = await signIn("user-health-a", "a@example.com", "device-health-a");
    const tokenB = await signIn("user-health-b", "b@example.com", "device-health-b");
    const created = await post(
      "/api/meals",
      {
        name: "Chicken bowl",
        eaten_at: "2026-11-23T20:00:00.000Z",
        local_date: "2026-11-23",
        timezone: "America/Los_Angeles",
        items: [{ name: "Chicken bowl", calories_kcal: 500, protein_g: 40, carbs_g: 45, fat_g: 12 }],
      },
      tokenA,
    );
    expect(created.status).toBe(201);
    const meal = await created.json();
    const edited = await patch(
      `/api/meals/${meal.id}`,
      {
        items: [{ name: "Chicken bowl", calories_kcal: 640, protein_g: 50, carbs_g: 60, fat_g: 16 }],
      },
      tokenA,
    );
    expect(edited.status).toBe(200);
    await database
      .prepare(
        `INSERT INTO photos (
           id, user_id, content_sha256, captured_at, local_date, timezone, source, status, is_meal, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'manual', 'analyzed_meal', 1, ?, ?)`,
      )
      .bind(
        "photo-health-1",
        "user-health-a",
        "a".repeat(64),
        "2026-11-23T20:00:00.000Z",
        "2026-11-23",
        "America/Los_Angeles",
        "2026-11-23T20:00:00.000Z",
        "2026-11-23T20:00:00.000Z",
      )
      .run();
    await database.prepare("UPDATE meals SET photo_id = ? WHERE id = ? AND user_id = ?").bind("photo-health-1", meal.id, "user-health-a").run();

    const batch = healthBatch();
    const first = await post("/api/health/sync", batch, tokenA);
    expect(first.status).toBe(200);
    const second = await post("/api/health/sync", batch, tokenA);
    expect(second.status).toBe(200);
    const count = await database.prepare("SELECT COUNT(*) AS n FROM health_records WHERE user_id = ?").bind("user-health-a").first<{ n: number }>();
    expect(count?.n).toBe(batch.records.length);

    const day = await get("/api/days/2026-11-23", tokenA);
    expect(day.status).toBe(200);
    const body = await day.json();
    expect(body.summary).toMatchObject({
      calories_in_kcal: 640,
      protein_g: 50,
      active_calories_kcal: 500,
      resting_calories_kcal: 1400,
      workout_calories_kcal: 300,
      total_calories_out_kcal: 1900,
      calorie_balance_kcal: -1260,
      calories_remaining_kcal: 1760,
      steps: 8420,
      workout_count: 1,
      workout_minutes: 35,
      active_energy_source: "aggregate",
      avg_heart_rate_bpm: 72,
      resting_heart_rate_bpm: 54,
    });
    expect(body.heart_rate).toMatchObject({ avg_bpm: 72, min_bpm: 58, max_bpm: 141, resting_bpm: 54 });
    expect(body.workouts).toEqual([
      expect.objectContaining({ external_id: "hk-run-1", name: "Outdoor Run", calories_kcal: 300, duration_min: 35, source: "Apple Watch" }),
    ]);
    expect(body.meals).toEqual([
      expect.objectContaining({ id: meal.id, calories_kcal: 640, is_user_edited: true, photo_id: "photo-health-1" }),
    ]);
    expect(body.weight).toMatchObject({ weight_kg: 79.2, local_date: "2026-11-23" });

    const storedMeal = await database
      .prepare("SELECT calories_kcal, is_user_edited FROM meals WHERE id = ? AND user_id = ?")
      .bind(meal.id, "user-health-a")
      .first<{ calories_kcal: number; is_user_edited: number }>();
    expect(storedMeal).toMatchObject({ calories_kcal: 640, is_user_edited: 1 });
    const summary = await database
      .prepare("SELECT total_calories_out_kcal, calories_in_kcal, workout_count FROM daily_summaries WHERE user_id = ? AND local_date = ?")
      .bind("user-health-a", "2026-11-23")
      .first<{ total_calories_out_kcal: number; calories_in_kcal: number; workout_count: number }>();
    expect(summary).toMatchObject({ total_calories_out_kcal: 1900, calories_in_kcal: 640, workout_count: 1 });

    const fallback = await (await get("/api/days/2026-11-22", tokenA)).json();
    expect(fallback.summary).toMatchObject({
      active_calories_kcal: 280,
      resting_calories_kcal: 1500,
      total_calories_out_kcal: 1780,
      active_energy_source: "workouts",
      workout_count: 1,
    });
    const explicitZero = await (await get("/api/days/2026-11-21", tokenA)).json();
    expect(explicitZero.summary).toMatchObject({
      active_calories_kcal: 0,
      resting_calories_kcal: 1000,
      workout_calories_kcal: 200,
      total_calories_out_kcal: 1000,
      active_energy_source: "aggregate",
    });

    const nextUtcDay = await (await get("/api/days/2026-11-24", tokenA)).json();
    expect(nextUtcDay.summary.active_calories_kcal).toBe(80);
    expect(nextUtcDay.workouts).toEqual([]);

    const checkpoint = await database
      .prepare("SELECT cursor_value FROM sync_checkpoints WHERE user_id = ? AND device_id = ? AND source = ?")
      .bind("user-health-a", "device-health-a", "healthkit:workout")
      .first<{ cursor_value: string }>();
    expect(checkpoint?.cursor_value).toBe("anchor-workout-1");

    await database
      .prepare("UPDATE health_records SET is_user_edited = 1, value_num = 81 WHERE user_id = ? AND source_record_id = ?")
      .bind("user-health-a", "hk-weight-1")
      .run();
    const overwritten = await post(
      "/api/health/sync",
      {
        device_id: "device-health-a",
        records: [sample({ record_type: "weight", external_id: "hk-weight-1", local_date: "2026-11-23", value: 70, unit: "kg" })],
        checkpoints: [],
      },
      tokenA,
    );
    expect(overwritten.status).toBe(200);
    expect((await overwritten.json()).skipped).toBe(1);
    const weight = await database
      .prepare("SELECT value_num FROM health_records WHERE user_id = ? AND source_record_id = ?")
      .bind("user-health-a", "hk-weight-1")
      .first<{ value_num: number }>();
    expect(weight?.value_num).toBe(81);

    const removed = await post(
      "/api/health/sync",
      {
        device_id: "device-health-a",
        records: [
          sample({
            record_type: "workout",
            external_id: "hk-run-1",
            local_date: "2026-11-23",
            value: 0,
            unit: "sec",
            deleted: true,
            metadata: { activity_type: "Outdoor Run", workout_kcal: 300 },
          }),
        ],
        checkpoints: [],
      },
      tokenA,
    );
    expect(removed.status).toBe(200);
    const afterDelete = await database
      .prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END) AS gone FROM health_records WHERE user_id = ? AND source_record_id = ?")
      .bind("user-health-a", "hk-run-1")
      .first<{ n: number; gone: number }>();
    expect(afterDelete).toMatchObject({ n: 1, gone: 1 });
    const withoutWorkout = await (await get("/api/days/2026-11-23", tokenA)).json();
    expect(withoutWorkout.workouts).toEqual([]);
    expect(withoutWorkout.summary.total_calories_out_kcal).toBe(1900);

    const other = await (await get("/api/days/2026-11-23", tokenB)).json();
    expect(other.meals).toEqual([]);
    expect(other.workouts).toEqual([]);
    expect(other.weight).toBeNull();
    expect(other.summary).toMatchObject({ calories_in_kcal: 0, active_calories_kcal: 0, steps: 0, workout_count: 0 });
    const otherRows = await database.prepare("SELECT COUNT(*) AS n FROM health_records WHERE user_id = ?").bind("user-health-b").first<{ n: number }>();
    expect(otherRows?.n).toBe(0);
    const stolen = await post("/api/health/sync", { device_id: "device-health-a", records: [], checkpoints: [] }, tokenB);
    expect(stolen.status).toBe(400);

    const tooBig = HealthSyncRequestTooBig();
    const rejected = await post("/api/health/sync", tooBig, tokenA);
    expect(rejected.status).toBe(400);
  });
  it("skips a bad record instead of rejecting the batch, and ignores unchanged re-sends", async () => {
    const token = await signIn("user-health-c", "c@example.com", "device-health-c");
    const steps = sample({ record_type: "steps", external_id: "agg:steps:2026-11-23", local_date: "2026-11-23", value: 5000, unit: "count" });
    const tooLong = sample({ record_type: "workout", external_id: "hk-long", local_date: "2026-11-23", value: 90_000, unit: "sec" });
    const blankDevice = {
      ...sample({ record_type: "steps", external_id: "agg:steps:2026-11-22", local_date: "2026-11-22", value: 10, unit: "count" }),
      source_device_name: "",
    };
    const mixed = await post("/api/health/sync", { device_id: "device-health-c", records: [steps, tooLong, blankDevice], checkpoints: [] }, token);
    expect(mixed.status).toBe(200);
    expect(await mixed.json()).toMatchObject({ upserted: 1, skipped: 2, dates: ["2026-11-23"] });

    const stamp = () =>
      database
        .prepare("SELECT updated_at FROM health_records WHERE user_id = ? AND source_record_id = ?")
        .bind("user-health-c", "agg:steps:2026-11-23")
        .first<{ updated_at: string }>();
    const before = await stamp();
    const resent = await post("/api/health/sync", { device_id: "device-health-c", records: [steps], checkpoints: [] }, token);
    expect(await resent.json()).toMatchObject({ upserted: 0, skipped: 1, dates: [] });
    expect(await stamp()).toEqual(before);

    const changed = await post(
      "/api/health/sync",
      { device_id: "device-health-c", records: [{ ...steps, value: 6200 }], checkpoints: [] },
      token,
    );
    expect(await changed.json()).toMatchObject({ upserted: 1, dates: ["2026-11-23"] });
    const day = await (await get("/api/days/2026-11-23", token)).json();
    expect(day.summary.steps).toBe(6200);
    const summary = await database
      .prepare("SELECT steps FROM daily_summaries WHERE user_id = ? AND local_date = ?")
      .bind("user-health-c", "2026-11-23")
      .first<{ steps: number }>();
    expect(summary?.steps).toBe(6200);
  });
});

function healthBatch() {
  return {
    device_id: "device-health-a",
    records: [
      sample({
        record_type: "active_calories",
        external_id: "agg:active_kcal:2026-11-23",
        local_date: "2026-11-23",
        start_time: "2026-11-23T08:00:00.000Z",
        end_time: "2026-11-24T07:59:00.000Z",
        value: 500,
        unit: "kcal",
      }),
      sample({
        record_type: "resting_calories",
        external_id: "agg:resting_kcal:2026-11-23",
        local_date: "2026-11-23",
        start_time: "2026-11-23T08:00:00.000Z",
        end_time: "2026-11-24T07:59:00.000Z",
        value: 1400,
        unit: "kcal",
      }),
      sample({
        record_type: "workout",
        external_id: "hk-run-1",
        local_date: "2026-11-23",
        start_time: "2026-11-23T19:30:00.000Z",
        end_time: "2026-11-23T20:05:00.000Z",
        value: 35 * 60,
        unit: "sec",
        metadata: { activity_type: "Outdoor Run", workout_kcal: 300 },
      }),
      sample({
        record_type: "steps",
        external_id: "agg:steps:2026-11-23",
        local_date: "2026-11-23",
        start_time: "2026-11-23T08:00:00.000Z",
        end_time: "2026-11-24T07:59:00.000Z",
        value: 8420,
        unit: "count",
      }),
      sample({
        record_type: "heart_rate",
        external_id: "agg:hr:2026-11-23",
        local_date: "2026-11-23",
        start_time: "2026-11-23T08:00:00.000Z",
        end_time: "2026-11-24T07:59:00.000Z",
        value: 72,
        unit: "bpm",
        metadata: { min_bpm: 58, max_bpm: 141 },
      }),
      sample({
        record_type: "resting_heart_rate",
        external_id: "agg:rhr:2026-11-23",
        local_date: "2026-11-23",
        start_time: "2026-11-24T03:00:00.000Z",
        end_time: "2026-11-24T03:00:00.000Z",
        value: 54,
        unit: "bpm",
      }),
      sample({
        record_type: "weight",
        external_id: "hk-weight-1",
        local_date: "2026-11-23",
        start_time: "2026-11-23T15:00:00.000Z",
        end_time: "2026-11-23T15:00:00.000Z",
        value: 79.2,
        unit: "kg",
      }),
      sample({
        record_type: "workout",
        external_id: "hk-ride-22",
        local_date: "2026-11-22",
        start_time: "2026-11-22T18:00:00.000Z",
        end_time: "2026-11-22T18:40:00.000Z",
        value: 40 * 60,
        unit: "sec",
        metadata: { activity_type: "Cycling", workout_kcal: 280 },
      }),
      sample({
        record_type: "resting_calories",
        external_id: "agg:resting_kcal:2026-11-22",
        local_date: "2026-11-22",
        start_time: "2026-11-22T08:00:00.000Z",
        end_time: "2026-11-23T07:59:00.000Z",
        value: 1500,
        unit: "kcal",
      }),
      sample({
        record_type: "active_calories",
        external_id: "agg:active_kcal:2026-11-21",
        local_date: "2026-11-21",
        start_time: "2026-11-21T08:00:00.000Z",
        end_time: "2026-11-22T07:59:00.000Z",
        value: 0,
        unit: "kcal",
      }),
      sample({
        record_type: "resting_calories",
        external_id: "agg:resting_kcal:2026-11-21",
        local_date: "2026-11-21",
        start_time: "2026-11-21T08:00:00.000Z",
        end_time: "2026-11-22T07:59:00.000Z",
        value: 1000,
        unit: "kcal",
      }),
      sample({
        record_type: "workout",
        external_id: "hk-lift-21",
        local_date: "2026-11-21",
        start_time: "2026-11-21T17:00:00.000Z",
        end_time: "2026-11-21T17:45:00.000Z",
        value: 45 * 60,
        unit: "sec",
        metadata: { activity_type: "Strength", workout_kcal: 200 },
      }),
      sample({
        record_type: "active_calories",
        external_id: "agg:active_kcal:2026-11-24",
        local_date: "2026-11-24",
        start_time: "2026-11-24T16:00:00.000Z",
        end_time: "2026-11-24T16:30:00.000Z",
        value: 80,
        unit: "kcal",
      }),
    ],
    checkpoints: [{ source: "healthkit:workout", cursor: "anchor-workout-1" }],
  };
}

function sample(overrides: Record<string, unknown>) {
  return {
    source_platform: "healthkit",
    source_app_id: "com.apple.health",
    source_device_name: "Apple Watch",
    timezone: "America/Los_Angeles",
    start_time: "2026-11-24T03:30:00.000Z",
    end_time: "2026-11-24T03:30:00.000Z",
    ...overrides,
  };
}

function HealthSyncRequestTooBig() {
  return {
    device_id: "device-health-a",
    records: Array.from({ length: 251 }, (_, index) =>
      sample({ record_type: "steps", external_id: `steps-${index}`, local_date: "2026-11-20", value: 1, unit: "count" }),
    ),
    checkpoints: [],
  };
}

async function signIn(userId: string, email: string, deviceId: string): Promise<string> {
  const now = "2026-11-24T04:00:00.000Z";
  await database
    .prepare(
      `INSERT INTO users (id, google_sub, email, display_name, avatar_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    )
    .bind(userId, `sub-${userId}`, email, "Test", now, now)
    .run();
  await database
    .prepare(
      `INSERT INTO user_settings (
         user_id, timezone, unit_system, daily_calorie_target_kcal, daily_protein_target_g,
         daily_carbs_target_g, daily_fat_target_g, updated_at
       ) VALUES (?, 'America/Los_Angeles', 'imperial', 1900, 140, 210, 65, ?)`,
    )
    .bind(userId, now)
    .run();
  await database
    .prepare(
      `INSERT INTO user_devices (id, user_id, platform, device_name, app_version, os_version, last_seen_at, created_at)
       VALUES (?, ?, 'ios', 'iPhone', NULL, NULL, ?, ?)`,
    )
    .bind(deviceId, userId, now, now)
    .run();
  const session = await issueSession(database, { userId, deviceId, sessionSecret: SESSION_SECRET, now: new Date(now) });
  return session.accessToken;
}

function env() {
  return {
    DB: database,
    ENVIRONMENT: "test",
    GOOGLE_OAUTH_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
    GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret",
    GOOGLE_OAUTH_REDIRECT_URI: "https://fitlogr.com/api/auth/google/callback",
    TOKEN_ENCRYPTION_KEY: btoa("0123456789abcdef0123456789abcdef"),
    SESSION_SECRET,
    APP_URL: "https://fitlogr.com",
    API_BASE_URL: "https://fitlogr.com/api",
  };
}

function post(path: string, body: unknown, token?: string) {
  return app.request(
    `https://fitlogr.com${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    },
    env(),
  );
}

function patch(path: string, body: unknown, token: string) {
  return app.request(
    `https://fitlogr.com${path}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
    env(),
  );
}

function get(path: string, token?: string) {
  return app.request(`https://fitlogr.com${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }, env());
}
