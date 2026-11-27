import { AppState } from "react-native";
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

interface Running {
  promise: Promise<PassResult>;
  long: boolean;
  /** Started with the app open. It ends itself in the background, so it cannot serve a background wake. */
  foregroundOnly: boolean;
  /** It has seen the app go to the background and is winding down. */
  leaving: boolean;
}

let inflight: Running | null = null;
let queued: { promise: Promise<PassResult>; request: PassRequest } | null = null;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * One pass at a time. A call made while a pass is running joins it, unless it asks for more than
 * that pass does: a foreground, setup, or manual request behind a short background pass gets its
 * own pass right after. Without that, the 20-second pass iOS triggers at launch would swallow the
 * full pass the open app needs. The same goes for a background wake that finds a pass left over
 * from when the app was open: that pass is about to end itself, so the wake gets its own.
 * The follow-up uses the most recent request's options, unless that request asks for less.
 */
export function runPass(request: PassRequest): Promise<PassResult> {
  if (!inflight) return start(request);
  const wantsMore =
    (isLong(request.reason) && !inflight.long) ||
    request.reason === "setup" ||
    request.reason === "manual" ||
    inflight.leaving ||
    (request.active === false && inflight.foregroundOnly);
  if (!wantsMore) return inflight.promise;
  if (queued) {
    if (weight(request) >= weight(queued.request)) queued.request = request;
    return queued.promise;
  }
  const entry: { promise: Promise<PassResult>; request: PassRequest } = {
    request,
    promise: inflight.promise
      .catch(() => undefined)
      .then(() => {
        queued = null;
        return start(entry.request);
      }),
  };
  queued = entry;
  return entry.promise;
}

/** A background wake must not replace a queued import, and a plain foreground pass must not replace a manual one. */
function weight(request: PassRequest): number {
  if (request.active === false || !isLong(request.reason)) return 0;
  return request.reason === "foreground" ? 1 : 2;
}

function start(request: PassRequest): Promise<PassResult> {
  const long = isLong(request.reason);
  const background = request.active === false || !long;
  const budgetMs = request.budgetMs ?? (long ? Number.POSITIVE_INFINITY : BACKGROUND_BUDGET_MS);
  const entry: Running = { promise: Promise.resolve({ ran: false, photos: null, error: null }), long, foregroundOnly: !background, leaving: false };
  const work = () =>
    execute({ ...request, budgetMs }, () => {
      entry.leaving = true;
    });
  // A background-woken app is suspended within seconds unless it asks iOS for time.
  entry.promise = (background ? withBackgroundTime("fitlogr-pass", work) : work()).finally(() => {
    if (inflight === entry) inflight = null;
  });
  inflight = entry;
  return entry.promise;
}

/** After a rate limit, continue by itself once the limit resets, as long as the app is still open. */
function scheduleResume(resumeAtMs: number | null): void {
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = null;
  // A time already past means the limit is over, and the pass that just ran was free to send.
  if (!resumeAtMs || resumeAtMs <= Date.now()) return;
  const delay = Math.min(Math.max(resumeAtMs - Date.now(), 0) + 2000, 6 * 60 * 60 * 1000);
  resumeTimer = setTimeout(() => {
    resumeTimer = null;
    if (AppState.currentState === "active") void runPass({ reason: "foreground", active: true });
  }, delay);
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
    // Read now, not when the pass began: the app may have gone to the background since.
    foreground: AppState.currentState === "active",
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

const EMPTY_COUNTS: PipelineCounts = { checked: 0, lookLikeFood: 0, analysed: 0, waiting: 0, errors: 0, meals: 0 };

function sessionEnded(): PassResult {
  emit({ type: "session-expired" });
  return { ran: false, photos: null, error: "session" };
}

async function execute(request: PassRequest & { budgetMs: number }, onLeftForeground: () => void): Promise<PassResult> {
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
      stopInBackground: active && isLong(request.reason),
      onLeftForeground,
      signal: request.signal,
      onProgress: (counts) => emit({ type: "progress", counts, message: pipelineMessage(counts), running: true }),
      onMeal: () => emit({ type: "state" }),
    });
    for (const meal of photos.logged) emit({ type: "meal", meal });
    try {
      await publishAlerts(db, request, photos, before);
    } catch {
      // A notification that could not be posted must not fail the pass that logged the meal.
    }
    if (active && isLong(request.reason)) scheduleResume(photos.counts.waiting > 0 ? photos.resumeAtMs : null);
  } catch (caught) {
    if (caught instanceof SessionExpired) {
      emit({ type: "progress", counts: EMPTY_COUNTS, message: "", running: false });
      return sessionEnded();
    }
    // The library or Health data can be unreadable while the phone is locked.
    error = caught instanceof Error ? caught.message : "This pass could not read the phone";
  }
  // Always sent, so a "Checking your photos" line never outlives the pass.
  emit({ type: "progress", counts: photos?.counts ?? EMPTY_COUNTS, message: photos?.message ?? "", running: false });
  // "(background)" in the log is how to tell that iOS really woke the app with the screen off.
  const reason = active ? request.reason : `${request.reason} (background)`;
  await recordPass(db, { reason, durationMs: Date.now() - started, counts: photos?.counts ?? null, error });
  if (request.reason === "foreground" || request.reason === "setup") void registerBackgroundPass();
  emit({ type: "state" });
  return { ran: true, photos, error };
}
