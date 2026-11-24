import { beforeEach, describe, expect, it } from "vitest";
import { AccountExportSchema } from "@fitlogr/shared";
import { createApp } from "../app";
import { issueSession } from "../auth/sessions";
import { addIsoDays } from "./dates";
import { DAILY_INSIGHT_LIMIT } from "./insights";
import { createTestDb } from "../test/d1";

const SESSION_SECRET = "test-session-secret-with-enough-entropy";
const NOW = "2026-11-24T07:30:00.000Z";
const INSIGHT =
  "You stayed under your calorie goal and kept the day simple. Protein landed close to target, which is a solid place to finish.";

let database: D1Database;
let textMode: "ok" | "fallback" = "ok";
let openRouterCalls = 0;
const fetchedUrls: string[] = [];

const app = createApp({
  fetch: mockFetch,
  now: () => new Date(NOW),
});

beforeEach(() => {
  database = createTestDb();
  textMode = "ok";
  openRouterCalls = 0;
  fetchedUrls.length = 0;
});

describe("daily insights", () => {
  it("caches an unchanged day and regenerates once after a meal, workout, or weight change", async () => {
    const token = await signIn("user-insight", "insight@example.com", "device-insight");
    const created = await post(
      "/api/meals",
      {
        name: "Chicken bowl",
        eaten_at: "2026-11-23T20:00:00.000Z",
        local_date: "2026-11-23",
        timezone: "America/Los_Angeles",
        items: [{ name: "Chicken bowl", calories_kcal: 500, protein_g: 40, carbs_g: 45, fat_g: 12 }],
      },
      token,
    );
    expect(created.status).toBe(201);
    const meal = await created.json();
    expect((await post("/api/health/sync", healthBody(), token)).status).toBe(200);

    const first = await get("/api/insights/2026-11-23", token);
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody).toMatchObject({ date: "2026-11-23", cached: false, insight: INSIGHT, model: "google/gemini-2.5-flash-lite" });
    expect(openRouterCalls).toBe(1);
    const hash = await insightHash("user-insight");

    const again = await get("/api/insights/2026-11-23", token);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ cached: true, insight: INSIGHT, model: null });
    expect(openRouterCalls).toBe(1);
    expect(await insightCount("user-insight")).toBe(1);

    const edited = await patch(
      `/api/meals/${meal.id}`,
      { items: [{ name: "Chicken bowl", calories_kcal: 700, protein_g: 55, carbs_g: 60, fat_g: 18 }] },
      token,
    );
    expect(edited.status).toBe(200);
    const afterMeal = await get("/api/insights/2026-11-23", token);
    expect(afterMeal.status).toBe(200);
    expect((await afterMeal.json()).cached).toBe(false);
    expect(openRouterCalls).toBe(2);
    expect(await insightHash("user-insight")).not.toBe(hash);
    const mealHash = await insightHash("user-insight");
    expect((await (await get("/api/insights/2026-11-23", token)).json()).cached).toBe(true);
    expect(openRouterCalls).toBe(2);

    expect((await post("/api/health/sync", workoutBody(), token)).status).toBe(200);
    expect((await (await get("/api/insights/2026-11-23", token)).json()).cached).toBe(false);
    expect(openRouterCalls).toBe(3);
    expect(await insightHash("user-insight")).not.toBe(mealHash);

    const weighed = await post(
      "/api/weight",
      { weight_kg: 80.4, recorded_at: "2026-11-23T15:00:00.000Z", local_date: "2026-11-23", timezone: "America/Los_Angeles" },
      token,
    );
    expect(weighed.status).toBe(201);
    expect((await (await get("/api/insights/2026-11-23", token)).json()).cached).toBe(false);
    expect(openRouterCalls).toBe(4);
    expect((await (await get("/api/insights/2026-11-23", token)).json()).cached).toBe(true);
    expect(openRouterCalls).toBe(4);
    expect((await get("/api/insights/11-23-2026", token)).status).toBe(400);
    expect((await get("/api/insights/2026-11-23")).status).toBe(401);
  });

  it("falls back to the text model and logs cost, tokens, and latency", async () => {
    textMode = "fallback";
    const token = await signIn("user-fallback", "fallback@example.com", "device-fallback");
    const response = await get("/api/insights/2026-11-23", token);
    expect(response.status).toBe(200);
    expect((await response.json()).model).toBe("openai/gpt-4o-mini");
    expect(openRouterCalls).toBe(2);
    const requests = await database
      .prepare(
        `SELECT model, fallback_used, status, prompt_tokens, completion_tokens, estimated_cost_usd, latency_ms, request_type
         FROM ai_requests WHERE user_id = ? ORDER BY model`,
      )
      .bind("user-fallback")
      .all<{
        model: string;
        fallback_used: number;
        status: string;
        prompt_tokens: number;
        completion_tokens: number;
        estimated_cost_usd: number;
        latency_ms: number;
        request_type: string;
      }>();
    expect(requests.results.map((row) => [row.model, row.fallback_used, row.status, row.request_type])).toEqual([
      ["google/gemini-2.5-flash-lite", 0, "schema_error", "daily_insight"],
      ["openai/gpt-4o-mini", 1, "ok", "daily_insight"],
    ]);
    expect(requests.results.every((row) => row.prompt_tokens > 0 && row.completion_tokens > 0 && row.estimated_cost_usd > 0 && row.latency_ms >= 0)).toBe(true);
  });

  it("rate limits new generations and still serves a cached insight", async () => {
    const token = await signIn("user-limit", "limit@example.com", "device-limit1");
    for (let index = 0; index < DAILY_INSIGHT_LIMIT; index += 1) {
      const date = addIsoDays("2026-10-01", index);
      const response = await get(`/api/insights/${date}`, token);
      expect(response.status).toBe(200);
      expect((await response.json()).cached).toBe(false);
    }
    expect(openRouterCalls).toBe(DAILY_INSIGHT_LIMIT);
    const blocked = await get(`/api/insights/${addIsoDays("2026-10-01", DAILY_INSIGHT_LIMIT)}`, token);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("3600");
    expect((await blocked.json()).error.code).toBe("RATE_LIMITED");
    expect(openRouterCalls).toBe(DAILY_INSIGHT_LIMIT);
    const cached = await get("/api/insights/2026-10-01", token);
    expect(cached.status).toBe(200);
    expect((await cached.json()).cached).toBe(true);
    expect(openRouterCalls).toBe(DAILY_INSIGHT_LIMIT);
  });
});

