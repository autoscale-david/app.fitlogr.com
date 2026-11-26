import Constants, { ExecutionEnvironment } from "expo-constants";
import type { SQLiteDatabase } from "expo-sqlite";
import { localDateISO } from "../dates";
import { SessionExpired } from "../api";
import { LIMITED_ACCESS_NOTE, libraryAccess, prepareLibraryPhoto, walkLibraryPhotos, type LibraryAccess } from "./library";
import { alreadyChecked, importPreparedPhoto, type ImportResult } from "./upload";

export interface HistoryProgress {
  scanned: number;
  skipped: number;
  meals: number;
  nonMeals: number;
  errors: number;
  /** Seconds left while the scan waits for the photo analysis limit to reset. */
  waitingSeconds?: number;
}

/** Waits this long at most for the analysis limit inside one scan; a longer wait ends the scan. */
const MAX_LIMIT_WAIT_SECONDS = 10 * 60;

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
  let access: LibraryAccess;
  try {
    access = await libraryAccess(true);
  } catch {
    return { ...progress, status: "unavailable", capped: false, message: EXPO_GO_MESSAGE };
  }
  if (access === "denied" || access === "undetermined") {
    return {
      ...progress,
      status: "permission_denied",
      capped: false,
      message: "Photo library access is off. You can still pick photos or use Google Photos.",
    };
  }

  const report = () => options.onProgress?.({ ...progress });
  // Updated inside the walk callback: how many new photos this run sent, and why it ended early.
  const run = { sent: 0, capped: false, ended: null as HistoryScanResult | null };
  try {
    await walkLibraryPhotos({ since: Date.now() - days * 24 * 60 * 60 * 1000, signal: options.signal }, async (photo) => {
      progress.scanned += 1;
      // Screenshots, undated photos, and photos handled in an earlier scan are skipped from metadata
      // alone, and do not use up this run's budget. That is what lets "scan again" reach older photos.
      if (photo.screenshot || !photo.captured || (await alreadyChecked(db, photo.id))) {
        progress.skipped += 1;
        report();
        return true;
      }
      if (run.sent >= cap) {
        progress.scanned -= 1;
        run.capped = true;
        return false;
      }
      run.sent += 1;
      const captured = photo.captured;
      try {
        const prepared = await prepareLibraryPhoto(photo.id);
        const send = () =>
          importPreparedPhoto(db, prepared, {
            capturedAt: captured.toISOString(),
            localDate: localDateISO(captured),
            source: "device_library",
            assetId: photo.id,
          });
        let result: ImportResult = await send();
        while (result.kind === "rate_limited") {
          const wait = result.retryAfterSeconds ?? 60;
          if (wait > MAX_LIMIT_WAIT_SECONDS) {
            const logged = progress.meals > 0 ? `Logged ${progress.meals} meal${progress.meals === 1 ? "" : "s"}. ` : "";
            run.ended = {
              ...progress,
              status: progress.meals > 0 ? "imported" : "empty",
              capped: true,
              message: `${logged}${result.message} Scan again then to continue.`,
            };
            return false;
          }
          const finished = await waitFor(wait, options.signal, (left) => options.onProgress?.({ ...progress, waitingSeconds: left }));
          if (!finished) return false;
          result = await send();
        }
        if (result.kind === "meal") progress.meals += 1;
        else if (result.kind === "not_meal") progress.nonMeals += 1;
        else if (result.kind === "offline" || result.kind === "error") progress.errors += 1;
        else progress.skipped += 1;
        if (result.kind === "offline") {
          run.ended = { ...progress, status: "unavailable", capped: true, message: "You're offline. Scan again when you reconnect." };
          return false;
        }
      } catch (error) {
        if (error instanceof SessionExpired) {
          run.ended = { ...progress, status: "unavailable", capped: true, message: "Sign in again to keep importing photos." };
          return false;
        }
        // A photo that will not load is counted and skipped; the scan carries on.
        progress.errors += 1;
      }
      report();
      return true;
    });
  } catch {
    if (progress.meals === 0) {
      return { ...progress, status: "unavailable", capped: false, message: "The photo library could not be read. Try the scan again." };
    }
  }
  if (run.ended) return run.ended;
  if (options.signal?.aborted) return { ...progress, status: "cancelled", capped: run.capped, message: "Import cancelled." };

  const meals = `${progress.meals} meal${progress.meals === 1 ? "" : "s"}`;
  const unreadable = progress.errors > 0 ? ` ${progress.errors} photo${progress.errors === 1 ? "" : "s"} could not be checked.` : "";
  const limited = access === "limited" ? ` ${LIMITED_ACCESS_NOTE}` : "";
  const message = run.capped
    ? `Checked ${progress.scanned} photos and logged ${meals}. Scan again to continue.${unreadable}`
    : progress.meals > 0
      ? `Logged ${meals} from the last ${days} days.${unreadable}${limited}`
      : `No new meal photos in the last ${days} days.${unreadable}${limited}`;
  return { ...progress, status: progress.meals > 0 ? "imported" : "empty", capped: run.capped, message };
}

/** Waits `seconds`, reporting the countdown. Resolves false if the scan was cancelled. */
function waitFor(seconds: number, signal: AbortSignal | undefined, tick: (left: number) => void): Promise<boolean> {
  return new Promise((resolve) => {
    let left = Math.ceil(seconds);
    tick(left);
    const timer = setInterval(() => {
      left -= 1;
      if (signal?.aborted) {
        clearInterval(timer);
        resolve(false);
        return;
      }
      if (left <= 0) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      tick(left);
    }, 1000);
  });
}
