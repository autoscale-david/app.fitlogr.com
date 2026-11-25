import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import {
  AMOUNT_PRESETS,
  DAY_PLAN_TYPES,
  DAY_PLAN_TYPE_LABELS,
  LOW_INTAKE_NOTE,
  PLAN_LIMITS,
  WEEKDAYS,
  WEEKDAY_LETTERS,
  applyDayPlan,
  clampAmount,
  dayEditorTitle,
  dayForKey,
  dayPlanHelper,
  dayTargetLine,
  isLowIntakeDay,
  maxAmount,
  stepAmount,
  type CaloriePlanSettings,
  type DayKey,
  type DayPlan,
  type DayPlanType,
  type Weekday,
} from "@fitlogr/shared";
import { Chip, Segmented, StepperButton, controlStyles } from "./planControls";
import { Sheet } from "./Sheet";
import { colors } from "../theme";

const TYPE_OPTIONS = DAY_PLAN_TYPES.map((value) => ({ value, label: DAY_PLAN_TYPE_LABELS[value] }));

function draftDay(type: DayPlanType, amount: number): DayPlan {
  return type === "deficit" || type === "surplus" ? { type, amount } : { type };
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
  const [weekdays, setWeekdays] = useState<Weekday[]>([]);
  const [indices, setIndices] = useState<number[]>([]);

  useEffect(() => {
    if (!dayKey) return;
    const day = dayForKey(plan, dayKey);
    const nextAmount = day.type === "deficit" || day.type === "surplus" ? day.amount : PLAN_LIMITS.amountDefault;
    setType(day.type);
    setAmount(nextAmount);
    setAmountText(String(nextAmount));
    setWeekdays(dayKey.planType === "weekly" ? [dayKey.weekday] : []);
    setIndices(dayKey.planType === "custom" ? [dayKey.index] : []);
    // Re-seed only when a different row opens; live plan edits elsewhere must not reset the draft.
  }, [dayKey]);

  if (!dayKey) return null;
  const maintenance = plan.maintenanceCalories;
  const hasAmount = type === "deficit" || type === "surplus";
  const effectiveAmount = hasAmount ? clampAmount(type, amount, maintenance) : amount;
  const day = draftDay(type, effectiveAmount);

  function commitAmount(value: number) {
    if (!hasAmount) return;
    const next = clampAmount(type as "deficit" | "surplus", value, maintenance);
    setAmount(next);
    setAmountText(String(next));
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
      <Segmented options={TYPE_OPTIONS} value={type} onChange={setType} />

      {hasAmount ? (
        <>
          <View style={styles.amountRow}>
            <Text style={styles.rowLabel}>Amount</Text>
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
          <View style={styles.presets}>
            <Text style={styles.rowLabel}>Presets:</Text>
            {AMOUNT_PRESETS.map((preset) => (
              <Chip key={preset} label={String(preset)} active={effectiveAmount === preset} onPress={() => commitAmount(preset)} />
            ))}
          </View>
          {isLowIntakeDay(day, maintenance) ? <Text style={styles.note}>{LOW_INTAKE_NOTE}</Text> : null}
        </>
      ) : null}

      <Text style={styles.target}>{dayTargetLine(day, maintenance, plan.fastAllowanceKcal)}</Text>
      <Text style={controlStyles.helper}>{dayPlanHelper(day, plan.toleranceKcal)}</Text>

      {dayKey.planType === "weekly" ? (
        <>
          <Text style={styles.applyLabel}>Also apply to:</Text>
          <View style={styles.chips}>
            {WEEKDAYS.map((weekday) => (
              <Chip
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
          <Text style={styles.applyLabel}>Also apply to:</Text>
          <ScrollView horizontal={plan.customPlan.lengthDays > 7} showsHorizontalScrollIndicator={false} contentContainerStyle={plan.customPlan.lengthDays > 7 ? styles.chipsScroll : styles.chips}>
            {plan.customPlan.days.map((_, index) => (
              <Chip
                key={index}
                label={`Day ${index + 1}`}
                active={indices.includes(index)}
                disabled={index === dayKey.index}
                onPress={() => setIndices((current) => (current.includes(index) ? current.filter((item) => item !== index) : [...current, index]))}
              />
            ))}
          </ScrollView>
        </>
      ) : null}

      <Pressable style={controlStyles.primary} onPress={save} accessibilityRole="button">
        <Text style={controlStyles.primaryText}>Save</Text>
      </Pressable>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  amountRow: { marginTop: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  rowLabel: { color: colors.muted },
  stepperRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  amountInput: { width: 76, textAlign: "center" },
  unit: { color: colors.muted },
  presets: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12 },
  note: { color: colors.faint, marginTop: 10 },
  target: { color: colors.text, fontSize: 16, fontWeight: "700", marginTop: 16 },
  applyLabel: { color: colors.muted, marginTop: 16, marginBottom: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chipsScroll: { flexDirection: "row", gap: 8 },
});
