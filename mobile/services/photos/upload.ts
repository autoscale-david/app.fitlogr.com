import type { SQLiteDatabase } from "expo-sqlite";
import {
  AI_PHOTO_CONSENT_VERSION,
  explicitPickReopens,
  type AnalyzePhotoResponse,
  type CheckHashesResponse,
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
  /** Set when photo analysis is rate limited: wait this long before sending another photo. */
  retryAfterSeconds?: number;
  /** Why a photo was skipped without analysis. `in_flight` means another pass is sending it right now. */
  skipReason?: "in_flight" | "already_checked" | "server_excluded" | "server_non_meal";
  remotePhotoId?: string | null;
  mealId?: string | null;
  name?: string;
  kcal?: number;
  classification?: "meal" | "workout" | "ignore" | null;
  confidence?: number | null;
  estimate?: unknown;
}

/** Photos being sent right now, so two scans running at once never upload the same photo twice. */
const inFlight = new Set<string>();

/** The server accepts at most this many on-device labels with a photo. */
const MAX_LABELS_SENT = 12;

/** True when this local photo was already handled (or is being sent) and should not be prepared again. */
export async function alreadyChecked(db: SQLiteDatabase, assetId: string): Promise<boolean> {
  if (inFlight.has(assetId)) return true;
  const seen = await db.getFirstAsync<{ scan_status: string }>(
    "SELECT scan_status FROM local_media_assets WHERE local_asset_id = ?",
    assetId,
  );
  // Queued photos still need analysis. Pending and error are retried too.
  return Boolean(seen && seen.scan_status !== "pending" && seen.scan_status !== "error" && seen.scan_status !== "queued");
}

