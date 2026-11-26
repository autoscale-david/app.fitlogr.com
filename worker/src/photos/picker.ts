import { PHOTO_LIMITS, PickerImportSummarySchema, type PickerImportSummary } from "@fitlogr/shared";
import { PICKER_SCOPE } from "../config";
import { base64UrlToJson, jsonToBase64Url } from "../encoding";
import { ApiError } from "../http";
import { localDateInTimeZone } from "../review/dates";
import { googleFetch } from "../google-photos/tokens";
import type { Env } from "../env";
import type { AppDeps } from "../types";
import { RateLimitError, analyzeUploadedPhoto } from "./service";

const PICKER_API = "https://photospicker.googleapis.com/v1";
/** What one import call handled before paging existed; older app builds still call this way. */
const LEGACY_IMPORT_LIMIT = 10;

export async function userHasPickerScope(db: D1Database, userId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT scopes, status FROM user_oauth_tokens WHERE user_id = ? AND provider = 'google'")
    .bind(userId)
    .first<{ scopes: string; status: string }>();
  if (!row || row.status === "revoked") return false;
  return row.scopes.includes(PICKER_SCOPE);
}

export function scopeRequired(): ApiError {
  return new ApiError(403, "SCOPE_REQUIRED", "Google Photos Picker access is not granted yet. Reconnect Google to allow it.");
}

export async function createPickerSession(
  db: D1Database,
  env: Env,
  deps: AppDeps,
  userId: string,
): Promise<{ session_id: string; picker_uri: string; polling_config: { poll_interval_ms: number; timeout_ms: number } }> {
  if (!(await userHasPickerScope(db, userId))) throw scopeRequired();
  const response = await googleFetch(db, env, userId, deps.fetch, deps.now(), `${PICKER_API}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pickingConfig: { maxItemCount: String(PHOTO_LIMITS.pickerMaxItems) } }),
  });
  const payload = await readJson(response);
  const sessionId = stringField(payload, "id");
  const pickerUri = stringField(payload, "pickerUri");
  if (!sessionId || !pickerUri) throw new ApiError(502, "UPSTREAM_ERROR", "Google Photos Picker did not return a session");
  const polling = recordField(payload, "pollingConfig");
  return {
    session_id: sessionId,
    picker_uri: pickerUri,
    polling_config: {
      poll_interval_ms: durationMs(stringField(polling, "pollInterval"), 5000),
      timeout_ms: durationMs(stringField(polling, "timeoutIn"), 300_000),
    },
  };
}

export async function pickerSessionStatus(
  db: D1Database,
  env: Env,
  deps: AppDeps,
  userId: string,
  sessionId: string,
): Promise<{ session_id: string; media_items_set: boolean }> {
  if (!(await userHasPickerScope(db, userId))) throw scopeRequired();
  const response = await googleFetch(db, env, userId, deps.fetch, deps.now(), `${PICKER_API}/sessions/${encodeURIComponent(sessionId)}`);
  const payload = await readJson(response);
  return { session_id: stringField(payload, "id") || sessionId, media_items_set: payload.mediaItemsSet === true };
}

interface PickerCursor {
  /** Google's page token for the page being worked on; null for the first page. */
  p: string | null;
  /** Items on that page already handled. */
  o: number;
}

/**
 * Imports one page of picked photos. The app calls again with `next_cursor` until it is null, so each
 * request stays small. When photo analysis is rate limited the cursor points at the first unhandled
 * photo and `retry_after_seconds` says when to resume. The session is deleted after the last page.
 */
export async function importPickerSession(
  db: D1Database,
  env: Env,
  deps: AppDeps,
  userId: string,
  sessionId: string,
  request: { cursor?: string; paged?: boolean } = {},
): Promise<PickerImportSummary> {
  if (!(await userHasPickerScope(db, userId))) throw scopeRequired();
  const paged = request.paged === true || Boolean(request.cursor);
  const cursor = decodeCursor(request.cursor);
  const settings = await db.prepare("SELECT timezone FROM user_settings WHERE user_id = ?").bind(userId).first<{ timezone: string }>();
  const timezone = settings?.timezone || "UTC";
  const url = new URL(`${PICKER_API}/mediaItems`);
  url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("pageSize", String(paged ? PHOTO_LIMITS.pickerPageSize : LEGACY_IMPORT_LIMIT));
  if (cursor.p) url.searchParams.set("pageToken", cursor.p);
  const listed = await googleFetch(db, env, userId, deps.fetch, deps.now(), url.toString());
  const payload = await readJson(listed);
  const items = Array.isArray(payload.mediaItems) ? payload.mediaItems : [];
  const nextPageToken = stringField(payload, "nextPageToken");
  const summary = { total_picked: 0, meals_imported: 0, non_meals_skipped: 0, duplicates_skipped: 0, errors: 0 };
  let resumeAt: PickerCursor | null = null;
  let retryAfter: number | null = null;
  for (let index = Math.min(cursor.o, items.length); index < items.length; index += 1) {
    try {
      const outcome = await importOne(db, env, deps, userId, timezone, items[index]);
      summary.total_picked += 1;
      if (outcome === "meal") summary.meals_imported += 1;
      else if (outcome === "not_meal") summary.non_meals_skipped += 1;
      else summary.duplicates_skipped += 1;
    } catch (error) {
      if (error instanceof RateLimitError && paged) {
        resumeAt = { p: cursor.p, o: index };
        retryAfter = error.retryAfter;
        break;
      }
      summary.total_picked += 1;
      summary.errors += 1;
    }
  }
  // An older app makes a single call and ignores the cursor, so that call finishes the session.
  const next = paged ? (resumeAt ?? (nextPageToken ? { p: nextPageToken, o: 0 } : null)) : null;
  if (!next) {
    try {
      await googleFetch(db, env, userId, deps.fetch, deps.now(), `${PICKER_API}/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    } catch {
      // The picked photos are already processed. Leaving the session is safe.
    }
  }
  return PickerImportSummarySchema.parse({
    ...summary,
    next_cursor: next ? jsonToBase64Url(next) : null,
    retry_after_seconds: retryAfter,
  });
}

