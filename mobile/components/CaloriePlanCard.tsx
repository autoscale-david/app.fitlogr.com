import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  NO_END_DATE_LABEL,
  PLAN_LIMITS,
  PLAN_TYPES,
  PLAN_TYPE_LABELS,
  WEEKDAYS,
  WEEKDAY_SHORT,
  clampCycleLength,
  clampMaintenance,
  cycleDateLabels,
  cycleFooter,
  dayKeyFor,
  burnSuffix,
  dayNetPhrase,
  targetBurnOf,
  dayTarget,
  formatFullDate,
  formatKcal,
  isWithinPlanDates,
  planStatus,
  planStatusText,
  planTotal,
  planTotalText,
  removeCycleDaysPrompt,
  resizeCycle,
  selectedPlanDates,
  setPlanEndDate,
  setPlanStartDate,
  weeklyFooter,
  withCycleLength,
  withSelectedPlanDates,
  type CaloriePlanSettings,
  type DayKey,
  type DayPlan,
  type PlanDates,
} from "@fitlogr/shared";
import { DayEditorSheet } from "./DayEditorSheet";
import { MaintenanceEstimateCard } from "./MaintenanceEstimateCard";
import { DatePickerSheet, EndDateSheet } from "./PlanDateSheets";
import { Segmented, StepperButton, controlStyles } from "./planControls";
import { dayColor } from "./planTone";
import { localDateISO } from "../services/dates";
import { ui } from "./settingsUi";
import { colors } from "../theme";

const PLAN_TYPE_OPTIONS = PLAN_TYPES.map((value) => ({ value, label: PLAN_TYPE_LABELS[value] }));

interface Row {
  key: DayKey;
  label: string;
  day: DayPlan;
  dateLabel?: string;
}

function sameKey(left: DayKey | null, right: DayKey): boolean {
  if (!left || left.planType !== right.planType) return false;
  if (left.planType === "weekly" && right.planType === "weekly") return left.weekday === right.weekday;
  if (left.planType === "custom" && right.planType === "custom") return left.index === right.index;
  return true;
}

