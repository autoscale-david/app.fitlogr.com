import { describe, expect, it } from "vitest";
import { chunkByLocalDate, estimateMaintenance, type EstimateDay, type EstimateWeight } from "./maintenance";

function days(count: number, start: string, patch?: Partial<EstimateDay>): EstimateDay[] {
  const result: EstimateDay[] = [];
  let date = start;
  for (let index = 0; index < count; index += 1) {
    result.push({
      date,
      intakeKcal: 2500,
      activeKcal: 500,
      restingKcal: 1600,
      hasWorkout: false,
      ...patch,
    });
    date = next(date);
  }
  return result;
}

function next(date: string): string {
  const utc = new Date(`${date}T00:00:00.000Z`);
  utc.setUTCDate(utc.getUTCDate() + 1);
  return utc.toISOString().slice(0, 10);
}

function weights(start: string, end: string, startKg: number, endKg: number): EstimateWeight[] {
  return [
    { date: start, kg: startKg },
    { date: end, kg: endKg },
  ];
}

describe("maintenance estimate", () => {
  it("estimates base and TDEE when weight is steady", () => {
    const series = days(10, "2026-01-01");
    const estimate = estimateMaintenance({
      daysRequested: 90,
      days: series,
      weights: weights("2026-01-01", "2026-01-10", 80, 80),
    });
    expect(estimate.status).toBe("ready");
    expect(estimate.estimated_base_calories).toBe(2000);
    expect(estimate.estimated_tdee_calories).toBe(2500);
    expect(estimate.confidence).toBe("low");
    expect(estimate.warnings.some((warning) => warning.includes("water-weight"))).toBe(true);
    expect(estimate.total_complete_days).toBe(10);
  });

  it("raises base calories when weight falls on the same intake", () => {
    const series = days(10, "2026-02-01");
    const estimate = estimateMaintenance({
      daysRequested: 90,
      days: series,
      weights: weights("2026-02-01", "2026-02-10", 80, 79),
    });
    expect(estimate.estimated_base_calories).toBe(2770);
    expect(estimate.estimated_tdee_calories).toBe(3270);
    expect(estimate.periods[0]?.weight_delta_kg).toBe(-1);
  });

  it("lowers base calories when weight rises", () => {
    const series = days(10, "2026-03-01");
    const estimate = estimateMaintenance({
      daysRequested: 90,
      days: series,
      weights: weights("2026-03-01", "2026-03-10", 80, 81),
    });
    expect(estimate.estimated_base_calories).toBe(1230);
    expect(estimate.estimated_tdee_calories).toBe(1730);
  });

  it("splits complete stretches around unlogged gaps and skips days missing active burn", () => {
    const first = days(6, "2026-04-01");
    const gap: EstimateDay = { date: "2026-04-07", intakeKcal: null, activeKcal: 500, restingKcal: 1600, hasWorkout: false };
    const second = days(6, "2026-04-08");
    const missingActive: EstimateDay = { date: "2026-04-14", intakeKcal: 2500, activeKcal: null, restingKcal: 1600, hasWorkout: true };
    const estimate = estimateMaintenance({
      daysRequested: 90,
      days: [...first, gap, ...second, missingActive],
      weights: [
        { date: "2026-04-01", kg: 80 },
        { date: "2026-04-06", kg: 80 },
        { date: "2026-04-08", kg: 79.5 },
        { date: "2026-04-13", kg: 79.5 },
      ],
    });
    expect(estimate.qualifying_period_count).toBe(2);
    expect(estimate.periods.map((period) => [period.start_date, period.end_date, period.days])).toEqual([
      ["2026-04-01", "2026-04-06", 6],
      ["2026-04-08", "2026-04-13", 6],
    ]);
    expect(estimate.total_complete_days).toBe(12);
    expect(estimate.estimated_base_calories).toBe(2000);
  });

  it("smooths boundary weights across the surrounding day", () => {
    const series = days(5, "2026-05-10");
    const estimate = estimateMaintenance({
      daysRequested: 30,
      days: series,
      weights: [
        { date: "2026-05-09", kg: 82 },
        { date: "2026-05-11", kg: 80 },
        { date: "2026-05-14", kg: 79 },
        { date: "2026-05-15", kg: 81 },
      ],
    });
    expect(estimate.periods[0]?.start_weight_kg).toBe(81);
    expect(estimate.periods[0]?.end_weight_kg).toBe(80);
  });

  it("explains insufficient data when the stretch or the weights are missing", () => {
    const short = estimateMaintenance({
      daysRequested: 14,
      days: days(4, "2026-06-01"),
      weights: weights("2026-06-01", "2026-06-04", 80, 80),
    });
    expect(short.status).toBe("insufficient_data");
    expect(short.estimated_base_calories).toBeNull();
    expect(short.missing_reason).toContain("4 complete days");

    const noWeights = estimateMaintenance({ daysRequested: 30, days: days(6, "2026-06-10"), weights: [] });
    expect(noWeights.status).toBe("insufficient_data");
    expect(noWeights.missing_reason).toContain("no weight");
  });

  it("warns when the estimate is physiologically implausible and raises confidence with more days", () => {
    const low = estimateMaintenance({
      daysRequested: 90,
      days: days(10, "2026-07-01", { intakeKcal: 800, activeKcal: 100 }),
      weights: weights("2026-07-01", "2026-07-10", 80, 80),
    });
    expect(low.warnings.some((warning) => warning.includes("1,000"))).toBe(true);

    const long = estimateMaintenance({
      daysRequested: 90,
      days: days(28, "2026-08-01"),
      weights: weights("2026-08-01", "2026-08-28", 80, 80),
    });
    expect(long.confidence).toBe("high");
    expect(long.warnings.some((warning) => warning.includes("water-weight"))).toBe(false);
  });
});

describe("health history chunks", () => {
  it("keeps each request inside a 14-day window", () => {
    const records = Array.from({ length: 30 }, (_, index) => ({
      local_date: `2026-09-${String(index + 1).padStart(2, "0")}`,
      id: index,
    }));
    const chunks = chunkByLocalDate(records, 14);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.[0]?.local_date).toBe("2026-09-01");
    expect(chunks[0]?.at(-1)?.local_date).toBe("2026-09-14");
    expect(chunks[2]?.[0]?.local_date).toBe("2026-09-29");
  });
});
