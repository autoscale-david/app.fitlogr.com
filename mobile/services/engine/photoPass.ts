import type { SQLiteDatabase } from "expo-sqlite";
import { localDateISO } from "../dates";
import { readSetting, writeSetting } from "../db";
import { libraryAccess, prepareLibraryPhoto, walkLibraryPhotos, type LibraryAccess } from "../photos/library";
import { importPreparedPhoto, type ImportResult } from "../photos/upload";
import { loadAuditMap, saveAuditRow } from "./audit";
import { STUB_POLICY_VERSION, getClassifier } from "./classifier";
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
  const before = new Map([...rows].map(([id, row]) => [id, JSON.stringify(row)]));
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
    policyVersion: STUB_POLICY_VERSION,
    classify: (photo) => classifier.classifyAsset(photo.id),
    decide: () => ({ verdict: "food", send: true }),
    analyze: async (photo, row) => analyzePhoto(db, photo, row, options.signal, thumbs, options.onMeal),
    toLocalDate: (ms) => localDateISO(new Date(ms)),
  });
  for (const [id, row] of rows) {
    if (before.get(id) === JSON.stringify(row) && !thumbs.has(id)) continue;
    await saveAuditRow(db, row, thumbs.get(id) ?? null);
  }
  if (result.resumeAtMs) await writeSetting(db, RESUME_AT_KEY, String(result.resumeAtMs));
  else await writeSetting(db, RESUME_AT_KEY, "");
  options.onProgress?.(result.counts);
  return { ...result, access, message: pipelineMessage(result.counts) };
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
  const prepared = await prepareLibraryPhoto(photo.id);
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
  return mapImport(result);
}

function mapImport(result: ImportResult): AnalyzeOutcome {
  if (result.kind === "rate_limited") return { kind: "rate_limited", retryAfterSeconds: result.retryAfterSeconds, message: result.message };
  if (result.kind === "offline" || result.kind === "consent") return { kind: "paused", message: result.message };
  if (result.kind === "error") return { kind: "error", message: result.message };
  if (result.kind === "duplicate" || result.kind === "skipped") {
    return { kind: result.kind === "duplicate" ? "duplicate" : "excluded", message: result.message, remotePhotoId: result.remotePhotoId, classification: result.classification, estimate: result.estimate, confidence: result.confidence };
  }
  if (result.classification === "workout") {
    return { kind: "workout", remotePhotoId: result.remotePhotoId, classification: "workout", confidence: result.confidence, estimate: result.estimate, message: result.message };
  }
  if (result.kind === "not_meal") {
    return { kind: "ignore", remotePhotoId: result.remotePhotoId, classification: result.classification ?? "ignore", confidence: result.confidence, estimate: result.estimate, message: result.message };
  }
  return {
    kind: "meal",
    name: result.name,
    kcal: result.kcal,
    mealId: result.mealId,
    remotePhotoId: result.remotePhotoId,
    classification: "meal",
    confidence: result.confidence,
    estimate: result.estimate,
    message: result.message,
  };
}
