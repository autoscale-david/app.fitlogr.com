import { describe, expect, it } from "vitest";
import {
  WEEKDAYS,
  addCalendarDays,
  applyDayPlan,
  calendarDaysBetween,
  caloriePlanFromApi,
  caloriePlanToApi,
  CaloriePlanApiSchema,
  caloriePlanSummary,
  clampTargetBurn,
  clampAmount,
  clampMaintenance,
  cycleDateLabels,
  cycleFooter,
  dayDotStatus,
  dayEditorTitle,
  dayKeyFor,
  dayPlanHelper,
  dayPlanLabel,
  dayTarget,
  dayTargetLine,
  defaultCaloriePlan,
  effectiveSnapshot,
  endDateAfterWeeks,
  endedBannerDue,
  endedBannerText,
  formatDateRange,
  formatKcal,
  isDayMet,
  isLowIntakeDay,
  macroTargetsForDay,
  maintainWeek,
  nextCycleDate,
  parseSnapshotJson,
  planPillLabel,
  planStatus,
  planStatusText,
  planTotal,
  planTotalText,
  remainingCalories,
  remainingState,
  remainingStateText,
  removeCycleDaysPrompt,
  resizeCycle,
  resolveDay,
  ringProgress,
  setPlanEndDate,
  setPlanStartDate,
  snapshotForDate,
  snapshotTarget,
  stepAmount,
  stepTargetBurn,
  targetBurnOf,
  weekdayOf,
  weeklyFooter,
  withCycleLength,
  withSelectedPlanDates,
  withTargetBurn,
  type CaloriePlanSettings,
  type DayPlan,
  type DayPlanSnapshot,
} from "./caloriePlan";
import { caloriesRemaining } from "./nutrition";

const TODAY = "2026-11-24"; // Tuesday
const deficit = (amount: number): DayPlan => ({ type: "deficit", amount });
const surplus = (amount: number): DayPlan => ({ type: "surplus", amount });
const MAINTAIN: DayPlan = { type: "maintain" };
const FAST: DayPlan = { type: "fast" };

function weeklyExample(maintenance = 1900): CaloriePlanSettings {
  const base = defaultCaloriePlan(maintenance, TODAY);
  return {
    ...base,
    planType: "weekly",
    weeklyPlan: {
      startDate: TODAY,
      endDate: null,
      days: { mon: deficit(500), tue: deficit(500), wed: FAST, thu: surplus(500), fri: MAINTAIN, sat: MAINTAIN, sun: surplus(500) },
    },
  };
}

function customExample(): CaloriePlanSettings {
  const base = defaultCaloriePlan(1900, TODAY);
  return { ...base, planType: "custom", customPlan: { startDate: TODAY, endDate: null, lengthDays: 3, days: [deficit(500), FAST, surplus(500)] } };
}

function weeklyRowTargets(settings: CaloriePlanSettings): number[] {
  return WEEKDAYS.map((weekday) => dayTarget(settings.weeklyPlan.days[weekday], settings.maintenanceCalories, settings.fastAllowanceKcal));
}

