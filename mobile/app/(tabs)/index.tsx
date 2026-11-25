import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  dayDotStatus,
  dayKeyFor,
  effectiveSnapshot,
  endedBannerDue,
  endedBannerText,
  fastOverAllowance,
  formatKcal,
  macroTargetsForDay,
  planPillLabel,
  caloriesCard,
  ringProgress,
  targetBanner,
  targetBannerText,
  type DayDotStatus,
  type DayKey,
} from "@fitlogr/shared";
import { CalorieRing } from "../../components/CalorieRing";
import { DayEditorSheet } from "../../components/DayEditorSheet";
import { MealCard, WorkoutCard } from "../../components/LogCard";
import { MealPhotoPicker } from "../../components/MealPhotoPicker";
import { MacroBars } from "../../components/MacroBars";
import { WeekStrip } from "../../components/WeekStrip";
import { addDays, formatHeading, localDateISO, startOfWeek } from "../../services/dates";
import type { DayLog, WeekDayStatus } from "../../services/db";
import { useStore } from "../../services/store";
import { colors, LB_PER_KG } from "../../theme";

const ENDED_BANNER_KEY = "plan_ended_banner_shown";

function openPlanSettings(focus: "plan" | "plan-end") {
  router.push(focus === "plan-end" ? { pathname: "/settings/plan", params: { focus } } : "/settings/plan");
}

