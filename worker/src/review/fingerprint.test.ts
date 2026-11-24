import { describe, expect, it } from "vitest";
import { canonicalJson, hashInsightSnapshot, type InsightSnapshot } from "./fingerprint";
import { addIsoDays, localDateInTimeZone } from "./dates";

const snapshot: InsightSnapshot = {
  date: "2026-11-23",
  goals: {
    daily_calorie_target_kcal: 1900,
    daily_calorie_delta_target_kcal: null,
    daily_protein_target_g: 140,
    daily_carbs_target_g: 210,
    daily_fat_target_g: 65,
    target_weight_kg: null,
  },
  meals: [
    {
      id: "meal-1",
      name: "Bowl",
      calories_kcal: 640,
      protein_g: 50,
      carbs_g: 60,
      fat_g: 16,
      items: [{ id: "item-1", name: "Bowl", quantity: 1, calories_kcal: 640, protein_g: 50, carbs_g: 60, fat_g: 16 }],
    },
  ],
  macros: { calories_kcal: 640, protein_g: 50, carbs_g: 60, fat_g: 16 },
  workouts: [],
  active_calories_kcal: 500,
  resting_calories_kcal: 1400,
  weight_kg: 79.2,
};

describe("insight fingerprint", () => {
  it("is stable for the same inputs and changes when weight, meals, or keys move", async () => {
    const first = await hashInsightSnapshot(snapshot);
    const second = await hashInsightSnapshot(JSON.parse(JSON.stringify(snapshot)) as InsightSnapshot);
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(await hashInsightSnapshot({ ...snapshot, weight_kg: 80 })).not.toBe(first);
    expect(await hashInsightSnapshot({ ...snapshot, active_calories_kcal: 510 })).not.toBe(first);
    expect(
      await hashInsightSnapshot({
        ...snapshot,
        meals: [{ ...snapshot.meals[0]!, calories_kcal: 700 }],
      }),
    ).not.toBe(first);
  });
});

describe("local dates", () => {
  it("keeps the evening on the user's local day across the UTC midnight boundary", () => {
    const evening = new Date("2026-11-24T07:30:00.000Z");
    expect(localDateInTimeZone(evening, "America/Los_Angeles")).toBe("2026-11-23");
    expect(localDateInTimeZone(evening, "UTC")).toBe("2026-11-24");
    expect(localDateInTimeZone(new Date("2026-11-24T08:00:00.000Z"), "America/Los_Angeles")).toBe("2026-11-24");
    expect(addIsoDays("2026-11-23", -6)).toBe("2026-11-17");
    expect(localDateInTimeZone(evening, "Not/AZone")).toBe("2026-11-24");
  });
});
