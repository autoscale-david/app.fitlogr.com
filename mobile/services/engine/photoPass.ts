import type { SQLiteDatabase } from "expo-sqlite";
import { AppState } from "react-native";
import { SessionExpired } from "../api";
import { localDateISO } from "../dates";
import { readSetting, writeSetting } from "../db";
import { libraryAccess, prepareLibraryPhoto, walkLibraryPhotos, type LibraryAccess } from "../photos/library";
import { importPreparedPhoto, rateLimitMessage, type ImportResult } from "../photos/upload";
import { loadAuditMap, saveAuditRow } from "./audit";
import { CLASSIFIER_POLICY_VERSION, decideLabels, getClassifier } from "./classifier";
import { runPipeline, type AnalyzeOutcome, type PipelineCounts, type PipelinePhoto, type PipelineResult } from "./pipeline";
import { copyMealThumb } from "./thumbs";

export const HISTORY_DAYS_KEY = "photo_history_days";
export const RESUME_AT_KEY = "photo_resume_at";
export const DEFAULT_HISTORY_DAYS = 90;

export interface PhotoPassResult extends PipelineResult {
  access: LibraryAccess | null;
  message: string;
}

export async function runPhotoPipeline(
  db: SQLiteDatabase,
  options: {
    days?: number;
    budgetMs: number;
    ask: boolean;
    /**
     * For a pass started with the app open: end it when the app goes to the background. Otherwise iOS
     * freezes it mid-run and every later background wake would join that stale, unlimited pass.
     */
    stopInBackground?: boolean;
    /** Called when `stopInBackground` ends the pass. */
    onLeftForeground?: () => void;
    signal?: AbortSignal;
    onProgress?: (counts: PipelineCounts) => void;
    onMeal?: () => void;
  },
): Promise<PhotoPassResult> {
  const classifier = getClassifier();
  const empty: PipelineCounts = { checked: 0, lookLikeFood: 0, analysed: 0, waiting: 0, errors: 0, meals: 0 };
  if (!classifier.available) {
    return { counts: empty, resumeAtMs: null, logged: [], stoppedForBudget: false, access: null, message: "Automatic photo scanning needs the fitlogr iPhone app." };
  }
  let access: LibraryAccess;
  try {
    access = await libraryAccess(options.ask);
  } catch {
    return { counts: empty, resumeAtMs: null, logged: [], stoppedForBudget: false, access: null, message: "Automatic photo scanning needs the fitlogr iPhone app." };
  }
  if (access !== "full") {
    const message =
      access === "limited"
        ? "fitlogr only sees the photos you selected. Allow all photos so new meals are logged automatically."
        : "Photo library access is off. You can still add a meal photo.";
    return { counts: empty, resumeAtMs: null, logged: [], stoppedForBudget: false, access, message };
  }

  const days = await historyDays(db, options.days);
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const discovered: PipelinePhoto[] = [];
  await walkLibraryPhotos({ since, signal: options.signal }, async (photo) => {
    if (!photo.captured) return true;
    discovered.push({ id: photo.id, capturedAtMs: photo.captured.getTime(), screenshot: photo.screenshot });
    return true;
  });
  const rows = await loadAuditMap(db, discovered.map((photo) => photo.id));
  const resumeRaw = await readSetting(db, RESUME_AT_KEY);
  const resumeAtMs = resumeRaw ? Number(resumeRaw) : null;
  const thumbs = new Map<string, string>();
  const result = await runPipeline({
    discovered,
    rows,
    nowMs: Date.now(),
    budgetMs: options.budgetMs,
    resumeAtMs: Number.isFinite(resumeAtMs) ? resumeAtMs : null,
    source: "library",
    classifierId: classifier.id,
    policyVersion: CLASSIFIER_POLICY_VERSION,
    classify: (photo) => classifier.classifyAsset(photo.id),
    decide: decideLabels,
    analyze: async (photo, row) => analyzePhoto(db, photo, row, options.signal, thumbs, options.onMeal),
    toLocalDate: (ms) => localDateISO(new Date(ms)),
    // Saved row by row: iOS can suspend the app mid-pass, and the next pass must pick up where this one stopped.
    persist: (row) => saveAuditRow(db, row, thumbs.get(row.id) ?? null),
    onProgress: options.onProgress,
    shouldStop: () => {
      if (options.signal?.aborted) return true;
      // Only "background". iOS also reports "inactive" for a permission prompt, Control Center and
      // the app switcher, and none of those should end an import.
      if (options.stopInBackground && AppState.currentState === "background") {
        options.onLeftForeground?.();
        return true;
      }
      return false;
    },
    isFatal: (error) => error instanceof SessionExpired,
  });
  if (result.resumeAtMs) await writeSetting(db, RESUME_AT_KEY, String(result.resumeAtMs));
  else await writeSetting(db, RESUME_AT_KEY, "");
  options.onProgress?.(result.counts);
  const waitSeconds = result.resumeAtMs ? Math.ceil((result.resumeAtMs - Date.now()) / 1000) : 0;
  const message = waitSeconds > 0 && result.counts.waiting > 0 ? `${pipelineMessage(result.counts)}. ${rateLimitMessage(waitSeconds)}` : pipelineMessage(result.counts);
  return { ...result, access, message };
}

