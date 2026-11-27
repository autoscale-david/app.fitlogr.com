import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { estimateFromModelPayload, type CalorieEstimate } from "./estimate";

const fixtures = fileURLToPath(new URL("./estimate/fixtures/", import.meta.url));

const cases: Array<{ file: string; image: string; assumption: RegExp; estimate: CalorieEstimate }> = [
  {
    file: "01-workout-vision-console.json",
    image: "01-workout-vision-console.png",
    assumption: /console calories window reads 153/i,
    estimate: {
      kind: "workout",
      items: [{ name: "Vision Fitness cardio", kcal: 153 }],
      kcal: 153,
      reason: "Vision Fitness console calories window reads 153.",
    },
  },
  {
    file: "02-meal-kenzi-latte-pastry.json",
    image: "02-meal-kenzi-latte-pastry.png",
    assumption: /not a lab measurement/i,
    estimate: {
      kind: "meal",
      items: [
        { name: "Kenzi latte", kcal: 158 },
        { name: "Berry cream danish", kcal: 448 },
      ],
      kcal: 606,
      reason: "12 fl oz Kenzi latte and one berry cream danish.",
    },
  },
  {
    file: "03-meal-banana-crepes.json",
    image: "03-meal-banana-crepes.png",
    assumption: /not a lab measurement/i,
    estimate: {
      kind: "meal",
      items: [
        { name: "Folded crepes", kcal: 324 },
        { name: "Banana slices", kcal: 134 },
        { name: "Whipped cream", kcal: 88 },
        { name: "Powdered sugar", kcal: 32 },
        { name: "Maple syrup", kcal: 104 },
      ],
      kcal: 682,
      reason: "Banana crepes with whipped cream, powdered sugar, and syrup.",
    },
  },
  {
    file: "04-ignore-fire-pit.json",
    image: "04-ignore-fire-pit.png",
    assumption: /no food and no exercise readout/i,
    estimate: {
      kind: "ignore",
      items: [],
      kcal: 0,
      reason: "Fire pit and patio, no food and no workout.",
    },
  },
];

describe("calorie estimate fixtures", () => {
  it.each(cases)("parses $file without calling a model", ({ file, image, assumption, estimate }) => {
    const imageStat = statSync(`${fixtures}${image}`);
    expect(imageStat.size).toBeGreaterThan(10_000);
    const payload = JSON.parse(readFileSync(`${fixtures}${file}`, "utf8")) as { assumption?: string };
    expect(payload.assumption).toMatch(assumption);
    expect(estimateFromModelPayload(payload)).toEqual(estimate);
  });

  it("uses the console burn and ignores a meal total", () => {
    expect(
      estimateFromModelPayload({
        classification: "workout",
        is_meal: false,
        confidence: 0.9,
        meal_name: "Bike",
        suggested_meal_type: null,
        notes: null,
        reason: "Console calories read 153.",
        burn_kcal: 153,
        items: [
          {
            name: "Bike",
            quantity: 35,
            unit: "min",
            estimated_grams: null,
            calories_kcal: 825,
            protein_g: 0,
            carbs_g: 0,
            fat_g: 0,
            confidence: 0.4,
          },
        ],
      }),
    ).toMatchObject({ kind: "workout", kcal: 153 });

    expect(
      estimateFromModelPayload({
        classification: "meal",
        is_meal: true,
        confidence: 0.8,
        meal_name: "Soup",
        suggested_meal_type: "lunch",
        notes: null,
        reason: "A bowl of soup.",
        burn_kcal: 9999,
        total_calories: 9999,
        items: [
          {
            name: "Soup",
            quantity: 1,
            unit: "bowl",
            estimated_grams: 300,
            calories_kcal: 120,
            protein_g: 6,
            carbs_g: 14,
            fat_g: 4,
            confidence: 0.8,
          },
        ],
      }),
    ).toEqual({
      kind: "meal",
      items: [{ name: "Soup", kcal: 120 }],
      kcal: 120,
      reason: "A bowl of soup.",
    });
  });

  it("ignores a non-meal even when the payload includes calories", () => {
    const legacy = estimateFromModelPayload({
      classification: "not_meal",
      is_meal: false,
      confidence: 0.9,
      meal_name: null,
      suggested_meal_type: null,
      notes: "A dog",
      items: [],
    });
    expect(legacy).toEqual({ kind: "ignore", items: [], kcal: 0, reason: "A dog" });

    const stray = estimateFromModelPayload({
      classification: "ignore",
      is_meal: false,
      confidence: 0.9,
      meal_name: null,
      suggested_meal_type: null,
      notes: null,
      reason: "Not food.",
      burn_kcal: 400,
      items: [
        {
          name: "Ghost calories",
          quantity: 1,
          unit: "serving",
          estimated_grams: null,
          calories_kcal: 400,
          protein_g: 0,
          carbs_g: 0,
          fat_g: 0,
          confidence: 0.2,
        },
      ],
    });
    expect(stray).toEqual({ kind: "ignore", items: [], kcal: 0, reason: "Not food." });
  });
});
