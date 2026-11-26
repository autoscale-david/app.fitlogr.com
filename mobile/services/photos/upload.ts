import type { SQLiteDatabase } from "expo-sqlite";
import { File } from "expo-file-system";
import {
  AI_PHOTO_CONSENT_VERSION,
  type AnalyzePhotoResponse,
  type CheckHashesResponse,
  type PhotoReference,
  type PhotoSource,
} from "@fitlogr/shared";
import { ApiError, OfflineError, SessionExpired, api } from "../api";
import { deviceTimeZone, localDateISO } from "../dates";
import { readSetting, writeServerMeal, writeSetting, type MealItemRecord } from "../db";
import type { PreparedMealImage } from "./prepare";

export type ImportKind = "meal" | "not_meal" | "duplicate" | "skipped" | "offline" | "rate_limited" | "consent" | "error";

export interface ImportResult {
  kind: ImportKind;
  message: string;
  reconnect: boolean;
  /** Set when photo analysis is rate limited: wait this long before sending another photo. */
  retryAfterSeconds?: number;
}

/** True when this local photo was already handled and should not be prepared or sent again. */
export async function alreadyChecked(db: SQLiteDatabase, assetId: string): Promise<boolean> {
  const seen = await db.getFirstAsync<{ scan_status: string }>(
    "SELECT scan_status FROM local_media_assets WHERE local_asset_id = ?",
    assetId,
  );
  return Boolean(seen && seen.scan_status !== "pending" && seen.scan_status !== "error");
}

export async function importPreparedPhoto(
  db: SQLiteDatabase,
  image: PreparedMealImage,
  input: { capturedAt: string; localDate: string; source: PhotoSource; assetId?: string },
): Promise<ImportResult> {
  if ((await readSetting(db, "ai_photo_consent_version")) !== AI_PHOTO_CONSENT_VERSION) {
    return { kind: "consent", message: "Agree to photo analysis before sending a meal photo.", reconnect: false };
  }
  const assetId = input.assetId ?? image.sha256;
  if (await alreadyChecked(db, assetId)) {
    return { kind: "skipped", message: "That photo was already checked.", reconnect: false };
  }

  try {
    const hashes = await api.send<CheckHashesResponse>("POST", "/photos/check-hashes", {
      items: [
        {
          content_sha256: image.sha256,
          perceptual_hash: image.dhash,
          captured_at: input.capturedAt,
        },
      ],
    });
    const match = hashes.results[0];
    if (match && match.status !== "new") {
      await remember(db, assetId, image, input.capturedAt, match.status, match.photo_id);
      if (match.status === "excluded" || match.status === "non_meal") {
        return { kind: "skipped", message: "That photo was already skipped.", reconnect: false };
      }
      return { kind: "duplicate", message: "That meal photo is already logged.", reconnect: false };
    }

    const metadata = {
      content_sha256: image.sha256,
      perceptual_hash: image.dhash,
      captured_at: input.capturedAt,
      local_date: input.localDate,
      timezone: deviceTimeZone(),
      source: input.source,
    };
    const form = new FormData();
    form.append("metadata", JSON.stringify(metadata));
    form.append("image", { uri: image.uri, name: "meal.jpg", type: "image/jpeg" } as unknown as Blob);
    const analyzed = await api.upload<AnalyzePhotoResponse>("/photos/analyze", form);
    if (analyzed.meal) {
      await writeServerMeal(db, {
        id: analyzed.meal.id,
        localDate: analyzed.meal.local_date,
        name: analyzed.meal.name,
        eatenAt: analyzed.meal.eaten_at,
        caloriesKcal: analyzed.meal.calories_kcal,
        proteinG: analyzed.meal.protein_g,
        carbsG: analyzed.meal.carbs_g,
        fatG: analyzed.meal.fat_g,
        badge: analyzed.meal.is_user_edited ? "edited" : "ai",
        photoId: analyzed.photo.id,
        mealType: analyzed.meal.meal_type,
        timezone: analyzed.meal.timezone,
        isUserEdited: analyzed.meal.is_user_edited,
        updatedAt: analyzed.meal.updated_at,
        items: analyzed.meal.items.filter((item) => !item.deleted_at).map(toLocalItem),
      });
    }
    const reconnect = analyzed.google_reconnect_required === true;
    const googlePending = analyzed.outcome === "meal" && needsAlbumRetry(analyzed.photo);
    await remember(db, assetId, image, input.capturedAt, analyzed.outcome, analyzed.photo.id, googlePending);
    if (analyzed.outcome === "not_meal") {
      return { kind: "not_meal", message: "That doesn't look like a meal, so it wasn't added.", reconnect: false };
    }
    if (analyzed.outcome === "duplicate") return { kind: "duplicate", message: "That meal photo is already logged.", reconnect: false };
    if (reconnect) {
      return { kind: "meal", message: "The meal was saved. Reconnect Google to store the photo in your fitlogr album.", reconnect: true };
    }
    return { kind: "meal", message: analyzed.meal ? `Logged ${analyzed.meal.name}.` : "Meal photo analyzed.", reconnect: false };
  } catch (error) {
    if (error instanceof OfflineError) {
      await remember(db, assetId, image, input.capturedAt, "pending", null);
      return { kind: "offline", message: "You're offline. fitlogr will send this photo when you reconnect.", reconnect: false };
    }
    if (error instanceof SessionExpired) throw error;
    if (error instanceof ApiError && error.status === 429) {
      // Not remembered: the photo is sent again once the limit resets.
      const wait = error.retryAfterSeconds ?? 60;
      return { kind: "rate_limited", message: rateLimitMessage(wait), reconnect: false, retryAfterSeconds: wait };
    }
    if (error instanceof ApiError && error.code === "google_reconnect_required") {
      // Older servers reported a revoked Google grant as an error after saving the meal.
      await remember(db, assetId, image, input.capturedAt, "meal", null);
      return { kind: "meal", message: "The meal was saved. Reconnect Google to store the photo.", reconnect: true };
    }
    if (error instanceof ApiError && error.code === "AI_CONSENT_REQUIRED") {
      await writeSetting(db, "ai_photo_consent_pending", "1");
      return { kind: "consent", message: "Agree to photo analysis before sending a meal photo.", reconnect: false };
    }
    await remember(db, assetId, image, input.capturedAt, "error", null);
    const message = error instanceof ApiError ? error.message : "The photo could not be analyzed.";
    return { kind: "error", message, reconnect: false };
  }
}

