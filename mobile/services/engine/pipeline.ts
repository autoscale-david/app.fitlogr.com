import { localDateISO } from "../dates";

/** What the audit row is waiting on. `not_sent` is final: the photo never leaves the phone. */
export type AiState = "not_sent" | "queued" | "meal" | "workout" | "ignore" | "duplicate" | "excluded" | "error";

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
}

export interface AnalyzeOutcome {
  kind: "meal" | "workout" | "ignore" | "duplicate" | "excluded" | "error" | "rate_limited" | "paused";
  retryAfterSeconds?: number;
  mealId?: string | null;
  remotePhotoId?: string | null;
  name?: string;
  kcal?: number;
  message?: string;
  classification?: string | null;
  confidence?: number | null;
  estimate?: unknown;
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
}

/**
 * One photo pass: classify newest first, then analyse the queue newest capture first.
 * A 429 stores a resume time and stops. One bad photo is recorded and the pass continues.
 * Final rows are not read again and are not modified.
 */
export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const clock = input.clock ?? Date.now;
  const toLocalDate = input.toLocalDate ?? ((ms: number) => localDateISO(new Date(ms)));
  const started = clock();
  const logged: LoggedMeal[] = [];
  let checked = 0;
  let analysed = 0;
  let errors = 0;
  let stoppedForBudget = false;
  let resumeAtMs = input.resumeAtMs;

  const photos = [...input.discovered].sort((a, b) => b.capturedAtMs - a.capturedAtMs);

  for (const photo of photos) {
    if (overBudget(started, input.budgetMs, clock())) {
      stoppedForBudget = true;
      break;
    }
    checked += 1;
    const existing = input.rows.get(photo.id);
    if (existing && isFinalAudit(existing)) continue;

    if (photo.screenshot) {
      input.rows.set(photo.id, baseRow(photo, input, toLocalDate, {
        verdict: "screenshot",
        aiState: "not_sent",
        classifiedAt: new Date(input.nowMs).toISOString(),
      }));
      continue;
    }

    let classified: { labels: PipelineLabel[] } | { error: string };
    try {
      classified = await input.classify(photo);
    } catch (error) {
      classified = { error: error instanceof Error ? error.message : "Could not read the photo" };
    }
    if ("error" in classified) {
      errors += 1;
      input.rows.set(photo.id, baseRow(photo, input, toLocalDate, {
        verdict: "unreadable",
        aiState: "error",
        error: classified.error,
        classifiedAt: new Date(input.nowMs).toISOString(),
      }));
      continue;
    }

    const decision = input.decide(classified.labels);
    input.rows.set(photo.id, baseRow(photo, input, toLocalDate, {
      verdict: decision.verdict,
      labels: classified.labels,
      aiState: decision.send ? "queued" : "not_sent",
      classifiedAt: new Date(input.nowMs).toISOString(),
    }));
  }

  const queue = [...input.rows.values()]
    .filter((row) => row.aiState === "queued")
    .sort((a, b) => b.capturedAtMs - a.capturedAtMs);

  const canSend = resumeAtMs === null || resumeAtMs <= input.nowMs;
  let hitLimit = false;
  if (canSend) {
    for (const row of queue) {
      if (overBudget(started, input.budgetMs, clock())) {
        stoppedForBudget = true;
        break;
      }
      const photo = photos.find((item) => item.id === row.id) ?? {
        id: row.id,
        capturedAtMs: row.capturedAtMs,
        screenshot: false,
      };
      let outcome: AnalyzeOutcome;
      try {
        outcome = await input.analyze(photo, row);
      } catch (error) {
        errors += 1;
        row.aiState = "error";
        row.error = error instanceof Error ? error.message : "The photo could not be analyzed";
        continue;
      }
      if (outcome.kind === "paused") {
        stoppedForBudget = true;
        break;
      }
      if (outcome.kind === "rate_limited") {
        const wait = Math.max(1, outcome.retryAfterSeconds ?? 60);
        resumeAtMs = input.nowMs + wait * 1000;
        row.error = outcome.message ?? "Photo analysis limit reached";
        hitLimit = true;
        break;
      }
      analysed += 1;
      row.error = outcome.kind === "error" ? outcome.message ?? "The photo could not be analyzed" : null;
      if (outcome.kind === "error") {
        errors += 1;
        row.aiState = "error";
        continue;
      }
      row.aiState = outcome.kind;
      row.remotePhotoId = outcome.remotePhotoId ?? row.remotePhotoId;
      row.mealId = outcome.mealId ?? row.mealId;
      row.classification = outcome.classification ?? row.classification;
      row.confidence = outcome.confidence ?? row.confidence;
      row.estimate = outcome.estimate ?? row.estimate;
      if (outcome.kind === "meal") {
        logged.push({
          assetId: row.id,
          name: outcome.name ?? "Meal",
          kcal: outcome.kcal ?? 0,
          capturedAtMs: row.capturedAtMs,
          localDate: row.captureDate,
          mealId: row.mealId,
        });
      }
    }
  }

  const waiting = [...input.rows.values()].filter((row) => row.aiState === "queued").length;
  if (canSend && !hitLimit && waiting === 0) resumeAtMs = null;
  const lookLikeFood = [...input.rows.values()].filter((row) => row.verdict === "food" || row.verdict === "workout" || row.verdict === "uncertain").length;
  return {
    counts: { checked, lookLikeFood, analysed, waiting, errors, meals: logged.length },
    resumeAtMs,
    logged,
    stoppedForBudget,
  };
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
    ...patch,
  };
}
