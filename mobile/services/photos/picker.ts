import * as WebBrowser from "expo-web-browser";
import type { PickerImportSummary, PickerSession, PickerStatus } from "@fitlogr/shared";
import { ApiError, api } from "../api";

export class PickerScopeRequired extends Error {
  constructor(message = "Google Photos Picker needs another permission.") {
    super(message);
    this.name = "PickerScopeRequired";
  }
}

/** Waits this long at most for the analysis limit during one import; longer stops the import. */
const MAX_LIMIT_WAIT_SECONDS = 10 * 60;

/**
 * Opens the Google Photos Picker, then imports the picked photos a page at a time. Waits out a short
 * photo-analysis limit (reporting the countdown through `onWait`) and stops on a long one, returning
 * `retry_after_seconds` so the screen can say when to continue.
 */
export async function importFromGooglePhotos(onWait?: (seconds: number | null) => void): Promise<PickerImportSummary> {
  let session: PickerSession;
  try {
    session = await api.send<PickerSession>("POST", "/photos/picker/sessions", {});
  } catch (error) {
    if (error instanceof ApiError && error.code === "SCOPE_REQUIRED") throw new PickerScopeRequired(error.message);
    throw error;
  }
  await WebBrowser.openBrowserAsync(session.picker_uri);
  const total: PickerImportSummary = {
    total_picked: 0,
    meals_imported: 0,
    non_meals_skipped: 0,
    duplicates_skipped: 0,
    errors: 0,
    next_cursor: null,
    retry_after_seconds: null,
  };
  const ready = await waitUntilPicked(session);
  if (!ready) return total;
  const path = `/photos/picker/sessions/${encodeURIComponent(session.session_id)}/import`;
  let cursor: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const result: PickerImportSummary = await api.send<PickerImportSummary>("POST", path, cursor ? { cursor } : {});
    total.total_picked += result.total_picked;
    total.meals_imported += result.meals_imported;
    total.non_meals_skipped += result.non_meals_skipped;
    total.duplicates_skipped += result.duplicates_skipped;
    total.errors += result.errors;
    cursor = result.next_cursor ?? null;
    if (!cursor) break;
    const wait = result.retry_after_seconds ?? 0;
    if (wait > MAX_LIMIT_WAIT_SECONDS) return { ...total, next_cursor: cursor, retry_after_seconds: wait };
    if (wait > 0) {
      for (let left = wait; left > 0; left -= 1) {
        onWait?.(left);
        await sleep(1000);
      }
      onWait?.(null);
    }
  }
  return total;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilPicked(session: PickerSession): Promise<boolean> {
  const deadline = Date.now() + Math.min(session.polling_config.timeout_ms, 20_000);
  const interval = Math.min(Math.max(session.polling_config.poll_interval_ms, 1000), 5000);
  while (Date.now() <= deadline) {
    const status = await api.send<PickerStatus>("GET", `/photos/picker/sessions/${encodeURIComponent(session.session_id)}`);
    if (status.media_items_set) return true;
    await sleep(interval);
  }
  return false;
}
