import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { formatKcal, formatMonthDay, PLAN_LIMITS, type MaintenanceEstimate } from "@fitlogr/shared";
import { api } from "../services/api";
import { useStore } from "../services/store";
import { ui } from "./settingsUi";
import { colors, LB_PER_KG } from "../theme";

export function MaintenanceEstimateCard() {
  const store = useStore();
  const [estimate, setEstimate] = useState<MaintenanceEstimate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<number | null>(null);
  const imperial = store.goals?.unitSystem !== "metric";
  const signedIn = store.mode === "account";

  async function load() {
    setBusy(true);
    setError(null);
    setApplied(null);
    try {
      setEstimate(await api.send<MaintenanceEstimate>("GET", "/settings/maintenance-estimate?days=90"));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The estimate could not be loaded.");
    } finally {
      setBusy(false);
    }
  }

  function apply() {
    if (!store.goals || estimate?.estimated_base_calories == null) return;
    const maintenanceCalories = Math.min(PLAN_LIMITS.maintenanceMax, Math.max(PLAN_LIMITS.maintenanceMin, Math.round(estimate.estimated_base_calories)));
    void store.saveGoals({ ...store.goals, plan: { ...store.goals.plan, maintenanceCalories } }).then(() => setApplied(maintenanceCalories));
  }

  return (
    <View style={styles.wrap}>
      {signedIn ? (
        <Pressable style={styles.button} onPress={() => void load()} disabled={busy} accessibilityRole="button">
          {busy ? <ActivityIndicator color={colors.text} /> : <Text style={styles.buttonText}>Estimate from my last 90 days</Text>}
        </Pressable>
      ) : (
        <Text style={styles.body}>Sign in to estimate your baseline from logged meals, burn, and weight.</Text>
      )}
      {error ? <Text style={styles.body}>{error}</Text> : null}
      {estimate ? (
        <View style={styles.result}>
          {estimate.status === "insufficient_data" ? (
            <Text style={styles.body}>{estimate.missing_reason}</Text>
          ) : (
            <>
              <Text style={styles.value}>Estimated baseline {estimate.estimated_base_calories != null ? formatKcal(estimate.estimated_base_calories) : ""} kcal</Text>
              <Text style={styles.body}>Average burn with workouts {estimate.estimated_tdee_calories != null ? formatKcal(estimate.estimated_tdee_calories) : ""} kcal/day</Text>
              <Text style={styles.body}>
                Confidence {estimate.confidence}. {estimate.total_complete_days} complete days across {estimate.qualifying_period_count} period
                {estimate.qualifying_period_count === 1 ? "" : "s"}.
              </Text>
              {estimate.periods.map((period) => (
                <Text key={`${period.start_date}-${period.end_date}`} style={styles.body}>
                  {formatMonthDay(period.start_date)} – {formatMonthDay(period.end_date)}: {formatDelta(period.weight_delta_kg, imperial)} over {period.days} days
                </Text>
              ))}
            </>
          )}
          {estimate.warnings.map((warning) => (
            <Text key={warning} style={styles.body}>
              {warning}
            </Text>
          ))}
          {applied != null ? (
            <Text style={styles.applied}>Maintenance calories set to {formatKcal(applied)}.</Text>
          ) : estimate.estimated_base_calories != null ? (
            <Pressable style={styles.secondary} onPress={apply} accessibilityRole="button">
              <Text style={styles.secondaryText}>Use as maintenance calories</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function formatDelta(kg: number, imperial: boolean): string {
  const amount = imperial ? kg * LB_PER_KG : kg;
  const unit = imperial ? "lb" : "kg";
  const sign = amount > 0 ? "+" : "";
  return `${sign}${amount.toFixed(1)} ${unit}`;
}

const styles = StyleSheet.create({
  wrap: { marginTop: 2 },
  body: ui.body,
  value: { color: colors.text, marginTop: 8, fontSize: 16, fontWeight: "800" },
  result: { marginTop: 2 },
  button: ui.secondary,
  buttonText: ui.secondaryText,
  secondary: ui.secondary,
  applied: { color: colors.green, fontSize: 13, fontWeight: "700", marginTop: 8 },
  secondaryText: ui.secondaryText,
});
