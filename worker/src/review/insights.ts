import type { DailyInsight } from "@fitlogr/shared";
import { InsightFailed, completeInsight, textConfigFromEnv, type TextAttempt } from "../ai/text";
import type { Env } from "../env";
import { ApiError } from "../http";
import { nowIso, uuidv7 } from "../ids";
import { hashInsightSnapshot, loadInsightSnapshot, type InsightSnapshot } from "./fingerprint";

/** Generous for a real evening review, tight enough to stop a retry loop. */
export const DAILY_INSIGHT_LIMIT = 8;

export class InsightRateLimitError extends ApiError {
  readonly retryAfter: number;

  constructor(retryAfter = 3600) {
    super(429, "RATE_LIMITED", "Too many daily insights today. Try again later.");
    this.retryAfter = retryAfter;
  }
}

export async function getDailyInsight(
  db: D1Database,
  env: Env,
  fetchImpl: typeof fetch,
  userId: string,
  date: string,
  now: Date,
): Promise<DailyInsight> {
  const snapshot = await loadInsightSnapshot(db, userId, date, now);
  const fingerprint = await hashInsightSnapshot(snapshot);
  const cached = await db
    .prepare(
      `SELECT ai_insight, insight_input_hash, insight_generated_at
       FROM daily_summaries WHERE user_id = ? AND local_date = ?`,
    )
    .bind(userId, date)
    .first<{ ai_insight: string | null; insight_input_hash: string | null; insight_generated_at: string | null }>();
  if (cached?.ai_insight && cached.insight_input_hash === fingerprint && cached.insight_generated_at) {
    return {
      date,
      insight: withoutGoalWording(cached.ai_insight),
      cached: true,
      generated_at: cached.insight_generated_at,
      model: null,
    };
  }

  await enforceInsightLimit(db, userId, date, now);
  const config = textConfigFromEnv(env);
  let generated: { insight: string; attempts: TextAttempt[] };
  try {
    generated = await completeInsight(fetchImpl, config, insightPrompt(snapshot));
    generated = { ...generated, insight: withoutGoalWording(generated.insight) };
  } catch (error) {
    if (error instanceof InsightFailed) {
      await logAttempts(db, userId, error.attempts, date, now);
    }
    throw error;
  }
  await logAttempts(db, userId, generated.attempts, date, now);
  const generatedAt = nowIso(now);
  const succeeded = [...generated.attempts].reverse().find((attempt) => attempt.insight);
  await storeInsight(db, userId, date, generated.insight, fingerprint, generatedAt);
  return {
    date,
    insight: generated.insight,
    cached: false,
    generated_at: generatedAt,
    model: succeeded?.model ?? null,
  };
}

function insightPrompt(snapshot: InsightSnapshot): string {
  const meals = snapshot.meals.map((meal) => `${meal.name} (${meal.calories_kcal} kcal)`).join(", ") || "none";
  const workouts =
    snapshot.workouts.map((workout) => `${workout.activity} ${workout.duration_min} min, ${workout.calories_kcal} kcal`).join(", ") ||
    "none";
  return `Write a friendly 2-3 sentence daily fitness note for ${snapshot.date}.
Use only the numbers below. Do not invent meals, workouts, or weight changes.
Do not give medical advice, diagnoses, or supplement recommendations.
Call calorie numbers a "target" or the "plan"; judge the day on net intake versus maintenance.
Reply with JSON only: {"insight":"..."} and keep insight under 320 characters.

Intake: ${snapshot.macros.calories_kcal} kcal
Protein: ${snapshot.macros.protein_g} g (target ${snapshot.goals.daily_protein_target_g ?? "unset"} g)
Carbs: ${snapshot.macros.carbs_g} g (target ${snapshot.goals.daily_carbs_target_g ?? "unset"} g)
Fat: ${snapshot.macros.fat_g} g (target ${snapshot.goals.daily_fat_target_g ?? "unset"} g)
Active calories burned: ${snapshot.active_calories_kcal} kcal
Resting calories burned: ${snapshot.resting_calories_kcal} kcal
Weight kg: ${snapshot.weight_kg ?? "none"}
Maintenance calories: ${snapshot.plan?.maintenance_kcal ?? "unset"} kcal
Today's plan: ${snapshot.plan?.label ?? "unset"}
Calorie target: ${snapshot.goals.daily_calorie_target_kcal ?? "unset"} kcal plus workout burn
Calorie offset vs maintenance: ${snapshot.goals.daily_calorie_delta_target_kcal ?? "unset"} kcal
Meals: ${meals}
Workouts: ${workouts}`;
}