export function pipelineMessage(counts: PipelineCounts): string {
  return `${group(counts.checked)} photos checked · ${group(counts.lookLikeFood)} look like food · ${group(counts.analysed)} analysed · ${group(counts.waiting)} waiting`;
}

async function historyDays(db: SQLiteDatabase, override?: number): Promise<number> {
  if (override !== undefined) {
    const days = clampDays(override);
    await writeSetting(db, HISTORY_DAYS_KEY, String(days));
    return days;
  }
  const stored = Number(await readSetting(db, HISTORY_DAYS_KEY));
  return clampDays(Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_HISTORY_DAYS);
}

function clampDays(days: number): number {
  return Math.min(365, Math.max(1, Math.round(days)));
}

function group(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

async function analyzePhoto(
  db: SQLiteDatabase,
  photo: { id: string; capturedAtMs: number },
  row: { captureDate: string; verdict: string | null; labels: { id: string; confidence: number }[] },
  signal: AbortSignal | undefined,
  thumbs: Map<string, string>,
  onMeal?: () => void,
): Promise<AnalyzeOutcome> {
  if (signal?.aborted) return { kind: "paused" };
  let prepared;
  try {
    prepared = await prepareLibraryPhoto(photo.id);
  } catch (error) {
    // Nothing was sent: the photo may still be in iCloud, or the phone is locked. Tried again later.
    return { kind: "error", local: true, message: error instanceof Error ? error.message : "The photo could not be loaded" };
  }
  const result = await importPreparedPhoto(db, prepared, {
    capturedAt: new Date(photo.capturedAtMs).toISOString(),
    localDate: row.captureDate || localDateISO(new Date(photo.capturedAtMs)),
    source: "device_library",
    assetId: photo.id,
    onDeviceVerdict: row.verdict ?? undefined,
    onDeviceLabels: row.labels,
  });
  if (result.kind === "meal" && result.mealId) {
    const thumb = await copyMealThumb(prepared.uri, result.mealId);
    if (thumb) thumbs.set(photo.id, thumb);
    onMeal?.();
  }
  return outcomeFromImport(result);
}

/** How one upload result is recorded in the photo log. Shared by the pipeline and by photos added by hand. */
export function outcomeFromImport(result: ImportResult): AnalyzeOutcome {
  if (result.kind === "rate_limited") return { kind: "rate_limited", retryAfterSeconds: result.retryAfterSeconds, message: result.message };
  if (result.kind === "offline" || result.kind === "consent") return { kind: "paused", message: result.message };
  if (result.kind === "error") return { kind: "error", message: result.message, permanent: result.permanent };
  if (result.kind === "skipped") {
    // Another pass is sending this photo, or already recorded it: leave the row as it is.
    if (result.skipReason === "in_flight" || result.skipReason === "already_checked") return { kind: "skip" };
    return { kind: result.skipReason === "server_non_meal" ? "ignore" : "excluded", message: result.message, remotePhotoId: result.remotePhotoId };
  }
  if (result.kind === "duplicate") {
    return {
      kind: "duplicate",
      message: result.message,
      remotePhotoId: result.remotePhotoId,
      mealId: result.mealId,
      classification: result.classification,
      estimate: result.estimate,
      confidence: result.confidence,
    };
  }
  // A photo the person insisted on is logged as a meal whatever the model called it, so check that first.
  if (result.kind === "meal") return mealOutcome(result);
  if (result.classification === "workout") {
    return { kind: "workout", remotePhotoId: result.remotePhotoId, classification: "workout", confidence: result.confidence, estimate: result.estimate, message: result.message };
  }
  if (result.kind === "not_meal") {
    // The model can call a photo a meal and still not log it (low confidence, no items). Keep its word for it.
    return { kind: "ignore", remotePhotoId: result.remotePhotoId, classification: result.classification ?? "ignore", confidence: result.confidence, estimate: result.estimate, message: result.message };
  }
  return mealOutcome(result);
}

function mealOutcome(result: ImportResult): AnalyzeOutcome {
  return {
    kind: "meal",
    name: result.name,
    kcal: result.kcal,
    mealId: result.mealId,
    remotePhotoId: result.remotePhotoId,
    classification: result.classification ?? "meal",
    confidence: result.confidence,
    estimate: result.estimate,
    message: result.message,
  };
}

/**
 * Writes the photo-log row for a photo analysed outside a pass: one the person picked or took in the
 * app, or "Analyse anyway" from the log. Keeps whatever the row already says about the on-device check.
 */
export async function recordImport(
  db: SQLiteDatabase,
  input: {
    assetId: string;
    capturedAtMs: number;
    source: "library" | "camera" | "picker";
    verdict?: string | null;
    labels?: { id: string; confidence: number }[];
    preparedUri?: string;
    result: ImportResult;
  },
): Promise<void> {
  const outcome = outcomeFromImport(input.result);
  if (outcome.kind === "skip" || outcome.kind === "paused" || outcome.kind === "rate_limited") return;
  const existing = (await loadAuditMap(db, [input.assetId])).get(input.assetId);
  const classifier = getClassifier();
  const now = new Date().toISOString();
  let thumb: string | null = null;
  if (outcome.kind === "meal" && outcome.mealId && input.preparedUri) thumb = await copyMealThumb(input.preparedUri, outcome.mealId);
  await saveAuditRow(
    db,
    {
      id: input.assetId,
      capturedAtMs: input.capturedAtMs,
      captureDate: localDateISO(new Date(input.capturedAtMs)),
      source: existing?.source ?? input.source,
      verdict: input.verdict ?? existing?.verdict ?? null,
      labels: input.labels ?? existing?.labels ?? [],
      classifierId: existing?.classifierId ?? classifier.id,
      policyVersion: existing?.policyVersion ?? CLASSIFIER_POLICY_VERSION,
      classifiedAt: existing?.classifiedAt ?? (input.labels ? now : null),
      aiState: outcome.kind === "error" ? (outcome.permanent ? "failed" : "error") : outcome.kind,
      classification: outcome.classification ?? existing?.classification ?? null,
      confidence: outcome.confidence ?? existing?.confidence ?? null,
      estimate: outcome.estimate ?? existing?.estimate ?? null,
      remotePhotoId: outcome.remotePhotoId ?? existing?.remotePhotoId ?? null,
      mealId: outcome.mealId ?? existing?.mealId ?? null,
      error: outcome.kind === "error" ? outcome.message ?? "The photo could not be analyzed" : null,
      // A failed try counts, so the automatic retries wait longer each time.
      attempts: (existing?.attempts ?? 0) + (outcome.kind === "error" && !outcome.local ? 1 : 0),
      analysedAt: now,
    },
    thumb,
  );
}
