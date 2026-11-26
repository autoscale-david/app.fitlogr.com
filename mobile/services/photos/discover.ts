import type { SQLiteDatabase } from "expo-sqlite";
import { SessionExpired } from "../api";
import { localDateISO } from "../dates";
import { LIMITED_ACCESS_NOTE, libraryAccess, prepareLibraryPhoto, walkLibraryPhotos, type LibraryAccess } from "./library";
import { prepareMealImage } from "./prepare";
import { alreadyChecked, importPreparedPhoto } from "./upload";

const LOOKBACK_MS = 48 * 60 * 60 * 1000;
/** New photos sent for analysis in one scan. The next scan continues with the rest. */
const MAX_NEW_PER_SCAN = 30;

export interface ScanResult {
  status: "imported" | "permission_denied" | "unavailable" | "empty";
  imported: number;
  message: string;
  /** Something the person should know even after an automatic scan (limited access, analysis limit). */
  notice: string | null;
  access: LibraryAccess | null;
}

/**
 * Recent camera-roll scan: non-screenshot photos from the last two days that fitlogr has not checked
 * yet. Already-checked photos are skipped from metadata alone, and a photo that cannot be loaded is
 * skipped without stopping the scan. `onSend` fires when the first new photo is about to be analyzed,
 * and `onMeal` as each meal is logged, so the Log can show progress and update live.
 */
export async function scanRecentPhotos(
  db: SQLiteDatabase,
  options?: { ask?: boolean; onMeal?: () => void; onSend?: () => void },
): Promise<ScanResult> {
  let access: LibraryAccess;
  try {
    access = await libraryAccess(options?.ask !== false);
  } catch {
    return {
      status: "unavailable",
      imported: 0,
      message: "Automatic library scan needs the native app. Add a meal photo still works here.",
      notice: null,
      access: null,
    };
  }
  if (access === "denied" || access === "undetermined") {
    return {
      status: "permission_denied",
      imported: 0,
      message: "Photo library access is off. You can still add a meal photo.",
      notice: null,
      access,
    };
  }

  // Counters live on an object because they are updated inside the walk callback.
  const run = { imported: 0, sent: 0, unreadable: 0, stopped: null as string | null };
  try {
    await walkLibraryPhotos({ since: Date.now() - LOOKBACK_MS }, async (photo) => {
      if (photo.screenshot) return true;
      if (await alreadyChecked(db, photo.id)) return true;
      if (run.sent >= MAX_NEW_PER_SCAN) return false;
      run.sent += 1;
      if (run.sent === 1) options?.onSend?.();
      try {
        const prepared = await prepareLibraryPhoto(photo.id);
        const when = photo.captured ?? new Date();
        const result = await importPreparedPhoto(db, prepared, {
          capturedAt: when.toISOString(),
          localDate: localDateISO(when),
          source: "device_library",
          assetId: photo.id,
        });
        if (result.kind === "meal") {
          run.imported += 1;
          options?.onMeal?.();
        }
        // Offline, or the server has not recorded the analysis consent yet: later photos would fail the same way.
        if (result.kind === "offline" || result.kind === "consent") return false;
        if (result.kind === "rate_limited") {
          run.stopped = result.message;
          return false;
        }
      } catch (error) {
        if (error instanceof SessionExpired) throw error;
        // One photo that will not load (still in iCloud, unsupported format) must not block the rest.
        run.unreadable += 1;
      }
      return true;
    });
  } catch (error) {
    if (error instanceof SessionExpired) {
      const message = "Sign in again to keep importing meal photos.";
      return { status: "unavailable", imported: run.imported, message, notice: message, access };
    }
    if (run.imported === 0) {
      return {
        status: "unavailable",
        imported: 0,
        message: "The photo library could not be read. Add a meal photo still works here.",
        notice: null,
        access,
      };
    }
  }

  const { imported, unreadable, stopped } = run;
  const notice = stopped ?? (access === "limited" ? LIMITED_ACCESS_NOTE : null);
  if (imported > 0) {
    const found = imported === 1 ? "Found 1 meal photo." : `Found ${imported} meal photos.`;
    return { status: "imported", imported, message: stopped ? `${found} ${stopped}` : found, notice, access };
  }
  const skipped = unreadable > 0 ? ` ${unreadable} photo${unreadable === 1 ? "" : "s"} could not be loaded.` : "";
  return {
    status: "empty",
    imported: 0,
    message: notice ?? `No new meal photos in the last two days.${skipped}`,
    notice,
    access,
  };
}

export async function retryPendingPhotos(db: SQLiteDatabase): Promise<number> {
  const pending = await db.getAllAsync<{ local_asset_id: string; uri: string | null; captured_at: string | null }>(
    "SELECT local_asset_id, uri, captured_at FROM local_media_assets WHERE scan_status = 'pending' AND uri IS NOT NULL LIMIT 5",
  );
  let imported = 0;
  for (const row of pending) {
    if (!row.uri) continue;
    try {
      // A library photo is reloaded from the library; the compressed copy from the first try may be gone.
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
      // Leave the row pending for the next sync.
    }
  }
  return imported;
}

