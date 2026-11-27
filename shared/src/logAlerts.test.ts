import { describe, expect, it } from "vitest";
import type { DayPlanSnapshot } from "./caloriePlan";
import { alertsForPass, type AlertMeal } from "./logAlerts";

const snapshot: DayPlanSnapshot = {
  planType: "daily",
  inPlan: true,
  day: { type: "maintain" },
  cycleDay: null,
  cycleLength: null,
  maintenanceCalories: 2050,
  toleranceKcal: 100,
  fastAllowanceKcal: 0,
};

const now = new Date("2026-11-26T20:00:00.000Z");

function meal(partial: Partial<AlertMeal> & Pick<AlertMeal, "name" | "kcal">): AlertMeal {
  return {
    capturedAt: "2026-11-26T19:00:00.000Z",
    localDate: "2026-11-26",
    ...partial,
  };
}

describe("log alerts", () => {
  it("collapses several fresh meals and skips history", () => {
    const { alerts } = alertsForPass({
      now,
      foreground: false,
      meals: [
        meal({ name: "Lunch", kcal: 640 }),
        meal({ name: "Snack", kcal: 200 }),
        meal({ name: "Old", kcal: 900, capturedAt: "2026-11-20T19:00:00.000Z", localDate: "2026-11-20", backfill: true }),
      ],
      today: { localDate: "2026-11-26", eatenBefore: 0, burnedKcal: 0, snapshot },
      usedUpSentForDate: null,
      notifyMeals: true,
      notifyUsedUp: true,
    });
    expect(alerts.find((alert) => alert.kind === "meal")?.body).toBe("2 meals logged · 840 kcal. 1210 kcal available today.");
    expect(alerts.some((alert) => alert.body.includes("Old"))).toBe(false);
  });

  it("does not notify while the app is open, and announces used-up once per day", () => {
    const first = alertsForPass({
      now,
      foreground: true,
      meals: [meal({ name: "Dinner", kcal: 2140 })],
      today: { localDate: "2026-11-26", eatenBefore: 0, burnedKcal: 0, snapshot },
      usedUpSentForDate: null,
      notifyMeals: true,
      notifyUsedUp: true,
    });
    expect(first.alerts.map((alert) => alert.kind)).toEqual(["used_up"]);
    expect(first.alerts[0]?.inApp).toBe(true);
    expect(first.alerts[0]?.body).toBe("You've used today's calories: 2140 eaten, 2050 available.");
    expect(first.usedUpDate).toBe("2026-11-26");

    const again = alertsForPass({
      now,
      foreground: false,
      meals: [meal({ name: "Dessert", kcal: 100 })],
      today: { localDate: "2026-11-26", eatenBefore: 2140, burnedKcal: 0, snapshot },
      usedUpSentForDate: first.usedUpDate,
      notifyMeals: true,
      notifyUsedUp: true,
    });
    expect(again.alerts.some((alert) => alert.kind === "used_up")).toBe(false);
    expect(again.alerts.some((alert) => alert.kind === "meal")).toBe(true);
  });

  it("does not notify for a backfill even when the photo is recent", () => {
    const { alerts } = alertsForPass({
      now,
      foreground: false,
      meals: [meal({ name: "Lunch", kcal: 400, backfill: true })],
      today: { localDate: "2026-11-26", eatenBefore: 0, burnedKcal: 0, snapshot },
      usedUpSentForDate: null,
      notifyMeals: true,
      notifyUsedUp: true,
    });
    expect(alerts).toEqual([]);
  });
});
