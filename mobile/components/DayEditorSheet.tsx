import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import {
  DAY_PLAN_TYPES,
  DAY_PLAN_TYPE_LABELS,
  LOW_INTAKE_NOTE,
  PLAN_LIMITS,
  WEEKDAYS,
  WEEKDAY_LETTERS,
  applyDayPlan,
  clampAmount,
  clampTargetBurn,
  dayEditorSummaryPrimary,
  dayEditorTitle,
  dayForKey,
  dayNetPhrase,
  formatKcal,
  isLowIntakeDay,
  maxAmount,
  stepAmount,
  stepTargetBurn,
  targetBurnOf,
  withTargetBurn,
  type CaloriePlanSettings,
  type DayKey,
  type DayPlan,
  type DayPlanType,
  type Weekday,
} from "@fitlogr/shared";
import { Segmented, StepperButton, controlStyles } from "./planControls";
import { Sheet } from "./Sheet";
import { colors } from "../theme";

const TYPE_OPTIONS = DAY_PLAN_TYPES.map((value) => ({ value, label: DAY_PLAN_TYPE_LABELS[value] }));

function draftDay(type: DayPlanType, amount: number, burn: number): DayPlan {
  const day: DayPlan = type === "deficit" || type === "surplus" ? { type, amount } : { type };
  return withTargetBurn(day, burn);
}

