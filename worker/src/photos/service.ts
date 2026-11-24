import {
  AnalyzePhotoMetadataSchema,
  PHOTO_LIMITS,
  atwaterWarning,
  isConfirmedMeal,
  matchHash,
  totalsFromVisionItems,
  type AnalyzePhotoResponse,
  type CheckHashItem,
  type CheckHashesResponse,
  type GooglePhotoStatus,
  type KnownPhotoHash,
  type MealVision,
  type MealVisionItem,
  type PhotoExcludeResponse,
  type PhotoReference,
  type PhotoStatus,
  type PhotoUrlResponse,
} from "@fitlogr/shared";
import { VisionFailed, analyzeMealVision, visionConfigFromEnv, type VisionAttempt } from "../ai/openrouter";
import { getMeal } from "../db/meals";
import { recomputeDailyIntake } from "../db/summaries";
import type { Env } from "../env";
import { fetchMealPhotoUrl, uploadMealPhoto, urlExpiresAt } from "../google-photos/library";
import { GOOGLE_RECONNECT } from "../google-photos/tokens";
import { ApiError } from "../http";
import { nowIso, uuidv7 } from "../ids";
import type { AppDeps } from "../types";

export class RateLimitError extends ApiError {
  readonly retryAfter: number;

  constructor(retryAfter = 60) {
    super(429, "RATE_LIMITED", "Too many meal photos today. Try again later.");
    this.retryAfter = retryAfter;
  }
}

interface PhotoRow {
  id: string;
  content_sha256: string;
  status: PhotoStatus;
  is_meal: number;
  google_media_item_id: string | null;
  google_status: GooglePhotoStatus;
  duplicate_of_photo_id: string | null;
  local_date: string;
  timezone: string;
}

export async function checkPhotoHashes(db: D1Database, userId: string, items: CheckHashItem[]): Promise<CheckHashesResponse> {
  const known = await loadKnown(db, userId, items.map((item) => item.content_sha256));
  return { results: items.map((item) => matchHash(item, known)) };
}

