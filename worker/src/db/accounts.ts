import type { DeviceInfo, DeviceSummary, GoogleConnection, UserProfile } from "@fitlogr/shared";
import { oauthTokenAad, encryptSecret } from "../crypto";
import { sha256Hex } from "../encoding";
import { nowIso, uuidv7 } from "../ids";
import { ApiError } from "../http";

export interface OAuthStartPayload {
  pkce_verifier: string;
  nonce: string;
  redirect_uri: string;
  client_challenge: string;
  timezone: string;
}

export interface ExchangePayload {
  user_id: string;
  client_challenge: string;
}

export async function saveOauthState(
  db: D1Database,
  input: { raw: string; kind: "oauth_start" | "app_exchange"; userId: string | null; payload: unknown; expiresAt: string; now: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO oauth_states (state_hash, kind, user_id, payload_json, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(await sha256Hex(input.raw), input.kind, input.userId, JSON.stringify(input.payload), input.expiresAt, input.now)
    .run();
}

export async function consumeOauthState<T>(db: D1Database, raw: string, kind: "oauth_start" | "app_exchange", now: string): Promise<T | null> {
  const row = await db
    .prepare(
      `DELETE FROM oauth_states
       WHERE state_hash = ? AND kind = ? AND expires_at > ?
       RETURNING payload_json`,
    )
    .bind(await sha256Hex(raw), kind, now)
    .first<{ payload_json: string }>();
  if (!row) return null;
  return JSON.parse(row.payload_json) as T;
}

export async function purgeExpiredStates(db: D1Database, now: string): Promise<void> {
  await db.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").bind(now).run();
}

export async function upsertGoogleUser(
  db: D1Database,
  identity: { sub: string; email: string; name: string | null; picture: string | null },
  timezone: string,
  now: Date,
): Promise<string> {
  const stamp = nowIso(now);
  await db
    .prepare(
      `INSERT INTO users (id, google_sub, email, display_name, avatar_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(google_sub) DO UPDATE SET
         email = excluded.email,
         display_name = excluded.display_name,
         avatar_url = excluded.avatar_url,
         updated_at = excluded.updated_at`,
    )
    .bind(uuidv7(now.getTime()), identity.sub, identity.email, identity.name, identity.picture, stamp, stamp)
    .run();
  const user = await db.prepare("SELECT id FROM users WHERE google_sub = ?").bind(identity.sub).first<{ id: string }>();
  if (!user) throw new ApiError(500, "INTERNAL_ERROR", "Could not save the account");
  await db
    .prepare(
      `INSERT INTO user_settings (
         user_id, timezone, unit_system, daily_calorie_target_kcal, daily_protein_target_g,
         daily_carbs_target_g, daily_fat_target_g, updated_at
       ) VALUES (?, ?, 'imperial', 1900, 140, 210, 65, ?)
       ON CONFLICT(user_id) DO NOTHING`,
    )
    .bind(user.id, timezone || "UTC", stamp)
    .run();
  return user.id;
}

export async function storeGoogleTokens(
  db: D1Database,
  input: {
    userId: string;
    tokenKey: string;
    refreshToken: string;
    accessToken: string;
    accessTokenExpiresAt: string;
    scopes: string;
    now: string;
  },
): Promise<void> {
  const aad = oauthTokenAad(input.userId);
  const refresh = await encryptSecret(input.tokenKey, aad, input.refreshToken);
  const access = await encryptSecret(input.tokenKey, aad, input.accessToken);
  await db
    .prepare(
      `INSERT INTO user_oauth_tokens (
         user_id, provider, encrypted_refresh_token, refresh_token_iv, encrypted_access_token,
         access_token_iv, access_token_expires_at, key_version, scopes, status, last_refreshed_at, updated_at
       ) VALUES (?, 'google', ?, ?, ?, ?, ?, 1, ?, 'active', ?, ?)
       ON CONFLICT(user_id, provider) DO UPDATE SET
         encrypted_refresh_token = excluded.encrypted_refresh_token,
         refresh_token_iv = excluded.refresh_token_iv,
         encrypted_access_token = excluded.encrypted_access_token,
         access_token_iv = excluded.access_token_iv,
         access_token_expires_at = excluded.access_token_expires_at,
         key_version = excluded.key_version,
         scopes = excluded.scopes,
         status = 'active',
         last_refreshed_at = excluded.last_refreshed_at,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.userId,
      refresh.ciphertext,
      refresh.iv,
      access.ciphertext,
      access.iv,
      input.accessTokenExpiresAt,
      input.scopes,
      input.now,
      input.now,
    )
    .run();
}

export async function touchDevice(db: D1Database, userId: string, device: DeviceInfo | undefined, now: Date): Promise<string | null> {
  if (!device) return null;
  const stamp = nowIso(now);
  let id = device.id ?? uuidv7(now.getTime());
  const existing = await db.prepare("SELECT user_id FROM user_devices WHERE id = ?").bind(id).first<{ user_id: string }>();
  if (existing && existing.user_id !== userId) id = uuidv7(now.getTime() + 1);
  if (existing && existing.user_id === userId) {
    await db
      .prepare(
        `UPDATE user_devices
         SET platform = ?, device_name = ?, app_version = ?, os_version = ?, last_seen_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .bind(device.platform, device.device_name ?? null, device.app_version ?? null, device.os_version ?? null, stamp, id, userId)
      .run();
    return id;
  }
  await db
    .prepare(
      `INSERT INTO user_devices (id, user_id, platform, device_name, app_version, os_version, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, userId, device.platform, device.device_name ?? null, device.app_version ?? null, device.os_version ?? null, stamp, stamp)
    .run();
  return id;
}

export async function getUserProfile(db: D1Database, userId: string): Promise<UserProfile> {
  const row = await db
    .prepare("SELECT id, email, display_name, avatar_url FROM users WHERE id = ?")
    .bind(userId)
    .first<{ id: string; email: string; display_name: string | null; avatar_url: string | null }>();
  if (!row) throw new ApiError(404, "NOT_FOUND", "Account not found");
  return { id: row.id, email: row.email, display_name: row.display_name, avatar_url: row.avatar_url };
}

export async function getGoogleConnection(db: D1Database, userId: string): Promise<GoogleConnection> {
  const row = await db
    .prepare("SELECT status, scopes FROM user_oauth_tokens WHERE user_id = ? AND provider = 'google'")
    .bind(userId)
    .first<{ status: "active" | "revoked" | "error"; scopes: string }>();
  if (!row) return { connected: false, status: "missing", scopes: [] };
  return {
    connected: row.status === "active",
    status: row.status,
    scopes: row.scopes.split(" ").filter(Boolean),
  };
}

export async function listDevices(db: D1Database, userId: string): Promise<DeviceSummary[]> {
  const result = await db
    .prepare(
      `SELECT id, platform, device_name, last_seen_at
       FROM user_devices WHERE user_id = ? ORDER BY last_seen_at DESC`,
    )
    .bind(userId)
    .all<{ id: string; platform: DeviceSummary["platform"]; device_name: string | null; last_seen_at: string }>();
  return result.results;
}
