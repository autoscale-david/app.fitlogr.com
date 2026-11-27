import { localDateISO } from "../dates";

/**
 * What the audit row is waiting on. `not_sent` is final: the photo never leaves the phone.
 * `error` is retried later with a growing wait; `failed` means the server rejected the photo itself
 * and is final.
 */
export type AiState = "not_sent" | "queued" | "meal" | "workout" | "ignore" | "duplicate" | "excluded" | "error" | "failed";

export interface PipelineLabel {
  id: string;
  confidence: number;
}

export interface PipelinePhoto {
  id: string;
  capturedAtMs: number;
  screenshot: boolean;
}

export interface PipelineRow {
  id: string;
  capturedAtMs: number;
  captureDate: string;
  source: "library" | "camera" | "picker";
  verdict: string | null;
  labels: PipelineLabel[];
  classifierId: string | null;
  policyVersion: string | null;
  classifiedAt: string | null;
  aiState: AiState;
  classification: string | null;
  confidence: number | null;
  estimate: unknown;
  remotePhotoId: string | null;
  mealId: string | null;
  error: string | null;
  /** Failed classification or analysis tries so far. */
  attempts?: number;
  analysedAt?: string | null;
}

export interface AnalyzeOutcome {
  /**
   * `paused` stops the queue (offline, consent missing, cancelled). `skip` leaves this one photo
   * queued and moves on (another pass is sending it right now).
   */
  kind: "meal" | "workout" | "ignore" | "duplicate" | "excluded" | "error" | "rate_limited" | "paused" | "skip";
  retryAfterSeconds?: number;
  mealId?: string | null;
  remotePhotoId?: string | null;
  name?: string;
  kcal?: number;
  message?: string;
  classification?: string | null;
  confidence?: number | null;
  estimate?: unknown;
  /**
   * For `error`: the server rejected this photo itself (too large, not a JPEG, bad metadata), so
   * sending it again cannot work. Anything else (an outage, a model hiccup) is retried later.
   */
  permanent?: boolean;
}

export interface LoggedMeal {
  assetId: string;
  name: string;
  kcal: number;
  capturedAtMs: number;
  localDate: string;
  mealId: string | null;
}

export interface PipelineCounts {
  checked: number;
  lookLikeFood: number;
  analysed: number;
  waiting: number;
  errors: number;
  meals: number;
}

export interface PipelineResult {
  counts: PipelineCounts;
  resumeAtMs: number | null;
  logged: LoggedMeal[];
  stoppedForBudget: boolean;
}

const OPEN: ReadonlySet<AiState> = new Set(["queued", "error"]);

/** A row the pipeline must not classify or send again. */
export function isFinalAudit(row: Pick<PipelineRow, "aiState">): boolean {
  return !OPEN.has(row.aiState);
}

export interface PipelineInput {
  discovered: PipelinePhoto[];
  rows: Map<string, PipelineRow>;
  nowMs: number;
  /** Foreground passes pass `Infinity`. */
  budgetMs: number;
  resumeAtMs: number | null;
  source: PipelineRow["source"];
  classifierId: string;
  policyVersion: string;
  classify: (photo: PipelinePhoto) => Promise<{ labels: PipelineLabel[] } | { error: string }>;
  decide: (labels: PipelineLabel[]) => { verdict: string; send: boolean };
  analyze: (photo: PipelinePhoto, row: PipelineRow) => Promise<AnalyzeOutcome>;
  toLocalDate?: (ms: number) => string;
  clock?: () => number;
  /**
   * Called every time a row is created or changes, so an interrupted pass loses nothing. iOS can
   * suspend the app at any moment, and a first run over months of photos takes minutes.
   */
  persist?: (row: PipelineRow) => Promise<void>;
  onProgress?: (counts: PipelineCounts) => void;
  /** Photos captured this recently are classified and analysed before older ones are even classified. */
  freshMs?: number;
  /** Checked between photos. True ends the pass early and leaves the rest for the next one. */
  shouldStop?: () => boolean;
  /** An error the caller must see (an expired session). It ends the pass instead of marking the photo. */
  isFatal?: (error: unknown) => boolean;
}

/**
 * How long to leave a photo alone after its nth failed analysis. A failure is never final on its own:
 * during an outage every queued photo fails, and none of them should be written off for it.
 */
