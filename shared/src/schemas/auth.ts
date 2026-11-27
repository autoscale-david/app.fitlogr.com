import { z } from "zod";

export const DevicePlatformSchema = z.enum(["ios", "android", "web"]);
export type DevicePlatform = z.infer<typeof DevicePlatformSchema>;

export const DeviceInfoSchema = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,80}$/)
    .optional(),
  platform: DevicePlatformSchema,
  device_name: z.string().max(120).optional(),
  app_version: z.string().max(40).optional(),
  os_version: z.string().max(80).optional(),
});
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

export const AuthStartRequestSchema = z.object({
  redirect_uri: z.string().min(1).max(500),
  client_challenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  device: DeviceInfoSchema.optional(),
  timezone: z.string().min(1).max(80).optional(),
  include_picker_scope: z.boolean().optional(),
  /**
   * When false, sign-in asks only for openid, email, and profile.
   * Absent keeps today's Photos scopes, so builds already on phones keep working.
   */
  include_photos_scopes: z.boolean().optional(),
});
export type AuthStartRequest = z.infer<typeof AuthStartRequestSchema>;

export const AuthStartResponseSchema = z.object({
  authorize_url: z.url(),
  expires_at: z.iso.datetime(),
});
export type AuthStartResponse = z.infer<typeof AuthStartResponseSchema>;

export const AuthExchangeRequestSchema = z.object({
  exchange_code: z.string().min(20).max(300),
  client_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  device: DeviceInfoSchema.optional(),
});
export type AuthExchangeRequest = z.infer<typeof AuthExchangeRequestSchema>;

export const UserProfileSchema = z.object({
  id: z.string(),
  email: z.string(),
  display_name: z.string().nullable(),
  avatar_url: z.string().nullable(),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

export const AuthSessionResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_at: z.iso.datetime(),
  user: UserProfileSchema,
});
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;

export const AuthRefreshRequestSchema = z.object({
  refresh_token: z.string().min(20).max(300),
});
export type AuthRefreshRequest = z.infer<typeof AuthRefreshRequestSchema>;

export const AuthRefreshResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_at: z.iso.datetime(),
});
export type AuthRefreshResponse = z.infer<typeof AuthRefreshResponseSchema>;

export const LogoutRequestSchema = z.object({
  all: z.boolean().optional(),
});
export type LogoutRequest = z.infer<typeof LogoutRequestSchema>;

export const GoogleConnectionSchema = z.object({
  connected: z.boolean(),
  status: z.enum(["active", "revoked", "error", "missing"]),
  scopes: z.array(z.string()),
});
export type GoogleConnection = z.infer<typeof GoogleConnectionSchema>;

export const DeviceSummarySchema = z.object({
  id: z.string(),
  platform: DevicePlatformSchema,
  device_name: z.string().nullable(),
  last_seen_at: z.iso.datetime(),
});
export type DeviceSummary = z.infer<typeof DeviceSummarySchema>;
