import { z } from "zod";

export const KCAL_PER_KG = 7700;
export const MIN_PERIOD_DAYS = 5;
export const MIN_COMPLETE_INTAKE_KCAL = 400;

export const MaintenancePeriodSchema = z.object({
  start_date: z.iso.date(),
  end_date: z.iso.date(),
  days: z.number().int(),
  avg_intake_kcal: z.number(),
  avg_active_kcal: z.number(),
  start_weight_kg: z.number(),
  end_weight_kg: z.number(),
  weight_delta_kg: z.number(),
  implied_base_kcal: z.number(),
});
export type MaintenancePeriod = z.infer<typeof MaintenancePeriodSchema>;

export const MaintenanceEstimateSchema = z.object({
  status: z.enum(["ready", "insufficient_data"]),
  confidence: z.enum(["low", "medium", "high"]),
  estimated_base_calories: z.number().int().nullable(),
  estimated_tdee_calories: z.number().int().nullable(),
  avg_intake_calories: z.number().nullable(),
  avg_active_calories: z.number().nullable(),
  total_complete_days: z.number().int(),
  qualifying_period_count: z.number().int(),
  periods: z.array(MaintenancePeriodSchema),
  warnings: z.array(z.string()),
  missing_reason: z.string().nullable(),
  days: z.number().int(),
});
export type MaintenanceEstimate = z.infer<typeof MaintenanceEstimateSchema>;

export const MaintenanceQuerySchema = z.object({
  days: z.string().regex(/^\d+$/).optional(),
});

export interface EstimateDay {
  date: string;
  intakeKcal: number | null;
  activeKcal: number | null;
  restingKcal: number;
  hasWorkout: boolean;
}

export interface EstimateWeight {
  date: string;
  kg: number;
}

export function clampEstimateDays(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 90;
  return Math.min(365, Math.max(14, Math.round(value)));
}

export function estimateMaintenance(input: {
  daysRequested: number;
  days: EstimateDay[];
  weights: EstimateWeight[];
}): MaintenanceEstimate {
  const ordered = [...input.days].sort((a, b) => a.date.localeCompare(b.date));
  const complete = ordered.filter(isCompleteDay);
  const runs = contiguousRuns(complete).filter((run) => run.length >= MIN_PERIOD_DAYS);
  const periods: MaintenancePeriod[] = [];
  for (const run of runs) {
    const start = run[0]?.date;
    const end = run[run.length - 1]?.date;
    if (!start || !end) continue;
    const startWeight = averageWeight(input.weights, addDays(start, -1), addDays(start, 1));
    const endWeight = averageWeight(input.weights, addDays(end, -1), addDays(end, 1));
    if (startWeight == null || endWeight == null) continue;
    const intake = run.reduce((total, day) => total + (day.intakeKcal ?? 0), 0);
    const active = run.reduce((total, day) => total + (day.activeKcal ?? 0), 0);
    const deltaKg = endWeight - startWeight;
    const deltaEnergy = deltaKg * KCAL_PER_KG;
    const implied = (intake - active - deltaEnergy) / run.length;
    periods.push({
      start_date: start,
      end_date: end,
      days: run.length,
      avg_intake_kcal: round1(intake / run.length),
      avg_active_kcal: round1(active / run.length),
      start_weight_kg: round2(startWeight),
      end_weight_kg: round2(endWeight),
      weight_delta_kg: round2(deltaKg),
      implied_base_kcal: round1(implied),
    });
  }

  const qualifyingDays = periods.reduce((total, period) => total + period.days, 0);
  if (periods.length === 0 || qualifyingDays === 0) {
    return MaintenanceEstimateSchema.parse({
      status: "insufficient_data",
      confidence: "low",
      estimated_base_calories: null,
      estimated_tdee_calories: null,
      avg_intake_calories: null,
      avg_active_calories: null,
      total_complete_days: complete.length,
      qualifying_period_count: 0,
      periods: [],
      warnings: [],
      missing_reason: missingReason(complete.length, runs.length, input.weights.length),
      days: input.daysRequested,
    });
  }

  const intakeSum = periods.reduce((total, period) => total + period.avg_intake_kcal * period.days, 0);
  const activeSum = periods.reduce((total, period) => total + period.avg_active_kcal * period.days, 0);
  const baseNumerator = periods.reduce((total, period) => total + period.implied_base_kcal * period.days, 0);
  const base = baseNumerator / qualifyingDays;
  const tdee = base + activeSum / qualifyingDays;
  const warnings: string[] = [];
  if (qualifyingDays < 14) {
    warnings.push("This window is shorter than 14 days, so water-weight swings can move the estimate.");
  }
  if (base < 1000 || base > 4500 || tdee < 1000 || tdee > 4500) {
    warnings.push("The estimate is outside 1,000–4,500 kcal/day. Check the logged intake, burn, and weights before applying it.");
  }
  return MaintenanceEstimateSchema.parse({
    status: "ready",
    confidence: qualifyingDays >= 28 ? "high" : qualifyingDays >= 14 ? "medium" : "low",
    estimated_base_calories: Math.round(base),
    estimated_tdee_calories: Math.round(tdee),
    avg_intake_calories: round1(intakeSum / qualifyingDays),
    avg_active_calories: round1(activeSum / qualifyingDays),
    total_complete_days: qualifyingDays,
    qualifying_period_count: periods.length,
    periods,
    warnings,
    missing_reason: null,
    days: input.daysRequested,
  });
}

