import { describe, expect, it } from "vitest";
import {
  atwaterCalories,
  calorieBudget,
  caloriesRemaining,
  round1,
  sumMacros,
} from "./nutrition";

describe("nutrition", () => {
  it("sums item macros and rounds to one decimal", () => {
    const totals = sumMacros([
      { calories_kcal: 410.24, protein_g: 18.15, carbs_g: 36.04, fat_g: 22.16 },
      { calories_kcal: 620.2, protein_g: 54.1, carbs_g: 78.2, fat_g: 16.1 },
    ]);
    expect(totals).toEqual({
      calories_kcal: 1030.4,
      protein_g: 72.3,
      carbs_g: 114.2,
      fat_g: 38.3,
    });
  });

  it("builds the remaining budget from base plus active burn, without double-counting workouts", () => {
    expect(calorieBudget(1900, 391)).toBe(2291);
    expect(caloriesRemaining(1900, 391, 1500)).toBe(791);
  });

  it("rounds halves away from binary noise", () => {
    expect(round1(1.25)).toBe(1.3);
    expect(round1(1.24)).toBe(1.2);
  });

  it("estimates Atwater energy from grams", () => {
    expect(atwaterCalories(10, 20, 5)).toBe(165);
  });
});
