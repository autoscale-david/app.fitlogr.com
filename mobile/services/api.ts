import Constants from "expo-constants";
import type { AuthSessionResponse, AuthRefreshResponse, EncodedUpload, MeResponse, Settings, SyncChangesResponse } from "@fitlogr/shared";
import { debugLog, describeError } from "./debugLog";
import { clearSession, readSession, saveSession } from "./session";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Seconds from the Retry-After header on a 429, when the server sent one. */
  readonly retryAfterSeconds: number | null;

  constructor(status: number, code: string, message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function retryAfter(response: Response): number | null {
  const value = Number(response.headers.get("retry-after"));
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : null;
}

/** The request never got an answer. Usually no connection; `reason` says what the system reported. */
export class OfflineError extends Error {
  readonly reason: string;

  constructor(reason = "") {
    super("You are offline");
    this.name = "OfflineError";
    this.reason = reason;
  }
}

/**
 * Sends one request and records it. Only a failure of the request itself becomes `OfflineError`.
 * Building the request happens before this is called, so a bug there is not reported as "offline".
 */
async function request(label: string, url: string, init: RequestInit, bytes?: number): Promise<Response> {
  const started = Date.now();
  const size = bytes === undefined ? "" : ` (${Math.round(bytes / 1024)} KB)`;
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    const reason = describeError(error);
    debugLog("api", `${label}${size} failed after ${Date.now() - started} ms: ${reason}`);
    throw new OfflineError(reason);
  }
  debugLog("api", `${label}${size} -> ${response.status} in ${Date.now() - started} ms`);
  return response;
}

export class SessionExpired extends Error {
  constructor() {
    super("Sign in again");
    this.name = "SessionExpired";
  }
}

export function apiBaseUrl(): string {
  const extra = Constants.expoConfig?.extra;
  if (extra && typeof extra === "object" && "apiBaseUrl" in extra && typeof extra.apiBaseUrl === "string") {
    return extra.apiBaseUrl.replace(/\/$/, "");
  }
  return "https://fitlogr.com/api";
}

let refreshing: Promise<void> | null = null;

async function refreshTokens(): Promise<void> {
  if (!refreshing) {
    refreshing = doRefresh().finally(() => {
      refreshing = null;
    });
  }
  await refreshing;
}

async function doRefresh(): Promise<void> {
  const current = await readSession();
  if (!current.refreshToken) throw new SessionExpired();
  const response = await request("POST /auth/refresh", `${apiBaseUrl()}/auth/refresh`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: current.refreshToken }),
  });
  if (response.status === 401) {
    await clearSession();
    throw new SessionExpired();
  }
  const payload = (await response.json().catch(() => null)) as AuthRefreshResponse | null;
  if (!response.ok || !payload?.access_token || !payload.refresh_token) {
    throw new ApiError(response.status, "AUTH_INVALID", "Could not refresh the session");
  }
  await saveSession(payload);
}

export async function apiRequest<T>(method: string, path: string, body?: unknown, authenticated = true): Promise<T> {
  return send<T>(method, path, body, authenticated, false);
}

async function send<T>(method: string, path: string, body: unknown, authenticated: boolean, retried: boolean): Promise<T> {
  const session = authenticated ? await readSession() : { accessToken: null, refreshToken: null, expiresAt: null };
  const response = await request(`${method} ${path.split("?")[0]}`, `${apiBaseUrl()}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(session.accessToken ? { authorization: `Bearer ${session.accessToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401 && authenticated && !retried && session.refreshToken && path !== "/auth/refresh") {
    await refreshTokens();
    return send<T>(method, path, body, authenticated, true);
  }
  const payload = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (!response.ok) {
    if (response.status === 401) throw new SessionExpired();
    debugLog("api", `${method} ${path.split("?")[0]} error: ${payload?.error?.code ?? "?"} ${payload?.error?.message ?? ""}`);
    throw new ApiError(
      response.status,
      payload?.error?.code ?? "INTERNAL_ERROR",
      payload?.error?.message ?? "Request failed",
      retryAfter(response),
    );
  }
  return payload as T;
}

export const api = {
  startGoogle: (body: unknown) => apiRequest<{ authorize_url: string; expires_at: string }>("POST", "/auth/google/start", body, false),
  exchange: (body: unknown) => apiRequest<AuthSessionResponse>("POST", "/auth/exchange", body, false),
  logout: () => apiRequest<{ ok: true }>("POST", "/auth/logout", {}),
  me: () => apiRequest<MeResponse>("GET", "/me"),
  putSettings: (body: unknown) => apiRequest<Settings>("PUT", "/settings", body),
  sync: (since?: string) =>
    apiRequest<SyncChangesResponse>("GET", `/sync/changes?limit=200${since ? `&since=${encodeURIComponent(since)}` : ""}`),
  send: apiRequest,
  upload: apiUpload,
};

/**
 * Posts a ready-made multipart body. The body is bytes, not `FormData`: Expo's fetch rejects React
 * Native's `{ uri, name, type }` file part, and that used to surface as "You're offline".
 */
export async function apiUpload<T>(path: string, upload: EncodedUpload): Promise<T> {
  return sendUpload<T>(path, upload, false);
}

async function sendUpload<T>(path: string, upload: EncodedUpload, retried: boolean): Promise<T> {
  const session = await readSession();
  const response = await request(
    `POST ${path}`,
    `${apiBaseUrl()}${path}`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": upload.contentType,
        ...(session.accessToken ? { authorization: `Bearer ${session.accessToken}` } : {}),
      },
      body: upload.body as unknown as BodyInit,
    },
    upload.body.byteLength,
  );
  if (response.status === 401 && !retried && session.refreshToken) {
    await refreshTokens();
    return sendUpload<T>(path, upload, true);
  }
  const payload = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (!response.ok) {
    if (response.status === 401) throw new SessionExpired();
    debugLog("api", `POST ${path} error: ${payload?.error?.code ?? "?"} ${payload?.error?.message ?? ""}`);
    throw new ApiError(
      response.status,
      payload?.error?.code ?? "INTERNAL_ERROR",
      payload?.error?.message ?? "Request failed",
      retryAfter(response),
    );
  }
  return payload as T;
}
