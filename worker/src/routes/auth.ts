import type { Hono } from "hono";
import {
  AuthExchangeRequestSchema,
  AuthRefreshRequestSchema,
  AuthStartRequestSchema,
  LogoutRequestSchema,
} from "@fitlogr/shared";
import { describeRejectedRedirect, isAllowedAppRedirect, redirectWithParams } from "../auth/redirects";
import { currentAuth, requireAuth } from "../auth/middleware";
import { issueSession, revokeAllSessions, revokeSession, rotateSession } from "../auth/sessions";
import { EXCHANGE_CODE_SECONDS, OAUTH_STATE_SECONDS, requireAuthConfig } from "../config";
import {
  consumeOauthState,
  getGoogleConnection,
  getUserProfile,
  listDevices,
  purgeExpiredStates,
  saveOauthState,
  storeGoogleTokens,
  touchDevice,
  upsertGoogleUser,
  type ExchangePayload,
  type OAuthStartPayload,
} from "../db/accounts";
import { getSettings } from "../db/settings";
import { randomToken, sha256Base64Url } from "../encoding";
import { ApiError, readJson, requireDb } from "../http";
import { addSeconds, nowIso } from "../ids";
import { buildAuthorizeUrl, exchangeGoogleCode, verifyGoogleIdToken } from "../services/google";
import type { AppEnv } from "../types";

