import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SCOPES } from "./config";
import { decryptSecret, oauthTokenAad } from "./crypto";
import { bytesToBase64Url, encodeUtf8, jsonToBase64Url, sha256Base64Url, sha256Hex } from "./encoding";
import { createApp } from "./app";
import { clearJwksCache } from "./services/google";
import { createTestDb } from "./test/d1";

const CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const CLIENT_SECRET = "test-client-secret";
const REDIRECT = "fitlogr://auth/callback";

let privateKey: CryptoKey;
let publicJwk: JsonWebKey;
let database: D1Database;
let tokenBodies: string[] = [];
let pending: { nonce: string; sub: string; email: string; name: string; refreshToken: string } | null = null;

const app = createApp({
  fetch: mockFetch,
  now: () => new Date(),
});

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
  tokenBodies = [];
  pending = null;
  clearJwksCache();
});

describe("stage 2 API", () => {
  it("reports db_ok when D1 can run SELECT 1", async () => {
    const response = await app.request("https://fitlogr.com/api/health", {}, env());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, db_ok: true });
  });

  it("rejects open redirects and accepts Expo Go callbacks", async () => {
    const rejected = await post("/api/auth/google/start", {
      redirect_uri: "https://evil.example/steal",
      client_challenge: "a".repeat(43),
    });
    expect(rejected.status).toBe(400);
    const states = await database.prepare("SELECT COUNT(*) AS n FROM oauth_states").first<{ n: number }>();
    expect(states?.n).toBe(0);

    const evil = await post("/api/auth/google/start", {
      redirect_uri: "https://evil.com/auth/callback",
      client_challenge: "a".repeat(43),
    });
    expect(evil.status).toBe(400);
    const evilBody = (await evil.json()) as { error: { message: string } };
    expect(evilBody.error.message).toBe("Redirect URL is not allowed (https://evil.com/auth/callback)");
    const stillEmpty = await database.prepare("SELECT COUNT(*) AS n FROM oauth_states").first<{ n: number }>();
    expect(stillEmpty?.n).toBe(0);

    const group = await post("/api/auth/google/start", {
      redirect_uri:
        "exp://u.expo.dev/1964593c-a6a0-49e5-a35b-240cf2bf254e/group/7e8bd250-083f-4331-b52b-70f882a4be4d//--/auth/callback",
      client_challenge: "c".repeat(43),
    });
    expect(group.status).toBe(200);

    const allowed = await post("/api/auth/google/start", {
      redirect_uri: "exp://192.168.1.20:8081/--/auth/callback",
      client_challenge: "a".repeat(43),
    });
    expect(allowed.status).toBe(200);

    const preview = await post("/api/auth/google/start", {
      redirect_uri: "exp://u.expo.dev/update/01a20c91-e031-7a2a-816c-f0d510b91266/--/auth/callback",
      client_challenge: "b".repeat(43),
    });
    expect(preview.status).toBe(200);
    const started = (await preview.json()) as { authorize_url: string };
    expect(new URL(started.authorize_url).hostname).toBe("accounts.google.com");
  });

  it("signs in with PKCE, encrypts the Google refresh token, and exchanges a single-use code", async () => {
    const session = await signIn({
      sub: "google-sub-a",
      email: "a@example.com",
      name: "Alex",
      refreshToken: "google-refresh-token",
      deviceId: "device-user-a",
    });
    expect(session.user.email).toBe("a@example.com");

    const params = new URLSearchParams(tokenBodies[0]);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(params.get("code_verifier")?.length).toBeGreaterThan(40);

    const stored = await database
      .prepare("SELECT encrypted_refresh_token, refresh_token_iv FROM user_oauth_tokens WHERE user_id = ?")
      .bind(session.user.id)
      .first<{ encrypted_refresh_token: string; refresh_token_iv: string }>();
    expect(stored?.encrypted_refresh_token).not.toBe("google-refresh-token");
    expect(await decryptSecret(encryptionKey(), oauthTokenAad(session.user.id), {
      ciphertext: stored!.encrypted_refresh_token,
      iv: stored!.refresh_token_iv,
    })).toBe("google-refresh-token");
    await expect(
      decryptSecret(encryptionKey(), oauthTokenAad("someone-else"), {
        ciphertext: stored!.encrypted_refresh_token,
        iv: stored!.refresh_token_iv,
      }),
    ).rejects.toThrow();

    const me = await get("/api/me", session.access_token);
    expect(me.status).toBe(200);
    const body = await me.json();
    expect(body.google.connected).toBe(true);
    expect(body.google.scopes).toEqual(expect.arrayContaining(["openid", "email"]));
    expect(body.settings.daily_calorie_target_kcal).toBe(1900);
  });

  it("rejects an expired OAuth state and a reused exchange code", async () => {
    const verifier = "b".repeat(50);
    const started = await post("/api/auth/google/start", {
      redirect_uri: REDIRECT,
      client_challenge: await sha256Base64Url(verifier),
      device: { platform: "ios", id: "device-expired1" },
    });
    const { authorize_url: authorizeUrl } = await started.json();
    const state = new URL(authorizeUrl).searchParams.get("state");
    await database.prepare("UPDATE oauth_states SET expires_at = ?").bind("2000-01-01T00:00:00.000Z").run();
    const callback = await app.request(
      `https://fitlogr.com/api/auth/google/callback?code=abc&state=${state}`,
      {},
      env(),
    );
    expect(callback.status).toBe(400);
    expect(tokenBodies).toHaveLength(0);

    const session = await signIn({
      sub: "google-sub-once",
      email: "once@example.com",
      name: "Once",
      refreshToken: "refresh-once",
      deviceId: "device-once01",
    });
    expect(session.access_token).toBeTruthy();
    const reused = await post("/api/auth/exchange", {
      exchange_code: session.exchangeCode,
      client_verifier: session.verifier,
      device: { platform: "ios", id: "device-once01" },
    });
    expect(reused.status).toBe(401);
  });

  it("rotates refresh tokens and revokes the session family when a used token is replayed", async () => {
    const session = await signIn({
      sub: "google-sub-rot",
      email: "rot@example.com",
      name: "Rot",
      refreshToken: "refresh-rot",
      deviceId: "device-rotate1",
    });
    const rotated = await post("/api/auth/refresh", { refresh_token: session.refresh_token });
    expect(rotated.status).toBe(200);
    const next = await rotated.json();
    expect(next.refresh_token).not.toBe(session.refresh_token);

    const replay = await post("/api/auth/refresh", { refresh_token: session.refresh_token });
    expect(replay.status).toBe(401);
    const afterReplay = await post("/api/auth/refresh", { refresh_token: next.refresh_token });
    expect(afterReplay.status).toBe(401);

    const loggedOut = await signIn({
      sub: "google-sub-out",
      email: "out@example.com",
      name: "Out",
      refreshToken: "refresh-out",
      deviceId: "device-logout1",
    });
    const logout = await post("/api/auth/logout", {}, loggedOut.access_token);
    expect(logout.status).toBe(200);
    const me = await get("/api/me", loggedOut.access_token);
    expect(me.status).toBe(401);
  });

  it("keeps user B from reading or changing user A's settings, meals, and weight", async () => {
    const userA = await signIn({
      sub: "google-sub-a2",
      email: "a2@example.com",
      name: "A",
      refreshToken: "refresh-a",
      deviceId: "device-user-a2",
    });
    const userB = await signIn({
      sub: "google-sub-b2",
      email: "b2@example.com",
      name: "B",
      refreshToken: "refresh-b",
      deviceId: "device-user-b2",
    });

    const settings = await put(
      "/api/settings",
      { daily_calorie_target_kcal: 2100, unit_system: "metric", expected_updated_at: userA.settingsUpdatedAt },
      userA.access_token,
    );
    expect(settings.status).toBe(200);
    const meal = await post(
      "/api/meals",
      {
        name: "Lunch",
        eaten_at: "2026-11-23T20:00:00.000Z",
        local_date: "2026-11-23",
        timezone: "America/Los_Angeles",
        items: [{ name: "Rice", calories_kcal: 200, protein_g: 4, carbs_g: 40, fat_g: 1 }],
      },
      userA.access_token,
    );
    expect(meal.status).toBe(201);
    const created = await meal.json();
    expect(created.is_user_edited).toBe(true);
    expect(created.calories_kcal).toBe(200);

    const patched = await patch(
      `/api/meals/${created.id}`,
      {
        items: [
          { name: "Rice", calories_kcal: 150, protein_g: 4, carbs_g: 30, fat_g: 1 },
          { name: "Chicken", calories_kcal: 220, protein_g: 35, carbs_g: 0, fat_g: 8 },
        ],
      },
      userA.access_token,
    );
    expect(patched.status).toBe(200);
    const edited = await patched.json();
    expect(edited.is_user_edited).toBe(true);
    expect(edited.calories_kcal).toBe(370);
    expect(edited.protein_g).toBe(39);

    const weight = await post(
      "/api/weight",
      {
        weight_kg: 80.5,
        recorded_at: "2026-11-23T15:00:00.000Z",
        local_date: "2026-11-23",
        timezone: "America/Los_Angeles",
      },
      userA.access_token,
    );
    expect(weight.status).toBe(201);
    const again = await post(
      "/api/weight",
      {
        weight_kg: 80.1,
        recorded_at: "2026-11-23T16:00:00.000Z",
        local_date: "2026-11-23",
        timezone: "America/Los_Angeles",
      },
      userA.access_token,
    );
    expect(again.status).toBe(201);
    const weights = await get("/api/weight?from=2026-11-23&to=2026-11-23", userA.access_token);
    const weightBody = await weights.json();
    expect(weightBody.weights).toHaveLength(1);
    expect(weightBody.weights[0].value_num).toBe(80.1);

    expect((await get(`/api/meals/${created.id}`, userB.access_token)).status).toBe(404);
    expect((await patch(`/api/meals/${created.id}`, { name: "Stolen" }, userB.access_token)).status).toBe(404);
    expect((await del(`/api/meals/${created.id}`, userB.access_token)).status).toBe(404);
    const bSettings = await get("/api/settings", userB.access_token);
    expect((await bSettings.json()).daily_calorie_target_kcal).toBe(1900);
    const bMeals = await get("/api/meals", userB.access_token);
    expect((await bMeals.json()).meals).toEqual([]);
    const bWeights = await get("/api/weight", userB.access_token);
    expect((await bWeights.json()).weights).toEqual([]);

    const stale = await put(
      "/api/settings",
      { daily_calorie_target_kcal: 1000, expected_updated_at: userA.settingsUpdatedAt },
      userA.access_token,
    );
    expect(stale.status).toBe(409);

    const removed = await del(`/api/meals/${created.id}`, userA.access_token);
    expect(removed.status).toBe(200);
    expect((await get(`/api/meals/${created.id}`, userA.access_token)).status).toBe(404);
  });

  it("returns a cursor page of settings, meals, and weight without another user's rows", async () => {
    const userA = await signIn({
      sub: "google-sub-sync",
      email: "sync@example.com",
      name: "Sync",
      refreshToken: "refresh-sync",
      deviceId: "device-sync01",
    });
    const userB = await signIn({
      sub: "google-sub-other",
      email: "other@example.com",
      name: "Other",
      refreshToken: "refresh-other",
      deviceId: "device-other01",
    });
    const mealIds: string[] = [];
    for (const name of ["One", "Two", "Three"]) {
      const response = await post(
        "/api/meals",
        {
          name,
          eaten_at: "2026-11-23T18:00:00.000Z",
          local_date: "2026-11-23",
          timezone: "America/Los_Angeles",
          items: [{ name, calories_kcal: 100, protein_g: 1, carbs_g: 2, fat_g: 3 }],
        },
        userA.access_token,
      );
      mealIds.push((await response.json()).id);
    }
    await post(
      "/api/weight",
      {
        weight_kg: 70,
        recorded_at: "2026-11-23T12:00:00.000Z",
        local_date: "2026-11-22",
        timezone: "America/Los_Angeles",
      },
      userA.access_token,
    );

    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    let sawSettings = false;
    let sawWeight = false;
    do {
      const response = await get(`/api/sync/changes?limit=1${cursor ? `&since=${encodeURIComponent(cursor)}` : ""}`, userA.access_token);
      expect(response.status).toBe(200);
      const page = await response.json();
      if (page.settings) sawSettings = true;
      for (const meal of page.meals) seen.add(meal.id);
      if (page.health_records.some((record: { record_type: string }) => record.record_type === "weight")) sawWeight = true;
      cursor = page.cursor;
      pages += 1;
      if (!page.has_more) break;
    } while (pages < 12);

    expect(pages).toBeGreaterThan(1);
    expect(sawSettings).toBe(true);
    expect(sawWeight).toBe(true);
    expect([...seen].sort()).toEqual([...mealIds].sort());

    const other = await get("/api/sync/changes", userB.access_token);
    const otherBody = await other.json();
    expect(otherBody.meals.map((meal: { id: string }) => meal.id)).not.toEqual(expect.arrayContaining(mealIds));
    expect(otherBody.health_records).toEqual([]);
  });
});

