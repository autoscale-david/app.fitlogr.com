import { GOOGLE_SCOPES, googleScopes } from "../config";
import { readJwtKid, verifyRs256Jwt } from "../jwt";
import { ApiError } from "../http";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";

interface CachedJwks {
  keys: JsonWebKey[];
  expiresAt: number;
}

const jwksCache = new Map<string, CachedJwks>();

export function clearJwksCache(): void {
  jwksCache.clear();
}

export interface GoogleTokenSet {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string | null;
  idToken: string;
  scopes: string;
}

export function buildAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  includePickerScope?: boolean;
  includePhotosScopes?: boolean;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "scope",
    googleScopes({
      includePhotosScopes: input.includePhotosScopes,
      includePickerScope: input.includePickerScope === true,
    }).join(" "),
  );
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  return url.toString();
}

export async function exchangeGoogleCode(
  fetchImpl: typeof fetch,
  input: { code: string; clientId: string; clientSecret: string; redirectUri: string; codeVerifier: string },
  now: Date,
): Promise<GoogleTokenSet> {
  const body = new URLSearchParams({
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
    code_verifier: input.codeVerifier,
  });
  let response: Response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch {
    throw new ApiError(502, "GOOGLE_UPSTREAM_ERROR", "Google sign-in could not be completed");
  }
  if (!response.ok) {
    throw new ApiError(502, "GOOGLE_UPSTREAM_ERROR", "Google sign-in could not be completed");
  }
  const payload = (await response.json()) as {
    access_token?: unknown;
    expires_in?: unknown;
    refresh_token?: unknown;
    id_token?: unknown;
    scope?: unknown;
  };
  if (typeof payload.access_token !== "string" || typeof payload.id_token !== "string") {
    throw new ApiError(502, "GOOGLE_UPSTREAM_ERROR", "Google sign-in could not be completed");
  }
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
  return {
    accessToken: payload.access_token,
    accessTokenExpiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : null,
    idToken: payload.id_token,
    scopes: typeof payload.scope === "string" ? payload.scope : GOOGLE_SCOPES.join(" "),
  };
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string | null;
  picture: string | null;
}

export async function verifyGoogleIdToken(
  fetchImpl: typeof fetch,
  idToken: string,
  input: { clientId: string; nonce: string; now: Date },
): Promise<GoogleIdentity> {
  const kid = readJwtKid(idToken);
  if (!kid) throw new ApiError(401, "AUTH_INVALID", "Google identity token is not valid");
  const jwk = await loadJwk(fetchImpl, kid, input.now);
  if (!jwk) throw new ApiError(401, "AUTH_INVALID", "Google identity token is not valid");
  const payload = await verifyRs256Jwt(idToken, jwk);
  if (!payload) throw new ApiError(401, "AUTH_INVALID", "Google identity token is not valid");
  const iss = payload.iss;
  if (iss !== "https://accounts.google.com" && iss !== "accounts.google.com") {
    throw new ApiError(401, "AUTH_INVALID", "Google identity token is not valid");
  }
  const aud = payload.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(input.clientId)) throw new ApiError(401, "AUTH_INVALID", "Google identity token is not valid");
  if (typeof payload.exp !== "number" || payload.exp * 1000 < input.now.getTime() - 30_000) {
    throw new ApiError(401, "AUTH_INVALID", "Google identity token is not valid");
  }
  if (payload.nonce !== input.nonce) throw new ApiError(401, "AUTH_INVALID", "Google identity token is not valid");
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new ApiError(401, "AUTH_INVALID", "Google identity token is not valid");
  }
  if (typeof payload.email !== "string" || payload.email_verified !== true) {
    throw new ApiError(401, "AUTH_INVALID", "Google account email is not verified");
  }
  return {
    sub: payload.sub,
    email: payload.email,
    name: typeof payload.name === "string" ? payload.name.slice(0, 200) : null,
    picture: typeof payload.picture === "string" ? payload.picture.slice(0, 500) : null,
  };
}

async function loadJwk(fetchImpl: typeof fetch, kid: string, now: Date): Promise<JsonWebKey | null> {
  const cached = jwksCache.get(JWKS_URL);
  const keys = cached && cached.expiresAt > now.getTime() ? cached.keys : await fetchJwks(fetchImpl, now);
  const match = keys.find((key) => (key as JsonWebKey & { kid?: string }).kid === kid);
  return match ?? null;
}

async function fetchJwks(fetchImpl: typeof fetch, now: Date): Promise<JsonWebKey[]> {
  let response: Response;
  try {
    response = await fetchImpl(JWKS_URL);
  } catch {
    throw new ApiError(502, "GOOGLE_UPSTREAM_ERROR", "Google sign-in could not be completed");
  }
  if (!response.ok) throw new ApiError(502, "GOOGLE_UPSTREAM_ERROR", "Google sign-in could not be completed");
  const payload = (await response.json()) as { keys?: JsonWebKey[] };
  const keys = Array.isArray(payload.keys) ? payload.keys : [];
  const maxAge = cacheMaxAge(response.headers.get("cache-control"));
  if (maxAge > 0) {
    jwksCache.set(JWKS_URL, { keys, expiresAt: now.getTime() + maxAge * 1000 });
  }
  return keys;
}

function cacheMaxAge(header: string | null): number {
  const match = header?.match(/max-age=(\d+)/);
  return match ? Number(match[1]) : 0;
}