export default function LogScreen() {
  const insets = useSafeAreaInsets();
  const store = useStore();
  const today = localDateISO();
  const [selected, setSelected] = useState(today);
  const [week, setWeek] = useState<Record<string, WeekDayStatus>>({});
  const [day, setDay] = useState<DayLog | null>(null);
  const [editing, setEditing] = useState<DayKey | null>(null);
  const [endedBanner, setEndedBanner] = useState(false);
  const weekStart = startOfWeek(selected);

  useEffect(() => {
    if (!store.ready) return;
    let cancelled = false;
    Promise.all([store.loadDay(selected), store.loadWeek(weekStart, addDays(weekStart, 6))]).then(([nextDay, nextWeek]) => {
      if (!cancelled) {
        setDay(nextDay);
        setWeek(nextWeek);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [store, selected, weekStart, store.refreshToken, store.ready]);

  const plan = store.goals?.plan ?? null;
  useFocusEffect(
    useCallback(() => {
      if (!plan) return;
      let cancelled = false;
      void store.readLocal(ENDED_BANNER_KEY).then(async (shown) => {
        const due = endedBannerDue(plan, localDateISO(), shown || null);
        if (cancelled || !due) return;
        setEndedBanner(true);
        await store.writeLocal(ENDED_BANNER_KEY, due);
      });
      return () => {
        cancelled = true;
      };
    }, [plan, store]),
  );

  const goals = store.goals;
  const eaten = day?.eatenKcal ?? 0;
  const burned = day?.activeBurnedKcal ?? 0;
  const snapshot = goals ? effectiveSnapshot(goals.plan, selected, today, day?.planSnapshot) : null;
  const banner = snapshot ? targetBanner(snapshot) : null;
  const card = snapshot ? caloriesCard(snapshot, eaten, burned) : null;
  const progress = snapshot ? ringProgress(snapshot, eaten, burned) : 0;
  const macroTargets =
    goals && snapshot
      ? macroTargetsForDay({ proteinG: goals.proteinTarget, carbsG: goals.carbsTarget, fatG: goals.fatTarget }, snapshot, goals.plan.scaleMacrosWithPlan)
      : null;
  const dots: Record<string, DayDotStatus> = {};
  if (goals) {
    for (const [date, status] of Object.entries(week)) {
      dots[date] = dayDotStatus({
        date,
        today,
        snapshot: effectiveSnapshot(goals.plan, date, today, status.snapshot),
        eatenKcal: status.eatenKcal,
        burnedKcal: status.burnedKcal,
        hasLog: status.hasLog,
      });
    }
  }

  function openPill() {
    if (!goals || !snapshot?.inPlan) {
      openPlanSettings("plan");
      return;
    }
    const key = dayKeyFor(goals.plan, selected);
    if (key) setEditing(key);
    else openPlanSettings("plan");
  }
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
      <Pressable onPress={() => router.push("/settings/data")} hitSlop={8}>
        <Text style={styles.importLink}>Import history</Text>
      </Pressable>

      {endedBanner && goals ? (
        <View style={styles.banner}>
          <View style={styles.bannerTop}>
            <Text style={styles.bannerText}>{endedBannerText(goals.plan)}</Text>
            <Pressable onPress={() => setEndedBanner(false)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Dismiss">
              <Ionicons name="close" size={18} color={colors.muted} />
            </Pressable>
          </View>
          <View style={styles.bannerActions}>
            <Pressable
              onPress={() => {
                setEndedBanner(false);
                openPlanSettings("plan-end");
              }}
              hitSlop={8}
              accessibilityRole="button"
            >
              <Text style={styles.bannerAction}>Extend</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setEndedBanner(false);
                openPlanSettings("plan");
              }}
              hitSlop={8}
              accessibilityRole="button"
            >
              <Text style={styles.bannerAction}>Edit plan</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <View style={styles.weekRow}>
        <Pressable onPress={() => setSelected(addDays(selected, -7))} hitSlop={8}>
          <Ionicons name="chevron-back" size={18} color={colors.muted} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <WeekStrip weekStart={weekStart} selected={selected} status={dots} onSelect={setSelected} />
        </View>
        <Pressable onPress={() => setSelected(addDays(selected, 7))} hitSlop={8}>
          <Ionicons name="chevron-forward" size={18} color={colors.muted} />
        </Pressable>
      </View>

      {!store.ready || !day || !goals || !snapshot || !card || !banner ? (
        <ActivityIndicator color={colors.green} style={{ marginTop: 48 }} />
      ) : (
        <>
          <View style={styles.calorieCard}>
            <Pressable
              style={styles.targetBanner}
              onPress={openPill}
              accessibilityRole="button"
              accessibilityLabel={`${targetBannerText(banner)}. Plan: ${planPillLabel(snapshot)}`}
            >
              <MaterialCommunityIcons name="bullseye-arrow" size={20} color={colors.green} />
              <Text style={styles.targetText} numberOfLines={2}>
                {banner.prefix}
                {banner.emphasis ? <Text style={[styles.targetEmphasis, { color: banner.tone === "surplus" ? colors.orange : colors.green }]}>{banner.emphasis}</Text> : null}
                {banner.rest}
              </Text>
            </Pressable>
            <View style={styles.calorieTop}>
              <View style={styles.calorieMain}>
                <Text style={styles.calorieTitle}>{card.title}</Text>
                <View style={styles.amountRow}>
                  <Text style={[styles.amountValue, card.title === "Calories Over" && { color: colors.orange }]} numberOfLines={1} adjustsFontSizeToFit>
                    {formatKcal(card.amount)}
                  </Text>
                  <Text style={styles.amountUnit}>kcal</Text>
                </View>
                <View style={styles.flowRow}>
                  <View style={styles.flowItem}>
                    <Ionicons name="flame-outline" size={18} color={colors.muted} />
                    <Text style={styles.flowText}>{card.burnedText}</Text>
                  </View>
                  <View style={styles.flowItem}>
                    <MaterialCommunityIcons name="silverware-fork-knife" size={18} color={colors.muted} />
                    <Text style={styles.flowText}>{card.eatenText}</Text>
                  </View>
                </View>
              </View>
              <CalorieRing progress={progress} warning={fastOverAllowance(snapshot, eaten)} label={card.percent == null ? "Fast" : `${card.percent}%`} />
            </View>
            {day.steps != null || day.heartRateBpm != null ? (
              <Text style={styles.calorieSub}>
                {day.steps != null ? `${day.steps.toLocaleString()} steps` : ""}
                {day.steps != null && day.heartRateBpm != null ? " · " : ""}
                {day.heartRateBpm != null ? `${Math.round(day.heartRateBpm)} bpm` : ""}
              </Text>
            ) : null}
          </View>

          {macroTargets ? (
            <MacroBars
              macros={[
                { label: "Protein", value: day.proteinG, target: macroTargets.proteinG, color: colors.protein },
                { label: "Carbs", value: day.carbsG, target: macroTargets.carbsG, color: colors.carbs },
                { label: "Fat", value: day.fatG, target: macroTargets.fatG, color: colors.fat },
              ]}
            />
          ) : null}

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
          <MealPhotoPicker />
          <Pressable style={styles.addMeal} onPress={() => router.push({ pathname: "/meal/[id]", params: { id: "new", date: selected } })}>
            <Text style={styles.addMealText}>Add a meal</Text>
          </Pressable>
        </>
      )}
      {goals ? (
        <DayEditorSheet
          plan={goals.plan}
          dayKey={editing}
          onClose={() => setEditing(null)}
          onSave={(next) => {
            setEditing(null);
            void store.saveGoals({ ...goals, plan: next });
          }}
        />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  todayButton: { flexDirection: "row", alignItems: "center", gap: 4 },
  today: { color: colors.text, fontSize: 34, fontWeight: "800", letterSpacing: -0.6 },
  importLink: { color: colors.green, fontWeight: "700", marginTop: 6 },
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
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 14,
  },
  calorieTop: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 12 },
  calorieMain: { flex: 1, minWidth: 0 },
  targetBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#16301F",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  targetText: { color: colors.text, fontSize: 15, flex: 1 },
  targetEmphasis: { fontWeight: "700" },
  calorieTitle: { color: colors.text, fontSize: 20, fontWeight: "700" },
  amountRow: { flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 2 },
  amountValue: { color: colors.text, fontSize: 52, fontWeight: "800", letterSpacing: -1.5, flexShrink: 1 },
  amountUnit: { color: colors.muted, fontSize: 22, fontWeight: "600" },
  flowRow: { flexDirection: "row", alignItems: "center", gap: 18, marginTop: 4 },
  flowItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  flowText: { color: colors.muted, fontSize: 15 },
  banner: { backgroundColor: colors.card, borderRadius: 16, padding: 12, marginTop: 12 },
  bannerTop: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  bannerText: { color: colors.text, flex: 1, lineHeight: 20 },
  bannerActions: { flexDirection: "row", gap: 18, marginTop: 10 },
  bannerAction: { color: colors.green, fontWeight: "700" },
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
