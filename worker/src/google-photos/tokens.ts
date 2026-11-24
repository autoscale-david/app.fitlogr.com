import { decryptSecret, encryptSecret, oauthTokenAad } from "../crypto";
import type { Env } from "../env";
import { ApiError } from "../http";
import { nowIso } from "../ids";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const EXPIRY_MARGIN_MS = 120_000;

export const GOOGLE_RECONNECT = "google_reconnect_required";

interface TokenRow {
  encrypted_refresh_token: string;
  refresh_token_iv: string;
  encrypted_access_token: string | null;
  access_token_iv: string | null;
  access_token_expires_at: string | null;
  key_version: number;
  scopes: string;
  status: "active" | "revoked" | "error";
}

export async function googleFetch(
  db: D1Database,
  env: Env,
  userId: string,
  fetchImpl: typeof fetch,
  now: Date,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const first = await getGoogleAccessToken(db, env, userId, fetchImpl, now, false);
  const response = await fetchImpl(url, withBearer(init, first));
  if (response.status !== 401) return response;
  const refreshed = await getGoogleAccessToken(db, env, userId, fetchImpl, now, true);
  return fetchImpl(url, withBearer(init, refreshed));
}

export async function getGoogleAccessToken(
  db: D1Database,
  env: Env,
  userId: string,
  fetchImpl: typeof fetch,
  now: Date,
  forceRefresh: boolean,
): Promise<string> {
  const row = await loadToken(db, userId);
  if (row.status === "revoked") throw reconnect();
  const key = requireKey(env);
  const aad = oauthTokenAad(userId, row.key_version);
  if (!forceRefresh && row.encrypted_access_token && row.access_token_iv && row.access_token_expires_at) {
    const expires = Date.parse(row.access_token_expires_at);
    if (Number.isFinite(expires) && expires - EXPIRY_MARGIN_MS > now.getTime()) {
      try {
        return await decryptSecret(key, aad, { ciphertext: row.encrypted_access_token, iv: row.access_token_iv });
      } catch {
        // The cached access token cannot be read. Refresh instead.
      }
    }
  }
  let refreshToken: string;
  try {
    refreshToken = await decryptSecret(key, aad, { ciphertext: row.encrypted_refresh_token, iv: row.refresh_token_iv });
  } catch {
    await markRevoked(db, userId, now);
    throw reconnect();
  }
  const refreshed = await refreshAccessToken(fetchImpl, env, refreshToken);
  if (!refreshed) {
    await markRevoked(db, userId, now);
    throw reconnect();
  }
  const access = await encryptSecret(key, aad, refreshed.accessToken);
  const nextRefresh = refreshed.refreshToken ? await encryptSecret(key, aad, refreshed.refreshToken) : null;
  const expiresAt = new Date(now.getTime() + refreshed.expiresIn * 1000).toISOString();
  await db
    .prepare(
      `UPDATE user_oauth_tokens SET
         encrypted_access_token = ?,
         access_token_iv = ?,
         access_token_expires_at = ?,
         encrypted_refresh_token = COALESCE(?, encrypted_refresh_token),
         refresh_token_iv = COALESCE(?, refresh_token_iv),
         status = 'active',
         last_refreshed_at = ?,
         updated_at = ?
       WHERE user_id = ? AND provider = 'google'`,
    )
    .bind(
      access.ciphertext,
      access.iv,
      expiresAt,
      nextRefresh?.ciphertext ?? null,
      nextRefresh?.iv ?? null,
      nowIso(now),
      nowIso(now),
      userId,
    )
    .run();
  return refreshed.accessToken;
}

export async function markRevoked(db: D1Database, userId: string, now: Date): Promise<void> {
  await db
    .prepare("UPDATE user_oauth_tokens SET status = 'revoked', updated_at = ? WHERE user_id = ? AND provider = 'google'")
    .bind(nowIso(now), userId)
    .run();
}

async function loadToken(db: D1Database, userId: string): Promise<TokenRow> {
  const row = await db
    .prepare(
      `SELECT encrypted_refresh_token, refresh_token_iv, encrypted_access_token, access_token_iv,
              access_token_expires_at, key_version, scopes, status
       FROM user_oauth_tokens WHERE user_id = ? AND provider = 'google'`,
    )
    .bind(userId)
    .first<TokenRow>();
  if (!row) throw reconnect();
  if (!row.scopes.includes("photoslibrary")) throw reconnect();
  return row;
}

async function refreshAccessToken(
  fetchImpl: typeof fetch,
  env: Env,
  refreshToken: string,
): Promise<{ accessToken: string; expiresIn: number; refreshToken: string | null } | null> {
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new ApiError(503, "INTERNAL_ERROR", "Google sign-in is not configured");
  }
  let response: Response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GOOGLE_OAUTH_CLIENT_ID,
        client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
  } catch {
    throw new ApiError(502, "GOOGLE_UPSTREAM_ERROR", "Google Photos could not be reached");
  }
  const payload = (await response.json().catch(() => null)) as {
    access_token?: unknown;
    expires_in?: unknown;
    refresh_token?: unknown;
    error?: unknown;
  } | null;
  if (!response.ok || !payload || payload.error === "invalid_grant" || typeof payload.access_token !== "string") {
    if (payload?.error === "invalid_grant" || response.status === 400 || response.status === 401) return null;
    throw new ApiError(502, "GOOGLE_UPSTREAM_ERROR", "Google Photos could not be reached");
  }
  return {
    accessToken: payload.access_token,
    expiresIn: typeof payload.expires_in === "number" ? payload.expires_in : 3600,
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : null,
  };
}

function withBearer(init: RequestInit, token: string): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return { ...init, headers };
}

function requireKey(env: Env): string {
  if (!env.TOKEN_ENCRYPTION_KEY) throw new ApiError(503, "INTERNAL_ERROR", "Sign-in is not configured");
  return env.TOKEN_ENCRYPTION_KEY;
}

function reconnect(): ApiError {
  return new ApiError(403, GOOGLE_RECONNECT, "Google Photos access was revoked. Reconnect Google to keep saving meal photos.");
}