export async function importPreparedPhoto(
  db: SQLiteDatabase,
  image: PreparedMealImage,
  input: {
    capturedAt: string;
    localDate: string;
    source: PhotoSource;
    assetId?: string;
    forceMeal?: boolean;
    onDeviceVerdict?: string;
    onDeviceLabels?: { id: string; confidence: number }[];
  },
): Promise<ImportResult> {
  if ((await readSetting(db, "ai_photo_consent_version")) !== AI_PHOTO_CONSENT_VERSION) {
    return { kind: "consent", message: "Agree to photo analysis before sending a meal photo." };
  }
  const assetId = input.assetId ?? image.sha256;
  // A deliberate pick overrides an earlier "not a meal" mark for this file.
  if (inFlight.has(assetId)) {
    return { kind: "skipped", message: "That photo is being checked right now.", skipReason: "in_flight" };
  }
  if (!input.forceMeal && (await alreadyChecked(db, assetId))) {
    return { kind: "skipped", message: "That photo was already checked.", skipReason: "already_checked" };
  }

  inFlight.add(assetId);
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
    if (match && match.status !== "new" && !explicitPickReopens(match.status, input.forceMeal === true)) {
      await remember(db, assetId, image, input.capturedAt, match.status, match.photo_id);
      if (match.status === "excluded" || match.status === "non_meal") {
        return {
          kind: "skipped",
          message: "That photo was already skipped.",
          skipReason: match.status === "excluded" ? "server_excluded" : "server_non_meal",
          remotePhotoId: match.photo_id,
        };
      }
      // The meal may exist only on the server. Ask analyze to return it so it can be written here.
      if (!input.forceMeal) {
        return { kind: "duplicate", message: "That meal photo is already logged.", remotePhotoId: match.photo_id, mealId: match.meal_id };
      }
    }

    const metadata = {
      content_sha256: image.sha256,
      perceptual_hash: image.dhash,
      captured_at: input.capturedAt,
      local_date: input.localDate,
      timezone: deviceTimeZone(),
      source: input.source,
      force_meal: input.forceMeal === true,
      // This app keeps the photo on the phone. Older builds omit the flag and still use the album.
      upload_to_google_photos: false,
      ...(input.onDeviceVerdict ? { on_device_verdict: input.onDeviceVerdict } : {}),
      ...(input.onDeviceLabels ? { on_device_labels: topLabels(input.onDeviceLabels) } : {}),
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
    // The stored state is what fitlogr did, not only what the model said: a "meal" the server was too
    // unsure to log must not read as a logged meal.
    const state =
      analyzed.outcome === "meal" ? "meal" : analyzed.outcome === "duplicate" ? "duplicate" : analyzed.classification === "workout" ? "workout" : "ignore";
    await remember(db, assetId, image, input.capturedAt, state, analyzed.photo.id);
    const shared = {
      remotePhotoId: analyzed.photo.id,
      mealId: analyzed.meal?.id ?? null,
      name: analyzed.meal?.name ?? analyzed.estimate?.items[0]?.name,
      kcal: analyzed.estimate?.kcal ?? analyzed.meal?.calories_kcal,
      classification: analyzed.classification ?? null,
      confidence: analyzed.estimate?.confidence ?? null,
      estimate: analyzed.estimate ?? null,
    };
    if (analyzed.outcome === "not_meal") {
      const workout = analyzed.classification === "workout";
      return { kind: "not_meal", message: workout ? "Workout photo recorded." : "That doesn't look like a meal, so it wasn't added.", ...shared };
    }
    if (analyzed.outcome === "duplicate") return { kind: "duplicate", message: "That meal photo is already logged.", ...shared };
    return { kind: "meal", message: analyzed.meal ? `Logged ${analyzed.meal.name}.` : "Meal photo analyzed.", ...shared };
  } catch (error) {
    if (error instanceof OfflineError) {
      await remember(db, assetId, image, input.capturedAt, "pending", null);
      return { kind: "offline", message: "You're offline. fitlogr will send this photo when you reconnect." };
    }
    if (error instanceof SessionExpired) throw error;
    if (error instanceof ApiError && error.status === 429) {
      // Not remembered: the photo is sent again once the limit resets.
      const wait = error.retryAfterSeconds ?? 60;
      return { kind: "rate_limited", message: rateLimitMessage(wait), retryAfterSeconds: wait };
    }
    if (error instanceof ApiError && error.code === "AI_CONSENT_REQUIRED") {
      await writeSetting(db, "ai_photo_consent_pending", "1");
      return { kind: "consent", message: "Agree to photo analysis before sending a meal photo." };
    }
    await remember(db, assetId, image, input.capturedAt, "error", null);
    const message = error instanceof ApiError ? error.message : "The photo could not be analyzed.";
    return { kind: "error", message };
  } finally {
    inFlight.delete(assetId);
  }
}

/** The strongest labels, clipped to what the server's schema accepts. */
function topLabels(labels: { id: string; confidence: number }[]): { id: string; confidence: number }[] {
  return [...labels]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_LABELS_SENT)
    .map((label) => ({ id: label.id.slice(0, 160), confidence: Math.min(1, Math.max(0, label.confidence)) }));
}

/** "fitlogr can analyze more photos in about 4 minutes." / "...in about 3 hours." */
export function rateLimitMessage(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  const when = minutes < 90 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${Math.round(minutes / 60)} hours`;
  return `Photo analysis limit reached. fitlogr can analyze more photos in about ${when}.`;
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
): Promise<void> {
  await db.runAsync(
    `INSERT INTO local_media_assets (
       local_asset_id, uri, content_sha256, perceptual_hash, captured_at, scan_status, remote_photo_id, google_pending, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(local_asset_id) DO UPDATE SET
       uri = excluded.uri,
       content_sha256 = excluded.content_sha256,
       perceptual_hash = excluded.perceptual_hash,
       scan_status = excluded.scan_status,
       remote_photo_id = COALESCE(excluded.remote_photo_id, local_media_assets.remote_photo_id),
       google_pending = 0,
       updated_at = excluded.updated_at`,
    assetId,
    image.uri,
    image.sha256,
    image.dhash,
    capturedAt,
    status,
    photoId,
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
