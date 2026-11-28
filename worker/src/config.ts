import { PHOTO_LIMITS } from "@fitlogr/shared";
import type { Env } from "./env";
import { ApiError } from "./http";

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenKey: string;
  sessionSecret: string;
}

export function requireAuthConfig(env: Env): AuthConfig {
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET || !env.TOKEN_ENCRYPTION_KEY || !env.SESSION_SECRET) {
    throw new ApiError(503, "INTERNAL_ERROR", "Sign-in is not configured");
  }
  return {
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI || "https://fitlogr.com/api/auth/google/callback",
    tokenKey: env.TOKEN_ENCRYPTION_KEY,
    sessionSecret: env.SESSION_SECRET,
  };
}

export const IDENTITY_SCOPES = ["openid", "email", "profile"] as const;

export const GOOGLE_SCOPES = [
  ...IDENTITY_SCOPES,
  "https://www.googleapis.com/auth/photoslibrary.appendonly",
  "https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata",
] as const;

export const PICKER_SCOPE = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";

/** Identity only when the phone opts out. Otherwise today's Photos scopes, plus the picker when asked. */
export function googleScopes(options: { includePhotosScopes?: boolean; includePickerScope?: boolean } = {}): string[] {
  if (options.includePhotosScopes === false) return [...IDENTITY_SCOPES];
  return options.includePickerScope ? [...GOOGLE_SCOPES, PICKER_SCOPE] : [...GOOGLE_SCOPES];
}

/** Positive integers only. Anything else falls back to the shared default. */
export function visionLimits(env: Env): { burst: number; daily: number } {
  return {
    burst: positiveLimit(env.VISION_BURST_LIMIT, PHOTO_LIMITS.burstVision),
    daily: positiveLimit(env.VISION_DAILY_LIMIT, PHOTO_LIMITS.dailyVision),
  };
}

function positiveLimit(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100_000) return fallback;
  return parsed;
}

export const ACCESS_TOKEN_SECONDS = 60 * 60;
export const REFRESH_TOKEN_SECONDS = 90 * 24 * 60 * 60;
/** A just-rotated refresh token is accepted once more for this long (lost-response retries). */
export const REFRESH_ROTATION_GRACE_SECONDS = 120;
export const OAUTH_STATE_SECONDS = 10 * 60;
export const EXCHANGE_CODE_SECONDS = 60;