export function CaloriePlanCard({
  plan,
  onChange,
  openEndsSignal = 0,
}: {
  plan: CaloriePlanSettings;
  onChange: (next: CaloriePlanSettings) => void;
  openEndsSignal?: number;
}) {
  const today = localDateISO();
  const [editing, setEditing] = useState<DayKey | null>(null);
  const [sheet, setSheet] = useState<"start" | "end" | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [maintenanceError, setMaintenanceError] = useState(false);

  useEffect(() => {
    if (openEndsSignal > 0) setSheet("end");
  }, [openEndsSignal]);

  const dates = selectedPlanDates(plan);
  const status = planStatus(dates, today);
  const active = isWithinPlanDates(dates, today);
  const todayKey = dayKeyFor(plan, today);
  const total = planTotal(plan);
  const maintenance = plan.maintenanceCalories;

  function setDates(next: PlanDates) {
    onChange(withSelectedPlanDates(plan, next));
  }

  /** Returns false while a confirm is pending so a typed length reverts until it is accepted. */
  function changeLength(requested: number): boolean {
    const current = plan.customPlan.lengthDays;
    const length = clampCycleLength(requested);
    if (length === current) return false;
    const apply = () => onChange(withCycleLength(plan, length));
    if (resizeCycle(plan.customPlan.days, length).removedPlanned.length > 0) {
      Alert.alert(removeCycleDaysPrompt(current, length), undefined, [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: apply },
      ]);
      return false;
    }
    apply();
    return true;
  }

  const rows: Row[] =
    plan.planType === "daily"
      ? [{ key: { planType: "daily" }, label: "Every day", day: plan.dailyPlan.day }]
      : plan.planType === "weekly"
        ? WEEKDAYS.map((weekday) => ({ key: { planType: "weekly", weekday }, label: WEEKDAY_SHORT[weekday], day: plan.weeklyPlan.days[weekday] }))
        : (() => {
            const labels = cycleDateLabels(plan.customPlan, today);
            return plan.customPlan.days.map((day, index) => ({
              key: { planType: "custom" as const, index },
              label: `Day ${index + 1}`,
              day,
              dateLabel: labels[index],
            }));
          })();

  return (
    <>
    <View style={ui.card}>
      <View style={styles.firstRow}>
        <Text style={styles.rowLabel}>Maintenance calories</Text>
        <IntegerInput
          value={maintenance}
          accessibilityLabel="Maintenance calories"
          onCommit={(value) => {
            const valid = clampMaintenance(value);
            setMaintenanceError(valid == null);
            if (valid != null && valid !== maintenance) onChange({ ...plan, maintenanceCalories: valid });
            return valid != null;
          }}
        />
      </View>
      {maintenanceError ? <Text style={styles.error}>Enter a whole number from 1000 to 6000.</Text> : null}
      <Text style={controlStyles.helper}>Your baseline: calories you burn on a day with no logged exercise. Workouts are added on top.</Text>
      <MaintenanceEstimateCard />
    </View>

    <View style={ui.card}>
      <Text style={ui.cardTitle}>Plan</Text>
      <Segmented options={PLAN_TYPE_OPTIONS} value={plan.planType} onChange={(planType) => onChange({ ...plan, planType })} />

      <View style={styles.dateRow}>
        <Text style={styles.rowLabel}>Starts</Text>
        <View style={styles.dateControls}>
          {plan.planType === "custom" ? (
            <Pressable onPress={() => setDates(setPlanStartDate(dates, today))} hitSlop={8} accessibilityRole="button">
              <Text style={styles.link}>Restart today</Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.dateButton} onPress={() => setSheet("start")} accessibilityRole="button" accessibilityLabel="Start date">
            <Text style={styles.dateText}>{formatFullDate(dates.startDate)}</Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.dateRow}>
        <Text style={styles.rowLabel}>Ends</Text>
        <View style={styles.dateControls}>
          <Pressable style={styles.dateButton} onPress={() => setSheet("end")} accessibilityRole="button" accessibilityLabel="End date">
            <Text style={dates.endDate ? styles.dateText : styles.dateEmpty}>{dates.endDate ? formatFullDate(dates.endDate) : NO_END_DATE_LABEL}</Text>
          </Pressable>
          {dates.endDate ? (
            <Pressable onPress={() => setDates(setPlanEndDate(dates, null))} hitSlop={10} accessibilityRole="button" accessibilityLabel="Clear end date">
              <Ionicons name="close" size={18} color={colors.muted} />
            </Pressable>
          ) : null}
        </View>
      </View>
      <View style={styles.statusRow}>
        <Text style={styles.status}>{planStatusText(status)}</Text>
        {status.kind === "ended" ? (
          <Pressable onPress={() => setSheet("end")} hitSlop={8} accessibilityRole="button">
            <Text style={styles.link}>Extend</Text>
          </Pressable>
        ) : null}
      </View>

      {plan.planType === "custom" ? (
        <View style={[styles.inlineRow, styles.sectionGap]}>
          <Text style={styles.rowLabel}>Repeat every</Text>
          <View style={styles.stepperRow}>
            <StepperButton label="-" disabled={plan.customPlan.lengthDays <= PLAN_LIMITS.cycleMin} onPress={() => changeLength(plan.customPlan.lengthDays - 1)} />
            <IntegerInput
              value={plan.customPlan.lengthDays}
              width={52}
              accessibilityLabel="Cycle length in days"
              onCommit={changeLength}
            />
            <Text style={styles.rowLabel}>days</Text>
            <StepperButton label="+" disabled={plan.customPlan.lengthDays >= PLAN_LIMITS.cycleMax} onPress={() => changeLength(plan.customPlan.lengthDays + 1)} />
          </View>
        </View>
      ) : null}

      <View style={[styles.rows, !active && styles.dimmed]}>
        {rows.map((row) => {
          const highlighted = active && sameKey(todayKey, row.key);
          return (
            <Pressable
              key={row.label}
              style={[styles.row, highlighted && styles.rowToday]}
              onPress={() => setEditing(row.key)}
              accessibilityRole="button"
            >
              <Text style={styles.rowName}>{row.label}</Text>
              <View style={styles.rowPlanColumn}>
                <Text style={[styles.rowPlan, { color: dayColor(row.day) }]} numberOfLines={1}>
                  {dayNetPhrase(row.day)}
                </Text>
                {targetBurnOf(row.day) > 0 ? <Text style={styles.rowBurn}>{burnSuffix(row.day).replace(" · ", "")}</Text> : null}
              </View>
              <Text style={styles.rowTarget}>{formatKcal(dayTarget(row.day, maintenance, plan.fastAllowanceKcal))} kcal</Text>
              {row.dateLabel !== undefined ? <Text style={styles.rowDate}>{row.dateLabel}</Text> : null}
              <Ionicons name="chevron-forward" size={16} color={colors.faint} />
            </Pressable>
          );
        })}
      </View>

      {plan.planType === "weekly" ? <Text style={styles.footer}>{weeklyFooter(plan)}</Text> : null}
      {plan.planType === "custom" ? <Text style={styles.footer}>{cycleFooter(plan)}</Text> : null}
      {total ? <Text style={styles.footer}>{planTotalText(total)}</Text> : null}
    </View>

    <View style={ui.card}>
      <Pressable style={styles.advancedToggle} onPress={() => setAdvanced((open) => !open)} accessibilityRole="button">
        <Text style={styles.advancedText}>Advanced</Text>
        <Ionicons name={advanced ? "chevron-up" : "chevron-down"} size={16} color={colors.muted} />
      </Pressable>
      {advanced ? (
        <>
          <View style={styles.inlineRow}>
            <Text style={styles.rowLabel}>On-target range</Text>
            <View style={styles.stepperRow}>
              <Text style={styles.rowLabel}>±</Text>
              <IntegerInput
                value={plan.toleranceKcal}
                width={64}
                accessibilityLabel="On-target range in kcal"
                onCommit={(value) => {
                  const valid = Number.isInteger(value) && value >= PLAN_LIMITS.toleranceMin && value <= PLAN_LIMITS.toleranceMax;
                  if (valid) onChange({ ...plan, toleranceKcal: value });
                  return valid;
                }}
              />
              <Text style={styles.rowLabel}>kcal</Text>
            </View>
          </View>
          <View style={styles.inlineRow}>
            <Text style={styles.rowLabel}>Fast day allowance</Text>
            <View style={styles.stepperRow}>
              <IntegerInput
                value={plan.fastAllowanceKcal}
                width={64}
                accessibilityLabel="Fast day allowance in kcal"
                onCommit={(value) => {
                  const valid = Number.isInteger(value) && value >= PLAN_LIMITS.fastAllowanceMin && value <= PLAN_LIMITS.fastAllowanceMax;
                  if (valid) onChange({ ...plan, fastAllowanceKcal: value });
                  return valid;
                }}
              />
              <Text style={styles.rowLabel}>kcal</Text>
            </View>
          </View>
          <Text style={controlStyles.helper}>For coffee, supplements, etc.</Text>
          <View style={styles.inlineRow}>
            <Text style={[styles.rowLabel, styles.switchLabel]}>Scale carbs & fat with daily target</Text>
            <Switch
              value={plan.scaleMacrosWithPlan}
              onValueChange={(scaleMacrosWithPlan) => onChange({ ...plan, scaleMacrosWithPlan })}
              trackColor={{ true: colors.green, false: "#3A3E44" }}
            />
          </View>
        </>
      ) : null}
    </View>

      <DayEditorSheet
        plan={plan}
        dayKey={editing}
        onClose={() => setEditing(null)}
        onSave={(next) => {
          onChange(next);
          setEditing(null);
        }}
      />
      <DatePickerSheet
        visible={sheet === "start"}
        title="Starts"
        value={dates.startDate}
        today={today}
        onClose={() => setSheet(null)}
        onSelect={(date) => {
          setDates(setPlanStartDate(dates, date));
          setSheet(null);
        }}
      />
      <EndDateSheet
        visible={sheet === "end"}
        startDate={dates.startDate}
        endDate={dates.endDate}
        today={today}
        onClose={() => setSheet(null)}
        onSelect={(date) => {
          setDates(setPlanEndDate(dates, date));
          setSheet(null);
        }}
      />
    </>
  );
}

