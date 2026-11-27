import { AI_PHOTO_CONSENT_VERSION, alertsForPass, effectiveSnapshot } from "@fitlogr/shared";
import { SessionExpired } from "../api";
import { localDateISO } from "../dates";
import { loadDay, openFitlogrDatabase, readGoals, readMode, readSetting, writeSetting } from "../db";
import { syncAppleHealth, syncHealthHistory } from "../health";
import { readSession } from "../session";
import { syncAccount } from "../sync";
import { recordPass } from "./activity";
import { registerBackgroundPass } from "./background";
import { withBackgroundTime } from "./classifier";
import { postAlerts } from "./notify";
import { DEFAULT_HISTORY_DAYS, HISTORY_DAYS_KEY, pipelineMessage, runPhotoPipeline, type PhotoPassResult } from "./photoPass";
import type { LoggedMeal, PipelineCounts } from "./pipeline";

export type PassReason = "foreground" | "healthkit" | "background-task" | "setup" | "manual";

export const BACKGROUND_BUDGET_MS = 20_000;

export interface PassRequest {
  reason: PassReason;
  budgetMs?: number;
  historyDays?: number;
  /** False when the app is not in the foreground. A pass then never asks for a permission. */
  active?: boolean;
  signal?: AbortSignal;
}

export interface PassResult {
  ran: boolean;
  photos: PhotoPassResult | null;
  error: string | null;
}

export type EngineEvent =
  | { type: "progress"; counts: PipelineCounts; message: string; running: boolean }
  | { type: "meal"; meal: LoggedMeal }
  | { type: "alert"; body: string }
  /** The server refused the session. The app keeps its data and asks the person to sign in again. */
  | { type: "session-expired" }
  | { type: "state" };

type Listener = (event: EngineEvent) => void;
const listeners = new Set<Listener>();

