import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeSummary, formatSummaryReport } from "../../../eval/estimate/metrics";
import type { EvalCaseResult, EvalManifest } from "../../../eval/estimate/types";

const manifestPath = fileURLToPath(new URL("../../../eval/estimate/manifest.json", import.meta.url));

describe("estimate eval benchmark manifest & metrics", () => {
  it("contains valid, balanced, leak-free splits with licenses and SHA-256 hashes", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as EvalManifest;
    expect(manifest.version).toBe(1);
    expect(manifest.cases.length).toBeGreaterThanOrEqual(50);

    const ids = new Set<string>();
    const hashes = new Set<string>();
    const counts = {
      fixtures: { meal: 0, workout: 0, ignore: 0 },
      dev: { meal: 0, workout: 0, ignore: 0 },
      test: { meal: 0, workout: 0, ignore: 0 },
    };

    for (const item of manifest.cases) {
      expect(ids.has(item.id)).toBe(false);
      ids.add(item.id);
      expect(item.source.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(hashes.has(item.source.sha256)).toBe(false);
      hashes.add(item.source.sha256);
      expect(item.source.license.length).toBeGreaterThan(0);
      expect(item.source.attribution.length).toBeGreaterThan(0);
      expect(Boolean(item.source.local_path) !== Boolean(item.source.url)).toBe(true);
      counts[item.split][item.expected.kind] += 1;
    }

    expect(counts.fixtures).toEqual({ meal: 2, workout: 1, ignore: 1 });
    expect(counts.dev.meal).toBeGreaterThanOrEqual(10);
    expect(counts.dev.workout).toBeGreaterThanOrEqual(5);
    expect(counts.dev.ignore).toBeGreaterThanOrEqual(6);
    expect(counts.test.meal).toBeGreaterThanOrEqual(10);
    expect(counts.test.workout).toBeGreaterThanOrEqual(5);
    expect(counts.test.ignore).toBeGreaterThanOrEqual(6);
  });

  it("computes classification, workout exact match, meal error, macro MAE, and cost metrics", () => {
    const sample: EvalCaseResult[] = [
      {
        id: "fixture-workout-01-vision-console",
        split: "fixtures",
        subcategory: "cardio_console",
        expected: { kind: "workout", kcal: 153, ground_truth_type: "exact_readout" },
        predicted_kind: "workout",
        predicted_kcal: 153,
        predicted_macros: null,
        confidence: 0.95,
        reason: "Calories window reads 153.",
        atwater_warning: null,
        schema_valid: true,
        fallback_used: false,
        model_used: "test-model",
        latency_ms: 1000,
        prompt_tokens: 500,
        completion_tokens: 100,
        estimated_cost_usd: 0.0005,
        preprocessed_bytes: 102_400,
        error: null,
        raw_analysis: null,
      },
      {
        id: "dev-meal-01",
        split: "dev",
        subcategory: "breakfast",
        expected: {
          kind: "meal",
          kcal: 500,
          ground_truth_type: "lab_weighed",
          macros: { protein_g: 20, carbs_g: 60, fat_g: 20 },
        },
        predicted_kind: "meal",
        predicted_kcal: 450,
        predicted_macros: { protein_g: 18, carbs_g: 55, fat_g: 17 },
        confidence: 0.9,
        reason: "Breakfast plate.",
        atwater_warning: null,
        schema_valid: true,
        fallback_used: false,
        model_used: "test-model",
        latency_ms: 2000,
        prompt_tokens: 600,
        completion_tokens: 150,
        estimated_cost_usd: 0.0007,
        preprocessed_bytes: 204_800,
        error: null,
        raw_analysis: null,
      },
      {
        id: "dev-ignore-01",
        split: "dev",
        subcategory: "dashboard",
        expected: { kind: "ignore", kcal: 0, ground_truth_type: "non_target" },
        predicted_kind: "ignore",
        predicted_kcal: 0,
        predicted_macros: null,
        confidence: 0.98,
        reason: "Car dashboard.",
        atwater_warning: null,
        schema_valid: true,
        fallback_used: false,
        model_used: "test-model",
        latency_ms: 1500,
        prompt_tokens: 400,
        completion_tokens: 50,
        estimated_cost_usd: 0.0003,
        preprocessed_bytes: 153_600,
        error: null,
        raw_analysis: null,
      },
    ];

    const summary = computeSummary(sample);
    expect(summary.classification.accuracy).toBe(1);
    expect(summary.workouts.exact_match_rate).toBe(1);
    expect(summary.workouts.vision_fitness_check.exact_153).toBe(true);
    expect(summary.meals.mae_kcal).toBe(50);
    expect(summary.meals.mape_pct).toBe(10);
    expect(summary.meals.within_20_pct_rate).toBe(1);
    expect(summary.meals.mean_signed_error_kcal).toBe(-50);
    expect(summary.meals.protein_mae_g).toBe(2);
    expect(summary.meals.carbs_mae_g).toBe(5);
    expect(summary.meals.fat_mae_g).toBe(3);
    expect(summary.performance.cost_per_1000_photos_usd).toBe(0.5);
    expect(formatSummaryReport("unit", summary, sample)).toContain("PASS 153");
  });
});