async function signIn(user: { sub: string; email: string; name: string; refreshToken: string; deviceId: string }) {
  const verifier = `${user.deviceId}${"x".repeat(40)}`;
  const challenge = await sha256Base64Url(verifier);
  const started = await post("/api/auth/google/start", {
    redirect_uri: REDIRECT,
    client_challenge: challenge,
    timezone: "America/Los_Angeles",
    device: { platform: "ios", id: user.deviceId, device_name: "iPhone" },
  });
  expect(started.status).toBe(200);
  const startBody = await started.json();
  const authorize = new URL(startBody.authorize_url);
  expect(authorize.searchParams.get("access_type")).toBe("offline");
  expect(authorize.searchParams.get("prompt")).toBe("consent");
  expect(authorize.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/photoslibrary.appendonly");
  expect(authorize.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata");
  const stateRow = await database
    .prepare("SELECT payload_json FROM oauth_states WHERE state_hash = ?")
    .bind(await sha256Hex(authorize.searchParams.get("state") ?? ""))
    .first<{ payload_json: string }>();
  const storedVerifier = JSON.parse(stateRow!.payload_json).pkce_verifier as string;
  expect(authorize.searchParams.get("code_challenge")).toBe(await sha256Base64Url(storedVerifier));
  pending = {
    nonce: authorize.searchParams.get("nonce") ?? "",
    sub: user.sub,
    email: user.email,
    name: user.name,
    refreshToken: user.refreshToken,
  };
  const callback = await app.request(
    `https://fitlogr.com/api/auth/google/callback?code=auth-code&state=${authorize.searchParams.get("state")}`,
    {},
    env(),
  );
  expect(callback.status).toBe(302);
  const location = new URL(callback.headers.get("location") ?? "");
  expect(location.protocol).toBe("fitlogr:");
  const exchangeCode = location.searchParams.get("exchange_code");
  expect(exchangeCode).toBeTruthy();
  const exchanged = await post("/api/auth/exchange", {
    exchange_code: exchangeCode,
    client_verifier: verifier,
    device: { platform: "ios", id: user.deviceId, device_name: "iPhone" },
  });
  expect(exchanged.status).toBe(200);
  const session = await exchanged.json();
  const settings = await get("/api/settings", session.access_token);
  const settingsBody = await settings.json();
  return {
    ...session,
    verifier,
    exchangeCode,
    settingsUpdatedAt: settingsBody.updated_at as string,
  };
}

function env() {
  return {
    DB: database,
    ENVIRONMENT: "test",
    GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    GOOGLE_OAUTH_REDIRECT_URI: "https://fitlogr.com/api/auth/google/callback",
    TOKEN_ENCRYPTION_KEY: encryptionKey(),
    SESSION_SECRET: "test-session-secret-with-enough-entropy",
    APP_URL: "https://fitlogr.com",
    API_BASE_URL: "https://fitlogr.com/api",
  };
}

function encryptionKey(): string {
  return btoa("0123456789abcdef0123456789abcdef");
}

async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (url === "https://oauth2.googleapis.com/token") {
    tokenBodies.push(String(init?.body ?? ""));
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

function del(path: string, token: string) {
  return app.request(
    `https://fitlogr.com${path}`,
    { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
    env(),
  );
}

function get(path: string, token?: string) {
  return app.request(
    `https://fitlogr.com${path}`,
    { headers: token ? { authorization: `Bearer ${token}` } : {} },
    env(),
  );
}
