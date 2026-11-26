import Constants, { ExecutionEnvironment } from "expo-constants";
import { AssetField, MediaSubtype, MediaType, Query, getPermissionsAsync, requestPermissionsAsync } from "expo-media-library";
import type { SQLiteDatabase } from "expo-sqlite";
import { localDateISO, timestampToDate } from "../dates";
import { prepareMealImage } from "./prepare";
import { importPreparedPhoto } from "./upload";

export interface HistoryProgress {
  scanned: number;
  skipped: number;
  meals: number;
  nonMeals: number;
  errors: number;
}

export interface HistoryScanResult extends HistoryProgress {
  status: "imported" | "permission_denied" | "unavailable" | "cancelled" | "empty";
  capped: boolean;
  message: string;
}

const EXPO_GO_MESSAGE =
  "Full photo library scan runs in the native iOS preview build. Google Photos Picker and the manual photo picker work in Expo Go right now.";

export async function scanMealPhotosFromPastDays(
  db: SQLiteDatabase,
  options: {
    days: number;
    maxPhotosPerRun?: number;
    onProgress?: (progress: HistoryProgress) => void;
    signal?: AbortSignal;
  },
): Promise<HistoryScanResult> {
  const progress: HistoryProgress = { scanned: 0, skipped: 0, meals: 0, nonMeals: 0, errors: 0 };
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) {
    return { ...progress, status: "unavailable", capped: false, message: EXPO_GO_MESSAGE };
  }
  const days = Math.min(365, Math.max(1, Math.round(options.days)));
  const cap = options.maxPhotosPerRun ?? 100;
  try {
    const current = await getPermissionsAsync(false, ["photo"]);
    const permission = current.granted ? current : await requestPermissionsAsync(false, ["photo"]);
    if (!permission.granted) {
      return {
        ...progress,
        status: "permission_denied",
        capped: false,
        message: "Photo library access is off. You can still pick photos or use Google Photos.",
      };
    }
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let offset = 0;
    let capped = false;
    let unseen = 0;
    let reachedOlder = false;
    while (unseen < cap && !reachedOlder) {
      if (options.signal?.aborted) return { ...progress, status: "cancelled", capped, message: "Import cancelled." };
      // Keep the date window in JS. A native creation-time predicate that disagrees
      // on seconds versus milliseconds matches no photos, so the import saves nothing.
      const assets = await new Query()
        .eq(AssetField.MEDIA_TYPE, MediaType.IMAGE)
        .orderBy({ key: AssetField.CREATION_TIME, ascending: false })
        .limit(40)
        .offset(offset)
        .exe();
      if (assets.length === 0) break;
      offset += assets.length;
      for (const asset of assets) {
        if (options.signal?.aborted) return { ...progress, status: "cancelled", capped, message: "Import cancelled." };
        if (unseen >= cap) break;
        const info = await asset.getInfo();
        const captured = timestampToDate(info.creationTime) ?? timestampToDate(await asset.getCreationTime());
        if (captured && captured.getTime() < cutoff) {
          reachedOlder = true;
          break;
        }
        progress.scanned += 1;
        const filename = typeof info.filename === "string" ? info.filename : "";
        if (info.mediaSubtypes?.includes(MediaSubtype.SCREENSHOT) || /screenshot/i.test(filename)) {
          progress.skipped += 1;
          options.onProgress?.({ ...progress });
          continue;
        }
        if (!captured) {
          progress.skipped += 1;
          options.onProgress?.({ ...progress });
          continue;
        }
        unseen += 1;
        try {
          const uri = info.uri || (await asset.getUri());
          const prepared = await prepareMealImage(uri);
          const result = await importPreparedPhoto(db, prepared, {
            capturedAt: captured.toISOString(),
            localDate: localDateISO(captured),
            source: "device_library",
            assetId: info.id,
          });
          if (result.message.startsWith("Logged")) progress.meals += 1;
          else if (result.message.includes("already") || result.message.includes("skipped")) progress.skipped += 1;
          else if (result.message.includes("doesn't look like a meal")) progress.nonMeals += 1;
          else if (result.message.includes("offline") || result.message.includes("could not")) progress.errors += 1;
          else progress.skipped += 1;
        } catch {
          progress.errors += 1;
        }
        options.onProgress?.({ ...progress });
      }
      if (unseen >= cap) capped = true;
    }
    const message = capped
      ? `Checked ${progress.scanned} photos and logged ${progress.meals} meals. Scan again to continue.`
      : progress.meals > 0
        ? `Logged ${progress.meals} meal${progress.meals === 1 ? "" : "s"} from the last ${days} days.`
        : `No new meal photos in the last ${days} days.`;
    return { ...progress, status: progress.meals > 0 ? "imported" : "empty", capped, message };
  } catch {
    return { ...progress, status: "unavailable", capped: false, message: EXPO_GO_MESSAGE };
  }
}

