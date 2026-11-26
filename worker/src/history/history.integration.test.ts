import { beforeEach, describe, expect, it } from "vitest";
import { PICKER_SCOPE } from "../config";
import { encryptSecret, oauthTokenAad } from "../crypto";
import { issueSession } from "../auth/sessions";
import { createApp } from "../app";
import { createTestDb } from "../test/d1";

const SESSION_SECRET = "history-session-secret";
const TOKEN_KEY = btoa("0123456789abcdef0123456789abcdef");
const NOW = new Date("2026-11-24T20:00:00.000Z");
const MEAL = {
  classification: "meal",
  is_meal: true,
  confidence: 0.9,
  meal_name: "Past lunch",
  suggested_meal_type: "lunch",
  notes: null,
  items: [
    { name: "Rice", quantity: 1, unit: "bowl", estimated_grams: 200, calories_kcal: 400, protein_g: 8, carbs_g: 70, fat_g: 4, confidence: 0.8 },
  ],
};
const NOT_MEAL = {
  classification: "not_meal",
  is_meal: false,
  confidence: 0.2,
  meal_name: null,
  suggested_meal_type: null,
  notes: null,
  items: [],
};

let database: D1Database;
let visionCalls = 0;
let deletedSessions = 0;
let mode: "meal" | "not_meal" = "meal";
let pickerHttp: "ok" | "disabled" = "ok";
let pickerItems: ReturnType<typeof item>[] = [];

const app = createApp({
  fetch: mockFetch,
  now: () => NOW,
});

beforeEach(() => {
  database = createTestDb();
  visionCalls = 0;
  deletedSessions = 0;
  mode = "meal";
  pickerHttp = "ok";
  pickerItems = [
    item("meal-a", "https://images.example/a"),
    item("meal-a-again", "https://images.example/a-copy"),
    item("scenery", "https://images.example/scenery"),
    item("broken", "https://images.example/broken"),
  ];
});