/** Saves on blur/confirm like the other Settings fields; reverts when `onCommit` rejects the value. */
function IntegerInput({
  value,
  onCommit,
  width = 96,
  accessibilityLabel,
}: {
  value: number;
  onCommit: (value: number) => boolean;
  width?: number;
  accessibilityLabel: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <TextInput
      value={text}
      keyboardType="number-pad"
      onChangeText={setText}
      onEndEditing={() => {
        const parsed = Number(text);
        const accepted = text.trim() !== "" && Number.isFinite(parsed) && onCommit(parsed);
        if (!accepted) setText(String(value));
      }}
      style={[ui.input, { width, textAlign: "right" }]}
      accessibilityLabel={accessibilityLabel}
    />
  );
}

const styles = StyleSheet.create({
  firstRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  inlineRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 8, gap: 10 },
  rowLabel: { color: colors.muted, fontSize: 14 },
  sectionGap: { marginTop: 10 },
  error: ui.error,
  dateRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 8 },
  dateControls: { flexDirection: "row", alignItems: "center", gap: 10 },
  dateButton: { backgroundColor: "#222428", borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6 },
  dateText: { color: colors.text, fontSize: 14, fontWeight: "600" },
  dateEmpty: { color: colors.muted, fontSize: 14 },
  link: { color: colors.green, fontWeight: "700", fontSize: 14 },
  statusRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 6 },
  status: { color: colors.muted, flexShrink: 1, fontSize: 13 },
  stepperRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  rows: { marginTop: 8 },
  dimmed: { opacity: 0.6 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 7, paddingHorizontal: 6, borderRadius: 10 },
  rowToday: { backgroundColor: colors.selectedDay },
  rowName: { color: colors.text, fontWeight: "700", width: 70, fontSize: 14 },
  rowPlanColumn: { flex: 1, minWidth: 0 },
  rowPlan: { fontWeight: "700", fontSize: 13 },
  rowBurn: { color: colors.muted, fontSize: 12, marginTop: 1 },
  rowTarget: { color: colors.text, fontVariant: ["tabular-nums"], fontSize: 14 },
  rowDate: { color: colors.muted, width: 76, textAlign: "right", fontSize: 12 },
  footer: { color: colors.muted, marginTop: 6, lineHeight: 17, fontSize: 13 },
  advancedToggle: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 2 },
  advancedText: { color: colors.text, fontWeight: "700", fontSize: 15 },
  switchLabel: { flex: 1 },
});