describe("local calendar dates", () => {
  it("does whole-day arithmetic on calendar dates", () => {
    expect(weekdayOf(TODAY)).toBe("tue");
    expect(addCalendarDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addCalendarDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(calendarDaysBetween("2026-10-31", "2026-11-02")).toBe(2);
    expect(calendarDaysBetween("2027-03-13", "2027-03-15")).toBe(2);
    expect(formatKcal(-10300)).toBe("-10,300");
    expect(formatDateRange("2026-11-24", "2026-12-31")).toBe("Nov 24 - Dec 31");
  });
});

describe("criterion 1: migration keeps remaining calories identical", () => {
  it("matches the old base-calorie math for every day and every input", () => {
    for (const base of [1200, 1900, 2450]) {
      const migrated = caloriePlanFromApi(base, null, TODAY);
      expect(migrated).toEqual(defaultCaloriePlan(base, TODAY));
      expect(migrated.planType).toBe("daily");
      expect(migrated.dailyPlan).toEqual({ startDate: TODAY, endDate: null, day: MAINTAIN });
      expect(Object.values(migrated.weeklyPlan.days).every((day) => day.type === "maintain")).toBe(true);
      expect(migrated.customPlan.days).toEqual([MAINTAIN, MAINTAIN, MAINTAIN]);
      for (const date of ["2025-01-01", "2026-11-23", TODAY, "2027-06-15"]) {
        for (const [eaten, burned] of [
          [0, 0],
          [1500, 391],
          [2600, 120],
          [1234.6, 87.4],
        ] as const) {
          const snapshot = snapshotForDate(migrated, date);
          expect(remainingCalories(snapshot, eaten, burned)).toBe(caloriesRemaining(base, burned, eaten));
        }
      }
    }
  });
});

describe("criterion 2: Weekly Plan example", () => {
  it("shows the exact targets, labels, and footer", () => {
    const settings = weeklyExample();
    expect(weeklyRowTargets(settings)).toEqual([1400, 1400, 0, 2400, 1900, 1900, 2400]);
    expect(WEEKDAYS.map((weekday) => dayPlanLabel(settings.weeklyPlan.days[weekday]))).toEqual([
      "Net -500",
      "Net -500",
      "Fast",
      "Net +500",
      "Net +0",
      "Net +0",
      "Net +500",
    ]);
    expect(weeklyFooter(settings)).toBe("Week: -1,900 kcal vs maintenance · avg 1,629/day");
  });

  it("shows the Custom Plan example rows and footer", () => {
    const settings = customExample();
    expect(settings.customPlan.days.map((day) => dayTarget(day, 1900, 0))).toEqual([1400, 0, 2400]);
    expect(cycleDateLabels(settings.customPlan, TODAY)).toEqual(["Today", "Wed Nov 25", "Thu Nov 26"]);
    expect(cycleFooter(settings)).toBe("Cycle: -1,900 kcal vs maintenance · avg 1,267/day");
  });

  it("totals every date in an ended range", () => {
    const settings = { ...weeklyExample(), weeklyPlan: { ...weeklyExample().weeklyPlan, endDate: "2026-12-31" } };
    const total = planTotal(settings);
    expect(total).toEqual({ startDate: TODAY, endDate: "2026-12-31", days: 38, offsetTotal: -11400 });
    expect(planTotalText(total!)).toBe("Nov 24 - Dec 31 · 38 days · -11,400 kcal vs maintenance");
    expect(planTotal(weeklyExample())).toBeNull();
  });

  it("resolves the worked example on the Log screen", () => {
    const settings = { ...defaultCaloriePlan(1900, TODAY), dailyPlan: { startDate: TODAY, endDate: null, day: deficit(500) } };
    const snapshot = snapshotForDate(settings, TODAY);
    expect(dayTarget(snapshot.day, 1900, 0)).toBe(1400);
    expect(remainingCalories(snapshot, 1500, 391)).toBe(291);
    expect(remainingStateText(remainingState(snapshot, 1500, 391))).toBe("291 Calories Remaining");
    expect(planPillLabel(snapshot)).toBe("Net -500");
    expect(ringProgress(snapshot, 1500, 391)).toBeCloseTo(1500 / 1791);
  });
});

describe("criterion 3: maintenance changes recalculate rows and footers", () => {
  it("updates every row target and footer from 1,900 to 2,000", () => {
    const before = weeklyExample(1900);
    const after = { ...before, maintenanceCalories: 2000 };
    expect(weeklyRowTargets(after)).toEqual([1500, 1500, 0, 2500, 2000, 2000, 2500]);
    expect(weeklyFooter(after)).toBe("Week: -2,000 kcal vs maintenance · avg 1,714/day");
    const custom = { ...customExample(), maintenanceCalories: 2000 };
    expect(cycleFooter(custom)).toBe("Cycle: -2,000 kcal vs maintenance · avg 1,333/day");
  });
});

describe("criterion 4: plan types keep their own values", () => {
  it("restores the daily plan and its dates after Daily -> Custom -> Daily", () => {
    const daily: CaloriePlanSettings = {
      ...defaultCaloriePlan(1900, TODAY),
      dailyPlan: { startDate: "2026-11-20", endDate: "2026-12-20", day: deficit(300) },
    };
    const custom = withSelectedPlanDates({ ...daily, planType: "custom" }, { startDate: "2026-12-01", endDate: null });
    const back = { ...custom, planType: "daily" as const };
    expect(back.dailyPlan).toEqual(daily.dailyPlan);
    expect(back.customPlan.startDate).toBe("2026-12-01");
    expect(resolveDay(back, "2026-11-25").day).toEqual(deficit(300));
  });

  it("round-trips all three plans through the API shape", () => {
    const settings = { ...weeklyExample(), customPlan: customExample().customPlan, toleranceKcal: 150, fastAllowanceKcal: 50, scaleMacrosWithPlan: false };
    const api = CaloriePlanApiSchema.parse(caloriePlanToApi(settings));
    expect(caloriePlanFromApi(settings.maintenanceCalories, api, "2030-01-01")).toEqual(settings);
  });

  it("rejects invalid plans", () => {
    const api = caloriePlanToApi(customExample());
    expect(CaloriePlanApiSchema.safeParse({ ...api, custom_plan: { ...api.custom_plan, length_days: 4 } }).success).toBe(false);
    expect(CaloriePlanApiSchema.safeParse({ ...api, daily_plan: { ...api.daily_plan, end_date: "2026-11-01" } }).success).toBe(false);
    expect(CaloriePlanApiSchema.safeParse({ ...api, tolerance_kcal: 20 }).success).toBe(false);
    expect(CaloriePlanApiSchema.safeParse({ ...api, fast_allowance_kcal: 250 }).success).toBe(false);
    expect(
      CaloriePlanApiSchema.safeParse({ ...api, daily_plan: { ...api.daily_plan, day: { type: "deficit", amount_kcal: 1050 } } }).success,
    ).toBe(false);
    expect(clampMaintenance(999)).toBeNull();
    expect(clampMaintenance(6001)).toBeNull();
    expect(clampMaintenance(1900.5)).toBeNull();
    expect(clampMaintenance(1900)).toBe(1900);
  });
});

describe("criterion 5: a plan starting next Monday", () => {
  it("shows Starts in N days and resolves Maintenance until it starts", () => {
    const settings = { ...weeklyExample(), weeklyPlan: { ...weeklyExample().weeklyPlan, startDate: "2026-11-30" } };
    expect(planStatusText(planStatus(settings.weeklyPlan, TODAY))).toBe("Starts in 6 days");
    expect(planStatusText(planStatus(settings.weeklyPlan, "2026-11-29"))).toBe("Starts in 1 day");
    for (let offset = 0; offset < 6; offset += 1) {
      const date = addCalendarDays(TODAY, offset);
      const snapshot = snapshotForDate(settings, date);
      expect(snapshot.inPlan).toBe(false);
      expect(snapshot.day).toEqual(MAINTAIN);
      expect(planPillLabel(snapshot)).toBe("Maintenance");
      expect(remainingCalories(snapshot, 1000, 200)).toBe(1100);
    }
    expect(resolveDay(settings, "2026-11-30")).toMatchObject({ inPlan: true, day: deficit(500) });
    expect(dayKeyFor(settings, TODAY)).toBeNull();
    expect(dayKeyFor(settings, "2026-12-02")).toEqual({ planType: "weekly", weekday: "wed" });
  });

  it("describes active and ended plans", () => {
    expect(planStatusText(planStatus({ startDate: TODAY, endDate: "2026-12-31" }, TODAY))).toBe("Day 1 of 38 · ends Dec 31");
    expect(planStatusText(planStatus({ startDate: "2026-11-20", endDate: null }, TODAY))).toBe("Active since Nov 20");
    expect(planStatusText(planStatus({ startDate: "2026-11-01", endDate: "2026-11-20" }, TODAY))).toBe("Ended Nov 20 · you're on Maintenance");
  });
});

describe("criterion 6: inclusive end date and the ended banner", () => {
  const settings: CaloriePlanSettings = { ...weeklyExample(), weeklyPlan: { ...weeklyExample().weeklyPlan, endDate: "2026-12-31" } };

  it("uses the plan on Dec 31 and Maintenance on Jan 1", () => {
    expect(resolveDay(settings, "2026-12-31")).toMatchObject({ inPlan: true, day: surplus(500) });
    expect(resolveDay(settings, "2027-01-01")).toMatchObject({ inPlan: false, day: MAINTAIN });
  });

  it("shows the ended banner once on the next Log open", () => {
    expect(endedBannerDue(settings, "2026-12-31", null)).toBeNull();
    const key = endedBannerDue(settings, "2027-01-01", null);
    expect(key).not.toBeNull();
    expect(endedBannerText(settings)).toBe("Your Weekly Plan ended Dec 31. You're on Maintenance.");
    expect(endedBannerDue(settings, "2027-01-01", key)).toBeNull();
    expect(endedBannerDue(settings, "2027-01-05", key)).toBeNull();
    const extended = { ...settings, weeklyPlan: { ...settings.weeklyPlan, endDate: "2027-01-10" } };
    expect(endedBannerDue(extended, "2027-01-05", key)).toBeNull();
    expect(endedBannerDue(extended, "2027-01-11", key)).not.toBeNull();
  });
});

describe("criterion 7: end-date quick options", () => {
  it("counts weeks from the start date, inclusive", () => {
    expect(endDateAfterWeeks(TODAY, 8)).toBe(addCalendarDays(TODAY, 55));
    expect(calendarDaysBetween(TODAY, endDateAfterWeeks(TODAY, 8)) + 1).toBe(56);
    expect(endDateAfterWeeks(TODAY, 4)).toBe("2026-12-21");
    expect(endDateAfterWeeks(TODAY, 12)).toBe(addCalendarDays(TODAY, 83));
  });

  it("keeps the end on or after the start", () => {
    const dates = { startDate: TODAY, endDate: "2026-12-31" };
    expect(setPlanEndDate(dates, "2026-11-01")).toEqual(dates);
    expect(setPlanEndDate(dates, TODAY)).toEqual({ startDate: TODAY, endDate: TODAY });
    expect(setPlanEndDate(dates, null)).toEqual({ startDate: TODAY, endDate: null });
    expect(setPlanStartDate(dates, "2027-01-05")).toEqual({ startDate: "2027-01-05", endDate: null });
    expect(setPlanStartDate(dates, "2026-12-31")).toEqual({ startDate: "2026-12-31", endDate: "2026-12-31" });
  });
});

describe("criterion 8: a 2-day Fast / Maintenance cycle", () => {
  const plan = (startDate: string): CaloriePlanSettings => ({
    ...defaultCaloriePlan(1900, startDate),
    planType: "custom",
    customPlan: { startDate, endDate: null, lengthDays: 2, days: [FAST, MAINTAIN] },
  });

  it("alternates across a month boundary and the November DST change", () => {
    const settings = plan("2026-10-28");
    const types = Array.from({ length: 10 }, (_, index) => resolveDay(settings, addCalendarDays("2026-10-28", index)).day.type);
    expect(types).toEqual(["fast", "maintain", "fast", "maintain", "fast", "maintain", "fast", "maintain", "fast", "maintain"]);
    expect(resolveDay(settings, "2026-11-01").cycleDay).toBe(1);
    expect(resolveDay(settings, "2026-11-02").cycleDay).toBe(2);
  });

  it("alternates across the March DST change", () => {
    const settings = plan("2027-03-12");
    expect(["2027-03-12", "2027-03-13", "2027-03-14", "2027-03-15", "2027-03-16"].map((date) => resolveDay(settings, date).day.type)).toEqual([
      "fast",
      "maintain",
      "fast",
      "maintain",
      "fast",
    ]);
  });

  it("stays aligned when local dates come from real instants in a DST timezone", () => {
    const settings = plan("2026-10-30");
    const localDate = (instant: Date) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
    // 23:30 local each evening; 24-hour steps cross the 25-hour day on Nov 1.
    let instant = new Date("2026-10-31T06:30:00.000Z");
    const seen: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const date = localDate(instant);
      seen.push(`${date}:${resolveDay(settings, date).day.type}`);
      instant = new Date(instant.getTime() + 24 * 60 * 60 * 1000);
    }
    const dates = seen.map((entry) => entry.split(":")[0]!);
    for (const entry of seen) {
      const [date, type] = entry.split(":");
      expect(type).toBe(calendarDaysBetween("2026-10-30", date!) % 2 === 0 ? "fast" : "maintain");
    }
    expect(dates).toContain("2026-11-01");
    expect(dates).toContain("2026-11-02");
  });
});