describe("history import and maintenance", () => {
  it("keeps a manual weight when Apple Health syncs the same day", async () => {
    const token = await signIn("user-weight");
    const logged = await post("/api/weight", {
      weight_kg: 82.4,
      recorded_at: "2026-11-23T16:00:00.000Z",
      local_date: "2026-11-23",
      timezone: "America/Los_Angeles",
    }, token);
    expect(logged.status).toBe(201);
    const synced = await post("/api/health/sync", {
      device_id: "device-user-weight",
      records: [
        {
          record_type: "weight",
          source_platform: "healthkit",
          external_id: "hk-weight-day",
          start_time: "2026-11-23T18:00:00.000Z",
          end_time: "2026-11-23T18:00:00.000Z",
          local_date: "2026-11-23",
          timezone: "America/Los_Angeles",
          value: 70,
          unit: "kg",
        },
        {
          record_type: "active_calories",
          source_platform: "healthkit",
          external_id: "agg:active_kcal:2026-11-23",
          start_time: "2026-11-23T08:00:00.000Z",
          end_time: "2026-11-24T08:00:00.000Z",
          local_date: "2026-11-23",
          timezone: "America/Los_Angeles",
          value: 400,
          unit: "kcal",
        },
        {
          record_type: "workout",
          source_platform: "healthkit",
          external_id: "hk-run",
          start_time: "2026-11-23T16:00:00.000Z",
          end_time: "2026-11-23T16:30:00.000Z",
          local_date: "2026-11-23",
          timezone: "America/Los_Angeles",
          value: 1800,
          unit: "sec",
          metadata: { activity_type: "Running", workout_kcal: 250 },
        },
      ],
      checkpoints: [],
    }, token);
    expect(synced.status).toBe(200);
    const again = await post("/api/health/sync", {
      device_id: "device-user-weight",
      records: [
        {
          record_type: "weight",
          source_platform: "healthkit",
          external_id: "hk-weight-day",
          start_time: "2026-11-23T18:00:00.000Z",
          end_time: "2026-11-23T18:00:00.000Z",
          local_date: "2026-11-23",
          timezone: "America/Los_Angeles",
          value: 71,
          unit: "kg",
        },
      ],
      checkpoints: [],
    }, token);
    expect(again.status).toBe(200);
    const summary = await database
      .prepare("SELECT weight_kg, active_calories_kcal, total_calories_out_kcal FROM daily_summaries WHERE user_id = ? AND local_date = ?")
      .bind("user-weight", "2026-11-23")
      .first<{ weight_kg: number; active_calories_kcal: number; total_calories_out_kcal: number }>();
    expect(summary?.weight_kg).toBe(82.4);
    expect(summary?.active_calories_kcal).toBe(400);
    expect(summary?.total_calories_out_kcal).toBe(400);
  });

  it("estimates base calories from complete historical days", async () => {
    const token = await signIn("user-estimate");
    for (let day = 15; day <= 24; day += 1) {
      const date = `2026-11-${String(day).padStart(2, "0")}`;
      await database
        .prepare(
          `INSERT INTO meals (
             id, user_id, name, meal_type, eaten_at, local_date, timezone, calories_kcal, protein_g, carbs_g, fat_g,
             is_ai_estimate, is_user_edited, created_at, updated_at
           ) VALUES (?, 'user-estimate', 'Lunch', 'lunch', ?, ?, 'America/Los_Angeles', 2500, 100, 200, 70, 0, 1, ?, ?)`,
        )
        .bind(`meal-${date}`, `${date}T20:00:00.000Z`, date, NOW.toISOString(), NOW.toISOString())
        .run();
      await database
        .prepare(
          `INSERT INTO health_records (
             id, user_id, platform, record_type, source_record_id, start_time, end_time, local_date, timezone,
             value_num, unit, is_user_edited, created_at, updated_at
           ) VALUES (?, 'user-estimate', 'healthkit', 'active_calories', ?, ?, ?, ?, 'America/Los_Angeles', 500, 'kcal', 0, ?, ?)`,
        )
        .bind(`active-${date}`, `active-${date}`, `${date}T08:00:00.000Z`, `${date}T08:00:00.000Z`, date, NOW.toISOString(), NOW.toISOString())
        .run();
    }
    await database
      .prepare(
        `INSERT INTO health_records (
           id, user_id, platform, record_type, source_record_id, start_time, end_time, local_date, timezone,
           value_num, unit, is_user_edited, created_at, updated_at
         ) VALUES
         ('w-start', 'user-estimate', 'manual', 'weight', 'manual:start', '2026-11-15T16:00:00.000Z', '2026-11-15T16:00:00.000Z', '2026-11-15', 'America/Los_Angeles', 80, 'kg', 1, ?, ?),
         ('w-end', 'user-estimate', 'healthkit', 'weight', 'hk-end', '2026-11-24T16:00:00.000Z', '2026-11-24T16:00:00.000Z', '2026-11-24', 'America/Los_Angeles', 79, 'kg', 0, ?, ?)`,
      )
      .bind(NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), NOW.toISOString())
      .run();
    const response = await app.request("https://fitlogr.com/api/settings/maintenance-estimate?days=14", { headers: { authorization: `Bearer ${token}` } }, env());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ready");
    expect(body.estimated_base_calories).toBe(2770);
    expect(body.estimated_tdee_calories).toBe(3270);
    expect(body.total_complete_days).toBe(10);
  });

  it("creates a picker session only with the picker scope, then imports historical photos in memory", async () => {
    const denied = await signIn("user-picker-no", false);
    const blocked = await post("/api/photos/picker/sessions", {}, denied);
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error.code).toBe("SCOPE_REQUIRED");

    const token = await signIn("user-picker", true);
    await database
      .prepare("UPDATE user_settings SET ai_consent_version = '2026-11-23', ai_consent_accepted_at = ? WHERE user_id = ?")
      .bind(NOW.toISOString(), "user-picker")
      .run();
    const created = await post("/api/photos/picker/sessions", {}, token);
    expect(created.status).toBe(200);
    const session = await created.json();
    expect(session.picker_uri).toContain("https://photos.google.com/");
    expect(session.session_id).toBe("picker-session-1");

    const status = await app.request(`https://fitlogr.com/api/photos/picker/sessions/${session.session_id}`, { headers: { authorization: `Bearer ${token}` } }, env());
    expect(status.status).toBe(200);
    expect((await status.json()).media_items_set).toBe(true);

    const imported = await post(`/api/photos/picker/sessions/${session.session_id}/import`, {}, token);
    expect(imported.status).toBe(200);
    expect(await imported.json()).toEqual({
      total_picked: 4,
      meals_imported: 1,
      non_meals_skipped: 1,
      duplicates_skipped: 1,
      errors: 1,
      next_cursor: null,
      retry_after_seconds: null,
    });
    expect(visionCalls).toBe(2);
    expect(deletedSessions).toBe(1);
    const meal = await database
      .prepare("SELECT local_date, calories_kcal FROM meals WHERE user_id = ?")
      .bind("user-picker")
      .first<{ local_date: string; calories_kcal: number }>();
    expect(meal).toEqual({ local_date: "2026-10-01", calories_kcal: 400 });
    const summary = await database
      .prepare("SELECT calories_in_kcal FROM daily_summaries WHERE user_id = ? AND local_date = ?")
      .bind("user-picker", "2026-10-01")
      .first<{ calories_in_kcal: number }>();
    expect(summary?.calories_in_kcal).toBe(400);
    const nonMeal = await database
      .prepare("SELECT COUNT(*) AS n FROM photos WHERE user_id = ? AND status = 'analyzed_non_meal'")
      .bind("user-picker")
      .first<{ n: number }>();
    expect(nonMeal?.n).toBe(1);
  });

  it("imports every picked photo across pages and resumes after the analysis rate limit", async () => {
    const token = await signIn("user-picker-pages", true);
    await database
      .prepare("UPDATE user_settings SET ai_consent_version = '2026-11-23', ai_consent_accepted_at = ? WHERE user_id = ?")
      .bind(NOW.toISOString(), "user-picker-pages")
      .run();
    pickerItems = Array.from({ length: 7 }, (_, index) =>
      item(`meal-${index}`, `https://images.example/meal-${index}`, `2026-10-0${index + 1}T18:00:00.000Z`),
    );
    const first = await (await post("/api/photos/picker/sessions/picker-session-1/import", { paged: true }, token)).json();
    expect(first).toMatchObject({ total_picked: 5, meals_imported: 5, retry_after_seconds: null });
    expect(first.next_cursor).toEqual(expect.any(String));
    expect(deletedSessions).toBe(0);

    // Fill the burst window so the next photo is rate limited.
    for (let index = 0; index < 30; index += 1) {
      await database
        .prepare(
          `INSERT INTO ai_requests (id, user_id, request_type, model, latency_ms, status, created_at)
           VALUES (?, 'user-picker-pages', 'meal_vision', 'test', 1, 'ok', ?)`,
        )
        .bind(`burst-${index}`, NOW.toISOString())
        .run();
    }
    const limited = await (await post("/api/photos/picker/sessions/picker-session-1/import", { cursor: first.next_cursor }, token)).json();
    expect(limited).toMatchObject({ total_picked: 0, meals_imported: 0, errors: 0 });
    expect(limited.retry_after_seconds).toBeGreaterThan(0);
    expect(limited.next_cursor).toEqual(expect.any(String));
    expect(deletedSessions).toBe(0);

    await database.prepare("DELETE FROM ai_requests WHERE id LIKE 'burst-%'").run();
    const rest = await (await post("/api/photos/picker/sessions/picker-session-1/import", { cursor: limited.next_cursor }, token)).json();
    expect(rest).toMatchObject({ total_picked: 2, meals_imported: 2, next_cursor: null, retry_after_seconds: null });
    expect(deletedSessions).toBe(1);
    const meals = await database.prepare("SELECT COUNT(*) AS n FROM meals WHERE user_id = ?").bind("user-picker-pages").first<{ n: number }>();
    expect(meals?.n).toBe(7);
  });

  it("keeps the one-call import for older app builds that do not page", async () => {
    const token = await signIn("user-picker-legacy", true);
    await database
      .prepare("UPDATE user_settings SET ai_consent_version = '2026-11-23', ai_consent_accepted_at = ? WHERE user_id = ?")
      .bind(NOW.toISOString(), "user-picker-legacy")
      .run();
    pickerItems = Array.from({ length: 8 }, (_, index) =>
      item(`meal-${index}`, `https://images.example/meal-${index}`, `2026-10-0${index + 1}T18:00:00.000Z`),
    );
    const result = await (await post("/api/photos/picker/sessions/picker-session-1/import", {}, token)).json();
    expect(result).toMatchObject({ total_picked: 8, meals_imported: 8, next_cursor: null });
    expect(deletedSessions).toBe(1);
  });

  it("names a disabled Photos Picker API instead of a generic failure", async () => {
    pickerHttp = "disabled";
    const token = await signIn("user-picker-off", true);
    const created = await post("/api/photos/picker/sessions", {}, token);
    expect(created.status).toBe(403);
    const body = await created.json();
    expect(body.error.code).toBe("PICKER_API_DISABLED");
    expect(body.error.message).toContain("photospicker.googleapis.com");
  });
});

