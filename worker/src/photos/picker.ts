import { PickerImportSummarySchema, dHashFromLuma, type PickerImportSummary } from "@fitlogr/shared";
import { PICKER_SCOPE } from "../config";
import { ApiError } from "../http";
import { localDateInTimeZone } from "../review/dates";
import { googleFetch } from "../google-photos/tokens";
import type { Env } from "../env";
import type { AppDeps } from "../types";
import { analyzeUploadedPhoto } from "./service";

const PICKER_API = "https://photospicker.googleapis.com/v1";
const MAX_IMPORT = 10;

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
    body: JSON.stringify({ pickingConfig: { maxItemCount: "100" } }),
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

export async function importPickerSession(
  db: D1Database,
  env: Env,
  deps: AppDeps,
  userId: string,
  sessionId: string,
): Promise<PickerImportSummary> {
  if (!(await userHasPickerScope(db, userId))) throw scopeRequired();
  const settings = await db.prepare("SELECT timezone FROM user_settings WHERE user_id = ?").bind(userId).first<{ timezone: string }>();
  const timezone = settings?.timezone || "UTC";
  const listed = await googleFetch(
    db,
    env,
    userId,
    deps.fetch,
    deps.now(),
    `${PICKER_API}/mediaItems?sessionId=${encodeURIComponent(sessionId)}&pageSize=${MAX_IMPORT}`,
  );
  const payload = await readJson(listed);
  const items = Array.isArray(payload.mediaItems) ? payload.mediaItems.slice(0, MAX_IMPORT) : [];
  const summary = { total_picked: items.length, meals_imported: 0, non_meals_skipped: 0, duplicates_skipped: 0, errors: 0 };
  for (const item of items) {
    try {
      const outcome = await importOne(db, env, deps, userId, timezone, item);
      if (outcome === "meal") summary.meals_imported += 1;
      else if (outcome === "not_meal") summary.non_meals_skipped += 1;
      else summary.duplicates_skipped += 1;
    } catch {
      summary.errors += 1;
    }
  }
  try {
    await googleFetch(db, env, userId, deps.fetch, deps.now(), `${PICKER_API}/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  } catch {
    // The picked photos are already processed. Leaving the session is safe.
  }
  return PickerImportSummarySchema.parse(summary);
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
      perceptual_hash: sampleDhash(bytes),
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

function sampleDhash(bytes: Uint8Array): string {
  const luma = new Uint8Array(9 * 8);
  for (let index = 0; index < luma.length; index += 1) luma[index] = bytes[index % Math.max(bytes.length, 1)] ?? 0;
  return dHashFromLuma(luma, 9, 8);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new ApiError(502, "UPSTREAM_ERROR", "Google Photos Picker request failed");
  const payload = (await response.json()) as unknown;
  if (!payload || typeof payload !== "object") throw new ApiError(502, "UPSTREAM_ERROR", "Google Photos Picker returned an empty response");
  return payload as Record<string, unknown>;
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
