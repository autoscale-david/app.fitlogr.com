import { z } from "zod";

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_NAMES: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};
export const WEEKDAY_SHORT: Record<Weekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};
export const WEEKDAY_LETTERS: Record<Weekday, string> = {
  mon: "M",
  tue: "T",
  wed: "W",
  thu: "T",
  fri: "F",
  sat: "S",
  sun: "S",
};

export const PLAN_LIMITS = {
  maintenanceMin: 1000,
  maintenanceMax: 6000,
  amountMin: 50,
  amountMax: 1000,
  amountStep: 50,
  amountDefault: 500,
  cycleMin: 2,
  cycleMax: 28,
  cycleDefault: 3,
  toleranceMin: 25,
  toleranceMax: 300,
  toleranceDefault: 100,
  fastAllowanceMin: 0,
  fastAllowanceMax: 200,
  fastAllowanceDefault: 0,
  /** Target Burn is 0 (none) or 50-2000 in steps of 50. */
  burnMin: 50,
  burnMax: 2000,
  burnStep: 50,
  burnDefault: 0,
  lowIntakeKcal: 1200,
} as const;

export const AMOUNT_PRESETS = [250, 500, 750] as const;
export const BURN_PRESETS = [0, 250, 500, 1000] as const;

export type PlanType = "daily" | "weekly" | "custom";
export const PLAN_TYPES: readonly PlanType[] = ["daily", "weekly", "custom"];
export const PLAN_TYPE_LABELS: Record<PlanType, string> = {
  daily: "Daily Plan",
  weekly: "Weekly Plan",
  custom: "Custom Plan",
};

export type DayPlanType = "deficit" | "maintain" | "surplus" | "fast";
export const DAY_PLAN_TYPES: readonly DayPlanType[] = ["deficit", "maintain", "surplus", "fast"];
/** Editor picker labels; days are described relative to the maintenance baseline. */
export const DAY_PLAN_TYPE_LABELS: Record<DayPlanType, string> = {
  deficit: "Below",
  maintain: "At baseline",
  surplus: "Above",
  fast: "Fast",
};

/**
 * The day type plus amount sets the net vs baseline (deficit -N, maintain 0, surplus +N). `targetBurn` is the
 * planned workout burn for that day; absent means 0. Fast days have no intake and no planned burn.
 */
export type DayPlan =
  | { type: "deficit"; amount: number; targetBurn?: number }
  | { type: "maintain"; targetBurn?: number }
  | { type: "surplus"; amount: number; targetBurn?: number }
  | { type: "fast" };

export interface PlanDates {
  /** Local calendar date, YYYY-MM-DD. */
  startDate: string;
  /** Inclusive local calendar date; null means no end date. */
  endDate: string | null;
}

export type DailyPlan = PlanDates & { day: DayPlan };
export type WeeklyPlan = PlanDates & { days: Record<Weekday, DayPlan> };
export type CustomPlan = PlanDates & { lengthDays: number; days: DayPlan[] };

export interface CaloriePlanSettings {
  maintenanceCalories: number;
  planType: PlanType;
  dailyPlan: DailyPlan;
  weeklyPlan: WeeklyPlan;
  customPlan: CustomPlan;
  toleranceKcal: number;
  fastAllowanceKcal: number;
  scaleMacrosWithPlan: boolean;
}

// ---------------------------------------------------------------------------
// Local calendar dates. All arithmetic runs on Y-M-D day numbers, never on
// instants, so DST and timezone changes cannot shift a plan.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const JS_WEEKDAYS: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function dayNumber(date: string): number {
  const match = ISO_DATE.exec(date);
  if (!match) throw new Error(`Invalid date: ${date}`);
  return Math.round(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS);
}