describe("criterion 9: moving a Custom Plan's start date", () => {
  it("moves Day 1 and the Today row without altering past dots", () => {
    const original = customExample();
    const pastDate = "2026-11-23";
    const stored = snapshotForDate({ ...original, customPlan: { ...original.customPlan, startDate: "2026-11-21" } }, pastDate);
    const storedDot = dayDotStatus({ date: pastDate, today: TODAY, snapshot: stored, eatenKcal: 2400, burnedKcal: 0, hasLog: true });

    const moved = withSelectedPlanDates(original, { startDate: "2026-11-23", endDate: null });
    expect(resolveDay(moved, "2026-11-23").cycleDay).toBe(1);
    expect(resolveDay(moved, TODAY).cycleDay).toBe(2);
    expect(cycleDateLabels(moved.customPlan, TODAY)).toEqual(["Thu Nov 26", "Today", "Wed Nov 25"]);
    expect(cycleDateLabels(original.customPlan, TODAY)).toEqual(["Today", "Wed Nov 25", "Thu Nov 26"]);

    const after = effectiveSnapshot(moved, pastDate, TODAY, stored);
    expect(after).toEqual(stored);
    expect(dayDotStatus({ date: pastDate, today: TODAY, snapshot: after, eatenKcal: 2400, burnedKcal: 0, hasLog: true })).toBe(storedDot);
  });

  it("shows '-' when no occurrence remains before the end date", () => {
    const plan = { startDate: "2026-11-20", endDate: "2026-11-25", lengthDays: 4, days: [MAINTAIN, FAST, MAINTAIN, MAINTAIN] };
    expect(cycleDateLabels(plan, TODAY)).toEqual(["Today", "Wed Nov 25", "-", "-"]);
    expect(nextCycleDate(plan, 0, "2026-11-26")).toBeNull();
    expect(cycleDateLabels({ ...plan, startDate: "2026-11-27", endDate: null }, TODAY)).toEqual(["Fri Nov 27", "Sat Nov 28", "Sun Nov 29", "Mon Nov 30"]);
  });

  it("resizes the cycle and asks before dropping planned days", () => {
    const days = [deficit(500), FAST, surplus(500), FAST, deficit(250)];
    expect(resizeCycle(days, 3)).toEqual({ days: days.slice(0, 3), removedPlanned: [4, 5] });
    expect(removeCycleDaysPrompt(5, 3)).toBe("Remove Day 4-5?");
    expect(removeCycleDaysPrompt(5, 4)).toBe("Remove Day 5?");
    expect(resizeCycle([MAINTAIN, MAINTAIN, MAINTAIN, MAINTAIN], 2).removedPlanned).toEqual([]);
    expect(resizeCycle(days, 7).days.slice(5)).toEqual([MAINTAIN, MAINTAIN]);
    expect(withCycleLength(customExample(), 40).customPlan.lengthDays).toBe(28);
    expect(withCycleLength(customExample(), 1).customPlan.days).toHaveLength(2);
  });
});

