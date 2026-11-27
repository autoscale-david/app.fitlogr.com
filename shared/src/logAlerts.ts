import { formatKcal, remainingCalories, type DayPlanSnapshot } from "./caloriePlan";

const FRESH_MS = 18 * 60 * 60 * 1000;

export interface AlertMeal {
  name: string;
  kcal: number;
  capturedAt: string;
  localDate: string;
  /** History import. These never notify, even when the photo is recent. */
  backfill?: boolean;
}

export interface LogAlert {
  kind: "meal" | "used_up";
  localDate: string;
  title: string;
  body: string;
  /** Shown in the app instead of a notification while fitlogr is open. */
  inApp: boolean;
}

export function alertsForPass(input: {
  now: Date;
  foreground: boolean;
  meals: readonly AlertMeal[];
  today: { localDate: string; eatenBefore: number; burnedKcal: number; snapshot: DayPlanSnapshot };
  usedUpSentForDate: string | null;
  notifyMeals: boolean;
  notifyUsedUp: boolean;
}): { alerts: LogAlert[]; usedUpDate: string | null } {
  const fresh = input.meals.filter((meal) => !meal.backfill && input.now.getTime() - Date.parse(meal.capturedAt) <= FRESH_MS);
  const todayMeals = input.meals.filter((meal) => meal.localDate === input.today.localDate);
  const eatenAfter = input.today.eatenBefore + todayMeals.reduce((sum, meal) => sum + meal.kcal, 0);
  const before = remainingCalories(input.today.snapshot, input.today.eatenBefore, input.today.burnedKcal);
  const after = remainingCalories(input.today.snapshot, eatenAfter, input.today.burnedKcal);
  const alerts: LogAlert[] = [];

  if (input.notifyMeals && !input.foreground && fresh.length > 0) {
    const kcal = fresh.reduce((sum, meal) => sum + meal.kcal, 0);
    const available = `${formatKcal(Math.max(0, after))} kcal available today.`;
    const body =
      fresh.length === 1
        ? `${fresh[0]?.name || "Meal"} logged · ${formatKcal(fresh[0]?.kcal ?? 0)} kcal. ${available}`
        : `${fresh.length} meals logged · ${formatKcal(kcal)} kcal. ${available}`;
    alerts.push({ kind: "meal", localDate: input.today.localDate, title: "Meal logged", body, inApp: false });
  }

  const crossed = before > 0 && after <= 0 && todayMeals.length > 0;
  const alreadySent = input.usedUpSentForDate === input.today.localDate;
  let usedUpDate = input.usedUpSentForDate;
  if (input.notifyUsedUp && crossed && !alreadySent) {
    const eaten = Math.round(eatenAfter);
    const allowance = eaten + after;
    alerts.push({
      kind: "used_up",
      localDate: input.today.localDate,
      title: "Calories used up",
      body: `You've used today's calories: ${formatKcal(eaten)} eaten, ${formatKcal(allowance)} available.`,
      inApp: input.foreground,
    });
    usedUpDate = input.today.localDate;
  }
  return { alerts, usedUpDate };
}
