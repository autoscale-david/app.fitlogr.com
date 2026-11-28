import type { DayPlan, PlanTone } from "@fitlogr/shared";
import { colors } from "../theme";

export function toneColor(tone: PlanTone): string {
  switch (tone) {
    case "deficit":
      return colors.green;
    case "surplus":
      return colors.orange;
    case "fast":
      return colors.fastAccent;
    case "maintain":
      return colors.text;
    case "outside":
      return colors.muted;
  }
}

export function dayColor(day: DayPlan): string {
  return toneColor(day.type);
}