const RETRY_AFTER_MS = [5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000, 24 * 3_600_000];
/** Two failures in a row mean the service is down, not the photos. Stop and try again next pass. */
const MAX_CONSECUTIVE_ERRORS = 2;

export function retryDue(row: Pick<PipelineRow, "attempts" | "analysedAt">, nowMs: number): boolean {
  const attempts = row.attempts ?? 0;
  if (attempts === 0 || !row.analysedAt) return true;
  const last = Date.parse(row.analysedAt);
  if (!Number.isFinite(last)) return true;
  const wait = RETRY_AFTER_MS[Math.min(attempts, RETRY_AFTER_MS.length) - 1] ?? 0;
  return nowMs >= last + wait;
}

const DEFAULT_FRESH_MS = 36 * 60 * 60 * 1000;

/**
 * One photo pass. Recent photos are classified and analysed first, so today's meal is never stuck
 * behind months of backlog; then older photos are classified and the queue drains newest first.
 * A 429 stores a resume time and stops. One bad photo is recorded and the pass continues.
 * Final rows are not read again and are not modified.
 */
export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const clock = input.clock ?? Date.now;
  const toLocalDate = input.toLocalDate ?? ((ms: number) => localDateISO(new Date(ms)));
  const started = clock();
  const elapsed = () => clock() - started;
  const stamp = () => new Date(input.nowMs + elapsed()).toISOString();
  const logged: LoggedMeal[] = [];
  const run = { checked: 0, analysed: 0, errors: 0, stoppedForBudget: false, hitLimit: false, paused: false, errorStreak: 0 };
  const mustStop = () => run.stoppedForBudget || overBudget(started, input.budgetMs, clock()) || input.shouldStop?.() === true;
  let resumeAtMs = input.resumeAtMs;
  const canSend = resumeAtMs === null || resumeAtMs <= input.nowMs;

  const counts = (): PipelineCounts => {
    const rows = [...input.rows.values()];
    return {
      checked: run.checked,
      lookLikeFood: rows.filter((row) => row.verdict === "food" || row.verdict === "workout" || row.verdict === "uncertain").length,
      analysed: run.analysed,
      waiting: rows.filter((row) => row.aiState === "queued").length,
      errors: run.errors,
      meals: logged.length,
    };
  };
  const save = async (row: PipelineRow) => {
    input.rows.set(row.id, row);
    await input.persist?.(row);
  };

  async function classify(batch: PipelinePhoto[]): Promise<void> {
    for (const photo of batch) {
      if (mustStop()) {
        run.stoppedForBudget = true;
        return;
      }
      run.checked += 1;
      const existing = input.rows.get(photo.id);
      if (existing && isFinalAudit(existing)) continue;
      if (existing?.aiState === "queued") continue;
      // An analysis error keeps its labels: queue it again when its wait is over, without classifying again.
      if (existing?.aiState === "error" && existing.verdict && existing.verdict !== "unreadable") {
        if (retryDue(existing, input.nowMs + elapsed())) await save({ ...existing, aiState: "queued" });
        continue;
      }

      if (photo.screenshot) {
        await save(baseRow(photo, input, toLocalDate, { verdict: "screenshot", aiState: "not_sent", classifiedAt: stamp() }));
        continue;
      }

      let classified: { labels: PipelineLabel[] } | { error: string };
      try {
        classified = await input.classify(photo);
      } catch (error) {
        if (input.isFatal?.(error)) throw error;
        classified = { error: error instanceof Error ? error.message : "Could not read the photo" };
      }
      if ("error" in classified) {
        // Reading is local and free, so an unreadable photo (still in iCloud, phone locked) is simply
        // tried again on every pass. It is never written off.
        run.errors += 1;
        await save(baseRow(photo, input, toLocalDate, { verdict: "unreadable", aiState: "error", error: classified.error, classifiedAt: stamp() }));
        continue;
      }

      const decision = input.decide(classified.labels);
      await save(
        baseRow(photo, input, toLocalDate, {
          verdict: decision.verdict,
          labels: classified.labels,
          aiState: decision.send ? "queued" : "not_sent",
          attempts: 0,
          analysedAt: null,
          classifiedAt: stamp(),
        }),
      );
      if (run.checked % 25 === 0) input.onProgress?.(counts());
    }
  }

  async function drain(): Promise<void> {
    if (!canSend || run.hitLimit || run.paused || run.stoppedForBudget) return;
    const queue = [...input.rows.values()].filter((row) => row.aiState === "queued").sort((a, b) => b.capturedAtMs - a.capturedAtMs);
    for (const row of queue) {
      if (mustStop()) {
        run.stoppedForBudget = true;
        return;
      }
      const photo: PipelinePhoto = { id: row.id, capturedAtMs: row.capturedAtMs, screenshot: false };
      let outcome: AnalyzeOutcome;
      try {
        outcome = await input.analyze(photo, row);
      } catch (error) {
        if (input.isFatal?.(error)) throw error;
        outcome = { kind: "error", message: error instanceof Error ? error.message : "The photo could not be analyzed" };
      }
      if (outcome.kind === "skip") continue;
      if (outcome.kind === "paused") {
        run.paused = true;
        return;
      }
      if (outcome.kind === "rate_limited") {
        const wait = Math.max(1, outcome.retryAfterSeconds ?? 60);
        resumeAtMs = input.nowMs + elapsed() + wait * 1000;
        run.hitLimit = true;
        await save({ ...row, error: outcome.message ?? "Photo analysis limit reached" });
        return;
      }
      run.analysed += 1;
      if (outcome.kind === "error") {
        run.errors += 1;
        run.errorStreak += 1;
        await save({
          ...row,
          aiState: outcome.permanent ? "failed" : "error",
          attempts: (row.attempts ?? 0) + 1,
          error: outcome.message ?? "The photo could not be analyzed",
          analysedAt: stamp(),
        });
        if (run.errorStreak >= MAX_CONSECUTIVE_ERRORS) {
          run.paused = true;
          return;
        }
        continue;
      }
      run.errorStreak = 0;
      const next: PipelineRow = {
        ...row,
        aiState: outcome.kind,
        error: null,
        remotePhotoId: outcome.remotePhotoId ?? row.remotePhotoId,
        mealId: outcome.mealId ?? row.mealId,
        classification: outcome.classification ?? row.classification,
        confidence: outcome.confidence ?? row.confidence,
        estimate: outcome.estimate ?? row.estimate,
        analysedAt: stamp(),
      };
      if (outcome.kind === "meal") {
        logged.push({
          assetId: row.id,
          name: outcome.name ?? "Meal",
          kcal: outcome.kcal ?? 0,
          capturedAtMs: row.capturedAtMs,
          localDate: row.captureDate,
          mealId: next.mealId,
        });
      }
      await save(next);
      input.onProgress?.(counts());
    }
  }

  const photos = [...input.discovered].sort((a, b) => b.capturedAtMs - a.capturedAtMs);
  const freshSince = input.nowMs - (input.freshMs ?? DEFAULT_FRESH_MS);
  await classify(photos.filter((photo) => photo.capturedAtMs >= freshSince));
  await drain();
  await classify(photos.filter((photo) => photo.capturedAtMs < freshSince));
  await drain();

  const final = counts();
  if (canSend && !run.hitLimit && final.waiting === 0) resumeAtMs = null;
  return { counts: final, resumeAtMs, logged, stoppedForBudget: run.stoppedForBudget || run.paused };
}

function overBudget(started: number, budgetMs: number, now: number): boolean {
  return now - started >= budgetMs;
}

function baseRow(
  photo: PipelinePhoto,
  input: PipelineInput,
  toLocalDate: (ms: number) => string,
  patch: Partial<PipelineRow>,
): PipelineRow {
  const previous = input.rows.get(photo.id);
  return {
    id: photo.id,
    capturedAtMs: photo.capturedAtMs,
    captureDate: toLocalDate(photo.capturedAtMs),
    source: previous?.source ?? input.source,
    verdict: null,
    labels: [],
    classifierId: input.classifierId,
    policyVersion: input.policyVersion,
    classifiedAt: null,
    aiState: "queued",
    classification: null,
    confidence: null,
    estimate: null,
    remotePhotoId: previous?.remotePhotoId ?? null,
    mealId: previous?.mealId ?? null,
    error: null,
    attempts: previous?.attempts ?? 0,
    analysedAt: previous?.analysedAt ?? null,
    ...patch,
  };
}