/** The app never says "goal"; model wording is normalized to "target". */
export function withoutGoalWording(text: string): string {
  return text.replace(/\b(g)(oal)(s?)\b/gi, (_match, g: string, _rest: string, plural: string) => `${g === "G" ? "T" : "t"}arget${plural}`);
}

async function enforceInsightLimit(db: D1Database, userId: string, date: string, now: Date): Promise<void> {
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const daily = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM ai_requests
       WHERE user_id = ? AND request_type = 'daily_insight' AND fallback_used = 0
         AND status != 'rate_limited' AND created_at >= ?`,
    )
    .bind(userId, dayAgo)
    .first<{ n: number }>();
  if ((daily?.n ?? 0) < DAILY_INSIGHT_LIMIT) return;
  await insertAi(db, {
    userId,
    model: "rate-limit",
    fallbackUsed: false,
    promptTokens: null,
    completionTokens: null,
    estimatedCostUsd: null,
    latencyMs: 0,
    status: "rate_limited",
    relatedEntityId: date,
    now,
  });
  throw new InsightRateLimitError(3600);
}

async function storeInsight(
  db: D1Database,
  userId: string,
  date: string,
  insight: string,
  fingerprint: string,
  generatedAt: string,
): Promise<void> {
  const settings = await db.prepare("SELECT timezone FROM user_settings WHERE user_id = ?").bind(userId).first<{ timezone: string }>();
  await db
    .prepare(
      `INSERT INTO daily_summaries (
         user_id, local_date, timezone, ai_insight, insight_input_hash, insight_generated_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, local_date) DO UPDATE SET
         ai_insight = excluded.ai_insight,
         insight_input_hash = excluded.insight_input_hash,
         insight_generated_at = excluded.insight_generated_at,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, date, settings?.timezone ?? "UTC", insight, fingerprint, generatedAt, generatedAt)
    .run();
}

async function logAttempts(db: D1Database, userId: string, attempts: TextAttempt[], date: string, now: Date): Promise<void> {
  for (const attempt of attempts) {
    await insertAi(db, {
      userId,
      model: attempt.model,
      fallbackUsed: attempt.fallbackUsed,
      promptTokens: attempt.promptTokens,
      completionTokens: attempt.completionTokens,
      estimatedCostUsd: attempt.estimatedCostUsd,
      latencyMs: attempt.latencyMs,
      status: attempt.status,
      relatedEntityId: date,
      now,
    });
  }
}

async function insertAi(
  db: D1Database,
  input: {
    userId: string;
    model: string;
    fallbackUsed: boolean;
    promptTokens: number | null;
    completionTokens: number | null;
    estimatedCostUsd: number | null;
    latencyMs: number;
    status: "ok" | "schema_error" | "upstream_error" | "rate_limited";
    relatedEntityId: string;
    now: Date;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ai_requests (
         id, user_id, request_type, model, fallback_used, prompt_tokens, completion_tokens,
         estimated_cost_usd, latency_ms, status, related_entity_id, created_at
       ) VALUES (?, ?, 'daily_insight', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      uuidv7(input.now.getTime()),
      input.userId,
      input.model,
      input.fallbackUsed ? 1 : 0,
      input.promptTokens,
      input.completionTokens,
      input.estimatedCostUsd,
      input.latencyMs,
      input.status,
      input.relatedEntityId,
      nowIso(input.now),
    )
    .run();
}
