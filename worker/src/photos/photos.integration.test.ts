import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PHOTO_LIMITS, totalsFromVisionItems } from "@fitlogr/shared";
import { GOOGLE_SCOPES } from "../config";
import { bytesToBase64Url, encodeUtf8, jsonToBase64Url, sha256Base64Url, sha256Hex } from "../encoding";
import { createApp } from "../app";
import { clearJwksCache } from "../services/google";
import { createTestDb } from "../test/d1";

const CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const CLIENT_SECRET = "test-client-secret";
const REDIRECT = "fitlogr://auth/callback";
const MEAL = {
  classification: "meal",
  is_meal: true,
  confidence: 0.93,
  meal_name: "Chicken rice bowl",
  suggested_meal_type: "lunch",
  notes: null,
  total_calories: 9999,
  items: [
    { name: "Chicken", quantity: 1, unit: "breast", estimated_grams: 150, calories_kcal: 100.4, protein_g: 20.2, carbs_g: 0, fat_g: 3.3, confidence: 0.8 },
    { name: "Rice", quantity: 1, unit: "cup", estimated_grams: 180, calories_kcal: 50.25, protein_g: 10.1, carbs_g: 5.1, fat_g: 1.2, confidence: 0.7 },
  ],
};

let privateKey: CryptoKey;
let publicJwk: JsonWebKey;
let database: D1Database;
let pending: { nonce: string; sub: string; email: string; name: string; refreshToken: string } | null = null;
let refreshMode: "ok" | "revoked" = "ok";
let mediaMode: "ok" | "missing" | "quota" = "ok";
let visionMode: "meal" | "not_meal" | "workout" | "ignore" | "bad_json" = "meal";
let burstLimit: string | undefined;
let openRouterCalls = 0;
let uploadCalls = 0;
let batchCalls = 0;

const app = createApp({ fetch: mockFetch, now: () => new Date() });

beforeAll(async () => {
  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  privateKey = keys.privateKey;
  publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
});

beforeEach(() => {
  database = createTestDb();
  pending = null;
  refreshMode = "ok";
  mediaMode = "ok";
  visionMode = "meal";
  burstLimit = undefined;
  openRouterCalls = 0;
  uploadCalls = 0;
  batchCalls = 0;
  clearJwksCache();
});

