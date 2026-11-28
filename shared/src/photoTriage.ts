export interface TriageLabel {
  id: string;
  confidence: number;
}

export type TriageVerdict = "food" | "workout" | "uncertain" | "not_relevant";

export interface PhotoTriagePolicy {
  version: string;
  foodLabels: readonly string[];
  workoutLabels: readonly string[];
  foodKeywords: readonly string[];
  workoutKeywords: readonly string[];
  /** A food label at or above this is food. */
  foodThreshold: number;
  /** A workout label at or above this is a workout. */
  workoutThreshold: number;
  /** A weaker food or workout label is uncertain rather than discarded. */
  uncertainThreshold: number;
  /** If the strongest label is below this, the photo is uncertain. */
  lowConfidence: number;
  /** When true, uncertain photos are sent for analysis. One switch for a stricter filter. */
  sendUncertain: boolean;
}

export const PHOTO_TRIAGE_POLICY: PhotoTriagePolicy = {
  version: "2026-11-26",
  foodLabels: ["food", "meal", "dish", "fruit", "vegetable", "dessert", "beverage"],
  workoutLabels: ["exercise_machine", "treadmill", "dumbbell", "barbell", "gym", "stationary_bike", "elliptical"],
  foodKeywords: ["food", "meal", "dish", "fruit", "vegetable", "drink", "beverage", "dessert", "cuisine", "snack", "bread", "pizza", "salad", "pasta", "coffee"],
  workoutKeywords: ["gym", "exercise", "treadmill", "dumbbell", "barbell", "workout", "elliptical", "stationary_bike", "display", "screen"],
  foodThreshold: 0.2,
  workoutThreshold: 0.3,
  uncertainThreshold: 0.05,
  lowConfidence: 0.3,
  sendUncertain: true,
};

export function triage(labels: readonly TriageLabel[], policy: PhotoTriagePolicy = PHOTO_TRIAGE_POLICY): { verdict: TriageVerdict; matched: string[] } {
  const food = matching(labels, policy.foodLabels, policy.foodKeywords);
  const workout = matching(labels, policy.workoutLabels, policy.workoutKeywords);
  const foodHit = food.find((label) => label.confidence >= policy.foodThreshold);
  if (foodHit) return { verdict: "food", matched: [foodHit.id] };
  const workoutHit = workout.find((label) => label.confidence >= policy.workoutThreshold);
  if (workoutHit) return { verdict: "workout", matched: [workoutHit.id] };
  const weak = [...food, ...workout].find((label) => label.confidence >= policy.uncertainThreshold);
  const best = labels.reduce((max, label) => Math.max(max, label.confidence), 0);
  if (weak || labels.length === 0 || best < policy.lowConfidence) {
    return { verdict: "uncertain", matched: weak ? [weak.id] : [] };
  }
  return { verdict: "not_relevant", matched: [] };
}

export function sendsForAnalysis(verdict: TriageVerdict, policy: PhotoTriagePolicy = PHOTO_TRIAGE_POLICY): boolean {
  if (verdict === "food" || verdict === "workout") return true;
  return verdict === "uncertain" && policy.sendUncertain;
}

function matching(labels: readonly TriageLabel[], exact: readonly string[], keywords: readonly string[]): TriageLabel[] {
  const exactSet = new Set(exact.map((item) => item.toLowerCase()));
  return labels.filter((label) => {
    const id = label.id.toLowerCase();
    if (exactSet.has(id)) return true;
    return keywords.some((word) => id.includes(word));
  });
}
