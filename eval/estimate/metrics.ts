import type { CalorieEstimateKind } from "@fitlogr/shared";
import type { ClassMetrics, EvalCaseResult, EvalSummary } from "./types";

const KINDS: readonly CalorieEstimateKind[] = ["meal", "workout", "ignore"];

export function computeSummary(results: readonly EvalCaseResult[]): EvalSummary {
  const total = results.length;
  const schemaValidCount = results.filter((r) => r.schema_valid).length;
  const fallbackCount = results.filter((r) => r.fallback_used).length;

  const confusion: Record<CalorieEstimateKind, Record<CalorieEstimateKind | "error", number>> = {
    meal: { meal: 0, workout: 0, ignore: 0, error: 0 },
    workout: { meal: 0, workout: 0, ignore: 0, error: 0 },
    ignore: { meal: 0, workout: 0, ignore: 0, error: 0 },
  };

  let clsCorrect = 0;
  for (const r of results) {
    const predicted = r.predicted_kind ?? "error";
    confusion[r.expected.kind][predicted] += 1;
    if (r.predicted_kind === r.expected.kind) clsCorrect += 1;
  }

  const perClass = {} as Record<CalorieEstimateKind, ClassMetrics>;
  for (const kind of KINDS) {
    const tp = confusion[kind][kind];
    const actualTotal = results.filter((r) => r.expected.kind === kind).length;
    const predictedTotal = results.filter((r) => r.predicted_kind === kind).length;
    perClass[kind] = {
      total: actualTotal,
      correct: tp,
      accuracy: ratio(tp, actualTotal),
      recall: ratio(tp, actualTotal),
      precision: ratio(tp, predictedTotal),
    };
  }

  const workoutCases = results.filter((r) => r.expected.kind === "workout");
  const workoutClassified = workoutCases.filter((r) => r.predicted_kind === "workout" && r.predicted_kcal !== null);
  const workoutExact = workoutClassified.filter((r) => Math.round(r.predicted_kcal!) === Math.round(r.expected.kcal)).length;
  const workoutWithin5 = workoutClassified.filter((r) => Math.abs(r.predicted_kcal! - r.expected.kcal) <= 5).length;
  const workoutAbsErrors = workoutClassified.map((r) => Math.abs(r.predicted_kcal! - r.expected.kcal));

  const vf = results.find((r) => r.id === "fixture-workout-01-vision-console");

  const mealCases = results.filter((r) => r.expected.kind === "meal");
  const mealScored = mealCases.filter((r) => r.predicted_kind === "meal" && r.predicted_kcal !== null && r.expected.kcal > 0);
  const mealAbsErrors = mealScored.map((r) => Math.abs(r.predicted_kcal! - r.expected.kcal));
  const mealSqErrors = mealScored.map((r) => (r.predicted_kcal! - r.expected.kcal) ** 2);
  const mealSignedErrors = mealScored.map((r) => r.predicted_kcal! - r.expected.kcal);
  const mealApes = mealScored.map((r) => (Math.abs(r.predicted_kcal! - r.expected.kcal) / r.expected.kcal) * 100);
  const mealSignedPcts = mealScored.map((r) => ((r.predicted_kcal! - r.expected.kcal) / r.expected.kcal) * 100);

  const macroScored = mealScored.filter((r) => r.expected.macros && r.predicted_macros);
  const proteinErrors = macroScored.map((r) => Math.abs(r.predicted_macros!.protein_g - r.expected.macros!.protein_g));
  const carbsErrors = macroScored.map((r) => Math.abs(r.predicted_macros!.carbs_g - r.expected.macros!.carbs_g));
  const fatErrors = macroScored.map((r) => Math.abs(r.predicted_macros!.fat_g - r.expected.macros!.fat_g));
  const atwaterWarnings = mealScored.filter((r) => r.atwater_warning !== null).length;

  const latencies = results.map((r) => r.latency_ms).filter((ms) => Number.isFinite(ms));
  const costs = results.map((r) => r.estimated_cost_usd).filter((c): c is number => c !== null && Number.isFinite(c));
  const totalCost = costs.reduce((sum, c) => sum + c, 0);
  const totalPromptTokens = results.reduce((sum, r) => sum + (r.prompt_tokens ?? 0), 0);
  const totalCompletionTokens = results.reduce((sum, r) => sum + (r.completion_tokens ?? 0), 0);
  const avgPreprocessedBytes = mean(results.map((r) => r.preprocessed_bytes));

  return {
    total_cases: total,
    schema_valid_count: schemaValidCount,
    schema_valid_rate: ratio(schemaValidCount, total),
    fallback_count: fallbackCount,
    fallback_rate: ratio(fallbackCount, total),
    classification: {
      correct: clsCorrect,
      total,
      accuracy: ratio(clsCorrect, total),
      per_class: perClass,
      confusion_matrix: confusion,
    },
    workouts: {
      total: workoutCases.length,
      classified_as_workout: workoutClassified.length,
      exact_match_count: workoutExact,
      exact_match_rate: ratio(workoutExact, workoutCases.length),
      within_5_kcal_count: workoutWithin5,
      within_5_kcal_rate: ratio(workoutWithin5, workoutCases.length),
      mae_kcal: round1OrNull(mean(workoutAbsErrors)),
      vision_fitness_check: {
        present: Boolean(vf),
        predicted_kind: vf?.predicted_kind ?? null,
        predicted_kcal: vf?.predicted_kcal ?? null,
        exact_153: Boolean(vf && vf.predicted_kind === "workout" && Math.round(vf.predicted_kcal ?? -1) === 153),
      },
    },
    meals: {
      total: mealCases.length,
      classified_as_meal: mealScored.length,
      scored_count: mealScored.length,
      mae_kcal: round1OrNull(mean(mealAbsErrors)),
      rmse_kcal: mealSqErrors.length > 0 ? round1(Math.sqrt(mean(mealSqErrors)!)) : null,
      mape_pct: round1OrNull(mean(mealApes)),
      median_ape_pct: round1OrNull(percentile(mealApes, 50)),
      within_20_pct_rate: mealScored.length > 0 ? ratio(mealApes.filter((p) => p <= 20).length, mealScored.length) : null,
      within_25_pct_rate: mealScored.length > 0 ? ratio(mealApes.filter((p) => p <= 25).length, mealScored.length) : null,
      within_30_pct_rate: mealScored.length > 0 ? ratio(mealApes.filter((p) => p <= 30).length, mealScored.length) : null,
      mean_signed_error_kcal: round1OrNull(mean(mealSignedErrors)),
      mean_signed_pct_error: round1OrNull(mean(mealSignedPcts)),
      macro_scored_count: macroScored.length,
      protein_mae_g: round1OrNull(mean(proteinErrors)),
      carbs_mae_g: round1OrNull(mean(carbsErrors)),
      fat_mae_g: round1OrNull(mean(fatErrors)),
      atwater_warning_count: atwaterWarnings,
    },
    performance: {
      latency_mean_ms: roundIntOrNull(mean(latencies)),
      latency_p50_ms: roundIntOrNull(percentile(latencies, 50)),
      latency_p95_ms: roundIntOrNull(percentile(latencies, 95)),
      total_prompt_tokens: totalPromptTokens,
      total_completion_tokens: totalCompletionTokens,
      total_cost_usd: round6(totalCost),
      cost_per_1000_photos_usd: costs.length > 0 ? round4((totalCost / costs.length) * 1000) : null,
      avg_preprocessed_kb: avgPreprocessedBytes !== null ? round1(avgPreprocessedBytes / 1024) : null,
    },
  };
}