describe("meal photo analysis", () => {
  it("rejects an exact hash and a near-duplicate dHash before calling the model again", async () => {
    const user = await signIn("hash");
    await consent(user.access_token);
    const first = await analyze(user.access_token, jpeg(1), "0000000000000000");
    expect(first.status).toBe(201);
    const created = await first.json();
    expect(created.outcome).toBe("meal");
    expect(created.meal.calories_kcal).toBe(totalsFromVisionItems(MEAL.items).calories_kcal);
    expect(created.meal.calories_kcal).toBe(150.7);
    expect(created.meal.protein_g).toBe(30.3);
    expect(created.meal.is_user_edited).toBe(false);
    expect(created.meal.is_ai_estimate).toBe(true);
    expect(created.meal.photo_id).toBe(created.photo.id);
    expect(created.photo.google_media_item_id).toBeTruthy();
    expect(created.meal).not.toHaveProperty("total_calories");

    const hashes = await post(
      "/api/photos/check-hashes",
      {
        items: [
          { content_sha256: await sha256HexBytes(jpeg(1)), perceptual_hash: "0000000000000000" },
          { content_sha256: await sha256HexBytes(jpeg(2)), perceptual_hash: "00000000000000ff", captured_at: "2026-11-23T19:31:00.000Z" },
          { content_sha256: "e".repeat(64), perceptual_hash: "0f0f0f0f0f0f0f0f", captured_at: "2026-11-23T19:31:00.000Z" },
        ],
      },
      user.access_token,
    );
    expect(hashes.status).toBe(200);
    const hashBody = await hashes.json();
    expect(hashBody.results.map((result: { status: string }) => result.status)).toEqual(["duplicate", "near_duplicate", "new"]);

    const again = await analyze(user.access_token, jpeg(1), "0000000000000000");
    expect(again.status).toBe(200);
    expect((await again.json()).outcome).toBe("duplicate");
    const near = await analyze(user.access_token, jpeg(2), "00000000000000ff");
    expect(near.status).toBe(200);
    expect((await near.json()).outcome).toBe("duplicate");
    expect(openRouterCalls).toBe(1);
    expect(uploadCalls).toBe(1);
  });

  it("logs the fallback model, recalculates totals, and stores no image bytes", async () => {
    const user = await signIn("fallback");
    await consent(user.access_token);
    visionMode = "bad_json";
    const response = await analyze(user.access_token, jpeg(3), "aaaaaaaaaaaaaaaa");
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.meal.calories_kcal).toBe(150.7);
    expect(body.meal.items).toHaveLength(2);

    const requests = await database
      .prepare("SELECT model, fallback_used, status, prompt_tokens, completion_tokens, estimated_cost_usd FROM ai_requests WHERE user_id = ? ORDER BY model")
      .bind(user.userId)
      .all<{ model: string; fallback_used: number; status: string; prompt_tokens: number; estimated_cost_usd: number }>();
    expect(requests.results.map((row) => [row.model, row.fallback_used, row.status])).toEqual([
      ["google/gemini-2.5-flash-lite", 0, "schema_error"],
      ["openai/gpt-4o-mini", 1, "ok"],
    ]);
    expect(requests.results.every((row) => row.prompt_tokens > 0 && row.estimated_cost_usd > 0)).toBe(true);

    const stored = JSON.stringify(
      (await database.prepare("SELECT * FROM photos").all()).results,
    );
    expect(stored).not.toContain(btoa(String.fromCharCode(...jpeg(3))));
    expect(stored).toContain(body.photo.google_media_item_id);
    const album = await database.prepare("SELECT album_title FROM user_google_photos WHERE user_id = ?").bind(user.userId).first<{ album_title: string }>();
    expect(album?.album_title).toBe("fitlogr");
    expect(batchCalls).toBe(1);
  });

  it("records a non-meal without uploading it", async () => {
    const user = await signIn("nonmeal");
    await consent(user.access_token);
    visionMode = "not_meal";
    const response = await analyze(user.access_token, jpeg(4), "bbbbbbbbbbbbbbbb");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.outcome).toBe("not_meal");
    expect(body.meal).toBeNull();
    expect(body.photo.google_media_item_id).toBeNull();
    expect(uploadCalls).toBe(0);
    const row = await database.prepare("SELECT status, google_status, ai_classification FROM photos WHERE id = ?").bind(body.photo.id).first<{ status: string; google_status: string; ai_classification: string }>();
    expect(row).toEqual({ status: "analyzed_non_meal", google_status: "none", ai_classification: "ignore" });
    expect(body.classification).toBe("ignore");
    expect(body.outcome).toBe("not_meal");
    const meals = await database.prepare("SELECT COUNT(*) AS n FROM meals").first<{ n: number }>();
    expect(meals?.n).toBe(0);

    const repeat = await analyze(user.access_token, jpeg(4), "bbbbbbbbbbbbbbbb");
    expect((await repeat.json()).outcome).toBe("not_meal");
    expect(openRouterCalls).toBe(1);
  });

  it("returns a fresh display URL, a missing photo, and a revoked Google grant", async () => {
    const user = await signIn("url");
    await consent(user.access_token);
    const created = await (await analyze(user.access_token, jpeg(5), "cccccccccccccccc")).json();
    const fresh = await get(`/api/photos/${created.photo.id}/url`, user.access_token);
    expect(fresh.status).toBe(200);
    const freshBody = await fresh.json();
    expect(freshBody.status).toBe("ok");
    expect(freshBody.url).toContain("=w1080-h1080");
    expect(freshBody.expires_at).toBeTruthy();

    mediaMode = "missing";
    const missing = await get(`/api/photos/${created.photo.id}/url`, user.access_token);
    expect(missing.status).toBe(200);
    expect((await missing.json()).status).toBe("missing");
    const missingRow = await database.prepare("SELECT google_status FROM photos WHERE id = ?").bind(created.photo.id).first<{ google_status: string }>();
    expect(missingRow?.google_status).toBe("missing");

    mediaMode = "ok";
    await database.prepare("UPDATE user_oauth_tokens SET access_token_expires_at = ? WHERE user_id = ?").bind("2000-01-01T00:00:00.000Z", user.userId).run();
    refreshMode = "revoked";
    const revoked = await get(`/api/photos/${created.photo.id}/url`, user.access_token);
    expect(revoked.status).toBe(403);
    expect((await revoked.json()).error.code).toBe("google_reconnect_required");
  });

  it("saves the meal when Google access is already revoked and keeps users isolated", async () => {
    const owner = await signIn("owner");
    const other = await signIn("other");
    await consent(owner.access_token);
    await database.prepare("UPDATE user_oauth_tokens SET access_token_expires_at = ? WHERE user_id = ?").bind("2000-01-01T00:00:00.000Z", owner.userId).run();
    refreshMode = "revoked";
    const response = await analyze(owner.access_token, jpeg(6), "dddddddddddddddd");
    expect(response.status).toBe(201);
    const saved = await response.json();
    expect(saved.google_reconnect_required).toBe(true);
    expect(saved.photo.google_status).toBe("failed");
    expect(saved.meal.photo_id).toBe(saved.photo.id);
    expect(uploadCalls).toBe(0);
    const meal = await database.prepare("SELECT name, calories_kcal, is_user_edited FROM meals WHERE user_id = ?").bind(owner.userId).first<{ name: string; calories_kcal: number; is_user_edited: number }>();
    expect(meal).toMatchObject({ name: "Chicken rice bowl", calories_kcal: 150.7, is_user_edited: 0 });
    const photo = await database.prepare("SELECT id, google_media_item_id FROM photos WHERE user_id = ?").bind(owner.userId).first<{ id: string; google_media_item_id: string | null }>();
    expect(photo?.google_media_item_id).toBeNull();

    expect((await get(`/api/photos/${photo!.id}/url`, other.access_token)).status).toBe(404);
    expect((await post(`/api/photos/${photo!.id}/exclude`, {}, other.access_token)).status).toBe(404);
    const otherHashes = await post(
      "/api/photos/check-hashes",
      { items: [{ content_sha256: await sha256HexBytes(jpeg(6)), perceptual_hash: "dddddddddddddddd" }] },
      other.access_token,
    );
    expect((await otherHashes.json()).results[0].status).toBe("new");

    refreshMode = "ok";
    // Still revoked: the retry asks for a reconnect instead of uploading.
    expect((await googleUpload(owner.access_token, photo!.id, jpeg(6))).status).toBe(403);
    // Reconnecting Google (a new sign-in) marks the grant active again.
    await database.prepare("UPDATE user_oauth_tokens SET status = 'active' WHERE user_id = ?").bind(owner.userId).run();
    // After reconnecting, the phone re-sends the same JPEG and the photo lands in the album.
    expect((await googleUpload(other.access_token, photo!.id, jpeg(6))).status).toBe(404);
    expect((await googleUpload(owner.access_token, photo!.id, jpeg(7))).status).toBe(400);
    const retried = await googleUpload(owner.access_token, photo!.id, jpeg(6));
    expect(retried.status).toBe(200);
    expect((await retried.json()).google_status).toBe("uploaded");
    expect(uploadCalls).toBe(1);
    expect((await googleUpload(owner.access_token, photo!.id, jpeg(6))).status).toBe(409);

    const excluded = await post(`/api/photos/${photo!.id}/exclude`, { reason: "not_meal" }, owner.access_token);
    expect(excluded.status).toBe(200);
    const after = await database.prepare("SELECT status FROM photos WHERE id = ?").bind(photo!.id).first<{ status: string }>();
    expect(after?.status).toBe("excluded");
    const deleted = await database.prepare("SELECT deleted_at FROM meals WHERE user_id = ?").bind(owner.userId).first<{ deleted_at: string | null }>();
    expect(deleted?.deleted_at).toBeTruthy();
    const summary = await database
      .prepare("SELECT meal_count, calories_in_kcal FROM daily_summaries WHERE user_id = ?")
      .bind(owner.userId)
      .first<{ meal_count: number; calories_in_kcal: number }>();
    expect(summary).toMatchObject({ meal_count: 0, calories_in_kcal: 0 });

    const replay = await post(
      "/api/photos/check-hashes",
      { items: [{ content_sha256: await sha256HexBytes(jpeg(6)) }] },
      owner.access_token,
    );
    expect((await replay.json()).results[0].status).toBe("excluded");
  });

  it("skips Google Photos when the phone opts out, and still uploads when the flag is absent", async () => {
    const user = await signIn("optout");
    await consent(user.access_token);
    const optedOut = await analyze(user.access_token, jpeg(8), "00000000000000ff", { upload_to_google_photos: false });
    expect(optedOut.status).toBe(201);
    const saved = await optedOut.json();
    expect(saved.outcome).toBe("meal");
    expect(saved.photo.google_media_item_id).toBeNull();
    expect(saved.photo.google_status).toBe("none");
    expect(saved.google_reconnect_required).toBeUndefined();
    expect(uploadCalls).toBe(0);
    const album = await database.prepare("SELECT COUNT(*) AS n FROM user_google_photos WHERE user_id = ?").bind(user.userId).first<{ n: number }>();
    expect(album?.n).toBe(0);

    const legacy = await analyze(user.access_token, jpeg(9), "ffffffffffffffff");
    expect(legacy.status).toBe(201);
    expect((await legacy.json()).photo.google_status).toBe("uploaded");
    expect(uploadCalls).toBe(1);
  });

  it("does not upload when the phone asks but the token has no Photos scope", async () => {
    const user = await signIn("scoped");
    await consent(user.access_token);
    await database.prepare("UPDATE user_oauth_tokens SET scopes = ? WHERE user_id = ?").bind("openid email profile", user.userId).run();
    const skipped = await analyze(user.access_token, jpeg(10), "aaaaaaaaaaaaaaaa", { upload_to_google_photos: true });
    expect(skipped.status).toBe(201);
    const body = await skipped.json();
    expect(body.outcome).toBe("meal");
    expect(body.photo.google_status).toBe("none");
    expect(body.google_reconnect_required).toBeUndefined();
    expect(uploadCalls).toBe(0);
  });

  it("stores a workout and an ignore without logging them as meals", async () => {
    const user = await signIn("classes");
    await consent(user.access_token);
    visionMode = "workout";
    const workout = await analyze(user.access_token, jpeg(11), "0101010101010101", {
      on_device_verdict: "workout",
      on_device_labels: [{ id: "exercise_machine", confidence: 0.42 }],
    });
    expect(workout.status).toBe(200);
    const workoutBody = await workout.json();
    expect(workoutBody.outcome).toBe("not_meal");
    expect(workoutBody.classification).toBe("workout");
    expect(workoutBody.meal).toBeNull();
    expect(workoutBody.estimate).toMatchObject({ kind: "workout", kcal: 420, confidence: 0.88 });
    const workoutRow = await database
      .prepare("SELECT status, ai_classification, ai_estimate_json, device_verdict, device_labels_json FROM photos WHERE id = ?")
      .bind(workoutBody.photo.id)
      .first<{ status: string; ai_classification: string; ai_estimate_json: string; device_verdict: string; device_labels_json: string }>();
    expect(workoutRow?.status).toBe("analyzed_non_meal");
    expect(workoutRow?.ai_classification).toBe("workout");
    expect(JSON.parse(workoutRow?.ai_estimate_json ?? "{}").kcal).toBe(420);
    expect(workoutRow?.device_verdict).toBe("workout");
    expect(JSON.parse(workoutRow?.device_labels_json ?? "[]")).toEqual([{ id: "exercise_machine", confidence: 0.42 }]);
    const meals = await database.prepare("SELECT COUNT(*) AS n FROM meals WHERE user_id = ?").bind(user.userId).first<{ n: number }>();
    expect(meals?.n).toBe(0);

    visionMode = "ignore";
    const ignored = await analyze(user.access_token, jpeg(12), "1010101010101010");
    expect(ignored.status).toBe(200);
    const ignoredBody = await ignored.json();
    expect(ignoredBody.outcome).toBe("not_meal");
    expect(ignoredBody.classification).toBe("ignore");
    expect(ignoredBody.estimate).toMatchObject({ kind: "ignore", kcal: 0 });
    const ignoredRow = await database.prepare("SELECT ai_classification FROM photos WHERE id = ?").bind(ignoredBody.photo.id).first<{ ai_classification: string }>();
    expect(ignoredRow?.ai_classification).toBe("ignore");
  });

  it("uses VISION_BURST_LIMIT when it is set", async () => {
    const user = await signIn("burstenv");
    await consent(user.access_token);
    burstLimit = "1";
    const first = await analyze(user.access_token, jpeg(13), "2222222222222222");
    expect(first.status).toBe(201);
    const second = await analyze(user.access_token, jpeg(14), "3333333333333333");
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBeTruthy();
  });

  it("requires consent and enforces the daily analysis limit", async () => {
    const user = await signIn("limit");
    const blocked = await analyze(user.access_token, jpeg(7), "eeeeeeeeeeeeeeee");
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error.code).toBe("AI_CONSENT_REQUIRED");
    expect(openRouterCalls).toBe(0);

    await consent(user.access_token);
    const now = new Date().toISOString();
    for (let index = 0; index < PHOTO_LIMITS.burstVision; index += 1) {
      await database
        .prepare(
          `INSERT INTO ai_requests (id, user_id, request_type, model, fallback_used, latency_ms, status, created_at)
           VALUES (?, ?, 'meal_vision', 'google/gemini-2.5-flash-lite', 0, 1, 'ok', ?)`,
        )
        .bind(`ai-limit-${index}`, user.userId, now)
        .run();
    }
    const limited = await analyze(user.access_token, jpeg(7), "eeeeeeeeeeeeeeee");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(openRouterCalls).toBe(0);
  });
});