function fromDayNumber(value: number): string {
  const date = new Date(value * DAY_MS);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function calendarDaysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

export function addCalendarDays(date: string, days: number): string {
  return fromDayNumber(dayNumber(date) + days);
}

export function weekdayOf(date: string): Weekday {
  return JS_WEEKDAYS[new Date(dayNumber(date) * DAY_MS).getUTCDay()]!;
}

function dateParts(date: string): { year: number; month: number; day: number } {
  const match = ISO_DATE.exec(date);
  if (!match) throw new Error(`Invalid date: ${date}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** "Dec 31" */
export function formatMonthDay(date: string): string {
  const { month, day } = dateParts(date);
  return `${MONTHS[month - 1]} ${day}`;
}

/** "Nov 24, 2026" */
export function formatFullDate(date: string): string {
  const { year } = dateParts(date);
  return `${formatMonthDay(date)}, ${year}`;
}

/** "Wed Nov 25" */
export function formatWeekdayDate(date: string): string {
  return `${WEEKDAY_SHORT[weekdayOf(date)]} ${formatMonthDay(date)}`;
}

/** "Nov 24 - Dec 31", with years only when the range crosses a year. */
export function formatDateRange(start: string, end: string): string {
  if (dateParts(start).year !== dateParts(end).year) return `${formatFullDate(start)} - ${formatFullDate(end)}`;
  return `${formatMonthDay(start)} - ${formatMonthDay(end)}`;
}

/** Thousands separators without relying on the runtime's Intl data. */
export function formatKcal(value: number): string {
  const rounded = Math.round(value);
  const digits = String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return rounded < 0 ? `-${digits}` : digits;
}

export function formatSignedKcal(value: number): string {
  const rounded = Math.round(value);
  return rounded > 0 ? `+${formatKcal(rounded)}` : formatKcal(rounded);
}

// ---------------------------------------------------------------------------
// Defaults and migration

const MAINTAIN: DayPlan = { type: "maintain" };

export function maintainWeek(): Record<Weekday, DayPlan> {
  return { mon: MAINTAIN, tue: MAINTAIN, wed: MAINTAIN, thu: MAINTAIN, fri: MAINTAIN, sat: MAINTAIN, sun: MAINTAIN };
}

/** Migration from a single base calorie number: Maintenance every day, starting today. */
export function defaultCaloriePlan(maintenanceCalories: number, today: string): CaloriePlanSettings {
  return {
    maintenanceCalories: Math.round(maintenanceCalories),
    planType: "daily",
    dailyPlan: { startDate: today, endDate: null, day: MAINTAIN },
    weeklyPlan: { startDate: today, endDate: null, days: maintainWeek() },
    customPlan: {
      startDate: today,
      endDate: null,
      lengthDays: PLAN_LIMITS.cycleDefault,
      days: Array.from({ length: PLAN_LIMITS.cycleDefault }, () => MAINTAIN),
    },
    toleranceKcal: PLAN_LIMITS.toleranceDefault,
    fastAllowanceKcal: PLAN_LIMITS.fastAllowanceDefault,
    scaleMacrosWithPlan: true,
  };
}

export function selectedPlanDates(settings: CaloriePlanSettings): PlanDates {
  const plan = selectedPlan(settings);
  return { startDate: plan.startDate, endDate: plan.endDate };
}

export function withSelectedPlanDates(settings: CaloriePlanSettings, dates: PlanDates): CaloriePlanSettings {
  switch (settings.planType) {
    case "daily":
      return { ...settings, dailyPlan: { ...settings.dailyPlan, ...dates } };
    case "weekly":
      return { ...settings, weeklyPlan: { ...settings.weeklyPlan, ...dates } };
    case "custom":
      return { ...settings, customPlan: { ...settings.customPlan, ...dates } };
  }
}

function selectedPlan(settings: CaloriePlanSettings): DailyPlan | WeeklyPlan | CustomPlan {
  return settings.planType === "daily" ? settings.dailyPlan : settings.planType === "weekly" ? settings.weeklyPlan : settings.customPlan;
}

// ---------------------------------------------------------------------------
// Plan dates

export function isWithinPlanDates(dates: PlanDates, date: string): boolean {
  if (date < dates.startDate) return false;
  return dates.endDate == null || date <= dates.endDate;
}

/** Moving the start past the end clears the end date. */
export function setPlanStartDate(dates: PlanDates, startDate: string): PlanDates {
  return { startDate, endDate: dates.endDate != null && startDate > dates.endDate ? null : dates.endDate };
}

/** End dates are inclusive and may not precede the start; an earlier end is ignored. */
export function setPlanEndDate(dates: PlanDates, endDate: string | null): PlanDates {
  if (endDate != null && endDate < dates.startDate) return dates;
  return { ...dates, endDate };
}

export interface EndDateQuickOption {
  label: string;
  weeks: number | null;
}

export const END_DATE_QUICK_OPTIONS: readonly EndDateQuickOption[] = [
  { label: "No end date", weeks: null },
  { label: "4 weeks", weeks: 4 },
  { label: "8 weeks", weeks: 8 },
  { label: "12 weeks", weeks: 12 },
];
export const PICK_A_DATE_LABEL = "Pick a date";
export const NO_END_DATE_LABEL = "No end date";

/** Quick options count from the start date: N weeks is 7N days inclusive. */
export function endDateAfterWeeks(startDate: string, weeks: number): string {
  return addCalendarDays(startDate, weeks * 7 - 1);
}

export type PlanStatus =
  | { kind: "upcoming"; daysUntilStart: number; startDate: string }
  | { kind: "active"; dayNumber: number; totalDays: number | null; startDate: string; endDate: string | null }
  | { kind: "ended"; endDate: string };

export function planStatus(dates: PlanDates, today: string): PlanStatus {
  if (today < dates.startDate) {
    return { kind: "upcoming", daysUntilStart: calendarDaysBetween(today, dates.startDate), startDate: dates.startDate };
  }
  if (dates.endDate != null && today > dates.endDate) return { kind: "ended", endDate: dates.endDate };
  return {
    kind: "active",
    dayNumber: calendarDaysBetween(dates.startDate, today) + 1,
    totalDays: dates.endDate == null ? null : calendarDaysBetween(dates.startDate, dates.endDate) + 1,
    startDate: dates.startDate,
    endDate: dates.endDate,
  };
}

export function planStatusText(status: PlanStatus): string {
  switch (status.kind) {
    case "upcoming":
      return `Starts in ${status.daysUntilStart} ${status.daysUntilStart === 1 ? "day" : "days"}`;
    case "active":
      return status.endDate == null || status.totalDays == null
        ? `Active since ${formatMonthDay(status.startDate)}`
        : `Day ${status.dayNumber} of ${status.totalDays} · ends ${formatMonthDay(status.endDate)}`;
    case "ended":
      return `Ended ${formatMonthDay(status.endDate)} · you're back at baseline`;
  }
}

// ---------------------------------------------------------------------------
// Resolving a date

export interface ResolvedDay {
  planType: PlanType;
  inPlan: boolean;
  day: DayPlan;
  weekday: Weekday;
  /** 1-based cycle position for an in-range Custom Plan day. */
  cycleDay: number | null;
  cycleLength: number | null;
}

/** 0-based cycle index; Day 1 falls on the start date. */
export function cycleIndex(startDate: string, date: string, lengthDays: number): number {
  const n = Math.max(1, Math.floor(lengthDays));
  return ((calendarDaysBetween(startDate, date) % n) + n) % n;
}

export function resolveDay(settings: CaloriePlanSettings, date: string): ResolvedDay {
  const weekday = weekdayOf(date);
  const outside: ResolvedDay = { planType: settings.planType, inPlan: false, day: MAINTAIN, weekday, cycleDay: null, cycleLength: null };
  if (!isWithinPlanDates(selectedPlanDates(settings), date)) return outside;
  switch (settings.planType) {
    case "daily":
      return { ...outside, inPlan: true, day: settings.dailyPlan.day };
    case "weekly":
      return { ...outside, inPlan: true, day: settings.weeklyPlan.days[weekday] };
    case "custom": {
      const plan = settings.customPlan;
      const index = cycleIndex(plan.startDate, date, plan.lengthDays);
      return { ...outside, inPlan: true, day: plan.days[index] ?? MAINTAIN, cycleDay: index + 1, cycleLength: plan.lengthDays };
    }
  }
}

// ---------------------------------------------------------------------------
// History snapshots

/** What a day was judged against, frozen once the day is in the past. */
export interface DayPlanSnapshot {
  planType: PlanType;
  inPlan: boolean;
  day: DayPlan;
  cycleDay: number | null;
  cycleLength: number | null;
  maintenanceCalories: number;
  toleranceKcal: number;
  fastAllowanceKcal: number;
}

export function snapshotForDate(settings: CaloriePlanSettings, date: string): DayPlanSnapshot {
  const resolved = resolveDay(settings, date);
  return {
    planType: resolved.planType,
    inPlan: resolved.inPlan,
    day: resolved.day,
    cycleDay: resolved.cycleDay,
    cycleLength: resolved.cycleLength,
    maintenanceCalories: settings.maintenanceCalories,
    toleranceKcal: settings.toleranceKcal,
    fastAllowanceKcal: settings.fastAllowanceKcal,
  };
}

/**
 * Settings changes affect today and future days only: a past day uses the snapshot stored for it,
 * while today and later always resolve from the current settings.
 */
export function effectiveSnapshot(
  settings: CaloriePlanSettings,
  date: string,
  today: string,
  stored: DayPlanSnapshot | null | undefined,
): DayPlanSnapshot {
  if (date < today && stored) return stored;
  return snapshotForDate(settings, date);
}

// ---------------------------------------------------------------------------
// Calculations

export function targetBurnOf(day: DayPlan): number {
  return day.type === "fast" ? 0 : (day.targetBurn ?? 0);
}

/** Sets a day's planned burn; 0 drops the field so plans without a burn keep their old shape. */
export function withTargetBurn(day: DayPlan, targetBurn: number): DayPlan {
  if (day.type === "fast") return day;
  const { targetBurn: _previous, ...rest } = day;
  return targetBurn > 0 ? { ...rest, targetBurn } : rest;
}

/** Net vs maintenance: deficit -N, maintain 0, surplus +N. */
export function dayOffset(day: DayPlan): number {
  switch (day.type) {
    case "deficit":
      return -day.amount;
    case "surplus":
      return day.amount;
    default:
      return 0;
  }
}

/** Offset used in footers and totals; a fast day counts as allowance minus maintenance. */
export function planOffset(day: DayPlan, maintenanceCalories: number, fastAllowanceKcal: number): number {
  if (day.type === "fast") return fastAllowanceKcal - maintenanceCalories;
  return Math.max(dayOffset(day), -maintenanceCalories);
}

/** Calories to eat before workout burn: maintenance + net, without the planned burn. */
export function netTarget(day: DayPlan, maintenanceCalories: number, fastAllowanceKcal: number): number {
  if (day.type === "fast") return fastAllowanceKcal;
  return Math.max(0, Math.round(maintenanceCalories + dayOffset(day)));
}

/** Consumption target: maintenance + net + planned burn. A fast day is its allowance and ignores burn. */
export function dayTarget(day: DayPlan, maintenanceCalories: number, fastAllowanceKcal: number): number {
  if (day.type === "fast") return fastAllowanceKcal;
  return netTarget(day, maintenanceCalories, fastAllowanceKcal) + targetBurnOf(day);
}

export function snapshotTarget(snapshot: DayPlanSnapshot): number {
  return dayTarget(snapshot.day, snapshot.maintenanceCalories, snapshot.fastAllowanceKcal);
}

/**
 * consumptionTarget - eaten + (actualBurn - targetBurn). The planned burn is already inside the
 * consumption target, so only burn beyond (or short of) it moves the number; missing burn counts as 0.
 */
export function remainingCalories(snapshot: DayPlanSnapshot, eatenKcal: number, burnedKcal: number): number {
  const target = snapshotTarget(snapshot);
  // Rounded like the pre-plan budget math so migrated days show identical numbers.
  if (snapshot.day.type === "fast") return target - Math.round(eatenKcal);
  const actualBurn = Number.isFinite(burnedKcal) ? burnedKcal : 0;
  return Math.round(target + actualBurn - targetBurnOf(snapshot.day)) - Math.round(eatenKcal);
}

export function deltaVsMaintenance(snapshot: DayPlanSnapshot, eatenKcal: number, burnedKcal: number): number {
  return eatenKcal - burnedKcal - snapshot.maintenanceCalories;
}

export function isDayMet(snapshot: DayPlanSnapshot, eatenKcal: number, burnedKcal: number): boolean {
  const delta = deltaVsMaintenance(snapshot, eatenKcal, burnedKcal);
  const day = snapshot.day;
  switch (day.type) {
    case "deficit":
      return delta <= -day.amount;
    case "maintain":
      return Math.abs(delta) <= snapshot.toleranceKcal;
    case "surplus":
      return Math.abs(delta - day.amount) <= snapshot.toleranceKcal;
    case "fast":
      return eatenKcal <= snapshot.fastAllowanceKcal;
  }
}

export type RemainingState = { kind: "remaining"; amount: number } | { kind: "onTarget" } | { kind: "over"; amount: number };

export function remainingState(snapshot: DayPlanSnapshot, eatenKcal: number, burnedKcal: number): RemainingState {
  const remaining = remainingCalories(snapshot, eatenKcal, burnedKcal);
  const type = snapshot.day.type;
  if ((type === "maintain" || type === "surplus") && Math.abs(remaining) <= snapshot.toleranceKcal) return { kind: "onTarget" };
  if (remaining >= 0) return { kind: "remaining", amount: remaining };
  return { kind: "over", amount: Math.abs(remaining) };
}

export function remainingStateText(state: RemainingState): string {
  switch (state.kind) {
    case "remaining":
      return `${formatKcal(state.amount)} Calories Remaining`;
    case "onTarget":
      return "On target";
    case "over":
      return `${formatKcal(state.amount)} Calories Over`;
  }
}

/**
 * Log card banner, split so the amount can be colored: "Target: " + "500 kcal below" + " 2,000 kcal baseline"
 * (+ " · burn 500+"). `tone` colors `emphasis`.
 */
export interface TargetBanner {
  prefix: string;
  emphasis: string;
  tone: "deficit" | "surplus" | null;
  rest: string;
}

export function targetBanner(snapshot: DayPlanSnapshot): TargetBanner {
  const day = snapshot.inPlan ? snapshot.day : MAINTAIN;
  const baseline = formatKcal(snapshot.maintenanceCalories);
  const burn = burnSuffix(day);
  switch (day.type) {
    case "deficit":
      return { prefix: "Target: ", emphasis: `${formatKcal(day.amount)} kcal below`, tone: "deficit", rest: ` ${baseline} kcal baseline${burn}` };
    case "surplus":
      return { prefix: "Target: ", emphasis: `${formatKcal(day.amount)} kcal above`, tone: "surplus", rest: ` ${baseline} kcal baseline${burn}` };
    case "maintain":
      return { prefix: "Target: ", emphasis: "", tone: null, rest: `at baseline · ${baseline} kcal${burn}` };
    case "fast":
      return { prefix: "Target: ", emphasis: "", tone: null, rest: `fasting day · ${formatKcal(snapshot.fastAllowanceKcal)} kcal` };
  }
}

export function targetBannerText(banner: TargetBanner): string {
  return `${banner.prefix}${banner.emphasis}${banner.rest}`;
}

/**
 * Log calories card: "Calories Available" with the remaining kcal, "Calories Over" with the overage, or
 * "On target" (Maintain/Surplus within tolerance) keeping the remaining number.
 */
export interface CaloriesCard {
  title: "Calories Available" | "Calories Over" | "On target";
  amount: number;
  /** Whole percent for the ring label; null on fast days, whose ring stays empty. */
  percent: number | null;
  burnedText: string;
  eatenText: string;
}

const MINUS = "\u2212";

export function caloriesCard(snapshot: DayPlanSnapshot, eatenKcal: number, burnedKcal: number): CaloriesCard {
  const state = remainingState(snapshot, eatenKcal, burnedKcal);
  const remaining = remainingCalories(snapshot, eatenKcal, burnedKcal);
  const burned = Math.round(burnedKcal);
  const eaten = Math.round(eatenKcal);
  return {
    title: state.kind === "onTarget" ? "On target" : state.kind === "over" ? "Calories Over" : "Calories Available",
    amount: state.kind === "over" ? state.amount : remaining,
    percent: snapshot.day.type === "fast" ? null : Math.round(ringProgress(snapshot, eatenKcal, burnedKcal) * 100),
    burnedText: `${burned > 0 ? "+" : ""}${formatKcal(burned)} burned`,
    eatenText: `${eaten > 0 ? MINUS : ""}${formatKcal(eaten)} eaten`,
  };
}

/** eaten / (consumption target + burn beyond the planned burn), clamped to 0-1. A fast day's ring stays empty. */
export function ringProgress(snapshot: DayPlanSnapshot, eatenKcal: number, burnedKcal: number): number {
  if (snapshot.day.type === "fast") return 0;
  const denominator = snapshotTarget(snapshot) - targetBurnOf(snapshot.day) + burnedKcal;
  if (denominator <= 0) return eatenKcal > 0 ? 1 : 0;
  return Math.min(1, Math.max(0, eatenKcal / denominator));
}

export function fastOverAllowance(snapshot: DayPlanSnapshot, eatenKcal: number): boolean {
  return snapshot.day.type === "fast" && eatenKcal > snapshot.fastAllowanceKcal;
}

export type DayDotStatus = "met" | "missed" | null;

/**
 * Week-strip dot. No dot for future days or days with nothing logged, except a fast day that has
 * ended with nothing logged, which counts as met.
 */
export function dayDotStatus(input: {
  date: string;
  today: string;
  snapshot: DayPlanSnapshot;
  eatenKcal: number;
  burnedKcal: number;
  hasLog: boolean;
}): DayDotStatus {
  if (input.date > input.today) return null;
  if (!input.hasLog) {
    return input.snapshot.day.type === "fast" && input.date < input.today ? "met" : null;
  }
  return isDayMet(input.snapshot, input.eatenKcal, input.burnedKcal) ? "met" : "missed";
}

// ---------------------------------------------------------------------------
// Labels and copy

/** "500 kcal below baseline", "500 kcal above baseline", "At baseline", "Fast". */
export function dayNetPhrase(day: DayPlan): string {
  switch (day.type) {
    case "deficit":
      return `${formatKcal(day.amount)} kcal below baseline`;
    case "surplus":
      return `${formatKcal(day.amount)} kcal above baseline`;
    case "maintain":
      return "At baseline";
    case "fast":
      return "Fast";
  }
}

/** " · burn 500+", or "" without a planned burn. */
export function burnSuffix(day: DayPlan): string {
  const burn = targetBurnOf(day);
  return burn > 0 ? ` · burn ${formatKcal(burn)}+` : "";
}

/** "500 kcal below baseline · burn 500+", "At baseline", "Fast". */
export function dayPlanLabel(day: DayPlan): string {
  return `${dayNetPhrase(day)}${burnSuffix(day)}`;
}

export type PlanTone = "deficit" | "surplus" | "fast" | "maintain" | "outside";

export function snapshotTone(snapshot: DayPlanSnapshot): PlanTone {
  return snapshot.inPlan ? snapshot.day.type : "outside";
}

/** Log screen pill. Custom Plans prefix the cycle position. */
export function planPillLabel(snapshot: DayPlanSnapshot): string {
  if (!snapshot.inPlan) return "At baseline";
  const label = dayPlanLabel(snapshot.day);
  if (snapshot.planType === "custom" && snapshot.cycleDay != null && snapshot.cycleLength != null) {
    return `Day ${snapshot.cycleDay} of ${snapshot.cycleLength} · ${label}`;
  }
  return label;
}

export function dayPlanHelper(day: DayPlan, toleranceKcal: number): string {
  switch (day.type) {
    case "deficit":
      return `Counts as met when you finish at least ${formatKcal(day.amount)} kcal below baseline.`;
    case "maintain":
      return `Counts as met within ±${formatKcal(toleranceKcal)} kcal of baseline.`;
    case "surplus":
      return `Counts as met within ±${formatKcal(toleranceKcal)} kcal of ${formatKcal(day.amount)} kcal above baseline.`;
    case "fast":
      return "No calories planned. Workout burn isn't added back on fast days.";
  }
}

/** "2,500 to eat if you burn 500." with a planned burn; otherwise the target plus any workout burn. */
export function dayTargetLine(day: DayPlan, maintenanceCalories: number, fastAllowanceKcal: number): string {
  const target = formatKcal(dayTarget(day, maintenanceCalories, fastAllowanceKcal));
  if (day.type === "fast") return `Target: ${target} kcal`;
  const burn = targetBurnOf(day);
  return burn > 0 ? `${target} to eat if you burn ${formatKcal(burn)}.` : `Target: ${target} kcal + workout burn`;
}

export const LOW_INTAKE_NOTE = "This is a very low intake day.";

/** Judged on net intake, so a planned burn cannot hide a very low day. */
export function isLowIntakeDay(day: DayPlan, maintenanceCalories: number): boolean {
  return day.type === "deficit" && netTarget(day, maintenanceCalories, 0) < PLAN_LIMITS.lowIntakeKcal;
}

/** Settings summary: "Baseline 2,000 kcal · Weekly Plan" and "Today: At baseline · burn 500+ · 2,500 kcal". */
export function caloriePlanSummary(settings: CaloriePlanSettings, today: string): { title: string; today: string } {
  const snapshot = snapshotForDate(settings, today);
  const status = planStatus(selectedPlanDates(settings), today);
  const title = `Baseline ${formatKcal(settings.maintenanceCalories)} kcal · ${PLAN_TYPE_LABELS[settings.planType]}`;
  const line = `Today: ${planPillLabel(snapshot)} · ${formatKcal(snapshotTarget(snapshot))} kcal`;
  return { title, today: status.kind === "active" ? line : `${line} · ${planStatusText(status)}` };
}

export type DayKey = { planType: "daily" } | { planType: "weekly"; weekday: Weekday } | { planType: "custom"; index: number };

export function dayEditorTitle(key: DayKey): string {
  switch (key.planType) {
    case "daily":
      return "Every day";
    case "weekly":
      return WEEKDAY_NAMES[key.weekday];
    case "custom":
      return `Day ${key.index + 1}`;
  }
}

export function dayForKey(settings: CaloriePlanSettings, key: DayKey): DayPlan {
  switch (key.planType) {
    case "daily":
      return settings.dailyPlan.day;
    case "weekly":
      return settings.weeklyPlan.days[key.weekday];
    case "custom":
      return settings.customPlan.days[key.index] ?? MAINTAIN;
  }
}

/** The editable row a resolved day belongs to, or null when the day is outside the plan. */
export function dayKeyFor(settings: CaloriePlanSettings, date: string): DayKey | null {
  const resolved = resolveDay(settings, date);
  if (!resolved.inPlan) return null;
  if (settings.planType === "daily") return { planType: "daily" };
  if (settings.planType === "weekly") return { planType: "weekly", weekday: resolved.weekday };
  return { planType: "custom", index: (resolved.cycleDay ?? 1) - 1 };
}

// ---------------------------------------------------------------------------
// Editing

export function maxAmount(type: "deficit" | "surplus", maintenanceCalories: number): number {
  if (type === "surplus") return PLAN_LIMITS.amountMax;
  return Math.max(PLAN_LIMITS.amountMin, Math.min(PLAN_LIMITS.amountMax, Math.floor(maintenanceCalories)));
}

/** Integer amount within 50-1000, with deficits capped so the target never drops below 0. */
export function clampAmount(type: "deficit" | "surplus", amount: number, maintenanceCalories: number): number {
  const value = Number.isFinite(amount) ? Math.round(amount) : PLAN_LIMITS.amountDefault;
  return Math.min(maxAmount(type, maintenanceCalories), Math.max(PLAN_LIMITS.amountMin, value));
}

export function stepAmount(type: "deficit" | "surplus", amount: number, direction: 1 | -1, maintenanceCalories: number): number {
  const step = PLAN_LIMITS.amountStep;
  const snapped = direction > 0 ? Math.floor(amount / step) * step + step : Math.ceil(amount / step) * step - step;
  return clampAmount(type, snapped, maintenanceCalories);
}

/** 0, or 50-2000 kcal; anything between 0 and 50 rounds up to the first step. */
export function clampTargetBurn(value: number): number {
  if (!Number.isFinite(value)) return PLAN_LIMITS.burnDefault;
  const rounded = Math.round(value);
  if (rounded <= 0) return 0;
  return Math.min(PLAN_LIMITS.burnMax, Math.max(PLAN_LIMITS.burnMin, rounded));
}

export function stepTargetBurn(value: number, direction: 1 | -1): number {
  const step = PLAN_LIMITS.burnStep;
  const snapped = direction > 0 ? Math.floor(value / step) * step + step : Math.ceil(value / step) * step - step;
  return clampTargetBurn(snapped);
}

export function clampMaintenance(value: number): number | null {
  if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
  if (value < PLAN_LIMITS.maintenanceMin || value > PLAN_LIMITS.maintenanceMax) return null;
  return value;
}

/** Writes one day plan to every selected day; deficits are re-capped for the current maintenance and burns clamped. */
export function applyDayPlan(
  settings: CaloriePlanSettings,
  targets: { planType: "daily" } | { planType: "weekly"; weekdays: Weekday[] } | { planType: "custom"; indices: number[] },
  day: DayPlan,
): CaloriePlanSettings {
  const amounted: DayPlan =
    day.type === "deficit" || day.type === "surplus"
      ? { ...day, amount: clampAmount(day.type, day.amount, settings.maintenanceCalories) }
      : day;
  const next = withTargetBurn(amounted, clampTargetBurn(targetBurnOf(day)));
  switch (targets.planType) {
    case "daily":
      return { ...settings, dailyPlan: { ...settings.dailyPlan, day: next } };
    case "weekly": {
      const days = { ...settings.weeklyPlan.days };
      for (const weekday of targets.weekdays) days[weekday] = next;
      return { ...settings, weeklyPlan: { ...settings.weeklyPlan, days } };
    }
    case "custom": {
      const days = settings.customPlan.days.slice();
      for (const index of targets.indices) if (index >= 0 && index < days.length) days[index] = next;
      return { ...settings, customPlan: { ...settings.customPlan, days } };
    }
  }
}

export function clampCycleLength(value: number): number {
  if (!Number.isFinite(value)) return PLAN_LIMITS.cycleDefault;
  return Math.min(PLAN_LIMITS.cycleMax, Math.max(PLAN_LIMITS.cycleMin, Math.round(value)));
}

/** Growing appends Maintenance days; shrinking drops trailing days and reports the non-Maintenance ones. */
export function resizeCycle(days: DayPlan[], lengthDays: number): { days: DayPlan[]; removedPlanned: number[] } {
  const length = clampCycleLength(lengthDays);
  if (length >= days.length) {
    return { days: [...days, ...Array.from({ length: length - days.length }, () => MAINTAIN)], removedPlanned: [] };
  }
  const removedPlanned = days
    .slice(length)
    .map((day, offset) => ({ day, number: length + offset + 1 }))
    .filter((entry) => entry.day.type !== "maintain")
    .map((entry) => entry.number);
  return { days: days.slice(0, length), removedPlanned };
}

/** "Remove Day 4-5?" or "Remove Day 5?" for the trailing days a shorter cycle drops. */
export function removeCycleDaysPrompt(previousLength: number, nextLength: number): string {
  const first = nextLength + 1;
  return first === previousLength ? `Remove Day ${first}?` : `Remove Day ${first}-${previousLength}?`;
}

export function withCycleLength(settings: CaloriePlanSettings, lengthDays: number): CaloriePlanSettings {
  const resized = resizeCycle(settings.customPlan.days, lengthDays);
  return { ...settings, customPlan: { ...settings.customPlan, lengthDays: resized.days.length, days: resized.days } };
}

// ---------------------------------------------------------------------------
// Footers and totals

export interface PlanSummary {
  offsetTotal: number;
  averageTarget: number;
  days: number;
}

export function summarizeDays(days: DayPlan[], maintenanceCalories: number, fastAllowanceKcal: number): PlanSummary {
  const offsetTotal = days.reduce((sum, day) => sum + planOffset(day, maintenanceCalories, fastAllowanceKcal), 0);
  const targetTotal = days.reduce((sum, day) => sum + dayTarget(day, maintenanceCalories, fastAllowanceKcal), 0);
  return { offsetTotal, averageTarget: days.length ? Math.round(targetTotal / days.length) : 0, days: days.length };
}

export function weeklyFooter(settings: CaloriePlanSettings): string {
  const summary = summarizeDays(
    WEEKDAYS.map((weekday) => settings.weeklyPlan.days[weekday]),
    settings.maintenanceCalories,
    settings.fastAllowanceKcal,
  );
  return `Week: ${formatSignedKcal(summary.offsetTotal)} kcal vs baseline · avg ${formatKcal(summary.averageTarget)}/day`;
}

export function cycleFooter(settings: CaloriePlanSettings): string {
  const summary = summarizeDays(settings.customPlan.days, settings.maintenanceCalories, settings.fastAllowanceKcal);
  return `Cycle: ${formatSignedKcal(summary.offsetTotal)} kcal vs baseline · avg ${formatKcal(summary.averageTarget)}/day`;
}

export interface PlanTotal {
  startDate: string;
  endDate: string;
  days: number;
  offsetTotal: number;
}

/** Sum of offsets across every date of the selected plan; only when it has an end date. */
export function planTotal(settings: CaloriePlanSettings): PlanTotal | null {
  const dates = selectedPlanDates(settings);
  if (dates.endDate == null) return null;
  const days = calendarDaysBetween(dates.startDate, dates.endDate) + 1;
  let offsetTotal = 0;
  for (let index = 0; index < days; index += 1) {
    const resolved = resolveDay(settings, addCalendarDays(dates.startDate, index));
    offsetTotal += planOffset(resolved.day, settings.maintenanceCalories, settings.fastAllowanceKcal);
  }
  return { startDate: dates.startDate, endDate: dates.endDate, days, offsetTotal };
}

export function planTotalText(total: PlanTotal): string {
  return `${formatDateRange(total.startDate, total.endDate)} · ${total.days} ${total.days === 1 ? "day" : "days"} · ${formatSignedKcal(total.offsetTotal)} kcal vs baseline`;
}

// ---------------------------------------------------------------------------
// Custom Plan next dates

/** Next date (today or later) a cycle day falls on within the plan's range, or null if none remains. */
export function nextCycleDate(plan: CustomPlan, index: number, today: string): string | null {
  const from = today < plan.startDate ? plan.startDate : today;
  const current = cycleIndex(plan.startDate, from, plan.lengthDays);
  const date = addCalendarDays(from, (index - current + plan.lengthDays) % plan.lengthDays);
  if (plan.endDate != null && date > plan.endDate) return null;
  return date;
}

/** Row labels: "Today", "Wed Nov 25", or "-" when no occurrence remains. */
export function cycleDateLabels(plan: CustomPlan, today: string): string[] {
  return plan.days.map((_, index) => {
    const date = nextCycleDate(plan, index, today);
    if (date == null) return "-";
    return date === today ? "Today" : formatWeekdayDate(date);
  });
}

// ---------------------------------------------------------------------------
// Macros

export interface MacroTargets {
  proteinG: number;
  carbsG: number;
  fatG: number;
}

/**
 * Protein never changes. With scaling on, carbs and fat scale by
 * (dayTarget - proteinKcal) / (maintenance - proteinKcal). Fast days have no macro targets.
 */
export function macroTargetsForDay(base: MacroTargets, snapshot: DayPlanSnapshot, scaleMacrosWithPlan: boolean): MacroTargets | null {
  if (snapshot.day.type === "fast") return null;
  if (!scaleMacrosWithPlan) return base;
  const proteinKcal = base.proteinG * 4;
  const denominator = snapshot.maintenanceCalories - proteinKcal;
  if (denominator <= 0) return base;
  const factor = Math.max(0, (snapshotTarget(snapshot) - proteinKcal) / denominator);
  return { proteinG: base.proteinG, carbsG: Math.round(base.carbsG * factor), fatG: Math.round(base.fatG * factor) };
}

// ---------------------------------------------------------------------------
// Ended banner

/** Identifies one ended plan so its banner shows once; null while the selected plan has not ended. */
export function endedPlanKey(settings: CaloriePlanSettings, today: string): string | null {
  const dates = selectedPlanDates(settings);
  if (dates.endDate == null || today <= dates.endDate) return null;
  return `${settings.planType}:${dates.startDate}:${dates.endDate}`;
}

/** The banner key to show on this Log open, or null when none is due or it was already shown. */
export function endedBannerDue(settings: CaloriePlanSettings, today: string, lastShownKey: string | null): string | null {
  const key = endedPlanKey(settings, today);
  return key != null && key !== lastShownKey ? key : null;
}

export function endedBannerText(settings: CaloriePlanSettings): string {
  const dates = selectedPlanDates(settings);
  return `Your ${PLAN_TYPE_LABELS[settings.planType]} ended ${dates.endDate ? formatMonthDay(dates.endDate) : ""}. You're back at baseline.`;
}

// ---------------------------------------------------------------------------
// Schemas. The API carries the plan in snake_case; snapshots are stored as JSON.

const IsoDateSchema = z.string().refine(isIsoDate, "Expected a YYYY-MM-DD date");
const AmountSchema = z.number().int().min(PLAN_LIMITS.amountMin).max(PLAN_LIMITS.amountMax);
const TargetBurnSchema = z
  .number()
  .int()
  .refine((value) => value === 0 || (value >= PLAN_LIMITS.burnMin && value <= PLAN_LIMITS.burnMax), "target_burn_kcal must be 0 or 50-2000")
  .optional();

export const DayPlanApiSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("deficit"), amount_kcal: AmountSchema, target_burn_kcal: TargetBurnSchema }),
  z.object({ type: z.literal("maintain"), target_burn_kcal: TargetBurnSchema }),
  z.object({ type: z.literal("surplus"), amount_kcal: AmountSchema, target_burn_kcal: TargetBurnSchema }),
  z.object({ type: z.literal("fast") }),
]);
export type DayPlanApi = z.infer<typeof DayPlanApiSchema>;

