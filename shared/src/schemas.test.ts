import { describe, expect, it } from "vitest";
import {
  AccountDeleteRequestSchema,
  AccountExportSchema,
  AuthStartRequestSchema,
  DailyInsightSchema,
  MealWriteSchema,
  SettingsUpdateSchema,
  SyncChangesResponseSchema,
  TrendsQuerySchema,
  TrendsResponseSchema,
  WeightWriteSchema,
} from "./schemas/index";

describe("stage 2 API schemas", () => {
  it("accepts a native and an Expo Go auth start", () => {
    expect(
      AuthStartRequestSchema.safeParse({
        redirect_uri: "fitlogr://auth/callback",
        client_challenge: "a".repeat(43),
        device: { platform: "ios" },
      }).success,
    ).toBe(true);
    expect(
      AuthStartRequestSchema.safeParse({
        redirect_uri: "exp://10.0.0.8:8081/--/auth/callback",
        client_challenge: "abc",
      }).success,
    ).toBe(false);
  });

  it("rejects meal writes that try to skip items", () => {
    const parsed = MealWriteSchema.safeParse({
      name: "Lunch",
      eaten_at: "2026-11-23T20:00:00.000Z",
      local_date: "2026-11-23",
      timezone: "America/Los_Angeles",
      items: [],
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts weight, settings, and a sync page", () => {
    expect(
      WeightWriteSchema.safeParse({
        weight_kg: 79.2,
        recorded_at: "2026-11-23T15:00:00.000Z",
        local_date: "2026-11-23",
        timezone: "America/Los_Angeles",
      }).success,
    ).toBe(true);
    expect(SettingsUpdateSchema.safeParse({ daily_calorie_target_kcal: 1800 }).success).toBe(true);
    expect(SettingsUpdateSchema.safeParse({ expected_updated_at: "2026-11-23T15:00:00.000Z" }).success).toBe(false);
    expect(
      SyncChangesResponseSchema.safeParse({
        cursor: "opaque",
        has_more: false,
        settings: null,
        meals: [],
        health_records: [],
      }).success,
    ).toBe(true);
  });
});

describe("stage 5 review schemas", () => {
  it("accepts an insight, a trend window, and a confirmed account deletion", () => {
    expect(
      DailyInsightSchema.safeParse({
        date: "2026-11-23",
        insight: "A steady day under the calorie goal.",
        cached: true,
        generated_at: "2026-11-24T04:00:00.000Z",
        model: null,
      }).success,
    ).toBe(true);
    expect(TrendsQuerySchema.safeParse({ days: "30" }).success).toBe(true);
    expect(TrendsQuerySchema.safeParse({ days: "90" }).success).toBe(false);
    expect(AccountDeleteRequestSchema.safeParse({ confirm: true }).success).toBe(true);
    expect(AccountDeleteRequestSchema.safeParse({ confirm: false }).success).toBe(false);
    expect(
      TrendsResponseSchema.safeParse({
        timezone: "America/Los_Angeles",
        days: 7,
        from: "2026-11-17",
        to: "2026-11-23",
        calorie_target_kcal: 1900,
        points: [
          {
            date: "2026-11-23",
            calories_in_kcal: 640,
            calories_burned_kcal: 1900,
            surplus_deficit_kcal: -1260,
            protein_g: 50,
            carbs_g: 60,
            fat_g: 16,
            workout_minutes: 35,
            workout_count: 1,
            meal_count: 1,
            weight_kg: 79.2,
          },
        ],
      }).success,
    ).toBe(true);
    expect(AccountExportSchema.safeParse({ exported_at: "not-a-date" }).success).toBe(false);
  });
});