describe("criterion 11: editing Monday's plan on Tuesday", () => {
  it("does not change last Monday's dot", () => {
    const before = withSelectedPlanDates(weeklyExample(), { startDate: "2026-11-16", endDate: null });
    const lastMonday = "2026-11-23";
    const stored = snapshotForDate(before, lastMonday);
    const input = { date: lastMonday, today: TODAY, eatenKcal: 1300, burnedKcal: 0, hasLog: true };
    expect(dayDotStatus({ ...input, snapshot: effectiveSnapshot(before, lastMonday, TODAY, stored) })).toBe("met");

    const after = applyDayPlan(before, { planType: "weekly", weekdays: ["mon"] }, surplus(500));
    expect(dayDotStatus({ ...input, snapshot: effectiveSnapshot(after, lastMonday, TODAY, stored) })).toBe("met");
    expect(resolveDay(after, "2026-11-30").day).toEqual(surplus(500));
    expect(effectiveSnapshot(after, TODAY, TODAY, snapshotForDate(before, TODAY)).day).toEqual(deficit(500));
  });

  it("applies one edit to every selected day", () => {
    const after = applyDayPlan(weeklyExample(), { planType: "weekly", weekdays: ["mon", "fri", "sat"] }, FAST);
    expect(WEEKDAYS.map((weekday) => after.weeklyPlan.days[weekday].type)).toEqual(["fast", "deficit", "fast", "surplus", "fast", "fast", "surplus"]);
    const custom = applyDayPlan(customExample(), { planType: "custom", indices: [0, 2, 9] }, MAINTAIN);
    expect(custom.customPlan.days).toEqual([MAINTAIN, FAST, MAINTAIN]);
  });
});