export function subscribeEngine(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(event: EngineEvent): void {
  for (const listener of listeners) listener(event);
}

let inflight: { promise: Promise<PassResult>; long: boolean } | null = null;
let queued: Promise<PassResult> | null = null;

/**
 * One pass at a time. A call made while a pass is running joins it, unless it asks for more than
 * that pass does: a foreground, setup, or manual request behind a short background pass gets its
 * own pass right after. Without that, the 20-second pass iOS triggers at launch would swallow the
 * full pass the open app needs.
 */
export function runPass(request: PassRequest): Promise<PassResult> {
  if (!inflight) return start(request);
  const wantsMore = (isLong(request.reason) && !inflight.long) || request.reason === "setup" || request.reason === "manual";
  if (!wantsMore) return inflight.promise;
  queued ??= inflight.promise
    .catch(() => undefined)
    .then(() => {
      queued = null;
      return start(request);
    });
  return queued;
}

function start(request: PassRequest): Promise<PassResult> {
  const long = isLong(request.reason);
  const budgetMs = request.budgetMs ?? (long ? Number.POSITIVE_INFINITY : BACKGROUND_BUDGET_MS);
  const work = () => execute({ ...request, budgetMs });
  // A background-woken app is suspended within seconds unless it asks iOS for time.
  const promise = (request.active === false || !long ? withBackgroundTime("fitlogr-pass", work) : work()).finally(() => {
    inflight = null;
  });
  inflight = { promise, long };
  return promise;
}

interface DayBefore {
  localDate: string;
  eatenKcal: number;
}

async function publishAlerts(
  db: Awaited<ReturnType<typeof openFitlogrDatabase>>,
  request: PassRequest,
  photos: PhotoPassResult,
  before: DayBefore,
): Promise<void> {
  if (photos.logged.length === 0) return;
  const goals = await readGoals(db);
  if (!goals) return;
  const today = localDateISO();
  const day = await loadDay(db, today);
  const snapshot = effectiveSnapshot(goals.plan, today, today, day.planSnapshot);
  // `day` already includes the meals this pass wrote. The alert rules need the total from before them.
  const loggedToday = photos.logged.filter((meal) => meal.localDate === today).reduce((sum, meal) => sum + meal.kcal, 0);
  const eatenBefore = before.localDate === today ? before.eatenKcal : Math.max(0, day.eatenKcal - loggedToday);
  const { alerts, usedUpDate } = alertsForPass({
    now: new Date(),
    foreground: request.active !== false && isLong(request.reason),
    meals: photos.logged.map((meal) => ({
      name: meal.name,
      kcal: meal.kcal,
      capturedAt: new Date(meal.capturedAtMs).toISOString(),
      localDate: meal.localDate,
      backfill: request.reason === "setup" || meal.capturedAtMs < Date.now() - 18 * 60 * 60 * 1000,
    })),
    today: { localDate: today, eatenBefore, burnedKcal: day.activeBurnedKcal, snapshot },
    usedUpSentForDate: await readSetting(db, "used_up_date"),
    notifyMeals: (await readSetting(db, "notify_meals")) !== "0",
    notifyUsedUp: (await readSetting(db, "notify_used_up")) !== "0",
  });
  if (usedUpDate) await writeSetting(db, "used_up_date", usedUpDate);
  await postAlerts(alerts);
  for (const alert of alerts) {
    if (alert.inApp) emit({ type: "alert", body: alert.body });
  }
}

async function ensureHealthHistory(db: Awaited<ReturnType<typeof openFitlogrDatabase>>, days: number): Promise<void> {
  const done = Number(await readSetting(db, "health_history_days"));
  if (Number.isFinite(done) && done >= days) return;
  const result = await syncHealthHistory(db, days, { ask: false });
  if (result.status === "imported" || result.status === "empty") {
    await writeSetting(db, "health_history_days", String(days));
  }
}

function isLong(reason: PassReason): boolean {
  return reason === "foreground" || reason === "setup" || reason === "manual";
}

function sessionEnded(): PassResult {
  emit({ type: "session-expired" });
  return { ran: false, photos: null, error: "session" };
}

async function execute(request: PassRequest & { budgetMs: number }): Promise<PassResult> {
  const started = Date.now();
  const db = await openFitlogrDatabase();
  if ((await readMode(db)) !== "account") return { ran: false, photos: null, error: null };
  const session = await readSession();
  if (!session.refreshToken) return { ran: false, photos: null, error: null };
  const active = request.active !== false;
  try {
    await syncAccount(db, request.reason !== "foreground");
    await writeSetting(db, "last_synced_at", new Date().toISOString());
  } catch (error) {
    if (error instanceof SessionExpired) return sessionEnded();
  }
  try {
    await syncAppleHealth(db, { force: request.reason !== "foreground", upload: true });
  } catch (error) {
    if (error instanceof SessionExpired) return sessionEnded();
    // Health data can be unreadable while the phone is locked. The next pass tries again.
  }
  if (isLong(request.reason)) {
    const storedDays = Number(await readSetting(db, HISTORY_DAYS_KEY));
    const days = request.historyDays ?? (Number.isFinite(storedDays) && storedDays > 0 ? storedDays : DEFAULT_HISTORY_DAYS);
    try {
      await ensureHealthHistory(db, days);
    } catch (error) {
      if (error instanceof SessionExpired) return sessionEnded();
    }
  }
  if ((await readSetting(db, "ai_photo_consent_version")) !== AI_PHOTO_CONSENT_VERSION) {
    emit({ type: "state" });
    return { ran: true, photos: null, error: null };
  }
  let photos: PhotoPassResult | null = null;
  let error: string | null = null;
  try {
    const today = localDateISO();
    const before: DayBefore = { localDate: today, eatenKcal: (await loadDay(db, today)).eatenKcal };
    photos = await runPhotoPipeline(db, {
      days: request.historyDays,
      budgetMs: request.budgetMs,
      ask: active && (request.reason === "setup" || request.reason === "manual"),
      signal: request.signal,
      onProgress: (counts) => emit({ type: "progress", counts, message: pipelineMessage(counts), running: true }),
      onMeal: () => emit({ type: "state" }),
    });
    for (const meal of photos.logged) emit({ type: "meal", meal });
    await publishAlerts(db, request, photos, before);
    emit({ type: "progress", counts: photos.counts, message: photos.message, running: false });
  } catch (caught) {
    if (caught instanceof SessionExpired) return sessionEnded();
    // The library or Health data can be unreadable while the phone is locked.
    error = caught instanceof Error ? caught.message : "This pass could not read the phone";
  }
  // "(background)" in the log is how to tell that iOS really woke the app with the screen off.
  const reason = active ? request.reason : `${request.reason} (background)`;
  await recordPass(db, { reason, durationMs: Date.now() - started, counts: photos?.counts ?? null, error });
  if (request.reason === "foreground" || request.reason === "setup") void registerBackgroundPass();
  emit({ type: "state" });
  return { ran: true, photos, error };
}
