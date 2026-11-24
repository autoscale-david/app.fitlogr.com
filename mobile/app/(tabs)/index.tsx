import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { calorieBudget, caloriesRemaining } from "@fitlogr/shared";
import { CalorieRing } from "../../components/CalorieRing";
import { MealCard, WorkoutCard } from "../../components/LogCard";
import { MacroBars } from "../../components/MacroBars";
import { WeekStrip } from "../../components/WeekStrip";
import { addDays, formatHeading, localDateISO, startOfWeek } from "../../services/dates";
import type { DayLog } from "../../services/db";
import { useStore } from "../../services/store";
import { colors, LB_PER_KG } from "../../theme";

export default function LogScreen() {
  const insets = useSafeAreaInsets();
  const store = useStore();
  const today = localDateISO();
  const [selected, setSelected] = useState(today);
  const [logged, setLogged] = useState<string[]>([]);
  const [day, setDay] = useState<DayLog | null>(null);

  useEffect(() => {
    if (!store.ready) return;
    let cancelled = false;
    Promise.all([store.loadDay(selected), store.loggedDates()]).then(([nextDay, dates]) => {
      if (!cancelled) {
        setDay(nextDay);
        setLogged(dates);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [store, selected, store.refreshToken, store.ready]);

  const goals = store.goals;
  const budget = goals ? calorieBudget(goals.baseKcal, day?.activeBurnedKcal ?? 0) : 0;
  const remaining = goals ? caloriesRemaining(goals.baseKcal, day?.activeBurnedKcal ?? 0, day?.eatenKcal ?? 0) : 0;
  const progress = budget > 0 ? (day?.eatenKcal ?? 0) / budget : 0;
  const weight =
    day?.weightKg == null || !goals
      ? null
      : goals.unitSystem === "metric"
        ? `${day.weightKg.toFixed(1)} kg`
        : `${(day.weightKg * LB_PER_KG).toFixed(1)} lb`;

  const entries = [
    ...(day?.meals.map((meal) => ({ kind: "meal" as const, at: meal.eatenAt, meal })) ?? []),
    ...(day?.workouts.map((workout) => ({ kind: "workout" as const, at: workout.startTime, workout })) ?? []),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 16, paddingBottom: 28 }}
      refreshControl={<RefreshControl refreshing={store.syncing} onRefresh={() => void store.sync(true)} tintColor={colors.green} />}
    >
      <View style={styles.header}>
        <Pressable style={styles.todayButton} onPress={() => setSelected(today)}>
          <Text style={styles.today}>{formatHeading(selected, today)}</Text>
          <Ionicons name="chevron-down" size={18} color={colors.muted} />
        </Pressable>
        <View style={styles.headerRight}>
          <Pressable style={styles.weightPill} onPress={() => router.push({ pathname: "/weight", params: { date: selected } })}>
            <View style={styles.weightDot} />
            <Text style={styles.weightText}>{weight ?? "Log weight"}</Text>
          </Pressable>
          <View style={styles.avatar}>
            <Ionicons name="person" size={18} color="#F2D2C4" />
          </View>
        </View>
      </View>

      <View style={styles.weekRow}>
        <Pressable onPress={() => setSelected(addDays(selected, -7))} hitSlop={8}>
          <Ionicons name="chevron-back" size={18} color={colors.muted} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <WeekStrip
            weekStart={startOfWeek(selected)}
            selected={selected}
            logged={new Set(logged)}
            onSelect={setSelected}
          />
        </View>
        <Pressable onPress={() => setSelected(addDays(selected, 7))} hitSlop={8}>
          <Ionicons name="chevron-forward" size={18} color={colors.muted} />
        </Pressable>
      </View>

      {!store.ready || !day || !goals ? (
        <ActivityIndicator color={colors.green} style={{ marginTop: 48 }} />
      ) : (
        <>
          <View style={styles.calorieCard}>
            <View style={styles.calorieTop}>
              <Text style={styles.remainingValue}>{remaining.toLocaleString()}</Text>
              <View>
                <Text style={styles.remainingLabel}>Calories</Text>
                <Text style={styles.remainingLabel}>Remaining</Text>
              </View>
              <View style={{ flex: 1 }} />
              <CalorieRing progress={progress} />
            </View>
            <Text style={styles.calorieSub}>
              {day.eatenKcal.toLocaleString()} eaten · {goals.baseKcal.toLocaleString()} base +{" "}
              {day.activeBurnedKcal.toLocaleString()} burned
            </Text>
          </View>

          <MacroBars
            macros={[
              { label: "Protein", value: day.proteinG, target: goals.proteinTarget, color: colors.protein },
              { label: "Carbs", value: day.carbsG, target: goals.carbsTarget, color: colors.carbs },
              { label: "Fat", value: day.fatG, target: goals.fatTarget, color: colors.fat },
            ]}
          />

          <Text style={styles.section}>{selected === today ? "TODAY'S LOG" : "LOG"}</Text>
          {entries.length === 0 ? (
            <Text style={styles.empty}>Nothing logged for this day.</Text>
          ) : (
            entries.map((entry) =>
              entry.kind === "meal" ? (
                <Pressable key={entry.meal.id} onPress={() => router.push({ pathname: "/meal/[id]", params: { id: entry.meal.id } })}>
                  <MealCard meal={entry.meal} />
                </Pressable>
              ) : (
                <WorkoutCard key={entry.workout.id} workout={entry.workout} />
              ),
            )
          )}
          <Pressable style={styles.addMeal} onPress={() => router.push({ pathname: "/meal/[id]", params: { id: "new", date: selected } })}>
            <Text style={styles.addMealText}>Add a meal</Text>
          </Pressable>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  todayButton: { flexDirection: "row", alignItems: "center", gap: 4 },
  today: { color: colors.text, fontSize: 34, fontWeight: "800", letterSpacing: -0.6 },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  weightPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.pill,
    borderRadius: 18,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  weightDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.green },
  weightText: { color: colors.text, fontWeight: "700", fontSize: 14 },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#C48B78",
    alignItems: "center",
    justifyContent: "center",
  },
  weekRow: { flexDirection: "row", alignItems: "center", marginTop: 6 },
  calorieCard: {
    marginTop: 18,
    backgroundColor: colors.card,
    borderRadius: 24,
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 14,
  },
  calorieTop: { flexDirection: "row", alignItems: "center", gap: 10 },
  remainingValue: { color: colors.text, fontSize: 48, fontWeight: "800", letterSpacing: -1.5 },
  remainingLabel: { color: colors.text, fontSize: 16, fontWeight: "700", lineHeight: 20 },
  calorieSub: { color: colors.muted, marginTop: 6, fontSize: 14 },
  section: {
    color: colors.faint,
    textAlign: "center",
    letterSpacing: 1.4,
    fontSize: 12,
    fontWeight: "700",
    marginTop: 22,
  },
  empty: { color: colors.muted, textAlign: "center", marginTop: 18 },
  addMeal: {
    marginTop: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#2E3338",
    paddingVertical: 14,
    alignItems: "center",
  },
  addMealText: { color: colors.text, fontWeight: "700" },
});