/** "fitlogr can analyze more photos in about 4 minutes." / "...in about 3 hours." */
export function rateLimitMessage(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  const when = minutes < 90 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${Math.round(minutes / 60)} hours`;
  return `Photo analysis limit reached. fitlogr can analyze more photos in about ${when}.`;
}

function needsAlbumRetry(photo: PhotoReference): boolean {
  // "quota_exceeded" means the Google account is out of storage; a retry will not help until space is freed.
  return !photo.google_media_item_id && photo.google_status === "failed";
}

/**
 * Re-sends meal photos whose Google Photos album upload failed (outage, rate limit, revoked access).
 * Uses the same compressed JPEG that was analyzed, so the server can check it is the same photo.
 */
export async function retryAlbumUploads(db: SQLiteDatabase, limit = 5): Promise<number> {
  const rows = await db.getAllAsync<{ local_asset_id: string; uri: string | null; remote_photo_id: string | null }>(
    `SELECT local_asset_id, uri, remote_photo_id FROM local_media_assets
     WHERE google_pending = 1 AND remote_photo_id IS NOT NULL ORDER BY updated_at LIMIT ?`,
    limit,
  );
  let uploaded = 0;
  for (const row of rows) {
    const file = row.uri ? new File(row.uri) : null;
    if (!row.remote_photo_id || !file || !file.exists) {
      // The compressed copy was cleared from the cache; nothing left to send.
      await setAlbumPending(db, row.local_asset_id, false);
      continue;
    }
    const form = new FormData();
    form.append("image", { uri: file.uri, name: "meal.jpg", type: "image/jpeg" } as unknown as Blob);
    try {
      await api.upload<PhotoReference>(`/photos/${encodeURIComponent(row.remote_photo_id)}/google-upload`, form);
      await setAlbumPending(db, row.local_asset_id, false);
      uploaded += 1;
    } catch (error) {
      if (error instanceof ApiError && [400, 404, 409, 413, 415].includes(error.status)) {
        await setAlbumPending(db, row.local_asset_id, false);
        continue;
      }
      // Offline, revoked Google access, or Google still failing: keep it for the next sync.
      if (error instanceof OfflineError || error instanceof SessionExpired) throw error;
      if (error instanceof ApiError && error.code === "google_reconnect_required") break;
    }
  }
  return uploaded;
}

async function setAlbumPending(db: SQLiteDatabase, assetId: string, pending: boolean): Promise<void> {
  await db.runAsync("UPDATE local_media_assets SET google_pending = ? WHERE local_asset_id = ?", pending ? 1 : 0, assetId);
}

export function capturedToday(date = new Date()): { capturedAt: string; localDate: string } {
  return { capturedAt: date.toISOString(), localDate: localDateISO(date) };
}

async function remember(
  db: SQLiteDatabase,
  assetId: string,
  image: PreparedMealImage,
  capturedAt: string,
  status: string,
  photoId: string | null,
  googlePending = false,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO local_media_assets (
       local_asset_id, uri, content_sha256, perceptual_hash, captured_at, scan_status, remote_photo_id, google_pending, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(local_asset_id) DO UPDATE SET
       uri = excluded.uri,
       content_sha256 = excluded.content_sha256,
       perceptual_hash = excluded.perceptual_hash,
       scan_status = excluded.scan_status,
       remote_photo_id = COALESCE(excluded.remote_photo_id, local_media_assets.remote_photo_id),
       google_pending = excluded.google_pending,
       updated_at = excluded.updated_at`,
    assetId,
    image.uri,
    image.sha256,
    image.dhash,
    capturedAt,
    status,
    photoId,
    googlePending ? 1 : 0,
    new Date().toISOString(),
  );
}

function toLocalItem(item: {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  estimated_grams: number | null;
  calories_kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  is_user_edited: boolean;
}): MealItemRecord {
  return {
    id: item.id,
    name: item.name,
    quantity: item.quantity,
    unit: item.unit,
    estimatedGrams: item.estimated_grams,
    caloriesKcal: item.calories_kcal,
    proteinG: item.protein_g,
    carbsG: item.carbs_g,
    fatG: item.fat_g,
    isUserEdited: item.is_user_edited,
  };
}
