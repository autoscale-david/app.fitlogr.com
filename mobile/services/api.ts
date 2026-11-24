import Constants from "expo-constants";
import type { AuthSessionResponse, AuthRefreshResponse, MeResponse, Settings, SyncChangesResponse } from "@fitlogr/shared";
import { clearSession, readSession, saveSession } from "./session";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export class OfflineError extends Error {
  constructor() {
    super("You are offline");
    this.name = "OfflineError";
  }
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
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}/auth/refresh`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: current.refreshToken }),
    });
  } catch {
    throw new OfflineError();
  }
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
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(session.accessToken ? { authorization: `Bearer ${session.accessToken}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new OfflineError();
  }
  if (response.status === 401 && authenticated && !retried && session.refreshToken && path !== "/auth/refresh") {
    await refreshTokens();
    return send<T>(method, path, body, authenticated, true);
  }
  const payload = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (!response.ok) {
    if (response.status === 401) throw new SessionExpired();
    throw new ApiError(response.status, payload?.error?.code ?? "INTERNAL_ERROR", payload?.error?.message ?? "Request failed");
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
};
