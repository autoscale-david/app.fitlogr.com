import type { SQLiteDatabase } from "expo-sqlite";
import { SessionExpired } from "../api";
import { localDateISO } from "../dates";
import { prepareLibraryPhoto } from "./library";
import { prepareMealImage } from "./prepare";
import { importPreparedPhoto } from "./upload";

/** Sends photos that were saved locally while the phone was offline. */
export async function retryPendingPhotos(db: SQLiteDatabase): Promise<number> {
  const pending = await db.getAllAsync<{ local_asset_id: string; uri: string | null; captured_at: string | null }>(
    "SELECT local_asset_id, uri, captured_at FROM local_media_assets WHERE scan_status = 'pending' AND uri IS NOT NULL LIMIT 5",
  );
  let imported = 0;
  for (const row of pending) {
    if (!row.uri) continue;
    try {
      const fromLibrary = /^(ph|content):\/\//.test(row.local_asset_id);
      const prepared = fromLibrary ? await prepareLibraryPhoto(row.local_asset_id) : await prepareMealImage(row.uri);
      const when = row.captured_at ? new Date(row.captured_at) : new Date();
      const result = await importPreparedPhoto(db, prepared, {
        capturedAt: when.toISOString(),
        localDate: localDateISO(when),
        source: fromLibrary ? "device_library" : "manual",
        assetId: row.local_asset_id,
      });
      if (result.kind === "meal") imported += 1;
      if (result.kind === "offline" || result.kind === "rate_limited") break;
    } catch (error) {
      if (error instanceof SessionExpired) throw error;
    }
  }
  return imported;
}