describe("review trends", () => {
  it("aggregates the local window and does not cross the user's midnight into the next UTC day", async () => {
    const token = await signIn("user-trends", "trends@example.com", "device-trends");
    await insertMeal("user-trends", "meal-16", "2026-11-16", 50);
    await insertMeal("user-trends", "meal-17", "2026-11-17", 80);
    await insertMeal("user-trends", "meal-23", "2026-11-23", 640, 40, 10, 5);
    await insertMeal("user-trends", "meal-24", "2026-11-24", 100);
    await insertHealth("user-trends", "active-23", "active_calories", "2026-11-23", 500, "kcal", null, "2026-11-24T06:30:00.000Z");
    await insertHealth("user-trends", "rest-23", "resting_calories", "2026-11-23", 1400, "kcal", null, "2026-11-24T07:00:00.000Z");
    await insertHealth(
      "user-trends",
      "run-23",
      "workout",
      "2026-11-23",
      35 * 60,
      "sec",
      JSON.stringify({ activity_type: "Running", workout_kcal: 300 }),
      "2026-11-23T19:30:00.000Z",
    );
    await insertHealth("user-trends", "wt-22", "weight", "2026-11-22", 80, "kg", null, "2026-11-22T16:00:00.000Z");
    await insertHealth("user-trends", "wt-23", "weight", "2026-11-23", 79.2, "kg", null, "2026-11-23T15:00:00.000Z");

    const response = await get("/api/review/trends?days=7", token);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.timezone).toBe("America/Los_Angeles");
    expect(body.days).toBe(7);
    expect(body.from).toBe("2026-11-17");
    expect(body.to).toBe("2026-11-23");
    expect(body.points).toHaveLength(7);
    expect(body.points.map((point: { date: string }) => point.date)).toEqual([
      "2026-11-17",
      "2026-11-18",
      "2026-11-19",
      "2026-11-20",
      "2026-11-21",
      "2026-11-22",
      "2026-11-23",
    ]);
    expect(body.points[0]).toMatchObject({ date: "2026-11-17", calories_in_kcal: 80, meal_count: 1, calories_burned_kcal: 0, weight_kg: null });
    expect(body.points[5]).toMatchObject({ date: "2026-11-22", weight_kg: 80, meal_count: 0 });
    expect(body.points[6]).toMatchObject({
      date: "2026-11-23",
      calories_in_kcal: 640,
      calories_burned_kcal: 1900,
      surplus_deficit_kcal: 640 - 1900,
      protein_g: 40,
      carbs_g: 10,
      fat_g: 5,
      workout_minutes: 35,
      workout_count: 1,
      meal_count: 1,
      weight_kg: 79.2,
    });
    expect(body.points.some((point: { date: string }) => point.date === "2026-11-16" || point.date === "2026-11-24")).toBe(false);

    const utc = await signIn("user-utc", "utc@example.com", "device-utc-user", "UTC");
    await insertMeal("user-utc", "meal-utc", "2026-11-24", 100);
    const utcBody = await (await get("/api/review/trends?days=7", utc)).json();
    expect(utcBody.to).toBe("2026-11-24");
    expect(utcBody.from).toBe("2026-11-18");
    expect(utcBody.points.at(-1)).toMatchObject({ date: "2026-11-24", calories_in_kcal: 100, surplus_deficit_kcal: 100 - 1900 });

    expect((await get("/api/review/trends?days=14", token)).status).toBe(200);
    expect((await (await get("/api/review/trends?days=14", token)).json()).points).toHaveLength(14);
    expect((await (await get("/api/review/trends?days=30", token)).json()).points).toHaveLength(30);
    expect((await get("/api/review/trends?days=90", token)).status).toBe(400);
    expect((await get("/api/review/trends?days=7")).status).toBe(401);
    expect(openRouterCalls).toBe(0);
    expect(fetchedUrls.filter((url) => url.includes("photoslibrary"))).toEqual([]);
  });
});