describe("criterion 12: met rules", () => {
  const snapshot = (day: DayPlan): DayPlanSnapshot => ({
    planType: "daily",
    inPlan: true,
    day,
    cycleDay: null,
    cycleLength: null,
    maintenanceCalories: 1900,
    toleranceKcal: 100,
    fastAllowanceKcal: 0,
  });

  it("counts a deficit day 700 under as met and a surplus day 900 over as missed", () => {
    expect(isDayMet(snapshot(deficit(500)), 1900 - 700, 0)).toBe(true);
    expect(isDayMet(snapshot(deficit(500)), 2000, 800)).toBe(true);
    expect(isDayMet(snapshot(deficit(500)), 1500, 0)).toBe(false);
    expect(isDayMet(snapshot(surplus(500)), 1900 + 900, 0)).toBe(false);
    expect(isDayMet(snapshot(surplus(500)), 1900 + 560, 0)).toBe(true);
    expect(isDayMet(snapshot(MAINTAIN), 1990, 0)).toBe(true);
    expect(isDayMet(snapshot(MAINTAIN), 2100, 0)).toBe(false);
  });

  it("maps remaining to Remaining, On target, and Over", () => {
    expect(remainingStateText(remainingState(snapshot(MAINTAIN), 1850, 0))).toBe("On target");
    expect(remainingStateText(remainingState(snapshot(surplus(500)), 2450, 0))).toBe("On target");
    expect(remainingStateText(remainingState(snapshot(MAINTAIN), 1000, 0))).toBe("900 Calories Remaining");
    expect(remainingStateText(remainingState(snapshot(deficit(500)), 1500, 0))).toBe("100 Calories Over");
    expect(remainingStateText(remainingState(snapshot(MAINTAIN), 2300, 100))).toBe("300 Calories Over");
  });
});

describe("criterion 13: fast days", () => {
  const fast: DayPlanSnapshot = {
    planType: "weekly",
    inPlan: true,
    day: FAST,
    cycleDay: null,
    cycleLength: null,
    maintenanceCalories: 1900,
    toleranceKcal: 100,
    fastAllowanceKcal: 0,
  };

  it("is met with nothing logged and missed after a meal", () => {
    expect(dayDotStatus({ date: "2026-11-23", today: TODAY, snapshot: fast, eatenKcal: 0, burnedKcal: 0, hasLog: false })).toBe("met");
    expect(dayDotStatus({ date: "2026-11-23", today: TODAY, snapshot: fast, eatenKcal: 450, burnedKcal: 0, hasLog: true })).toBe("missed");
    expect(dayDotStatus({ date: TODAY, today: TODAY, snapshot: fast, eatenKcal: 0, burnedKcal: 0, hasLog: false })).toBeNull();
    expect(dayDotStatus({ date: "2026-11-25", today: TODAY, snapshot: fast, eatenKcal: 0, burnedKcal: 0, hasLog: false })).toBeNull();
  });

  it("ignores burn and keeps the ring empty", () => {
    expect(isDayMet(fast, 0, 600)).toBe(true);
    expect(isDayMet({ ...fast, fastAllowanceKcal: 50 }, 40, 0)).toBe(true);
    expect(remainingCalories(fast, 120, 600)).toBe(-120);
    expect(ringProgress(fast, 120, 600)).toBe(0);
    expect(macroTargetsForDay({ proteinG: 140, carbsG: 210, fatG: 65 }, fast, true)).toBeNull();
  });

  it("does not show dots for past non-fast days without logs", () => {
    expect(dayDotStatus({ date: "2026-11-23", today: TODAY, snapshot: { ...fast, day: MAINTAIN }, eatenKcal: 0, burnedKcal: 0, hasLog: false })).toBeNull();
  });
});

