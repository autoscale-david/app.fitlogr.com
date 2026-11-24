import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { MaintenanceEstimate } from "@fitlogr/shared";
import { api } from "../services/api";
import { useStore } from "../services/store";
import { colors, LB_PER_KG } from "../theme";

export function MaintenanceEstimateCard() {
  const store = useStore();
  const [estimate, setEstimate] = useState<MaintenanceEstimate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const imperial = store.goals?.unitSystem !== "metric";

  async function load() {
    if (store.mode !== "account") {
      setError("Sign in to estimate base calories from your history.");
      return;
    }
    setBusy(true);
    setError(null);
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
    void store.saveGoals({ ...store.goals, baseKcal: estimate.estimated_base_calories });
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>Estimate base calories from history</Text>
      <Pressable style={styles.button} onPress={() => void load()} disabled={busy}>
        {busy ? <ActivityIndicator color="#062214" /> : <Text style={styles.buttonText}>Estimate from the last 90 days</Text>}
      </Pressable>
      {error ? <Text style={styles.body}>{error}</Text> : null}
      {estimate ? (
        <View style={styles.result}>
          {estimate.status === "insufficient_data" ? (
            <Text style={styles.body}>{estimate.missing_reason}</Text>
          ) : (
            <>
              <Text style={styles.value}>Base calories {estimate.estimated_base_calories?.toLocaleString()}</Text>
              <Text style={styles.body}>Total maintenance (TDEE) {estimate.estimated_tdee_calories?.toLocaleString()} kcal</Text>
              <Text style={styles.body}>
                Confidence {estimate.confidence}. {estimate.total_complete_days} complete days across {estimate.qualifying_period_count} period
                {estimate.qualifying_period_count === 1 ? "" : "s"}.
              </Text>
              {estimate.periods.map((period) => (
                <Text key={`${period.start_date}-${period.end_date}`} style={styles.body}>
                  {period.start_date} to {period.end_date}: {formatDelta(period.weight_delta_kg, imperial)} over {period.days} days
                </Text>
              ))}
            </>
          )}
          {estimate.warnings.map((warning) => (
            <Text key={warning} style={styles.body}>
              {warning}
            </Text>
          ))}
          {estimate.estimated_base_calories != null ? (
            <Pressable style={styles.secondary} onPress={apply}>
              <Text style={styles.secondaryText}>Apply to base calories</Text>
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
  wrap: { marginTop: 16 },
  label: { color: colors.text, fontSize: 15, fontWeight: "700" },
  body: { color: colors.muted, marginTop: 6, lineHeight: 20 },
  value: { color: colors.text, marginTop: 10, fontSize: 18, fontWeight: "800" },
  result: { marginTop: 4 },
  button: { marginTop: 10, backgroundColor: colors.green, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  buttonText: { color: "#062214", fontWeight: "800" },
  secondary: { marginTop: 10, borderRadius: 12, borderWidth: 1, borderColor: "#2E3338", paddingVertical: 12, alignItems: "center" },
  secondaryText: { color: colors.text, fontWeight: "700" },
});