const datesValid = (value: { start_date: string; end_date: string | null }) => value.end_date == null || value.end_date >= value.start_date;
const datesMessage = { message: "end_date must be on or after start_date", path: ["end_date"] };

export const CaloriePlanApiSchema = z.object({
  plan_type: z.enum(["daily", "weekly", "custom"]),
  daily_plan: z
    .object({ start_date: IsoDateSchema, end_date: IsoDateSchema.nullable(), day: DayPlanApiSchema })
    .refine(datesValid, datesMessage),
  weekly_plan: z
    .object({
      start_date: IsoDateSchema,
      end_date: IsoDateSchema.nullable(),
      days: z.object({
        mon: DayPlanApiSchema,
        tue: DayPlanApiSchema,
        wed: DayPlanApiSchema,
        thu: DayPlanApiSchema,
        fri: DayPlanApiSchema,
        sat: DayPlanApiSchema,
        sun: DayPlanApiSchema,
      }),
    })
    .refine(datesValid, datesMessage),
  custom_plan: z
    .object({
      start_date: IsoDateSchema,
      end_date: IsoDateSchema.nullable(),
      length_days: z.number().int().min(PLAN_LIMITS.cycleMin).max(PLAN_LIMITS.cycleMax),
      days: z.array(DayPlanApiSchema).min(PLAN_LIMITS.cycleMin).max(PLAN_LIMITS.cycleMax),
    })
    .refine(datesValid, datesMessage)
    .refine((value) => value.days.length === value.length_days, { message: "days must have length_days entries", path: ["days"] }),
  tolerance_kcal: z.number().int().min(PLAN_LIMITS.toleranceMin).max(PLAN_LIMITS.toleranceMax),
  fast_allowance_kcal: z.number().int().min(PLAN_LIMITS.fastAllowanceMin).max(PLAN_LIMITS.fastAllowanceMax),
  scale_macros_with_plan: z.boolean(),
});
export type CaloriePlanApi = z.infer<typeof CaloriePlanApiSchema>;