describe("account export and deletion", () => {
  it("exports the user's records and leaves tokens, hashes, and other users out", async () => {
    const token = await signIn("user-export", "export@example.com", "device-export");
    const other = await signIn("user-other", "other@example.com", "device-other");
    const created = await post(
      "/api/meals",
      {
        name: "Salmon plate",
        eaten_at: "2026-11-23T19:00:00.000Z",
        local_date: "2026-11-23",
        timezone: "America/Los_Angeles",
        items: [{ name: "Salmon", calories_kcal: 540, protein_g: 42, carbs_g: 20, fat_g: 28 }],
      },
      token,
    );
    const meal = await created.json();
    await post(
      "/api/meals",
      {
        name: "Secret smoothie",
        eaten_at: "2026-11-23T18:00:00.000Z",
        local_date: "2026-11-23",
        timezone: "America/Los_Angeles",
        items: [{ name: "Secret smoothie", calories_kcal: 200, protein_g: 10, carbs_g: 20, fat_g: 5 }],
      },
      other,
    );
    await database
      .prepare(
        `INSERT INTO photos (
           id, user_id, content_sha256, captured_at, local_date, timezone, source, status, is_meal,
           google_media_item_id, google_album_id, google_status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'manual', 'analyzed_meal', 1, ?, ?, 'uploaded', ?, ?)`,
      )
      .bind(
        "photo-export-1",
        "user-export",
        "ab".repeat(32),
        "2026-11-23T19:00:00.000Z",
        "2026-11-23",
        "America/Los_Angeles",
        "media-item-export-1",
        "album-export-1",
        NOW,
        NOW,
      )
      .run();
    await database.prepare("UPDATE meals SET photo_id = ? WHERE id = ?").bind("photo-export-1", meal.id).run();
    await insertHealth("user-export", "steps-export", "steps", "2026-11-23", 9000, "count", null, "2026-11-24T03:00:00.000Z");
    await database
      .prepare(
        `INSERT INTO user_oauth_tokens (
           user_id, provider, encrypted_refresh_token, refresh_token_iv, encrypted_access_token, access_token_iv,
           key_version, scopes, status, updated_at
         ) VALUES (?, 'google', ?, ?, ?, ?, 1, 'openid', 'active', ?)`,
      )
      .bind("user-export", "enc-refresh-SENTINEL", "iv-SENTINEL", "access-SENTINEL", "access-iv-SENTINEL", NOW)
      .run();
    await database
      .prepare(
        `INSERT INTO oauth_states (state_hash, kind, user_id, payload_json, expires_at, created_at)
         VALUES (?, 'oauth_start', ?, ?, ?, ?)`,
      )
      .bind("state-export", "user-export", JSON.stringify({ pkce_verifier: "pkce-SENTINEL" }), "2026-11-25T00:00:00.000Z", NOW)
      .run();
    await database.prepare("UPDATE user_sessions SET refresh_token_hash = ? WHERE user_id = ?").bind("session-hash-SENTINEL", "user-export").run();

    const response = await get("/api/account/export", token);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    const raw = await response.text();
    const body = JSON.parse(raw);
    expect(AccountExportSchema.safeParse(body).success).toBe(true);
    expect(body.profile).toMatchObject({ id: "user-export", email: "export@example.com" });
    expect(body.settings.daily_calorie_target_kcal).toBe(1900);
    expect(body.meals).toEqual([
      expect.objectContaining({
        name: "Salmon plate",
        photo_id: "photo-export-1",
        items: [expect.objectContaining({ name: "Salmon", calories_kcal: 540 })],
      }),
    ]);
    expect(body.photos).toEqual([
      expect.objectContaining({ id: "photo-export-1", google_media_item_id: "media-item-export-1", google_album_id: "album-export-1" }),
    ]);
    expect(body.health_records).toEqual([expect.objectContaining({ source_record_id: "steps-export", value_num: 9000 })]);
    expect(body.daily_summaries.some((row: { calories_in_kcal: number }) => row.calories_in_kcal === 540)).toBe(true);
    expect(raw).not.toContain("Secret smoothie");
    for (const secret of ["enc-refresh-SENTINEL", "iv-SENTINEL", "access-SENTINEL", "access-iv-SENTINEL", "pkce-SENTINEL", "session-hash-SENTINEL", SESSION_SECRET]) {
      expect(raw).not.toContain(secret);
    }
    const keys = new Set<string>();
    collectKeys(body, keys);
    for (const forbidden of ["encrypted_refresh_token", "refresh_token_hash", "refresh_token_iv", "encrypted_access_token", "access_token", "pkce_verifier", "payload_json"]) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });

  it("deletes one user's rows, revokes sessions, and never calls Google Photos", async () => {
    const token = await signIn("user-delete", "delete@example.com", "device-delete");
    const second = await issueSession(database, {
      userId: "user-delete",
      deviceId: "device-delete",
      sessionSecret: SESSION_SECRET,
      now: new Date(NOW),
    });
    const other = await signIn("user-kept", "kept@example.com", "device-kept");
    await insertMeal("user-delete", "meal-delete", "2026-11-23", 400);
    await insertMeal("user-kept", "meal-kept", "2026-11-23", 250);
    await database
      .prepare(
        `INSERT INTO photos (
           id, user_id, content_sha256, captured_at, local_date, timezone, source, status, is_meal, google_media_item_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, '2026-11-23', 'America/Los_Angeles', 'manual', 'analyzed_meal', 1, 'media-keep-me', ?, ?)`,
      )
      .bind("photo-delete", "user-delete", "cd".repeat(32), NOW, NOW, NOW)
      .run();
    await database
      .prepare(
        `INSERT INTO user_google_photos (user_id, album_id, album_title, status, created_at, updated_at)
         VALUES (?, 'album-delete', 'fitlogr', 'active', ?, ?)`,
      )
      .bind("user-delete", NOW, NOW)
      .run();
    await insertHealth("user-delete", "wt-delete", "weight", "2026-11-23", 81, "kg", null, NOW);
    await database
      .prepare(
        `INSERT INTO ai_requests (id, user_id, request_type, model, fallback_used, latency_ms, status, created_at)
         VALUES ('ai-delete', 'user-delete', 'daily_insight', 'test', 0, 1, 'ok', ?)`,
      )
      .bind(NOW)
      .run();
    const before = await count("meals", "user-kept");

    const missing = await del("/api/account", {}, token);
    expect(missing.status).toBe(400);
    const response = await del("/api/account", { confirm: true }, token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, google_photos_preserved: true });
    expect(fetchedUrls.filter((url) => /photoslibrary|mediaItems|googleapis.com\/v1\/albums/.test(url))).toEqual([]);

    expect((await get("/api/me", token)).status).toBe(401);
    expect((await get("/api/insights/2026-11-23", token)).status).toBe(401);
    expect((await get("/api/me", second.accessToken)).status).toBe(401);
    for (const table of [
      "user_settings",
      "user_devices",
      "user_oauth_tokens",
      "user_google_photos",
      "photos",
      "meals",
      "meal_items",
      "health_records",
      "daily_summaries",
      "sync_checkpoints",
      "ai_requests",
      "user_sessions",
      "oauth_states",
    ]) {
      expect(await count(table, "user-delete")).toBe(0);
    }
    const user = await database.prepare("SELECT COUNT(*) AS n FROM users WHERE id = ?").bind("user-delete").first<{ n: number }>();
    expect(user?.n).toBe(0);
    expect(await count("meals", "user-kept")).toBe(before);
    expect((await get("/api/me", other)).status).toBe(200);
    const keptMeal = await database.prepare("SELECT name FROM meals WHERE user_id = ?").bind("user-kept").first<{ name: string }>();
    expect(keptMeal?.name).toBe("meal-kept");
  });
});