export function registerAuthRoutes(app: Hono<AppEnv>): void {
  app.post("/api/auth/google/start", async (c) => {
    const config = requireAuthConfig(c.env);
    const db = requireDb(c.env.DB);
    const body = await readJson(c.req.raw, AuthStartRequestSchema);
    if (!isAllowedAppRedirect(body.redirect_uri)) {
      const described = describeRejectedRedirect(body.redirect_uri);
      console.warn("rejected app redirect", described);
      throw new ApiError(400, "VALIDATION_ERROR", `Redirect URL is not allowed (${described})`);
    }
    const now = c.get("deps").now();
    const stamp = nowIso(now);
    await purgeExpiredStates(db, stamp);
    const state = randomToken(32);
    const pkceVerifier = randomToken(32);
    const nonce = randomToken(32);
    const payload: OAuthStartPayload = {
      pkce_verifier: pkceVerifier,
      nonce,
      redirect_uri: body.redirect_uri,
      client_challenge: body.client_challenge,
      timezone: body.timezone ?? "UTC",
    };
    const expiresAt = addSeconds(now, OAUTH_STATE_SECONDS);
    await saveOauthState(db, { raw: state, kind: "oauth_start", userId: null, payload, expiresAt, now: stamp });
    return c.json({
      authorize_url: buildAuthorizeUrl({
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        state,
        nonce,
        codeChallenge: await sha256Base64Url(pkceVerifier),
        includePickerScope: body.include_picker_scope === true,
      }),
      expires_at: expiresAt,
    });
  });

  app.get("/api/auth/google/callback", async (c) => {
    const config = requireAuthConfig(c.env);
    const db = requireDb(c.env.DB);
    const now = c.get("deps").now();
    const state = c.req.query("state");
    if (!state) throw new ApiError(400, "VALIDATION_ERROR", "Sign-in state is missing");
    const payload = await consumeOauthState<OAuthStartPayload>(db, state, "oauth_start", nowIso(now));
    if (!payload || !isAllowedAppRedirect(payload.redirect_uri)) {
      throw new ApiError(400, "VALIDATION_ERROR", "Sign-in state is not valid");
    }
    const fail = (error: string) => c.redirect(redirectWithParams(payload.redirect_uri, { error }), 302);
    if (c.req.query("error")) return fail("access_denied");
    const code = c.req.query("code");
    if (!code) return fail("access_denied");
    try {
      const tokens = await exchangeGoogleCode(
        c.get("deps").fetch,
        {
          code,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          redirectUri: config.redirectUri,
          codeVerifier: payload.pkce_verifier,
        },
        now,
      );
      const identity = await verifyGoogleIdToken(c.get("deps").fetch, tokens.idToken, {
        clientId: config.clientId,
        nonce: payload.nonce,
        now,
      });
      if (!tokens.refreshToken) return fail("server_error");
      const userId = await upsertGoogleUser(db, identity, payload.timezone, now);
      const stamp = nowIso(now);
      await storeGoogleTokens(db, {
        userId,
        tokenKey: config.tokenKey,
        refreshToken: tokens.refreshToken,
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        scopes: tokens.scopes,
        now: stamp,
      });
      const exchangeCode = randomToken(32);
      const exchangePayload: ExchangePayload = { user_id: userId, client_challenge: payload.client_challenge };
      await saveOauthState(db, {
        raw: exchangeCode,
        kind: "app_exchange",
        userId,
        payload: exchangePayload,
        expiresAt: addSeconds(now, EXCHANGE_CODE_SECONDS),
        now: stamp,
      });
      return c.redirect(redirectWithParams(payload.redirect_uri, { exchange_code: exchangeCode }), 302);
    } catch (error) {
      if (error instanceof ApiError && error.message === "Google account email is not verified") return fail("email_required");
      if (error instanceof ApiError && error.status < 500) return fail("invalid_token");
      return fail("server_error");
    }
  });

  app.post("/api/auth/exchange", async (c) => {
    const config = requireAuthConfig(c.env);
    const db = requireDb(c.env.DB);
    const body = await readJson(c.req.raw, AuthExchangeRequestSchema);
    const now = c.get("deps").now();
    const payload = await consumeOauthState<ExchangePayload>(db, body.exchange_code, "app_exchange", nowIso(now));
    if (!payload) throw new ApiError(401, "AUTH_INVALID", "Sign-in code is not valid");
    const challenge = await sha256Base64Url(body.client_verifier);
    if (!safeEqual(challenge, payload.client_challenge)) {
      throw new ApiError(401, "AUTH_INVALID", "Sign-in code is not valid");
    }
    const deviceId = await touchDevice(db, payload.user_id, body.device, now);
    const session = await issueSession(db, { userId: payload.user_id, deviceId, sessionSecret: config.sessionSecret, now });
    const user = await getUserProfile(db, payload.user_id);
    return c.json({
      access_token: session.accessToken,
      refresh_token: session.refreshToken,
      expires_at: session.expiresAt,
      user,
    });
  });

  app.post("/api/auth/refresh", async (c) => {
    const config = requireAuthConfig(c.env);
    const db = requireDb(c.env.DB);
    const body = await readJson(c.req.raw, AuthRefreshRequestSchema);
    const session = await rotateSession(db, body.refresh_token, config.sessionSecret, c.get("deps").now());
    return c.json({
      access_token: session.accessToken,
      refresh_token: session.refreshToken,
      expires_at: session.expiresAt,
    });
  });

  app.post("/api/auth/logout", requireAuth(), async (c) => {
    const db = requireDb(c.env.DB);
    const auth = currentAuth(c.get("auth"));
    const now = c.get("deps").now();
    let all = c.req.query("all") === "true";
    if (c.req.header("content-type")?.includes("application/json")) {
      const text = await c.req.raw.clone().text();
      if (text.trim()) {
        const body = await readJson(new Request(c.req.url, { method: "POST", body: text }), LogoutRequestSchema);
        all = all || body.all === true;
      }
    }
    if (all) await revokeAllSessions(db, auth.userId, now);
    else await revokeSession(db, auth.sessionId, auth.userId, now);
    return c.json({ ok: true as const });
  });

  app.get("/api/me", requireAuth(), async (c) => {
    const db = requireDb(c.env.DB);
    const auth = currentAuth(c.get("auth"));
    const [user, settings, google, devices] = await Promise.all([
      getUserProfile(db, auth.userId),
      getSettings(db, auth.userId),
      getGoogleConnection(db, auth.userId),
      listDevices(db, auth.userId),
    ]);
    return c.json({ user, settings, google, devices });
  });
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}