function isCompleteDay(day: EstimateDay): boolean {
  if (day.intakeKcal == null || day.intakeKcal < MIN_COMPLETE_INTAKE_KCAL) return false;
  if (day.activeKcal == null) return false;
  return day.activeKcal > 0 || day.restingKcal > 0 || day.hasWorkout;
}

function contiguousRuns(days: EstimateDay[]): EstimateDay[][] {
  const runs: EstimateDay[][] = [];
  let current: EstimateDay[] = [];
  for (const day of days) {
    const previous = current[current.length - 1];
    if (!previous || addDays(previous.date, 1) === day.date) current.push(day);
    else {
      runs.push(current);
      current = [day];
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

function averageWeight(weights: EstimateWeight[], from: string, to: string): number | null {
  const matched = weights.filter((weight) => weight.date >= from && weight.date <= to);
  if (matched.length === 0) return null;
  return matched.reduce((total, weight) => total + weight.kg, 0) / matched.length;
}

function missingReason(completeDays: number, longRuns: number, weightCount: number): string {
  if (completeDays < MIN_PERIOD_DAYS) {
    return `Found ${completeDays} complete day${completeDays === 1 ? "" : "s"}. A complete day needs at least 400 kcal logged and an active-calorie record, and a period needs ${MIN_PERIOD_DAYS} days in a row.`;
  }
  if (longRuns === 0) {
    return `Found ${completeDays} complete days, but none form a ${MIN_PERIOD_DAYS}-day stretch without a gap.`;
  }
  if (weightCount === 0) {
    return `Found a ${MIN_PERIOD_DAYS}-day stretch, but no weight records near the start and end. Log or import weight for those days.`;
  }
  return `Found complete days, but no stretch of ${MIN_PERIOD_DAYS} or more has a weight within a day of both its start and its end.`;
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function chunkByLocalDate<T extends { local_date: string }>(records: T[], daysPerChunk: number): T[][] {
  const size = Math.max(1, daysPerChunk);
  const ordered = [...records].sort((a, b) => a.local_date.localeCompare(b.local_date));
  const chunks: T[][] = [];
  let current: T[] = [];
  let origin: string | null = null;
  for (const record of ordered) {
    if (!origin) origin = record.local_date;
    if (daySpan(origin, record.local_date) >= size) {
      if (current.length > 0) chunks.push(current);
      current = [record];
      origin = record.local_date;
    } else current.push(record);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function daySpan(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((end - start) / 86_400_000);
}