async function signIn(name: string) {
  const verifier = `${name}${"x".repeat(43)}`.slice(0, 50);
  const started = await post("/api/auth/google/start", {
    redirect_uri: REDIRECT,
    client_challenge: await sha256Base64Url(verifier),
    device: { platform: "ios", id: `device-${name}`.slice(0, 36) },
  });
  expect(started.status).toBe(200);
  const authorize = new URL((await started.json()).authorize_url);
  const stateRow = await database
    .prepare("SELECT payload_json FROM oauth_states WHERE state_hash = ?")
    .bind(await sha256Hex(authorize.searchParams.get("state") ?? ""))
    .first<{ payload_json: string }>();
  pending = {
    nonce: authorize.searchParams.get("nonce") ?? "",
    sub: `sub-${name}`,
    email: `${name}@example.com`,
    name,
    refreshToken: `refresh-${name}`,
  };
  expect(JSON.parse(stateRow!.payload_json).pkce_verifier).toBeTruthy();
  const callback = await app.request(
    `https://fitlogr.com/api/auth/google/callback?code=auth-code&state=${authorize.searchParams.get("state")}`,
    {},
    env(),
  );
  expect(callback.status).toBe(302);
  const exchangeCode = new URL(callback.headers.get("location") ?? "").searchParams.get("exchange_code");
  const exchanged = await post("/api/auth/exchange", {
    exchange_code: exchangeCode,
    client_verifier: verifier,
    device: { platform: "ios", id: `device-${name}`.slice(0, 36) },
  });
  expect(exchanged.status).toBe(200);
  const session = await exchanged.json();
  return { ...session, userId: session.user.id as string };
}