describe("macro scaling", () => {
  it("keeps protein and scales carbs and fat by the day target", () => {
    const snapshot = snapshotForDate({ ...defaultCaloriePlan(1900, TODAY), dailyPlan: { startDate: TODAY, endDate: null, day: deficit(500) } }, TODAY);
    const base = { proteinG: 140, carbsG: 210, fatG: 65 };
    expect(macroTargetsForDay(base, snapshot, true)).toEqual({ proteinG: 140, carbsG: 132, fatG: 41 });
    expect(macroTargetsForDay(base, snapshot, false)).toEqual(base);
    expect(macroTargetsForDay(base, snapshotForDate(defaultCaloriePlan(1900, TODAY), TODAY), true)).toEqual(base);
  });
});

describe("editor copy and limits", () => {
  it("uses the spec's labels and helper sentences", () => {
    expect(dayEditorTitle({ planType: "weekly", weekday: "mon" })).toBe("Monday");
    expect(dayEditorTitle({ planType: "custom", index: 1 })).toBe("Day 2");
    expect(dayEditorTitle({ planType: "daily" })).toBe("Every day");
    expect(dayPlanHelper(deficit(500), 100)).toBe("Counts as met when you finish at least 500 under maintenance.");
    expect(dayPlanHelper(MAINTAIN, 100)).toBe("Counts as met within ±100 kcal of maintenance.");
    expect(dayPlanHelper(surplus(500), 100)).toBe("Counts as met within ±100 kcal of 500 over maintenance.");
    expect(dayPlanHelper(FAST, 100)).toBe("No calories planned. Workout burn isn't added back on fast days.");
    expect(dayTargetLine(deficit(500), 1900, 0)).toBe("Target: 1,400 kcal + workout burn");
    expect(planPillLabel(snapshotForDate(customExample(), "2026-11-25"))).toBe("Day 2 of 3 · Fast");
  });

  it("steps amounts by 50 within 50-1000 and caps deficits at maintenance", () => {
    expect(stepAmount("deficit", 500, 1, 1900)).toBe(550);
    expect(stepAmount("deficit", 520, -1, 1900)).toBe(500);
    expect(stepAmount("deficit", 50, -1, 1900)).toBe(50);
    expect(stepAmount("surplus", 1000, 1, 1900)).toBe(1000);
    expect(clampAmount("deficit", 1400, 1000)).toBe(1000);
    expect(dayTarget(deficit(1000), 1000, 0)).toBe(0);
    expect(isLowIntakeDay(deficit(700), 1900)).toBe(false);
    expect(isLowIntakeDay(deficit(750), 1900)).toBe(true);
    expect(isLowIntakeDay(surplus(750), 1000)).toBe(false);
  });

  it("rejects malformed stored snapshots", () => {
    expect(parseSnapshotJson("{bad")).toBeNull();
    expect(parseSnapshotJson(JSON.stringify({ day: { type: "fast" } }))).toBeNull();
    const snapshot = snapshotForDate(weeklyExample(), TODAY);
    expect(parseSnapshotJson(JSON.stringify(snapshot))).toEqual(snapshot);
  });
});