export function formatSummaryReport(
  label: string,
  summary: EvalSummary,
  results: readonly EvalCaseResult[],
): string {
  const lines: string[] = [];
  lines.push(`=== FitLogr Estimate Eval: ${label} (n=${summary.total_cases}) ===`);
  lines.push(
    `Classification: ${summary.classification.correct}/${summary.classification.total} (${pct(summary.classification.accuracy)}) | ` +
      `Schema valid: ${summary.schema_valid_count}/${summary.total_cases} (${pct(summary.schema_valid_rate)}) | ` +
      `Fallback: ${summary.fallback_count}/${summary.total_cases}`,
  );
  for (const kind of KINDS) {
    const c = summary.classification.per_class[kind];
    lines.push(
      `  ${kind.padEnd(7)}: ${c.correct}/${c.total} recall=${pct(c.recall)} precision=${pct(c.precision)}`,
    );
  }
  lines.push("  Confusion (actual -> predicted: meal | workout | ignore | error):");
  for (const kind of KINDS) {
    const row = summary.classification.confusion_matrix[kind];
    lines.push(
      `    ${kind.padEnd(7)} -> meal:${String(row.meal).padStart(2)}  workout:${String(row.workout).padStart(2)}  ignore:${String(row.ignore).padStart(2)}  error:${String(row.error).padStart(2)}`,
    );
  }

  if (summary.workouts.total > 0) {
    const w = summary.workouts;
    lines.push(
      `Workouts (n=${w.total}): exact=${w.exact_match_count}/${w.total} (${pct(w.exact_match_rate)}) | ` +
        `<=5kcal=${w.within_5_kcal_count}/${w.total} | MAE=${w.mae_kcal ?? "n/a"} kcal` +
        (w.vision_fitness_check.present
          ? ` | VisionFitness=${w.vision_fitness_check.predicted_kcal ?? "err"} (${w.vision_fitness_check.exact_153 ? "PASS 153" : "FAIL !=153"})`
          : ""),
    );
  }

  if (summary.meals.total > 0) {
    const m = summary.meals;
    lines.push(
      `Meals (scored ${m.scored_count}/${m.total}): MAE=${m.mae_kcal ?? "n/a"} kcal | RMSE=${m.rmse_kcal ?? "n/a"} | ` +
        `MAPE=${m.mape_pct ?? "n/a"}% | MedAPE=${m.median_ape_pct ?? "n/a"}%`,
    );
    lines.push(
      `  Within ±20%: ${pctOrNa(m.within_20_pct_rate)} | ±25%: ${pctOrNa(m.within_25_pct_rate)} | ±30%: ${pctOrNa(m.within_30_pct_rate)} | ` +
        `Bias: ${signed(m.mean_signed_error_kcal)} kcal (${signed(m.mean_signed_pct_error)}%)`,
    );
    if (m.macro_scored_count > 0) {
      lines.push(
        `  Macros (n=${m.macro_scored_count}): Protein MAE=${m.protein_mae_g}g | Carbs MAE=${m.carbs_mae_g}g | Fat MAE=${m.fat_mae_g}g | Atwater warns=${m.atwater_warning_count}`,
      );
    }
  }

  const p = summary.performance;
  lines.push(
    `Perf & Cost: p50=${p.latency_p50_ms ?? "n/a"}ms | p95=${p.latency_p95_ms ?? "n/a"}ms | mean=${p.latency_mean_ms ?? "n/a"}ms | ` +
      `Cost/1k=$${p.cost_per_1000_photos_usd !== null ? p.cost_per_1000_photos_usd.toFixed(3) : "n/a"} | ` +
      `Avg JPEG=${p.avg_preprocessed_kb ?? "n/a"}KB | Tokens=${p.total_prompt_tokens}in/${p.total_completion_tokens}out`,
  );

  lines.push("\nPer-case details:");
  for (const r of results) {
    const clsOk = r.predicted_kind === r.expected.kind;
    let status = clsOk ? "OK" : "CLS_ERR";
    let detail = "";
    if (!r.schema_valid) {
      status = "SCHEMA_ERR";
      detail = r.error ?? "invalid schema";
    } else if (r.expected.kind === "workout" && clsOk) {
      const diff = round1((r.predicted_kcal ?? 0) - r.expected.kcal);
      status = Math.round(r.predicted_kcal ?? -1) === Math.round(r.expected.kcal) ? "EXACT" : "NUM_ERR";
      detail = `pred=${r.predicted_kcal} exp=${r.expected.kcal} (diff=${signed(diff)})`;
    } else if (r.expected.kind === "meal" && clsOk) {
      const diff = round1((r.predicted_kcal ?? 0) - r.expected.kcal);
      const ape = r.expected.kcal > 0 ? round1((Math.abs(diff) / r.expected.kcal) * 100) : 0;
      status = ape <= 25 ? "OK" : "HIGH_ERR";
      detail = `pred=${r.predicted_kcal} exp=${r.expected.kcal} (diff=${signed(diff)}, APE=${ape}%)`;
    } else {
      detail = `pred=${r.predicted_kind}:${r.predicted_kcal} exp=${r.expected.kind}:${r.expected.kcal}`;
    }
    lines.push(
      `  [${status.padEnd(10)}] ${r.id.padEnd(40)} ${detail.padEnd(44)} ${String(r.latency_ms).padStart(5)}ms | ${r.reason ?? ""}`,
    );
  }
  return lines.join("\n");
}

function ratio(n: number, d: number): number {
  if (d <= 0) return 0;
  return Math.round((n / d) * 10000) / 10000;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round1OrNull(v: number | null): number | null {
  return v === null ? null : round1(v);
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function round6(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000;
}

function roundIntOrNull(v: number | null): number | null {
  return v === null ? null : Math.round(v);
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function pctOrNa(v: number | null): string {
  return v === null ? "n/a" : pct(v);
}

function signed(v: number | null): string {
  if (v === null) return "n/a";
  return `${v >= 0 ? "+" : ""}${v}`;
}
