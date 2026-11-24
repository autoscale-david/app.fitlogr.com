import * as WebBrowser from "expo-web-browser";
import type { PickerImportSummary, PickerSession, PickerStatus } from "@fitlogr/shared";
import { ApiError, api } from "../api";

export class PickerScopeRequired extends Error {
  constructor() {
    super("Google Photos Picker needs another permission.");
    this.name = "PickerScopeRequired";
  }
}

export async function importFromGooglePhotos(): Promise<PickerImportSummary> {
  let session: PickerSession;
  try {
    session = await api.send<PickerSession>("POST", "/photos/picker/sessions", {});
  } catch (error) {
    if (error instanceof ApiError && error.code === "SCOPE_REQUIRED") throw new PickerScopeRequired();
    throw error;
  }
  await WebBrowser.openBrowserAsync(session.picker_uri);
  const ready = await waitUntilPicked(session);
  if (!ready) {
    return { total_picked: 0, meals_imported: 0, non_meals_skipped: 0, duplicates_skipped: 0, errors: 0 };
  }
  return api.send<PickerImportSummary>("POST", `/photos/picker/sessions/${encodeURIComponent(session.session_id)}/import`, {});
}

async function waitUntilPicked(session: PickerSession): Promise<boolean> {
  const deadline = Date.now() + Math.min(session.polling_config.timeout_ms, 20_000);
  const interval = Math.min(Math.max(session.polling_config.poll_interval_ms, 1000), 5000);
  while (Date.now() <= deadline) {
    const status = await api.send<PickerStatus>("GET", `/photos/picker/sessions/${encodeURIComponent(session.session_id)}`);
    if (status.media_items_set) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return false;
}