async function signIn(userId: string, picker = false): Promise<string> {
  const stamp = NOW.toISOString();
  await database
    .prepare(`INSERT INTO users (id, google_sub, email, display_name, avatar_url, created_at, updated_at) VALUES (?, ?, ?, 'Test', NULL, ?, ?)`)
    .bind(userId, `sub-${userId}`, `${userId}@example.com`, stamp, stamp)
    .run();
  await database
    .prepare(
      `INSERT INTO user_settings (user_id, timezone, unit_system, daily_calorie_target_kcal, updated_at) VALUES (?, 'America/Los_Angeles', 'imperial', 1900, ?)`,
    )
    .bind(userId, stamp)
    .run();
  await database
    .prepare(`INSERT INTO user_devices (id, user_id, platform, last_seen_at, created_at) VALUES (?, ?, 'ios', ?, ?)`)
    .bind(`device-${userId}`, userId, stamp, stamp)
    .run();
  const scopes = `openid email profile https://www.googleapis.com/auth/photoslibrary.appendonly${picker ? ` ${PICKER_SCOPE}` : ""}`;
  const refresh = await encryptSecret(TOKEN_KEY, oauthTokenAad(userId), "refresh-token");
  const access = await encryptSecret(TOKEN_KEY, oauthTokenAad(userId), "access-token");
  await database
    .prepare(
      `INSERT INTO user_oauth_tokens (
         user_id, provider, encrypted_refresh_token, refresh_token_iv, encrypted_access_token, access_token_iv,
         access_token_expires_at, key_version, scopes, status, updated_at
       ) VALUES (?, 'google', ?, ?, ?, ?, ?, 1, ?, 'active', ?)`,
    )
    .bind(userId, refresh.ciphertext, refresh.iv, access.ciphertext, access.iv, "2026-11-25T20:00:00.000Z", scopes, stamp)
    .run();
  const session = await issueSession(database, { userId, deviceId: `device-${userId}`, sessionSecret: SESSION_SECRET, now: NOW });
  return session.accessToken;
}

