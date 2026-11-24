import type { SQLiteDatabase } from "expo-sqlite";
import {
  AI_PHOTO_CONSENT_VERSION,
  type AnalyzePhotoResponse,
  type CheckHashesResponse,
  type PhotoSource,
} from "@fitlogr/shared";
import { ApiError, OfflineError, api } from "../api";
import { deviceTimeZone, localDateISO } from "../dates";
import { readSetting, writeServerMeal, writeSetting, type MealItemRecord } from "../db";
import type { PreparedMealImage } from "./prepare";

export interface ImportResult {
  message: string;
  reconnect: boolean;
}

export async function importPreparedPhoto(
  db: SQLiteDatabase,
  image: PreparedMealImage,
  input: { capturedAt: string; localDate: string; source: PhotoSource; assetId?: string },
): Promise<ImportResult> {
  if ((await readSetting(db, "ai_photo_consent_version")) !== AI_PHOTO_CONSENT_VERSION) {
    return { message: "Agree to photo analysis before sending a meal photo.", reconnect: false };
  }
  const assetId = input.assetId ?? image.sha256;
  const seen = await db.getFirstAsync<{ scan_status: string }>(
    "SELECT scan_status FROM local_media_assets WHERE local_asset_id = ?",
    assetId,
  );
  if (seen && seen.scan_status !== "pending" && seen.scan_status !== "error") {
    return { message: "That photo was already checked.", reconnect: false };
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
        return { message: "That photo was already skipped.", reconnect: false };
      }
      return { message: "That meal photo is already logged.", reconnect: false };
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
    await remember(db, assetId, image, input.capturedAt, analyzed.outcome, analyzed.photo.id);
    if (analyzed.outcome === "not_meal") return { message: "That doesn't look like a meal, so it wasn't added.", reconnect: false };
    if (analyzed.outcome === "duplicate") return { message: "That meal photo is already logged.", reconnect: false };
    return { message: analyzed.meal ? `Logged ${analyzed.meal.name}.` : "Meal photo analyzed.", reconnect: false };
  } catch (error) {
    if (error instanceof OfflineError) {
      await remember(db, assetId, image, input.capturedAt, "pending", null);
      return { message: "You're offline. fitlogr will send this photo when you reconnect.", reconnect: false };
    }
    if (error instanceof ApiError && error.code === "google_reconnect_required") {
      await remember(db, assetId, image, input.capturedAt, "meal", null);
      return { message: "The meal was saved. Reconnect Google to store the photo.", reconnect: true };
    }
    if (error instanceof ApiError && error.code === "AI_CONSENT_REQUIRED") {
      await writeSetting(db, "ai_photo_consent_pending", "1");
      return { message: "Agree to photo analysis before sending a meal photo.", reconnect: false };
    }
    await remember(db, assetId, image, input.capturedAt, "error", null);
    const message = error instanceof ApiError ? error.message : "The photo could not be analyzed.";
    return { message, reconnect: false };
  }
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
       local_asset_id, uri, content_sha256, perceptual_hash, captured_at, scan_status, remote_photo_id, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(local_asset_id) DO UPDATE SET
       uri = excluded.uri,
       content_sha256 = excluded.content_sha256,
       perceptual_hash = excluded.perceptual_hash,
       scan_status = excluded.scan_status,
       remote_photo_id = COALESCE(excluded.remote_photo_id, local_media_assets.remote_photo_id),
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
