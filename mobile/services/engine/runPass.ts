import { AI_PHOTO_CONSENT_VERSION } from "@fitlogr/shared";
import { SessionExpired } from "../api";
import { openFitlogrDatabase, readMode, readSetting, writeSetting } from "../db";
import { syncAppleHealth, syncHealthHistory } from "../health";
import { readSession } from "../session";
import { syncAccount } from "../sync";
import { DEFAULT_HISTORY_DAYS, HISTORY_DAYS_KEY, runPhotoPipeline, type PhotoPassResult } from "./photoPass";
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
  | { type: "progress"; counts: PipelineCounts; message: string }
  | { type: "meal"; meal: LoggedMeal }
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

let inflight: Promise<PassResult> | null = null;

/** One pass at a time. A second call waits for the one already running. */
export function runPass(request: PassRequest): Promise<PassResult> {
  if (inflight) return inflight;
  const budgetMs = request.budgetMs ?? (isLong(request.reason) ? Number.POSITIVE_INFINITY : BACKGROUND_BUDGET_MS);
  inflight = execute({ ...request, budgetMs }).finally(() => {
    inflight = null;
  });
  return inflight;
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

async function execute(request: PassRequest & { budgetMs: number }): Promise<PassResult> {
  const db = await openFitlogrDatabase();
  if ((await readMode(db)) !== "account") return { ran: false, photos: null, error: null };
  const session = await readSession();
  if (!session.refreshToken) return { ran: false, photos: null, error: null };
  const active = request.active !== false;
  try {
    await syncAccount(db, request.reason !== "foreground");
  } catch (error) {
    if (error instanceof SessionExpired) return { ran: false, photos: null, error: "session" };
  }
  try {
    await syncAppleHealth(db, { force: request.reason !== "foreground", upload: true });
  } catch (error) {
    if (error instanceof SessionExpired) return { ran: false, photos: null, error: "session" };
    // Health data can be unreadable while the phone is locked. The next pass tries again.
  }
  if (isLong(request.reason)) {
    const storedDays = Number(await readSetting(db, HISTORY_DAYS_KEY));
    const days = request.historyDays ?? (Number.isFinite(storedDays) && storedDays > 0 ? storedDays : DEFAULT_HISTORY_DAYS);
    try {
      await ensureHealthHistory(db, days);
    } catch (error) {
      if (error instanceof SessionExpired) return { ran: false, photos: null, error: "session" };
    }
  }
  if ((await readSetting(db, "ai_photo_consent_version")) !== AI_PHOTO_CONSENT_VERSION) {
    emit({ type: "state" });
    return { ran: true, photos: null, error: null };
  }
  const photos = await runPhotoPipeline(db, {
    days: request.historyDays,
    budgetMs: request.budgetMs,
    ask: active && (request.reason === "setup" || request.reason === "manual"),
    signal: request.signal,
    onProgress: (counts) => emit({ type: "progress", counts, message: "" }),
    onMeal: () => emit({ type: "state" }),
  });
  for (const meal of photos.logged) emit({ type: "meal", meal });
  emit({ type: "progress", counts: photos.counts, message: photos.message });
  emit({ type: "state" });
  return { ran: true, photos, error: null };
}