export async function analyzeUploadedPhoto(
  db: D1Database,
  env: Env,
  deps: AppDeps,
  userId: string,
  file: { bytes: Uint8Array; type: string },
  metadataRaw: unknown,
): Promise<{ status: 200 | 201; body: AnalyzePhotoResponse }> {
  await requireConsent(db, userId);
  if (file.bytes.byteLength > PHOTO_LIMITS.maxImageBytes) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Photo must be 2 MB or smaller");
  }
  if (!isJpeg(file)) throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Photo must be a JPEG");
  const parsed = AnalyzePhotoMetadataSchema.safeParse(metadataRaw);
  if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid photo");
  const metadata = parsed.data;
  const actualHash = await sha256Hex(file.bytes);
  if (actualHash !== metadata.content_sha256) throw new ApiError(400, "VALIDATION_ERROR", "Photo hash does not match");

  const now = deps.now();
  const known = await loadKnown(db, userId, [metadata.content_sha256]);
  const match = matchHash(metadata, known);
  if (match.status !== "new" && match.photo_id) {
    return duplicateResult(db, userId, metadata, match.photo_id, match.status, now);
  }

  await enforceRateLimit(db, userId, now);
  const photoId = metadata.client_photo_id && /^[A-Za-z0-9_-]{8,80}$/.test(metadata.client_photo_id) ? metadata.client_photo_id : uuidv7(now.getTime());
  const config = visionConfigFromEnv(env);
  let analysis: MealVision;
  let attempts: VisionAttempt[];
  try {
    const vision = await analyzeMealVision(deps.fetch, config, file.bytes);
    analysis = vision.analysis;
    attempts = vision.attempts;
  } catch (error) {
    if (error instanceof VisionFailed) {
      await logAttempts(db, userId, error.attempts, photoId, now);
      throw error;
    }
    throw error;
  }
  await logAttempts(db, userId, attempts, photoId, now);

  const stamp = nowIso(now);
  const deviceId = await ownedDevice(db, userId, metadata.device_id);
  if (!isConfirmedMeal(analysis, metadata.force_meal === true)) {
    await insertPhoto(db, {
      id: photoId,
      userId,
      deviceId,
      metadata,
      status: "analyzed_non_meal",
      isMeal: false,
      confidence: analysis.confidence,
      mediaItemId: null,
      albumId: null,
      googleStatus: "none",
      duplicateOf: null,
      stamp,
    });
    return {
      status: 200,
      body: {
        outcome: "not_meal",
        photo: await photoReference(db, userId, photoId),
        meal: null,
      },
    };
  }

  const items = analysis.items.length > 0 ? analysis.items : [placeholderItem(analysis)];
  const totals = totalsFromVisionItems(items);
  const mealName = (analysis.meal_name || "Meal").slice(0, 120);
  let mediaItemId: string | null = null;
  let albumId: string | null = null;
  let googleStatus: GooglePhotoStatus = "none";
  let reconnect = false;
  try {
    const uploaded = await uploadMealPhoto(
      db,
      env,
      userId,
      deps.fetch,
      now,
      file.bytes,
      `${mealName} — ${totals.calories_kcal} kcal (fitlogr estimate)`,
      `fitlogr-${photoId}.jpg`,
    );
    mediaItemId = uploaded.mediaItemId;
    albumId = uploaded.albumId;
    googleStatus = "uploaded";
  } catch (error) {
    if (error instanceof ApiError && error.code === "GOOGLE_QUOTA_EXCEEDED") googleStatus = "quota_exceeded";
    else if (error instanceof ApiError && error.code === GOOGLE_RECONNECT) {
      googleStatus = "failed";
      reconnect = true;
    } else if (error instanceof ApiError && error.code === "GOOGLE_UPSTREAM_ERROR") googleStatus = "failed";
    else throw error;
  }

  const notes = [analysis.notes, atwaterWarning(items)].filter((note): note is string => Boolean(note)).join(" ").slice(0, 500);
  const mealId = uuidv7(now.getTime() + 1);
  await insertPhoto(db, {
    id: photoId,
    userId,
    deviceId,
    metadata,
    status: "analyzed_meal",
    isMeal: true,
    confidence: analysis.confidence,
    mediaItemId,
    albumId,
    googleStatus,
    duplicateOf: null,
    stamp,
  });
  await db
    .prepare(
      `INSERT INTO meals (
         id, user_id, photo_id, name, meal_type, eaten_at, local_date, timezone,
         calories_kcal, protein_g, carbs_g, fat_g, ai_confidence, ai_notes,
         is_ai_estimate, is_user_edited, user_edited_at, created_at, updated_at, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, ?, ?, NULL)`,
    )
    .bind(
      mealId,
      userId,
      photoId,
      mealName,
      analysis.suggested_meal_type ?? "meal",
      metadata.captured_at,
      metadata.local_date,
      metadata.timezone,
      totals.calories_kcal,
      totals.protein_g,
      totals.carbs_g,
      totals.fat_g,
      analysis.confidence,
      notes || null,
      stamp,
      stamp,
    )
    .run();
  let offset = 2;
  for (const item of items) {
    await db
      .prepare(
        `INSERT INTO meal_items (
           id, meal_id, user_id, sort_order, name, quantity, unit, estimated_grams,
           calories_kcal, protein_g, carbs_g, fat_g, confidence, is_user_edited, created_at, updated_at, deleted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`,
      )
      .bind(
        uuidv7(now.getTime() + offset),
        mealId,
        userId,
        offset - 2,
        item.name,
        item.quantity,
        item.unit,
        item.estimated_grams,
        item.calories_kcal,
        item.protein_g,
        item.carbs_g,
        item.fat_g,
        item.confidence,
        stamp,
        stamp,
      )
      .run();
    offset += 1;
  }
  await recomputeDailyIntake(db, userId, metadata.local_date, metadata.timezone, stamp);
  if (reconnect) {
    throw new ApiError(403, GOOGLE_RECONNECT, "The meal was saved. Reconnect Google to store the photo in your fitlogr album.");
  }
  return {
    status: 201,
    body: {
      outcome: "meal",
      photo: await photoReference(db, userId, photoId),
      meal: await getMeal(db, userId, mealId),
    },
  };
}