export const MaintenanceCaloriesSchema = z.number().int().min(PLAN_LIMITS.maintenanceMin).max(PLAN_LIMITS.maintenanceMax);

function dayToApi(day: DayPlan): DayPlanApi {
  if (day.type === "fast") return { type: "fast" };
  const burn = targetBurnOf(day);
  const extra = burn > 0 ? { target_burn_kcal: burn } : {};
  return day.type === "maintain" ? { type: "maintain", ...extra } : { type: day.type, amount_kcal: day.amount, ...extra };
}

/** Plans saved before Target Burn existed have no target_burn_kcal and read as 0. */
function dayFromApi(day: DayPlanApi): DayPlan {
  if (day.type === "fast") return { type: "fast" };
  const base: DayPlan = day.type === "maintain" ? { type: "maintain" } : { type: day.type, amount: day.amount_kcal };
  return withTargetBurn(base, day.target_burn_kcal ?? 0);
}

export function caloriePlanToApi(settings: CaloriePlanSettings): CaloriePlanApi {
  return {
    plan_type: settings.planType,
    daily_plan: { start_date: settings.dailyPlan.startDate, end_date: settings.dailyPlan.endDate, day: dayToApi(settings.dailyPlan.day) },
    weekly_plan: {
      start_date: settings.weeklyPlan.startDate,
      end_date: settings.weeklyPlan.endDate,
      days: {
        mon: dayToApi(settings.weeklyPlan.days.mon),
        tue: dayToApi(settings.weeklyPlan.days.tue),
        wed: dayToApi(settings.weeklyPlan.days.wed),
        thu: dayToApi(settings.weeklyPlan.days.thu),
        fri: dayToApi(settings.weeklyPlan.days.fri),
        sat: dayToApi(settings.weeklyPlan.days.sat),
        sun: dayToApi(settings.weeklyPlan.days.sun),
      },
    },
    custom_plan: {
      start_date: settings.customPlan.startDate,
      end_date: settings.customPlan.endDate,
      length_days: settings.customPlan.lengthDays,
      days: settings.customPlan.days.map(dayToApi),
    },
    tolerance_kcal: settings.toleranceKcal,
    fast_allowance_kcal: settings.fastAllowanceKcal,
    scale_macros_with_plan: settings.scaleMacrosWithPlan,
  };
}