function env() {
  return {
    DB: database,
    ENVIRONMENT: "test",
    GOOGLE_OAUTH_CLIENT_ID: "test-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "test-secret",
    TOKEN_ENCRYPTION_KEY: TOKEN_KEY,
    SESSION_SECRET,
    OPENROUTER_API_KEY: "test-openrouter",
    OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
    GOOGLE_PHOTOS_ALBUM_NAME: "fitlogr",
    APP_URL: "https://fitlogr.com",
  };
}

function post(path: string, body: unknown, token: string) {
  return app.request(
    `https://fitlogr.com${path}`,
    { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) },
    env(),
  );
}

function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (url.includes("photospicker.googleapis.com/v1/sessions") && init?.method === "DELETE") {
    deletedSessions += 1;
    return json({ ok: true });
  }
  if (url.endsWith("/v1/sessions") && init?.method === "POST") {
    if (pickerHttp === "disabled") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: 403,
              message: "Photos Picker API has not been used in project 1 before or it is disabled.",
              status: "PERMISSION_DENIED",
              details: [{ reason: "SERVICE_DISABLED" }],
            },
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return json({
      id: "picker-session-1",
      pickerUri: "https://photos.google.com/picker/session",
      pollingConfig: { pollInterval: "2s", timeoutIn: "120s" },
    });
  }
  if (url.includes("/v1/sessions/picker-session-1") && (!init?.method || init.method === "GET")) {
    return json({ id: "picker-session-1", mediaItemsSet: true });
  }
  if (url.includes("/v1/mediaItems")) {
    const params = new URL(url).searchParams;
    const size = Number(params.get("pageSize") ?? "100");
    const start = Number(params.get("pageToken") ?? "0");
    const page = pickerItems.slice(start, start + size);
    const next = start + size < pickerItems.length ? String(start + size) : undefined;
    return json({ mediaItems: page, ...(next ? { nextPageToken: next } : {}) });
  }
  if (url.startsWith("https://images.example/")) {
    if (url.includes("broken")) return Promise.resolve(new Response("no", { status: 500 }));
    mode = url.includes("scenery") ? "not_meal" : "meal";
    const numbered = /meal-(\d+)/.exec(url);
    const seed = url.includes("scenery") ? 2 : numbered ? 10 + Number(numbered[1]) : 1;
    return Promise.resolve(new Response(jpeg(seed), { status: 200, headers: { "content-type": "image/jpeg" } }));
  }
  if (url.includes("openrouter.ai")) {
    visionCalls += 1;
    return json({
      choices: [{ message: { content: JSON.stringify(mode === "meal" ? MEAL : NOT_MEAL) } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.001 },
    });
  }
  if (url.includes("/albums")) return json({ albums: [{ id: "album-1", title: "fitlogr" }] });
  if (url.endsWith("/uploads")) return Promise.resolve(new Response("upload-token", { status: 200 }));
  if (url.includes("mediaItems:batchCreate")) return json({ newMediaItemResults: [{ mediaItem: { id: `media-${visionCalls}` } }] });
  return Promise.resolve(new Response("unexpected", { status: 500 }));
}

function item(id: string, baseUrl: string, createTime = "2026-10-01T18:00:00.000Z") {
  return { id, createTime, type: "PHOTO", mediaFile: { baseUrl, mimeType: "image/jpeg" } };
}

function jpeg(seed: number): Uint8Array {
  const bytes = new Uint8Array(80);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  for (let index = 2; index < bytes.length; index += 1) bytes[index] = (seed * 40 + index * 17) & 0xff;
  bytes[bytes.length - 2] = 0xff;
  bytes[bytes.length - 1] = 0xd9;
  return bytes;
}

function json(body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
}