export async function freshPhotoUrl(db: D1Database, env: Env, deps: AppDeps, userId: string, photoId: string): Promise<PhotoUrlResponse> {
  const row = await ownedPhoto(db, userId, photoId);
  if (!row) throw new ApiError(404, "NOT_FOUND", "Photo not found");
  if (!row.google_media_item_id) {
    return { photo_id: photoId, status: "unavailable", url: null, expires_at: null };
  }
  const now = deps.now();
  const lookedUp = await fetchMealPhotoUrl(db, env, userId, deps.fetch, now, row.google_media_item_id);
  if ("missing" in lookedUp) {
    await db
      .prepare("UPDATE photos SET google_status = 'missing', updated_at = ? WHERE id = ? AND user_id = ?")
      .bind(nowIso(now), photoId, userId)
      .run();
    return { photo_id: photoId, status: "missing", url: null, expires_at: null };
  }
  if ("quota" in lookedUp) {
    await db
      .prepare("UPDATE photos SET google_status = 'quota_exceeded', updated_at = ? WHERE id = ? AND user_id = ?")
      .bind(nowIso(now), photoId, userId)
      .run();
    return { photo_id: photoId, status: "quota_exceeded", url: null, expires_at: null };
  }
  return { photo_id: photoId, status: "ok", url: lookedUp.url, expires_at: urlExpiresAt(now) };
}

export async function excludePhoto(db: D1Database, userId: string, photoId: string, now: Date): Promise<PhotoExcludeResponse> {
  const row = await ownedPhoto(db, userId, photoId);
  if (!row) throw new ApiError(404, "NOT_FOUND", "Photo not found");
  const stamp = nowIso(now);
  await db
    .prepare("UPDATE photos SET status = 'excluded', is_meal = 0, updated_at = ? WHERE id = ? AND user_id = ?")
    .bind(stamp, photoId, userId)
    .run();
  const meal = await db
    .prepare("SELECT id, local_date, timezone FROM meals WHERE photo_id = ? AND user_id = ? AND deleted_at IS NULL")
    .bind(photoId, userId)
    .first<{ id: string; local_date: string; timezone: string }>();
  if (meal) {
    await db
      .prepare("UPDATE meals SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
      .bind(stamp, stamp, meal.id, userId)
      .run();
    await db
      .prepare("UPDATE meal_items SET deleted_at = ?, updated_at = ? WHERE meal_id = ? AND user_id = ? AND deleted_at IS NULL")
      .bind(stamp, stamp, meal.id, userId)
      .run();
    await recomputeDailyIntake(db, userId, meal.local_date, meal.timezone, stamp);
  }
  return { photo_id: photoId, status: "excluded", meal_id: meal?.id ?? null };
}

async function duplicateResult(
  db: D1Database,
  userId: string,
  metadata: { content_sha256: string; perceptual_hash?: string | null; captured_at: string; local_date: string; timezone: string; source?: "device_library" | "google_picker" | "manual"; device_id?: string },
  photoId: string,
  status: string,
  now: Date,
): Promise<{ status: 200; body: AnalyzePhotoResponse }> {
  const existing = await ownedPhoto(db, userId, photoId);
  if (existing && existing.content_sha256 !== metadata.content_sha256) {
    const stamp = nowIso(now);
    await insertPhoto(db, {
      id: uuidv7(now.getTime()),
      userId,
      deviceId: await ownedDevice(db, userId, metadata.device_id),
      metadata,
      status: "duplicate",
      isMeal: false,
      confidence: null,
      mediaItemId: null,
      albumId: null,
      googleStatus: "none",
      duplicateOf: photoId,
      stamp,
    });
  }
  const meal = await db
    .prepare("SELECT id FROM meals WHERE photo_id = ? AND user_id = ? AND deleted_at IS NULL")
    .bind(photoId, userId)
    .first<{ id: string }>();
  return {
    status: 200,
    body: {
      outcome: status === "non_meal" ? "not_meal" : "duplicate",
      photo: await photoReference(db, userId, photoId),
      meal: meal ? await getMeal(db, userId, meal.id) : null,
    },
  };
}

async function enforceRateLimit(db: D1Database, userId: string, now: Date): Promise<void> {
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const burstAgo = new Date(now.getTime() - PHOTO_LIMITS.burstWindowMs).toISOString();
  const daily = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM ai_requests
       WHERE user_id = ? AND request_type = 'meal_vision' AND status != 'rate_limited' AND created_at >= ?`,
    )
    .bind(userId, dayAgo)
    .first<{ n: number }>();
  const burst = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM ai_requests
       WHERE user_id = ? AND request_type = 'meal_vision' AND status != 'rate_limited' AND created_at >= ?`,
    )
    .bind(userId, burstAgo)
    .first<{ n: number }>();
  if ((daily?.n ?? 0) >= PHOTO_LIMITS.dailyVision || (burst?.n ?? 0) >= PHOTO_LIMITS.burstVision) {
    await insertAi(db, {
      userId,
      model: "rate-limit",
      fallbackUsed: false,
      promptTokens: null,
      completionTokens: null,
      estimatedCostUsd: null,
      latencyMs: 0,
      status: "rate_limited",
      relatedEntityId: null,
      now,
    });
    throw new RateLimitError((burst?.n ?? 0) >= PHOTO_LIMITS.burstVision ? 60 : 3600);
  }
}