function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  fetchedUrls.push(url);
  if (/photoslibrary\.googleapis\.com|mediaItems|\/albums/.test(url)) {
    return Promise.reject(new Error(`Google Photos API was called: ${url}`));
  }
  if (!url.includes("openrouter.ai")) return Promise.resolve(new Response("unexpected", { status: 500 }));
  openRouterCalls += 1;
  const model = JSON.parse(String(init?.body)).model as string;
  if (textMode === "fallback" && model.includes("gemini")) {
    return Promise.resolve(chat("not json", { prompt_tokens: 12, completion_tokens: 2, cost: 0.00001 }));
  }
  return Promise.resolve(chat(JSON.stringify({ insight: INSIGHT }), { prompt_tokens: 80, completion_tokens: 30, cost: 0.00002 }));
}

function chat(content: string, usage: { prompt_tokens: number; completion_tokens: number; cost: number }): Response {
  return Response.json({ choices: [{ message: { content } }], usage });
}

async function signIn(userId: string, email: string, deviceId: string, timezone = "America/Los_Angeles"): Promise<string> {
  await database
    .prepare(
      `INSERT INTO users (id, google_sub, email, display_name, avatar_url, created_at, updated_at)
       VALUES (?, ?, ?, 'Test', NULL, ?, ?)`,
    )
    .bind(userId, `sub-${userId}`, email, NOW, NOW)
    .run();
  await database
    .prepare(
      `INSERT INTO user_settings (
         user_id, timezone, unit_system, daily_calorie_target_kcal, daily_protein_target_g,
         daily_carbs_target_g, daily_fat_target_g, updated_at
       ) VALUES (?, ?, 'imperial', 1900, 140, 210, 65, ?)`,
    )
    .bind(userId, timezone, NOW)
    .run();
  await database
    .prepare(
      `INSERT INTO user_devices (id, user_id, platform, device_name, last_seen_at, created_at)
       VALUES (?, ?, 'ios', 'iPhone', ?, ?)`,
    )
    .bind(deviceId, userId, NOW, NOW)
    .run();
  const session = await issueSession(database, { userId, deviceId, sessionSecret: SESSION_SECRET, now: new Date(NOW) });
  return session.accessToken;
}

