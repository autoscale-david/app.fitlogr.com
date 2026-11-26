import { AssetField, MediaSubtype, MediaType, Query, getPermissionsAsync, requestPermissionsAsync } from "expo-media-library";
import type { SQLiteDatabase } from "expo-sqlite";
import { localDateISO, timestampToDate } from "../dates";
import { prepareMealImage } from "./prepare";
import { importPreparedPhoto } from "./upload";

const LOOKBACK_MS = 48 * 60 * 60 * 1000;

export interface ScanResult {
  status: "imported" | "permission_denied" | "unavailable" | "empty";
  imported: number;
  message: string;
}

/**
 * Recent camera-roll scan. Native EAS builds can read the library. Expo Go and a denied
 * permission return a message instead of throwing, so Add meal photo still works.
 */
export async function scanRecentPhotos(db: SQLiteDatabase): Promise<ScanResult> {
  try {
    const current = await getPermissionsAsync(false, ["photo"]);
    const permission = current.granted ? current : await requestPermissionsAsync(false, ["photo"]);
    if (!permission.granted) {
      return {
        status: "permission_denied",
        imported: 0,
        message: permission.accessPrivileges === "limited"
          ? "Only selected photos are available. You can still add a meal photo."
          : "Photo library access is off. You can still add a meal photo.",
      };
    }
    const assets = await new Query()
      .eq(AssetField.MEDIA_TYPE, MediaType.IMAGE)
      .orderBy({ key: AssetField.CREATION_TIME, ascending: false })
      .limit(30)
      .exe();
    let imported = 0;
    const oldest = Date.now() - LOOKBACK_MS;
    for (const asset of assets) {
      const info = await asset.getInfo();
      if (info.mediaSubtypes?.includes(MediaSubtype.SCREENSHOT)) continue;
      if (/screenshot/i.test(info.filename)) continue;
      const captured = timestampToDate(info.creationTime) ?? timestampToDate(await asset.getCreationTime());
      if (captured && captured.getTime() < oldest) continue;
      const seen = await db.getFirstAsync<{ scan_status: string }>(
        "SELECT scan_status FROM local_media_assets WHERE local_asset_id = ?",
        info.id,
      );
      if (seen && seen.scan_status !== "pending" && seen.scan_status !== "error") continue;
      const uri = info.uri || (await asset.getUri());
      const prepared = await prepareMealImage(uri);
      const when = captured ?? new Date();
      const result = await importPreparedPhoto(db, prepared, {
        capturedAt: when.toISOString(),
        localDate: localDateISO(when),
        source: "device_library",
        assetId: info.id,
      });
      if (result.message.startsWith("Logged")) imported += 1;
      if (result.message.includes("offline")) break;
    }
    if (imported === 0) return { status: "empty", imported: 0, message: "No new meal photos in the last two days." };
    return { status: "imported", imported, message: imported === 1 ? "Found 1 meal photo." : `Found ${imported} meal photos.` };
  } catch {
    return {
      status: "unavailable",
      imported: 0,
      message: "Automatic library scan needs the native app. Add a meal photo still works here.",
    };
  }
}

export async function retryPendingPhotos(db: SQLiteDatabase): Promise<number> {
  const pending = await db.getAllAsync<{ local_asset_id: string; uri: string | null; captured_at: string | null }>(
    "SELECT local_asset_id, uri, captured_at FROM local_media_assets WHERE scan_status = 'pending' AND uri IS NOT NULL LIMIT 5",
  );
  let imported = 0;
  for (const row of pending) {
    if (!row.uri) continue;
    try {
      const prepared = await prepareMealImage(row.uri);
      const when = row.captured_at ? new Date(row.captured_at) : new Date();
      const result = await importPreparedPhoto(db, prepared, {
        capturedAt: when.toISOString(),
        localDate: localDateISO(when),
        source: "manual",
        assetId: row.local_asset_id,
      });
      if (result.message.startsWith("Logged")) imported += 1;
      if (result.message.includes("offline")) break;
    } catch {
      // Leave the row pending for the next sync.
    }
  }
  return imported;
}

