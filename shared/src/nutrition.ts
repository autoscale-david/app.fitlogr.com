export interface MacroTotals {
  calories_kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

export interface MacroItem extends MacroTotals {
  name?: string;
}

/** Round to one decimal without binary drift on values like 1.005. */
export function round1(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

/** Authoritative meal totals. Callers must not trust model-summed totals. */
export function sumMacros(items: readonly MacroItem[]): MacroTotals {
  return {
    calories_kcal: round1(items.reduce((sum, item) => sum + item.calories_kcal, 0)),
    protein_g: round1(items.reduce((sum, item) => sum + item.protein_g, 0)),
    carbs_g: round1(items.reduce((sum, item) => sum + item.carbs_g, 0)),
    fat_g: round1(items.reduce((sum, item) => sum + item.fat_g, 0)),
  };
}

/**
 * Daily eating budget shown on the Log screen.
 * Active calories from a workout are already inside the platform active-energy
 * total, so workout calories are not added a second time.
 * Resting burn is not added on top of the user's base goal.
 */
export function calorieBudget(baseKcal: number, activeBurnedKcal: number): number {
  return Math.round(baseKcal + activeBurnedKcal);
}

export function caloriesRemaining(
  baseKcal: number,
  activeBurnedKcal: number,
  eatenKcal: number,
): number {
  return calorieBudget(baseKcal, activeBurnedKcal) - Math.round(eatenKcal);
}

/** 4/4/9 Atwater estimate, used only as a sanity warning, never as the stored total. */
export function atwaterCalories(proteinG: number, carbsG: number, fatG: number): number {
  return 4 * proteinG + 4 * carbsG + 9 * fatG;
}
