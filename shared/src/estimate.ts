import { round1, sumMacros } from "./nutrition";
import { MealVisionSchema, type MealVision } from "./photos";

export type CalorieEstimateKind = "meal" | "workout" | "ignore";

export interface CalorieEstimateItem {
  name: string;
  kcal: number;
}

/** `kcal` is intake for a meal, machine burn for a workout, and 0 for ignore. */
export interface CalorieEstimate {
  kind: CalorieEstimateKind;
  items: CalorieEstimateItem[];
  kcal: number;
  reason: string;
}

/** Turn one model JSON payload into a meal, a workout burn, or ignore. */
export function estimateFromModelPayload(payload: unknown): CalorieEstimate {
  return estimateFromVision(MealVisionSchema.parse(payload));
}

export function estimateFromVision(analysis: MealVision): CalorieEstimate {
  if (analysis.classification === "workout") {
    const readout = analysis.burn_kcal;
    const kcal = readout === null ? round1(analysis.items.reduce((sum, item) => sum + item.calories_kcal, 0)) : round1(readout);
    return {
      kind: "workout",
      items: analysis.items.map(toItem),
      kcal,
      reason: shortReason(analysis, "Machine calorie readout"),
    };
  }
  if (analysis.classification === "meal") {
    return {
      kind: "meal",
      items: analysis.items.map(toItem),
      kcal: sumMacros(analysis.items).calories_kcal,
      reason: shortReason(analysis, analysis.meal_name ?? "Meal"),
    };
  }
  return {
    kind: "ignore",
    items: [],
    kcal: 0,
    reason: shortReason(analysis, "Not a meal or a workout"),
  };
}

function toItem(item: MealVision["items"][number]): CalorieEstimateItem {
  return { name: item.name, kcal: round1(item.calories_kcal) };
}

function shortReason(analysis: MealVision, fallback: string): string {
  const reason = analysis.reason?.trim();
  if (reason) return reason.slice(0, 300);
  const notes = analysis.notes?.trim();
  if (notes) return notes.slice(0, 300);
  return fallback;
}