async function insertMeal(
  userId: string,
  id: string,
  localDate: string,
  calories: number,
  protein = 10,
  carbs = 10,
  fat = 10,
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO meals (
         id, user_id, name, meal_type, eaten_at, local_date, timezone,
         calories_kcal, protein_g, carbs_g, fat_g, is_ai_estimate, is_user_edited, created_at, updated_at
       ) VALUES (?, ?, ?, 'meal', ?, ?, 'America/Los_Angeles', ?, ?, ?, ?, 0, 1, ?, ?)`,
    )
    .bind(id, userId, id, `${localDate}T20:00:00.000Z`, localDate, calories, protein, carbs, fat, NOW, NOW)
    .run();
}

async function insertHealth(
  userId: string,
  id: string,
  recordType: string,
  localDate: string,
  value: number,
  unit: string,
  metadata: string | null,
  endTime: string,
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO health_records (
         id, user_id, platform, record_type, source_record_id, start_time, end_time, local_date, timezone,
         value_num, unit, metadata_json, is_user_edited, created_at, updated_at
       ) VALUES (?, ?, 'healthkit', ?, ?, ?, ?, ?, 'America/Los_Angeles', ?, ?, ?, 0, ?, ?)`,
    )
    .bind(id, userId, recordType, id, endTime, endTime, localDate, value, unit, metadata, NOW, NOW)
    .run();
}

