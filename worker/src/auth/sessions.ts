import type { AccessClaims } from "../jwt";
import { signAccessToken, verifyAccessToken } from "../jwt";
import { sha256Hex, randomToken } from "../encoding";
import { addSeconds, nowIso, uuidv7 } from "../ids";
import { ACCESS_TOKEN_SECONDS, REFRESH_TOKEN_SECONDS } from "../config";
import { ApiError } from "../http";

export interface AuthContext {
  userId: string;
  sessionId: string;
  deviceId: string | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  device_id: string | null;
  expires_at: string;
  revoked_at: string | null;
}

export async function issueSession(
  db: D1Database,
  input: { userId: string; deviceId: string | null; sessionSecret: string; now: Date },
): Promise<{ accessToken: string; refreshToken: string; expiresAt: string; sessionId: string }> {
  const refreshToken = randomToken(32);
  const sessionId = uuidv7(input.now.getTime());
  const createdAt = nowIso(input.now);
  const refreshExpiresAt = addSeconds(input.now, REFRESH_TOKEN_SECONDS);
  const accessExpiresAt = addSeconds(input.now, ACCESS_TOKEN_SECONDS);
  await db
    .prepare(
      `INSERT INTO user_sessions
        (id, user_id, device_id, refresh_token_hash, expires_at, revoked_at, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .bind(sessionId, input.userId, input.deviceId, await sha256Hex(refreshToken), refreshExpiresAt, createdAt, createdAt)
    .run();
  const accessToken = await signSession(input.sessionSecret, {
    sub: input.userId,
    sid: sessionId,
    did: input.deviceId ?? "",
    iat: Math.floor(input.now.getTime() / 1000),
    exp: Math.floor(new Date(accessExpiresAt).getTime() / 1000),
    iss: "fitlogr",
  });
  return { accessToken, refreshToken, expiresAt: accessExpiresAt, sessionId };
}

export async function rotateSession(
  db: D1Database,
  refreshToken: string,
  sessionSecret: string,
  now: Date,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: string }> {
  const hash = await sha256Hex(refreshToken);
  const current = await db
    .prepare(
      `SELECT id, user_id, device_id, expires_at, revoked_at
       FROM user_sessions WHERE refresh_token_hash = ?`,
    )
    .bind(hash)
    .first<SessionRow>();
  if (!current) throw new ApiError(401, "AUTH_INVALID", "Refresh token is not valid");
  if (current.revoked_at) {
    await revokeDeviceSessions(db, current.user_id, current.device_id, now);
    throw new ApiError(401, "AUTH_INVALID", "Refresh token is not valid");
  }
  if (current.expires_at <= nowIso(now)) throw new ApiError(401, "AUTH_EXPIRED", "Refresh token expired");

  const nextRefresh = randomToken(32);
  const nextId = uuidv7(now.getTime());
  const stamp = nowIso(now);
  const refreshExpiresAt = addSeconds(now, REFRESH_TOKEN_SECONDS);
  const accessExpiresAt = addSeconds(now, ACCESS_TOKEN_SECONDS);
  await db.batch([
    db
      .prepare(
        `INSERT INTO user_sessions
          (id, user_id, device_id, refresh_token_hash, expires_at, revoked_at, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .bind(nextId, current.user_id, current.device_id, await sha256Hex(nextRefresh), refreshExpiresAt, stamp, stamp),
    db.prepare("UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(stamp, current.id),
  ]);
  const accessToken = await signSession(sessionSecret, {
    sub: current.user_id,
    sid: nextId,
    did: current.device_id ?? "",
    iat: Math.floor(now.getTime() / 1000),
    exp: Math.floor(new Date(accessExpiresAt).getTime() / 1000),
    iss: "fitlogr",
  });
  return { accessToken, refreshToken: nextRefresh, expiresAt: accessExpiresAt };
}

export async function authenticate(
  db: D1Database,
  authorization: string | undefined,
  sessionSecret: string,
  now: Date,
): Promise<AuthContext> {
  const token = bearer(authorization);
  if (!token) throw new ApiError(401, "AUTH_REQUIRED", "Sign in to continue");
  const claims = await verifyAccessToken(token, sessionSecret, Math.floor(now.getTime() / 1000));
  if (!claims) throw new ApiError(401, "AUTH_INVALID", "Sign in again");
  const session = await db
    .prepare("SELECT id, user_id, device_id, expires_at, revoked_at FROM user_sessions WHERE id = ?")
    .bind(claims.sid)
    .first<SessionRow>();
  if (!session || session.user_id !== claims.sub || session.revoked_at || session.expires_at <= nowIso(now)) {
    throw new ApiError(401, "AUTH_EXPIRED", "Sign in again");
  }
  return { userId: session.user_id, sessionId: session.id, deviceId: session.device_id };
}

export async function revokeSession(db: D1Database, sessionId: string, userId: string, now: Date): Promise<void> {
  await db
    .prepare("UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .bind(nowIso(now), sessionId, userId)
    .run();
}

export async function revokeAllSessions(db: D1Database, userId: string, now: Date): Promise<void> {
  await db
    .prepare("UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
    .bind(nowIso(now), userId)
    .run();
}

async function revokeDeviceSessions(db: D1Database, userId: string, deviceId: string | null, now: Date): Promise<void> {
  const stamp = nowIso(now);
  if (deviceId) {
    await db
      .prepare("UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL")
      .bind(stamp, userId, deviceId)
      .run();
    return;
  }
  await db
    .prepare("UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND device_id IS NULL AND revoked_at IS NULL")
    .bind(stamp, userId)
    .run();
}

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return token;
}

function signSession(secret: string, claims: AccessClaims): Promise<string> {
  return signAccessToken(claims, secret);
}