async function requireConsent(db: D1Database, userId: string): Promise<void> {
  const row = await db
    .prepare("SELECT ai_consent_accepted_at FROM user_settings WHERE user_id = ?")
    .bind(userId)
    .first<{ ai_consent_accepted_at: string | null }>();
  if (!row?.ai_consent_accepted_at) {
    throw new ApiError(403, "AI_CONSENT_REQUIRED", "Agree to meal photo analysis before sending a photo");
  }
}

async function loadKnown(db: D1Database, userId: string, hashes: string[]): Promise<KnownPhotoHash[]> {
  const recent = await db
    .prepare(
      `SELECT p.id, p.content_sha256, p.perceptual_hash, p.status, m.id AS meal_id
       FROM photos p
       LEFT JOIN meals m ON m.photo_id = p.id AND m.user_id = p.user_id AND m.deleted_at IS NULL
       WHERE p.user_id = ? AND p.deleted_at IS NULL
       ORDER BY p.created_at DESC
       LIMIT 2000`,
    )
    .bind(userId)
    .all<KnownPhotoHash>();
  const byId = new Map(recent.results.map((photo) => [photo.id, photo]));
  if (hashes.length > 0) {
    const placeholders = hashes.map(() => "?").join(", ");
    const exact = await db
      .prepare(
        `SELECT p.id, p.content_sha256, p.perceptual_hash, p.status, m.id AS meal_id
         FROM photos p
         LEFT JOIN meals m ON m.photo_id = p.id AND m.user_id = p.user_id AND m.deleted_at IS NULL
         WHERE p.user_id = ? AND p.deleted_at IS NULL AND p.content_sha256 IN (${placeholders})`,
      )
      .bind(userId, ...hashes)
      .all<KnownPhotoHash>();
    for (const photo of exact.results) byId.set(photo.id, photo);
  }
  return [...byId.values()];
}

async function photoReference(db: D1Database, userId: string, photoId: string): Promise<PhotoReference> {
  const row = await ownedPhoto(db, userId, photoId);
  if (!row) throw new ApiError(404, "NOT_FOUND", "Photo not found");
  return {
    id: row.id,
    status: row.status,
    is_meal: row.is_meal === 1,
    google_media_item_id: row.google_media_item_id,
    google_status: row.google_status,
    content_sha256: row.content_sha256,
    duplicate_of_photo_id: row.duplicate_of_photo_id,
  };
}

