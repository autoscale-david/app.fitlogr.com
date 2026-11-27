import type { CalorieEstimateKind, MealVision } from "@fitlogr/shared";

export type EvalSplit = "fixtures" | "dev" | "test";

export type GroundTruthType = "lab_weighed" | "exact_readout" | "visual_reference" | "non_target";

export interface EvalMacros {
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

export interface EvalCaseSource {
  dataset: string;
  local_path?: string;
  url?: string;
  page_url?: string;
  license: string;
  attribution: string;
  sha256: string;
}

export interface EvalCaseExpected {
  kind: CalorieEstimateKind;
  kcal: number;
  ground_truth_type: GroundTruthType;
  mass_g?: number;
  macros?: EvalMacros;
  ingredients_note?: string;
}

export interface EvalCase {
  id: string;
  split: EvalSplit;
  subcategory: string;
  description: string;
  expected: EvalCaseExpected;
  source: EvalCaseSource;
}

export interface EvalManifest {
  version: number;
  description: string;
  policy_notes: string[];
  cases: EvalCase[];
}

export interface EvalCaseResult {
  id: string;
  split: EvalSplit;
  subcategory: string;
  expected: EvalCaseExpected;
  predicted_kind: CalorieEstimateKind | null;
  predicted_kcal: number | null;
  predicted_macros: EvalMacros | null;
  confidence: number | null;
  reason: string | null;
  atwater_warning: string | null;
  schema_valid: boolean;
  fallback_used: boolean;
  model_used: string | null;
  latency_ms: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  estimated_cost_usd: number | null;
  preprocessed_bytes: number;
  error: string | null;
  raw_analysis: MealVision | null;
}

export interface ClassMetrics {
  total: number;
  correct: number;
  accuracy: number;
  precision: number;
  recall: number;
}

export interface EvalSummary {
  total_cases: number;
  schema_valid_count: number;
  schema_valid_rate: number;
  fallback_count: number;
  fallback_rate: number;
  classification: {
    correct: number;
    total: number;
    accuracy: number;
    per_class: Record<CalorieEstimateKind, ClassMetrics>;
    confusion_matrix: Record<CalorieEstimateKind, Record<CalorieEstimateKind | "error", number>>;
  };
  workouts: {
    total: number;
    classified_as_workout: number;
    exact_match_count: number;
    exact_match_rate: number;
    within_5_kcal_count: number;
    within_5_kcal_rate: number;
    mae_kcal: number | null;
    vision_fitness_check: {
      present: boolean;
      predicted_kind: CalorieEstimateKind | null;
      predicted_kcal: number | null;
      exact_153: boolean;
    };
  };
  meals: {
    total: number;
    classified_as_meal: number;
    scored_count: number;
    mae_kcal: number | null;
    rmse_kcal: number | null;
    mape_pct: number | null;
    median_ape_pct: number | null;
    within_20_pct_rate: number | null;
    within_25_pct_rate: number | null;
    within_30_pct_rate: number | null;
    mean_signed_error_kcal: number | null;
    mean_signed_pct_error: number | null;
    macro_scored_count: number;
    protein_mae_g: number | null;
    carbs_mae_g: number | null;
    fat_mae_g: number | null;
    atwater_warning_count: number;
  };
  performance: {
    latency_mean_ms: number | null;
    latency_p50_ms: number | null;
    latency_p95_ms: number | null;
    total_prompt_tokens: number;
    total_completion_tokens: number;
    total_cost_usd: number;
    cost_per_1000_photos_usd: number | null;
    avg_preprocessed_kb: number | null;
  };
}
