import type { SQLiteDatabase } from "expo-sqlite";
import { SessionExpired } from "../api";
import { localDateISO } from "../dates";
import { recordImport } from "../engine/photoPass";
import { prepareMealImage } from "./prepare";
import { importPreparedPhoto } from "./upload";

/** Sends photos that were saved locally while the phone was offline. */
/**
 * Sends photos the person added by hand while offline. Library photos are not handled here: the
 * engine's pipeline retries those, with the on-device labels and the photo-log bookkeeping.
 */
export async function retryPendingPhotos(db: SQLiteDatabase): Promise<number> {
  const pending = await db.getAllAsync<{ local_asset_id: string; uri: string | null; captured_at: string | null }>(
    `SELECT local_asset_id, uri, captured_at FROM local_media_assets
     WHERE scan_status = 'pending' AND uri IS NOT NULL
       AND local_asset_id NOT LIKE 'ph://%' AND local_asset_id NOT LIKE 'content://%'
     LIMIT 5`,
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
        forceMeal: true,
      });
      await recordImport(db, { assetId: row.local_asset_id, capturedAtMs: when.getTime(), source: "picker", preparedUri: prepared.uri, result }).catch(
        () => undefined,
      );
      if (result.kind === "meal") imported += 1;
      if (result.kind === "offline" || result.kind === "rate_limited") break;
    } catch (error) {
      if (error instanceof SessionExpired) throw error;
      // The compressed copy is gone or unreadable. Leave the row for the next sync.
    }
  }
  return imported;
}