async function ownedPhoto(db: D1Database, userId: string, photoId: string): Promise<PhotoRow | null> {
  return db
    .prepare(
      `SELECT id, content_sha256, status, is_meal, google_media_item_id, google_status, duplicate_of_photo_id, local_date, timezone
       FROM photos WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    )
    .bind(photoId, userId)
    .first<PhotoRow>();
}

async function ownedDevice(db: D1Database, userId: string, deviceId: string | undefined): Promise<string | null> {
  if (!deviceId) return null;
  const row = await db.prepare("SELECT id FROM user_devices WHERE id = ? AND user_id = ?").bind(deviceId, userId).first<{ id: string }>();
  return row?.id ?? null;
}

async function insertPhoto(
  db: D1Database,
  input: {
    id: string;
    userId: string;
    deviceId: string | null;
    metadata: { content_sha256: string; perceptual_hash?: string | null; captured_at: string; local_date: string; timezone: string; source?: string };
    status: PhotoStatus;
    isMeal: boolean;
    confidence: number | null;
    mediaItemId: string | null;
    albumId: string | null;
    googleStatus: GooglePhotoStatus;
    duplicateOf: string | null;
    stamp: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO photos (
         id, user_id, device_id, content_sha256, perceptual_hash, captured_at, local_date, timezone, source,
         status, is_meal, meal_confidence, google_media_item_id, google_album_id, google_status,
         duplicate_of_photo_id, created_at, updated_at, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      input.id,
      input.userId,
      input.deviceId,
      input.metadata.content_sha256,
      input.metadata.perceptual_hash ?? null,
      input.metadata.captured_at,
      input.metadata.local_date,
      input.metadata.timezone,
      input.metadata.source ?? "manual",
      input.status,
      input.isMeal ? 1 : 0,
      input.confidence,
      input.mediaItemId,
      input.albumId,
      input.googleStatus,
      input.duplicateOf,
      input.stamp,
      input.stamp,
    )
    .run();
}

async function logAttempts(db: D1Database, userId: string, attempts: VisionAttempt[], photoId: string, now: Date): Promise<void> {
  for (const attempt of attempts) {
    await insertAi(db, {
      userId,
      model: attempt.model,
      fallbackUsed: attempt.fallbackUsed,
      promptTokens: attempt.promptTokens,
      completionTokens: attempt.completionTokens,
      estimatedCostUsd: attempt.estimatedCostUsd,
      latencyMs: attempt.latencyMs,
      status: attempt.status,
      relatedEntityId: photoId,
      now,
    });
  }
}

async function insertAi(
  db: D1Database,
  input: {
    userId: string;
    model: string;
    fallbackUsed: boolean;
    promptTokens: number | null;
    completionTokens: number | null;
    estimatedCostUsd: number | null;
    latencyMs: number;
    status: "ok" | "schema_error" | "upstream_error" | "rate_limited";
    relatedEntityId: string | null;
    now: Date;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ai_requests (
         id, user_id, request_type, model, fallback_used, prompt_tokens, completion_tokens,
         estimated_cost_usd, latency_ms, status, related_entity_id, created_at
       ) VALUES (?, ?, 'meal_vision', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      uuidv7(input.now.getTime()),
      input.userId,
      input.model,
      input.fallbackUsed ? 1 : 0,
      input.promptTokens,
      input.completionTokens,
      input.estimatedCostUsd,
      input.latencyMs,
      input.status,
      input.relatedEntityId,
      nowIso(input.now),
    )
    .run();
}

function placeholderItem(analysis: MealVision): MealVisionItem {
  return {
    name: analysis.meal_name || "Meal",
    quantity: 1,
    unit: "serving",
    estimated_grams: null,
    calories_kcal: 0,
    protein_g: 0,
    carbs_g: 0,
    fat_g: 0,
    confidence: analysis.confidence,
  };
}

function isJpeg(file: { bytes: Uint8Array; type: string }): boolean {
  const type = file.type.toLowerCase();
  if (type && type !== "image/jpeg" && type !== "image/jpg") return false;
  return file.bytes.length > 3 && file.bytes[0] === 0xff && file.bytes[1] === 0xd8;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