/** A missing plan migrates to Maintenance every day starting `today`. */
export function caloriePlanFromApi(maintenanceCalories: number, plan: CaloriePlanApi | null | undefined, today: string): CaloriePlanSettings {
  if (!plan) return defaultCaloriePlan(maintenanceCalories, today);
  const days = plan.weekly_plan.days;
  return {
    maintenanceCalories: Math.round(maintenanceCalories),
    planType: plan.plan_type,
    dailyPlan: { startDate: plan.daily_plan.start_date, endDate: plan.daily_plan.end_date, day: dayFromApi(plan.daily_plan.day) },
    weeklyPlan: {
      startDate: plan.weekly_plan.start_date,
      endDate: plan.weekly_plan.end_date,
      days: {
        mon: dayFromApi(days.mon),
        tue: dayFromApi(days.tue),
        wed: dayFromApi(days.wed),
        thu: dayFromApi(days.thu),
        fri: dayFromApi(days.fri),
        sat: dayFromApi(days.sat),
        sun: dayFromApi(days.sun),
      },
    },
    customPlan: {
      startDate: plan.custom_plan.start_date,
      endDate: plan.custom_plan.end_date,
      lengthDays: plan.custom_plan.length_days,
      days: plan.custom_plan.days.map(dayFromApi),
    },
    toleranceKcal: plan.tolerance_kcal,
    fastAllowanceKcal: plan.fast_allowance_kcal,
    scaleMacrosWithPlan: plan.scale_macros_with_plan,
  };
}

/** Parses a stored plan JSON string; null when absent or invalid. */
export function parseCaloriePlanJson(raw: string | null | undefined): CaloriePlanApi | null {
  if (!raw) return null;
  try {
    const parsed = CaloriePlanApiSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const DayPlanStoredSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("deficit"), amount: z.number(), targetBurn: z.number().optional() }),
  z.object({ type: z.literal("maintain"), targetBurn: z.number().optional() }),
  z.object({ type: z.literal("surplus"), amount: z.number(), targetBurn: z.number().optional() }),
  z.object({ type: z.literal("fast") }),
]);

export const DayPlanSnapshotSchema = z.object({
  planType: z.enum(["daily", "weekly", "custom"]),
  inPlan: z.boolean(),
  day: DayPlanStoredSchema,
  cycleDay: z.number().int().nullable(),
  cycleLength: z.number().int().nullable(),
  maintenanceCalories: z.number(),
  toleranceKcal: z.number(),
  fastAllowanceKcal: z.number(),
});

export function parseSnapshotJson(raw: string | null | undefined): DayPlanSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = DayPlanSnapshotSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
