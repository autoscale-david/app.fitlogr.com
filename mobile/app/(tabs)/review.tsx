import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { caloriesRemaining } from "@fitlogr/shared";
import { addDays, formatReviewDate, localDateISO } from "../../services/dates";
import type { DayLog } from "../../services/db";
import { useStore } from "../../services/store";
import { colors, LB_PER_KG } from "../../theme";

export default function ReviewScreen() {
  const insets = useSafeAreaInsets();
  const store = useStore();
  const [days, setDays] = useState<{ date: string; log: DayLog }[]>([]);

  useEffect(() => {
    if (!store.ready) return;
    const today = localDateISO();
    const dates = Array.from({ length: 7 }, (_, index) => addDays(today, index - 6));
    let cancelled = false;
    Promise.all(dates.map(async (date) => ({ date, log: await store.loadDay(date) }))).then((rows) => {
      if (!cancelled) setDays(rows.reverse());
    });
    return () => {
      cancelled = true;
    };
  }, [store, store.refreshToken, store.ready]);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ paddingTop: insets.top + 12, paddingHorizontal: 16, paddingBottom: 28 }}
    >
      <Text style={styles.title}>Review</Text>
      <Text style={styles.subtitle}>The last 7 days, from the phone.</Text>
      {!store.ready || !store.goals ? (
        <ActivityIndicator color={colors.green} style={{ marginTop: 40 }} />
      ) : (
        days.map(({ date, log }) => {
          const remaining = caloriesRemaining(store.goals!.baseKcal, log.activeBurnedKcal, log.eatenKcal);
          const weight =
            log.weightKg == null
              ? "No weigh-in"
              : store.goals!.unitSystem === "metric"
                ? `${log.weightKg.toFixed(1)} kg`
                : `${(log.weightKg * LB_PER_KG).toFixed(1)} lb`;
          const quiet = log.meals.length === 0 && log.workouts.length === 0;
          return (
            <View key={date} style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.day}>{formatReviewDate(date)}</Text>
                <Text style={styles.weight}>{weight}</Text>
              </View>
              {quiet ? (
                <Text style={styles.quiet}>No meals or workouts.</Text>
              ) : (
                <Text style={styles.stats}>
                  {log.eatenKcal.toLocaleString()} eaten · {log.activeBurnedKcal.toLocaleString()} burned ·{" "}
                  {remaining.toLocaleString()} left
                </Text>
              )}
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  title: { color: colors.text, fontSize: 34, fontWeight: "800", letterSpacing: -0.6 },
  subtitle: { color: colors.muted, marginTop: 4, marginBottom: 16 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 18,
    padding: 16,
    marginBottom: 10,
  },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  day: { color: colors.text, fontSize: 17, fontWeight: "700" },
  weight: { color: colors.muted, fontWeight: "600" },
  stats: { color: colors.text, marginTop: 8 },
  quiet: { color: colors.faint, marginTop: 8 },
});