function healthBody() {
  return {
    device_id: "device-insight",
    records: [
      sample("active_calories", "agg:active:2026-11-23", 400, "kcal"),
      sample("resting_calories", "agg:resting:2026-11-23", 1500, "kcal"),
    ],
    checkpoints: [],
  };
}

function workoutBody() {
  return {
    device_id: "device-insight",
    records: [
      sample("workout", "hk-run-review", 35 * 60, "sec", {
        activity_type: "Running",
        workout_kcal: 280,
      }),
    ],
    checkpoints: [],
  };
}

function sample(recordType: string, externalId: string, value: number, unit: string, metadata?: Record<string, unknown>) {
  return {
    record_type: recordType,
    source_platform: "healthkit",
    external_id: externalId,
    source_device_name: "Apple Watch",
    start_time: "2026-11-23T18:00:00.000Z",
    end_time: "2026-11-23T18:35:00.000Z",
    local_date: "2026-11-23",
    timezone: "America/Los_Angeles",
    value,
    unit,
    ...(metadata ? { metadata } : {}),
  };
}

async function insightHash(userId: string): Promise<string | null> {
  const row = await database
    .prepare("SELECT insight_input_hash FROM daily_summaries WHERE user_id = ? AND local_date = '2026-11-23'")
    .bind(userId)
    .first<{ insight_input_hash: string | null }>();
  return row?.insight_input_hash ?? null;
}

async function insightCount(userId: string): Promise<number> {
  const row = await database
    .prepare("SELECT COUNT(*) AS n FROM ai_requests WHERE user_id = ? AND request_type = 'daily_insight' AND status = 'ok'")
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function count(table: string, userId: string): Promise<number> {
  const row = await database.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).bind(userId).first<{ n: number }>();
  return row?.n ?? 0;
}

function collectKeys(value: unknown, keys: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      keys.add(key);
      collectKeys(item, keys);
    }
  }
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
    OPENROUTER_API_KEY: "test-openrouter-key",
    OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
    OPENROUTER_TEXT_MODEL: "google/gemini-2.5-flash-lite",
    OPENROUTER_TEXT_FALLBACK_MODELS: "openai/gpt-4o-mini",
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

function del(path: string, body: unknown, token?: string) {
  return app.request(
    `https://fitlogr.com${path}`,
    {
      method: "DELETE",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    },
    env(),
  );
}

function get(path: string, token?: string) {
  return app.request(`https://fitlogr.com${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }, env());
}