function decodeCursor(raw: string | undefined): PickerCursor {
  if (!raw) return { p: null, o: 0 };
  try {
    const parsed = base64UrlToJson(raw) as Partial<PickerCursor> | null;
    const page = typeof parsed?.p === "string" && parsed.p.length > 0 ? parsed.p : null;
    const offset = typeof parsed?.o === "number" && Number.isInteger(parsed.o) && parsed.o >= 0 ? parsed.o : 0;
    return { p: page, o: offset };
  } catch {
    throw new ApiError(400, "VALIDATION_ERROR", "Picker cursor is not valid");
  }
}

async function importOne(
  db: D1Database,
  env: Env,
  deps: AppDeps,
  userId: string,
  timezone: string,
  item: unknown,
): Promise<"meal" | "not_meal" | "duplicate"> {
  if (!item || typeof item !== "object") throw new Error("bad item");
  const record = item as Record<string, unknown>;
  // Videos are not meal photos, and their thumbnail would cost a model call.
  if (stringField(record, "type") === "VIDEO") return "not_meal";
  const mediaFile = record.mediaFile;
  if (!mediaFile || typeof mediaFile !== "object") throw new Error("no file");
  const baseUrl = stringField(mediaFile as Record<string, unknown>, "baseUrl");
  if (!baseUrl) throw new Error("no url");
  const created = stringField(record, "createTime");
  const capturedAt = created && !Number.isNaN(Date.parse(created)) ? new Date(created).toISOString() : deps.now().toISOString();
  const localDate = localDateInTimeZone(new Date(capturedAt), timezone);
  const downloaded = await googleFetch(db, env, userId, deps.fetch, deps.now(), `${baseUrl}=w1280-h1280`);
  if (!downloaded.ok) throw new Error("download failed");
  const bytes = new Uint8Array(await downloaded.arrayBuffer());
  const hash = await sha256Hex(bytes);
  const result = await analyzeUploadedPhoto(
    db,
    env,
    deps,
    userId,
    { bytes, type: "image/jpeg" },
    {
      content_sha256: hash,
      // The Worker cannot decode a JPEG, so there is no real dHash here. Duplicates of a phone photo are
      // still caught by the exact hash or by the capture time (see matchHash).
      perceptual_hash: null,
      captured_at: capturedAt,
      local_date: localDate,
      timezone,
      source: "google_picker",
    },
  );
  if (result.body.outcome === "meal") return "meal";
  if (result.body.outcome === "not_meal") return "not_meal";
  return "duplicate";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw explainPickerFailure(response.status, payload);
  if (!payload || typeof payload !== "object") throw new ApiError(502, "UPSTREAM_ERROR", "Google Photos Picker returned an empty response");
  return payload as Record<string, unknown>;
}

/** Turns a Photos Picker HTTP error into a message that names the cause. */
export function explainPickerFailure(status: number, payload: unknown): ApiError {
  const { message, reason } = googleError(payload);
  const blob = `${reason} ${message}`.toLowerCase();
  if (
    reason === "SERVICE_DISABLED" ||
    reason === "accessNotConfigured" ||
    blob.includes("photospicker.googleapis.com") ||
    blob.includes("has not been used") ||
    blob.includes("api has not been used") ||
    (blob.includes("disabled") && blob.includes("picker"))
  ) {
    return new ApiError(
      403,
      "PICKER_API_DISABLED",
      "Google Photos Picker is not enabled for this Google Cloud project. Enable the Photos Picker API (photospicker.googleapis.com) in Google Cloud Console, then try again.",
    );
  }
  if (reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT" || blob.includes("insufficient authentication scopes")) {
    return new ApiError(
      403,
      "SCOPE_REQUIRED",
      "Google Photos Picker needs the photospicker.mediaitems.readonly permission. Reconnect Google Photos and allow it.",
    );
  }
  const detail = clip(message);
  return new ApiError(502, "UPSTREAM_ERROR", detail ? `Google Photos Picker request failed (${status}). ${detail}` : `Google Photos Picker request failed (${status}).`);
}

function googleError(payload: unknown): { message: string; reason: string } {
  if (!payload || typeof payload !== "object") return { message: "", reason: "" };
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") return { message: "", reason: "" };
  const record = error as { message?: unknown; status?: unknown; details?: unknown };
  const message = typeof record.message === "string" ? record.message : "";
  let reason = typeof record.status === "string" ? record.status : "";
  if (Array.isArray(record.details)) {
    for (const detail of record.details) {
      if (detail && typeof detail === "object" && typeof (detail as { reason?: unknown }).reason === "string") {
        reason = (detail as { reason: string }).reason;
        break;
      }
    }
  }
  return { message, reason };
}

function clip(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  if (!record) return null;
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function durationMs(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value);
  if (!match) return fallback;
  return Math.max(1000, Math.round(Number(match[1]) * 1000));
}