async function consent(token: string) {
  const response = await put("/api/settings", { accept_ai_consent: true, ai_consent_version: "2026-11-23" }, token);
  expect(response.status).toBe(200);
}

async function analyze(token: string, image: Uint8Array, dhash: string, extra: Record<string, unknown> = {}) {
  const metadata = {
    ...extra,
    content_sha256: await sha256HexBytes(image),
    perceptual_hash: dhash,
    captured_at: "2026-11-23T19:30:00.000Z",
    local_date: "2026-11-23",
    timezone: "America/Los_Angeles",
    source: "manual",
  };
  const payload = multipart(metadata, image);
  return app.request(
    "https://fitlogr.com/api/photos/analyze",
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": payload.contentType },
      body: payload.body,
    },
    env(),
  );
}

async function googleUpload(token: string, photoId: string, image: Uint8Array) {
  const form = new FormData();
  form.append("image", new File([image], "meal.jpg", { type: "image/jpeg" }));
  return app.request(
    `https://fitlogr.com/api/photos/${photoId}/google-upload`,
    { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form },
    env(),
  );
}

function jpeg(seed: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, seed, 0xd9]);
}

function multipart(metadata: unknown, image: Uint8Array): { body: Uint8Array; contentType: string } {
  const boundary = "----fitlogrboundary";
  const encoder = new TextEncoder();
  const prefix = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="meal.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(prefix.length + image.length + suffix.length);
  body.set(prefix, 0);
  body.set(image, prefix.length);
  body.set(suffix, prefix.length + image.length);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function env() {
  return {
    DB: database,
    ENVIRONMENT: "test",
    GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    GOOGLE_OAUTH_REDIRECT_URI: "https://fitlogr.com/api/auth/google/callback",
    GOOGLE_PHOTOS_ALBUM_NAME: "fitlogr",
    TOKEN_ENCRYPTION_KEY: btoa("0123456789abcdef0123456789abcdef"),
    SESSION_SECRET: "test-session-secret-with-enough-entropy",
    OPENROUTER_API_KEY: "test-openrouter-key",
    ...(burstLimit ? { VISION_BURST_LIMIT: burstLimit } : {}),
    OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
    OPENROUTER_VISION_MODEL: "google/gemini-2.5-flash-lite",
    OPENROUTER_VISION_FALLBACK_MODELS: "openai/gpt-4o-mini",
    APP_URL: "https://fitlogr.com",
    API_BASE_URL: "https://fitlogr.com/api",
  };
}

async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (url === "https://oauth2.googleapis.com/token") {
    const params = new URLSearchParams(String(init?.body ?? ""));
    if (params.get("grant_type") === "refresh_token") {
      if (refreshMode === "revoked") return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: "refreshed-access-token", expires_in: 3600, token_type: "Bearer" });
    }
    if (!pending) return new Response("missing", { status: 400 });
    const idToken = await signIdToken({
      iss: "https://accounts.google.com",
      aud: CLIENT_ID,
      sub: pending.sub,
      email: pending.email,
      email_verified: true,
      name: pending.name,
      nonce: pending.nonce,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    return Response.json({
      access_token: "google-access-token",
      expires_in: 3600,
      refresh_token: pending.refreshToken,
      id_token: idToken,
      scope: GOOGLE_SCOPES.join(" "),
      token_type: "Bearer",
    });
  }
  if (url === "https://www.googleapis.com/oauth2/v3/certs") {
    return new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "max-age=0" },
    });
  }
  if (url === "https://openrouter.ai/api/v1/chat/completions") {
    openRouterCalls += 1;
    const body = JSON.parse(String(init?.body ?? "{}"));
    const authorization = new Headers(init?.headers).get("authorization");
    if (authorization !== "Bearer test-openrouter-key") return new Response("unauthorized", { status: 401 });
    if (visionMode === "bad_json" && body.model === "google/gemini-2.5-flash-lite") {
      return Response.json({ choices: [{ message: { content: "not-json" } }], usage: { prompt_tokens: 11, completion_tokens: 1 } });
    }
    if (visionMode === "not_meal" || visionMode === "ignore") {
      return Response.json({
        choices: [{ message: { content: JSON.stringify({ classification: visionMode === "ignore" ? "ignore" : "not_meal", is_meal: false, confidence: 0.9, meal_name: null, suggested_meal_type: null, notes: "A dog", reason: "Not food", burn_kcal: null, items: [] }) } }],
        usage: { prompt_tokens: 20, completion_tokens: 8, cost: 0.00002 },
      });
    }
    if (visionMode === "workout") {
      return Response.json({
        choices: [{
          message: {
            content: JSON.stringify({
              classification: "workout",
              is_meal: false,
              confidence: 0.88,
              meal_name: null,
              suggested_meal_type: null,
              notes: null,
              reason: "Treadmill console",
              burn_kcal: 420,
              items: [{ name: "Treadmill", quantity: 1, unit: "session", calories_kcal: 420, protein_g: 0, carbs_g: 0, fat_g: 0, confidence: 0.8 }],
            }),
          },
        }],
        usage: { prompt_tokens: 20, completion_tokens: 8, cost: 0.00002 },
      });
    }
    return Response.json({
      choices: [{ message: { content: JSON.stringify(MEAL) } }],
      usage: { prompt_tokens: 30, completion_tokens: 20, cost: 0.00005 },
    });
  }
  if (url.startsWith("https://photoslibrary.googleapis.com/v1/albums")) {
    const method = init?.method ?? "GET";
    if (method === "POST") {
      return Response.json({ id: "album-fitlogr", title: "fitlogr", productUrl: "https://photos.google.com/album/fitlogr" });
    }
    return Response.json({ albums: [] });
  }
  if (url === "https://photoslibrary.googleapis.com/v1/uploads") {
    uploadCalls += 1;
    const headers = new Headers(init?.headers);
    if (!headers.get("authorization")?.startsWith("Bearer ")) return new Response("unauthorized", { status: 401 });
    return new Response("upload-token-1", { status: 200 });
  }
  if (url === "https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate") {
    batchCalls += 1;
    const body = JSON.parse(String(init?.body ?? "{}"));
    expect(body.albumId).toBe("album-fitlogr");
    expect(body.newMediaItems[0].simpleMediaItem.uploadToken).toBe("upload-token-1");
    return Response.json({ newMediaItemResults: [{ mediaItem: { id: `media-${batchCalls}` }, status: { message: "Success" } }] });
  }
  if (url.startsWith("https://photoslibrary.googleapis.com/v1/mediaItems/")) {
    if (mediaMode === "missing") return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
    if (mediaMode === "quota") return new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" } }), { status: 429 });
    return Response.json({ id: url.split("/").pop(), baseUrl: "https://lh3.googleusercontent.com/lr/meal-photo" });
  }
  return new Response("not found", { status: 404 });
}

async function signIdToken(payload: Record<string, unknown>): Promise<string> {
  const encoded = `${jsonToBase64Url({ alg: "RS256", typ: "JWT", kid: "test-key" })}.${jsonToBase64Url(payload)}`;
  const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, privateKey, encodeUtf8(encoded));
  return `${encoded}.${bytesToBase64Url(new Uint8Array(signature))}`;
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

function put(path: string, body: unknown, token: string) {
  return app.request(
    `https://fitlogr.com${path}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
    env(),
  );
}

function get(path: string, token?: string) {
  return app.request(`https://fitlogr.com${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }, env());
}