function DayChip({
  label,
  active,
  onPress,
  disabled,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      style={[styles.dayChip, active && styles.dayChipActive]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
    >
      <Text style={[styles.dayChipText, active && styles.dayChipTextActive]}>{label}</Text>
    </Pressable>
  );
}

export function DayEditorSheet({
  plan,
  dayKey,
  onClose,
  onSave,
}: {
  plan: CaloriePlanSettings;
  dayKey: DayKey | null;
  onClose: () => void;
  onSave: (next: CaloriePlanSettings) => void;
}) {
  const [type, setType] = useState<DayPlanType>("maintain");
  const [amount, setAmount] = useState<number>(PLAN_LIMITS.amountDefault);
  const [amountText, setAmountText] = useState(String(PLAN_LIMITS.amountDefault));
  const [burn, setBurn] = useState<number>(PLAN_LIMITS.burnDefault);
  const [burnText, setBurnText] = useState(String(PLAN_LIMITS.burnDefault));
  const [weekdays, setWeekdays] = useState<Weekday[]>([]);
  const [indices, setIndices] = useState<number[]>([]);

  useEffect(() => {
    if (!dayKey) return;
    const day = dayForKey(plan, dayKey);
    const nextAmount = day.type === "deficit" || day.type === "surplus" ? day.amount : PLAN_LIMITS.amountDefault;
    setType(day.type);
    setAmount(nextAmount);
    setAmountText(String(nextAmount));
    setBurn(targetBurnOf(day));
    setBurnText(String(targetBurnOf(day)));
    setWeekdays(dayKey.planType === "weekly" ? [dayKey.weekday] : []);
    setIndices(dayKey.planType === "custom" ? [dayKey.index] : []);
    // Re-seed only when a different row opens; live plan edits elsewhere must not reset the draft.
  }, [dayKey]);

  if (!dayKey) return null;
  const maintenance = plan.maintenanceCalories;
  const hasAmount = type === "deficit" || type === "surplus";
  const effectiveAmount = hasAmount ? clampAmount(type, amount, maintenance) : amount;
  const hasBurn = type !== "fast";
  const day = draftDay(type, effectiveAmount, hasBurn ? burn : 0);

  function commitAmount(value: number) {
    if (!hasAmount) return;
    const next = clampAmount(type as "deficit" | "surplus", value, maintenance);
    setAmount(next);
    setAmountText(String(next));
  }

  function commitBurn(value: number) {
    const next = clampTargetBurn(value);
    setBurn(next);
    setBurnText(String(next));
  }

  function save() {
    if (!dayKey) return;
    const targets =
      dayKey.planType === "daily"
        ? { planType: "daily" as const }
        : dayKey.planType === "weekly"
          ? { planType: "weekly" as const, weekdays }
          : { planType: "custom" as const, indices };
    onSave(applyDayPlan(plan, targets, day));
  }

  return (
    <Sheet visible title={dayEditorTitle(dayKey)} onClose={onClose}>
      <View style={styles.calorieHeader}>
        <Text style={styles.sectionTitle}>Calorie target</Text>
        <Text style={styles.baseline}>{formatKcal(maintenance)} kcal baseline</Text>
      </View>
      <Segmented options={TYPE_OPTIONS} value={type} onChange={setType} />

      {hasAmount ? (
        <>
          <View style={styles.amountRow}>
            <Text style={styles.rowLabel}>{type === "deficit" ? "Below baseline" : "Above baseline"}</Text>
            <View style={styles.stepperRow}>
              <StepperButton
                label="-"
                disabled={effectiveAmount <= PLAN_LIMITS.amountMin}
                onPress={() => commitAmount(stepAmount(type as "deficit" | "surplus", effectiveAmount, -1, maintenance))}
              />
              <TextInput
                value={amountText}
                onChangeText={setAmountText}
                onEndEditing={() => {
                  const parsed = Number(amountText);
                  if (Number.isFinite(parsed) && amountText.trim() !== "") commitAmount(parsed);
                  else setAmountText(String(effectiveAmount));
                }}
                keyboardType="number-pad"
                style={[controlStyles.input, styles.amountInput]}
                accessibilityLabel="Amount in kcal"
              />
              <Text style={styles.unit}>kcal</Text>
              <StepperButton
                label="+"
                disabled={effectiveAmount >= maxAmount(type as "deficit" | "surplus", maintenance)}
                onPress={() => commitAmount(stepAmount(type as "deficit" | "surplus", effectiveAmount, 1, maintenance))}
              />
            </View>
          </View>
          {isLowIntakeDay(day, maintenance) ? <Text style={styles.note}>{LOW_INTAKE_NOTE}</Text> : null}
        </>
      ) : null}

      {hasBurn ? (
        <>
          <View style={styles.divider} />
          <View style={styles.workoutHeader}>
            <View style={styles.workoutLabels}>
              <Text style={styles.sectionTitle}>Workout target</Text>
              <Text style={styles.optional}>Optional</Text>
            </View>
            <View style={styles.stepperRow}>
              <StepperButton label="-" disabled={burn <= 0} onPress={() => commitBurn(stepTargetBurn(burn, -1))} />
              <TextInput
                value={burnText}
                onChangeText={setBurnText}
                onEndEditing={() => {
                  const parsed = Number(burnText);
                  if (Number.isFinite(parsed) && burnText.trim() !== "") commitBurn(parsed);
                  else setBurnText(String(burn));
                }}
                keyboardType="number-pad"
                style={[controlStyles.input, styles.amountInput]}
                accessibilityLabel="Workout target in kcal"
              />
              <Text style={styles.unit}>kcal</Text>
              <StepperButton label="+" disabled={burn >= PLAN_LIMITS.burnMax} onPress={() => commitBurn(stepTargetBurn(burn, 1))} />
            </View>
          </View>
        </>
      ) : null}

      <View style={styles.summary}>
        <Text style={styles.summaryEyebrow}>Daily target</Text>
        <Text style={styles.summaryPrimary}>{dayEditorSummaryPrimary(day, maintenance, plan.fastAllowanceKcal)}</Text>
        <Text style={styles.summarySub}>{dayNetPhrase(day)}</Text>
      </View>

      {dayKey.planType === "weekly" ? (
        <>
          <Text style={styles.applyLabel}>Apply to</Text>
          <View style={styles.chips}>
            {WEEKDAYS.map((weekday) => (
              <DayChip
                key={weekday}
                label={WEEKDAY_LETTERS[weekday]}
                active={weekdays.includes(weekday)}
                disabled={weekday === dayKey.weekday}
                onPress={() => setWeekdays((current) => (current.includes(weekday) ? current.filter((item) => item !== weekday) : [...current, weekday]))}
              />
            ))}
          </View>
        </>
      ) : null}
      {dayKey.planType === "custom" ? (
        <>
          <Text style={styles.applyLabel}>Apply to</Text>
          <ScrollView horizontal={plan.customPlan.lengthDays > 7} showsHorizontalScrollIndicator={false} contentContainerStyle={plan.customPlan.lengthDays > 7 ? styles.chipsScroll : styles.chips}>
            {plan.customPlan.days.map((_, index) => (
              <DayChip
                key={index}
                label={`${index + 1}`}
                active={indices.includes(index)}
                disabled={index === dayKey.index}
                onPress={() => setIndices((current) => (current.includes(index) ? current.filter((item) => item !== index) : [...current, index]))}
              />
            ))}
          </ScrollView>
        </>
      ) : null}

      <Pressable style={styles.save} onPress={save} accessibilityRole="button">
        <Text style={styles.saveText}>Save</Text>
      </Pressable>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  calorieHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: -4,
  },
  sectionTitle: { color: colors.text, fontWeight: "700", fontSize: 15 },
  baseline: { color: colors.muted, fontSize: 13 },
  amountRow: { marginTop: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  rowLabel: { color: colors.muted, flexShrink: 1 },
  stepperRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  amountInput: { width: 64, textAlign: "center" },
  unit: { color: colors.muted },
  note: { color: colors.faint, marginTop: 10 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.cardBorder, marginTop: 16 },
  workoutHeader: {
    marginTop: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  workoutLabels: { flexShrink: 1 },
  optional: { color: colors.muted, fontSize: 12, marginTop: 2 },
  summary: {
    marginTop: 16,
    backgroundColor: "#222428",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  summaryEyebrow: { color: colors.muted, fontSize: 13 },
  summaryPrimary: { color: colors.text, fontSize: 20, fontWeight: "800", marginTop: 4 },
  summarySub: { color: colors.muted, fontSize: 13, marginTop: 4 },
  applyLabel: { color: colors.muted, marginTop: 16, marginBottom: 10, fontSize: 13 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chipsScroll: { flexDirection: "row", gap: 8 },
  dayChip: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#222428",
    alignItems: "center",
    justifyContent: "center",
  },
  dayChipActive: { backgroundColor: colors.green },
  dayChipText: { color: colors.muted, fontWeight: "700", fontSize: 14 },
  dayChipTextActive: { color: "#062214" },
  save: {
    marginTop: 18,
    backgroundColor: colors.green,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  saveText: { color: "#062214", fontWeight: "800", fontSize: 16 },
});