describe("Target Net and Target Burn", () => {
  const maintainBurn = (burn: number): DayPlan => withTargetBurn(MAINTAIN, burn);
  const daily = (day: DayPlan, maintenance = 2000): CaloriePlanSettings => ({
    ...defaultCaloriePlan(maintenance, TODAY),
    dailyPlan: { startDate: "2026-11-16", endDate: null, day },
  });

  it("adds the planned burn to the consumption target: 2,000 / +0 / 500+ is 2,500", () => {
    const day = maintainBurn(500);
    expect(day).toEqual({ type: "maintain", targetBurn: 500 });
    expect(dayTarget(day, 2000, 0)).toBe(2500);
    expect(dayTarget(withTargetBurn(deficit(500), 300), 2000, 0)).toBe(1800);
    expect(dayTarget(withTargetBurn(surplus(500), 200), 2000, 0)).toBe(2700);
    expect(dayTargetLine(day, 2000, 0)).toBe("2,500 to eat if you burn 500.");
    expect(dayTargetLine(MAINTAIN, 2000, 0)).toBe("Target: 2,000 kcal + workout burn");
    const snapshot = snapshotForDate(daily(day), TODAY);
    expect(snapshot.day).toEqual({ type: "maintain", targetBurn: 500 });
    expect(planPillLabel(snapshot)).toBe("Net +0 · Burn 500+");
    expect(caloriePlanSummary(daily(day), TODAY)).toEqual({ title: "Maintenance 2,000 · Daily Plan", today: "Today: Net +0 · Burn 500+ · 2,500 kcal" });
  });

  it("labels rows as Net and Burn, omitting a zero burn", () => {
    expect(dayPlanLabel(maintainBurn(500))).toBe("Net +0 · Burn 500+");
    expect(dayPlanLabel(MAINTAIN)).toBe("Net +0");
    expect(dayPlanLabel(deficit(500))).toBe("Net -500");
    expect(dayPlanLabel(withTargetBurn(deficit(500), 0))).toBe("Net -500");
    expect(dayPlanLabel(withTargetBurn(surplus(500), 200))).toBe("Net +500 · Burn 200+");
    expect(dayPlanLabel(withTargetBurn(surplus(1000), 1000))).toBe("Net +1,000 · Burn 1,000+");
    expect(dayPlanLabel(FAST)).toBe("Fast");
  });

  it("does not double-count the planned burn in remaining calories", () => {
    const snapshot = snapshotForDate(daily(maintainBurn(500)), TODAY);
    expect(remainingCalories(snapshot, 2000, 500)).toBe(500);
    expect(remainingCalories(snapshot, 2000, 500)).not.toBe(2500 + 500 - 2000);
    expect(remainingCalories(snapshot, 2500, 500)).toBe(0);
    expect(remainingCalories(snapshot, 2500, 800)).toBe(300);
    expect(remainingCalories(snapshot, 1000, 0)).toBe(1000);
    expect(remainingCalories(snapshot, 2500, 0)).toBe(-500);
    expect(remainingCalories(snapshot, 2500, Number.NaN)).toBe(-500);
    expect(remainingState(snapshot, 2500, 0)).toEqual({ kind: "over", amount: 500 });
    expect(ringProgress(snapshot, 1250, 500)).toBeCloseTo(0.5);
    expect(ringProgress(snapshot, 1250, 0)).toBeCloseTo(1250 / 2000);
    const withoutBurn = snapshotForDate(daily(MAINTAIN), TODAY);
    for (const [eaten, burned] of [
      [0, 0],
      [1800, 650],
      [2600, 120],
      [1234.6, 87.4],
    ] as const) {
      expect(remainingCalories(snapshot, eaten, burned)).toBe(remainingCalories(withoutBurn, eaten, burned));
    }
  });

  it("keeps Fast as its own type that ignores burn", () => {
    expect(withTargetBurn(FAST, 500)).toEqual(FAST);
    expect(targetBurnOf(FAST)).toBe(0);
    const settings = { ...daily(FAST), fastAllowanceKcal: 100 };
    const snapshot = snapshotForDate(settings, TODAY);
    expect(dayTarget(FAST, 2000, 100)).toBe(100);
    expect(remainingCalories(snapshot, 40, 900)).toBe(60);
    expect(remainingCalories(snapshot, 140, 900)).toBe(-40);
    expect(applyDayPlan(settings, { planType: "daily" }, FAST).dailyPlan.day).toEqual(FAST);
  });

  it("judges met on net intake, not on hitting the burn", () => {
    const snapshot = snapshotForDate(daily(maintainBurn(500)), TODAY);
    expect(isDayMet(snapshot, 2500, 500)).toBe(true);
    expect(isDayMet(snapshot, 2000, 0)).toBe(true);
    expect(isDayMet(snapshot, 2500, 0)).toBe(false);
    const deficitBurn = snapshotForDate(daily(withTargetBurn(deficit(500), 500)), TODAY);
    expect(isDayMet(deficitBurn, 1500, 0)).toBe(true);
    expect(isDayMet(deficitBurn, 2000, 500)).toBe(true);
    expect(isDayMet(deficitBurn, 2000, 400)).toBe(false);
    const surplusBurn = snapshotForDate(daily(withTargetBurn(surplus(500), 200)), TODAY);
    expect(isDayMet(surplusBurn, 2500, 0)).toBe(true);
    expect(isDayMet(surplusBurn, 2700, 0)).toBe(false);
    for (const [eaten, burned] of [
      [2500, 500],
      [2500, 0],
      [1900, 300],
    ] as const) {
      expect(isDayMet(snapshot, eaten, burned)).toBe(isDayMet(snapshotForDate(daily(MAINTAIN), TODAY), eaten, burned));
    }
    expect(dayDotStatus({ date: "2026-11-23", today: TODAY, snapshot, eatenKcal: 2500, burnedKcal: 0, hasLog: true })).toBe("missed");
  });

  it("averages consumption targets in footers while totals stay net vs maintenance", () => {
    const base = defaultCaloriePlan(2000, TODAY);
    const days = { ...maintainWeek(), mon: maintainBurn(500), wed: withTargetBurn(deficit(500), 500), sat: FAST };
    const settings: CaloriePlanSettings = { ...base, planType: "weekly", weeklyPlan: { startDate: TODAY, endDate: "2026-12-07", days } };
    expect(weeklyRowTargets(settings)).toEqual([2500, 2000, 2000, 2000, 2000, 0, 2000]);
    expect(weeklyFooter(settings)).toBe("Week: -2,500 kcal vs maintenance · avg 1,786/day");
    expect(planTotal(settings)).toMatchObject({ days: 14, offsetTotal: -5000 });
  });

  it("scales carbs and fat with the consumption target and keeps low intake on net", () => {
    const snapshot = snapshotForDate(daily(maintainBurn(500)), TODAY);
    expect(macroTargetsForDay({ proteinG: 140, carbsG: 210, fatG: 65 }, snapshot, true)).toEqual({
      proteinG: 140,
      carbsG: Math.round(210 * (1940 / 1440)),
      fatG: Math.round(65 * (1940 / 1440)),
    });
    expect(isLowIntakeDay(withTargetBurn(deficit(750), 500), 1900)).toBe(true);
    expect(isLowIntakeDay(withTargetBurn(deficit(700), 500), 1900)).toBe(false);
  });

  it("steps and clamps the burn: 0, then 50-2,000 in 50s", () => {
    expect(stepTargetBurn(0, 1)).toBe(50);
    expect(stepTargetBurn(50, -1)).toBe(0);
    expect(stepTargetBurn(0, -1)).toBe(0);
    expect(stepTargetBurn(480, 1)).toBe(500);
    expect(stepTargetBurn(480, -1)).toBe(450);
    expect(stepTargetBurn(1950, 1)).toBe(2000);
    expect(stepTargetBurn(2000, 1)).toBe(2000);
    expect(clampTargetBurn(30)).toBe(50);
    expect(clampTargetBurn(-5)).toBe(0);
    expect(clampTargetBurn(2600)).toBe(2000);
    expect(clampTargetBurn(Number.NaN)).toBe(0);
    const saved = applyDayPlan(daily(MAINTAIN), { planType: "daily" }, { type: "maintain", targetBurn: 2600 });
    expect(saved.dailyPlan.day).toEqual({ type: "maintain", targetBurn: 2000 });
    expect(applyDayPlan(saved, { planType: "daily" }, { type: "maintain", targetBurn: 0 }).dailyPlan.day).toEqual(MAINTAIN);
  });

  it("syncs the burn through the API and migrates old plans to burn 0", () => {
    const settings = { ...weeklyExample(2000), weeklyPlan: { ...weeklyExample(2000).weeklyPlan } };
    settings.weeklyPlan.days = { ...settings.weeklyPlan.days, fri: maintainBurn(500), thu: withTargetBurn(surplus(500), 200) };
    const api = caloriePlanToApi(settings);
    expect(api.weekly_plan.days.fri).toEqual({ type: "maintain", target_burn_kcal: 500 });
    expect(api.weekly_plan.days.thu).toEqual({ type: "surplus", amount_kcal: 500, target_burn_kcal: 200 });
    expect(api.weekly_plan.days.mon).toEqual({ type: "deficit", amount_kcal: 500 });
    expect(caloriePlanFromApi(2000, CaloriePlanApiSchema.parse(api), TODAY)).toEqual(settings);
    const bad = (burn: number) => ({ ...api, weekly_plan: { ...api.weekly_plan, days: { ...api.weekly_plan.days, fri: { type: "maintain", target_burn_kcal: burn } } } });
    expect(CaloriePlanApiSchema.safeParse(bad(30)).success).toBe(false);
    expect(CaloriePlanApiSchema.safeParse(bad(2050)).success).toBe(false);
    expect(CaloriePlanApiSchema.safeParse(bad(0)).success).toBe(true);

    const legacy = caloriePlanToApi(weeklyExample(2000));
    expect(JSON.stringify(legacy)).not.toContain("target_burn");
    const migrated = caloriePlanFromApi(2000, CaloriePlanApiSchema.parse(JSON.parse(JSON.stringify(legacy))), TODAY);
    expect(WEEKDAYS.map((weekday) => targetBurnOf(migrated.weeklyPlan.days[weekday]))).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(weeklyRowTargets(migrated)).toEqual([1500, 1500, 0, 2500, 2000, 2000, 2500]);
  });

  it("stores the burn in snapshots and keeps past days frozen", () => {
    const before = daily(maintainBurn(500));
    const monday = snapshotForDate(before, "2026-11-23");
    expect(monday).toMatchObject({ day: { type: "maintain", targetBurn: 500 }, maintenanceCalories: 2000 });
    const stored = parseSnapshotJson(JSON.stringify(monday));
    expect(stored).toEqual(monday);
    const after = daily(maintainBurn(200), 2100);
    expect(effectiveSnapshot(after, "2026-11-23", TODAY, stored).day).toEqual({ type: "maintain", targetBurn: 500 });
    expect(snapshotTarget(effectiveSnapshot(after, "2026-11-23", TODAY, stored))).toBe(2500);
    expect(snapshotTarget(effectiveSnapshot(after, TODAY, TODAY, stored))).toBe(2300);
    const old = parseSnapshotJson(JSON.stringify({ ...monday, day: { type: "maintain" } }));
    expect(old && targetBurnOf(old.day)).toBe(0);
  });

  it("summarizes a plan that has not started yet", () => {
    const settings = { ...daily(maintainBurn(500)), dailyPlan: { startDate: "2026-11-30", endDate: null, day: maintainBurn(500) } };
    expect(caloriePlanSummary(settings, TODAY).today).toBe("Today: Maintenance · 2,000 kcal · Starts in 6 days");
  });
});
