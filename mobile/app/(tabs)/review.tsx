import { useEffect, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { DailyInsight, TrendPoint } from "@fitlogr/shared";
import { GoogleReconnectBanner, SyncStatusBanner } from "../../components/AccountBanners";
import { MealCard, WorkoutCard } from "../../components/LogCard";
import { MacroBars } from "../../components/MacroBars";
import { addDays, formatReviewDate, localDateISO } from "../../services/dates";
import type { DayLog } from "../../services/db";
import { AuthCancelled, useStore } from "../../services/store";
import { colors, LB_PER_KG } from "../../theme";

type Span = 7 | 30;

export default function ReviewScreen() {
  const insets = useSafeAreaInsets();
  const store = useStore();
  const today = localDateISO();
  const [span, setSpan] = useState<Span>(7);
  const [day, setDay] = useState<DayLog | null>(null);
  const [localPoints, setLocalPoints] = useState<TrendPoint[]>([]);
  const [serverPoints, setServerPoints] = useState<TrendPoint[] | null>(null);
  const [insight, setInsight] = useState<DailyInsight | null>(null);
  const [insightNote, setInsightNote] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    if (!store.ready || !store.goals) return;
    let cancelled = false;
    const dates = Array.from({ length: span }, (_, index) => addDays(today, index - (span - 1)));
    const from = dates[0] ?? today;
    Promise.all([store.loadDay(today), store.listWeights(from, today), ...dates.map((date) => store.loadDay(date))]).then(
      ([todayLog, weights, ...logs]) => {
        if (cancelled || !store.goals) return;
        const weightByDate = new Map(weights.map((row) => [row.localDate, row.weightKg]));
        setDay(todayLog);
        setLocalPoints(
          dates.map((date, index) => {
            const log = logs[index] ?? emptyDay();
            const intake = log.eatenKcal;
            const burned = log.activeBurnedKcal + log.restingBurnedKcal;
            return {
              date,
              calories_in_kcal: intake,
              calories_burned_kcal: burned,
              surplus_deficit_kcal: intake - store.goals!.baseKcal,
              protein_g: log.proteinG,
              carbs_g: log.carbsG,
              fat_g: log.fatG,
              workout_minutes: log.workouts.reduce((sum, workout) => sum + workout.durationMin, 0),
              workout_count: log.workouts.length,
              meal_count: log.meals.length,
              weight_kg: weightByDate.get(date) ?? null,
            };
          }),
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [store, span, today, store.refreshToken, store.ready, store.goals]);

  useEffect(() => {
    if (!store.ready) return;
    let cancelled = false;
    if (store.mode !== "account") {
      setServerPoints(null);
      setInsight(null);
      setInsightNote(null);
      return;
    }
    setInsightNote(null);
    store.loadTrends(span).then((trends) => {
      if (!cancelled) setServerPoints(trends?.points ?? null);
    });
    store.loadInsight(today).then((next) => {
      if (cancelled) return;
      setInsight(next);
      setInsightNote(next ? null : "Insight will show again when you're back online.");
    });
    return () => {
      cancelled = true;
    };
  }, [store, span, today, store.mode, store.refreshToken, store.ready]);

  const goals = store.goals;
  const points = store.mode === "account" && store.pending === 0 && serverPoints ? serverPoints : localPoints;
  const intake = day?.eatenKcal ?? 0;
  const burn = (day?.activeBurnedKcal ?? 0) + (day?.restingBurnedKcal ?? 0);
  const net = intake - burn;
  const versusGoal = goals ? intake - goals.baseKcal : 0;
  const weight =
    day?.weightKg == null || !goals
      ? "No weigh-in"
      : goals.unitSystem === "metric"
        ? `${day.weightKg.toFixed(1)} kg`
        : `${(day.weightKg * LB_PER_KG).toFixed(1)} lb`;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ paddingTop: insets.top + 12, paddingHorizontal: 16, paddingBottom: 32 }}
      refreshControl={<RefreshControl refreshing={store.syncing} onRefresh={() => void store.sync(true)} tintColor={colors.green} />}
    >
      <Text style={styles.title}>Review</Text>
      <Text style={styles.subtitle}>
        {store.mode === "account" ? "Tonight's balance from your synced log." : "Sample evening review on this phone."}
      </Text>

      <GoogleReconnectBanner
        visible={store.googleReconnectRequired}
        busy={reconnecting}
        onReconnect={() => {
          setReconnecting(true);
          store
            .reconnectGoogle()
            .catch((error: unknown) => {
              if (error instanceof AuthCancelled) return;
            })
            .finally(() => setReconnecting(false));
        }}
      />
      <SyncStatusBanner
        visible={store.mode === "account"}
        pending={store.pending}
        lastSyncedAt={store.lastSyncedAt}
        syncing={store.syncing}
        error={store.syncError}
        onRetry={() => void store.sync(true)}
      />

      {!store.ready || !day || !goals ? (
        <ActivityIndicator color={colors.green} style={{ marginTop: 40 }} />
      ) : (
        <>
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Today · {weight}</Text>
            <View style={styles.balanceRow}>
              <BalanceStat label="Intake" value={intake} />
              <BalanceStat label="Burned" value={burn} />
              <BalanceStat label={net <= 0 ? "Deficit" : "Surplus"} value={Math.abs(net)} accent={net <= 0 ? colors.green : colors.orange} />
            </View>
            <Text style={styles.goalLine}>
              {versusGoal === 0
                ? "Right on your calorie goal"
                : versusGoal < 0
                  ? `${Math.abs(versusGoal).toLocaleString()} kcal under your ${goals.baseKcal.toLocaleString()} goal`
                  : `${versusGoal.toLocaleString()} kcal over your ${goals.baseKcal.toLocaleString()} goal`}
            </Text>
          </View>

          <MacroBars
            macros={[
              { label: "Protein", value: day.proteinG, target: goals.proteinTarget, color: colors.protein },
              { label: "Carbs", value: day.carbsG, target: goals.carbsTarget, color: colors.carbs },
              { label: "Fat", value: day.fatG, target: goals.fatTarget, color: colors.fat },
            ]}
          />

          <Text style={styles.section}>Today</Text>
          {day.meals.length === 0 && day.workouts.length === 0 ? (
            <Text style={styles.quiet}>No meals or workouts yet.</Text>
          ) : (
            <>
              {day.meals.map((meal) => (
                <MealCard key={meal.id} meal={meal} />
              ))}
              {day.workouts.map((workout) => (
                <WorkoutCard key={workout.id} workout={workout} />
              ))}
            </>
          )}

          <View style={styles.trendHeader}>
            <Text style={styles.sectionInline}>Trends</Text>
            <View style={styles.segment}>
              <Segment label="7 days" active={span === 7} onPress={() => setSpan(7)} />
              <Segment label="30 days" active={span === 30} onPress={() => setSpan(30)} />
            </View>
          </View>
          <TrendChart points={points} unitSystem={goals.unitSystem} />

          <View style={styles.insight}>
            <View style={styles.sectionRow}>
              <Text style={styles.cardLabel}>AI Daily Insight</Text>
              <Text style={styles.badge}>{store.mode === "account" ? "AI-generated" : "Sample"}</Text>
            </View>
            {store.mode === "account" ? (
              insight ? (
                <>
                  <Text style={styles.meta}>
                    {insight.cached ? "Cached" : "Updated"}
                    {insight.generated_at ? ` · ${new Date(insight.generated_at).toLocaleString()}` : ""}
                    {" · Pull to refresh"}
                  </Text>
                  <Text style={styles.insightText}>{insight.insight}</Text>
                </>
              ) : (
                <Text style={styles.quiet}>{insightNote ?? "Writing today's note…"}</Text>
              )
            ) : (
              <>
                <Text style={styles.meta}>Sample preview. Sign in for an insight written from your day.</Text>
                <Text style={styles.insightText}>{sampleInsight(day, goals.baseKcal, goals.proteinTarget)}</Text>
              </>
            )}
          </View>
        </>
      )}
    </ScrollView>
  );
}

function BalanceStat({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, accent ? { color: accent } : null]}>{value.toLocaleString()}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function Segment({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Text onPress={onPress} style={[styles.segmentText, active && styles.segmentActive]}>
      {label}
    </Text>
  );
}

function TrendChart({ points, unitSystem }: { points: TrendPoint[]; unitSystem: "metric" | "imperial" }) {
  const maxCalories = Math.max(1, ...points.map((point) => Math.max(point.calories_in_kcal, point.calories_burned_kcal)));
  const weights = points.map((point) => point.weight_kg).filter((value): value is number => value != null);
  const minWeight = weights.length ? Math.min(...weights) : 0;
  const maxWeight = weights.length ? Math.max(...weights) : 1;
  const spanWeight = Math.max(maxWeight - minWeight, 0.1);
  return (
    <View style={styles.card}>
      <Text style={styles.meta}>
        {points[0] ? formatReviewDate(points[0].date) : ""} – {points.at(-1) ? formatReviewDate(points.at(-1)!.date) : ""}
      </Text>
      <View style={styles.bars}>
        {points.map((point) => (
          <View key={point.date} style={styles.barSlot}>
            <View style={styles.barTrack}>
              <View style={[styles.barBurn, { height: `${(point.calories_burned_kcal / maxCalories) * 100}%` }]} />
              <View style={[styles.barIn, { height: `${(point.calories_in_kcal / maxCalories) * 100}%` }]} />
            </View>
          </View>
        ))}
      </View>
      <Text style={styles.meta}>Green is intake. Dim is calories burned.</Text>
      <View style={styles.weightRow}>
        {points.map((point) => {
          const height = point.weight_kg == null ? 2 : 8 + ((point.weight_kg - minWeight) / spanWeight) * 28;
          return <View key={`${point.date}-w`} style={[styles.weightTick, { height, opacity: point.weight_kg == null ? 0.25 : 1 }]} />;
        })}
      </View>
      <Text style={styles.meta}>
        {weights.length === 0
          ? "No weigh-ins in this range."
          : `${formatWeight(weights[0]!, unitSystem)} → ${formatWeight(weights.at(-1)!, unitSystem)}`}
      </Text>
    </View>
  );
}

function formatWeight(kg: number, unitSystem: "metric" | "imperial"): string {
  return unitSystem === "metric" ? `${kg.toFixed(1)} kg` : `${(kg * LB_PER_KG).toFixed(1)} lb`;
}

function sampleInsight(day: DayLog, calorieGoal: number, proteinGoal: number): string {
  const burned = day.activeBurnedKcal + day.restingBurnedKcal;
  const versus = day.eatenKcal - calorieGoal;
  const goalLine =
    versus <= 0 ? `${Math.abs(versus).toLocaleString()} kcal under the ${calorieGoal.toLocaleString()} calorie goal.` : `${versus.toLocaleString()} kcal over the calorie goal.`;
  return `This sample day shows ${day.eatenKcal.toLocaleString()} kcal eaten and ${burned.toLocaleString()} kcal burned. Protein is ${day.proteinG}g of ${proteinGoal}g. ${goalLine}`;
}

function emptyDay(): DayLog {
  return {
    meals: [],
    workouts: [],
    weightKg: null,
    eatenKcal: 0,
    proteinG: 0,
    carbsG: 0,
    fatG: 0,
    activeBurnedKcal: 0,
    restingBurnedKcal: 0,
    steps: null,
    heartRateBpm: null,
  };
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  title: { color: colors.text, fontSize: 34, fontWeight: "800", letterSpacing: -0.6 },
  subtitle: { color: colors.muted, marginTop: 4, marginBottom: 16 },
  card: { backgroundColor: colors.card, borderRadius: 22, padding: 16, marginTop: 12 },
  cardLabel: { color: colors.text, fontSize: 16, fontWeight: "700" },
  balanceRow: { flexDirection: "row", marginTop: 14 },
  stat: { flex: 1 },
  statValue: { color: colors.text, fontSize: 22, fontWeight: "800" },
  statLabel: { color: colors.muted, marginTop: 4 },
  goalLine: { color: colors.text, marginTop: 14, lineHeight: 20 },
  section: { color: colors.text, fontSize: 20, fontWeight: "800", marginTop: 22 },
  sectionInline: { color: colors.text, fontSize: 20, fontWeight: "800" },
  trendHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 22 },
  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  quiet: { color: colors.faint, marginTop: 10 },
  segment: { flexDirection: "row", gap: 8, marginTop: 14 },
  segmentText: { color: colors.muted, fontWeight: "700", paddingVertical: 6, paddingHorizontal: 10, borderRadius: 10, overflow: "hidden" },
  segmentActive: { color: colors.green, backgroundColor: "#163524" },
  bars: { flexDirection: "row", alignItems: "flex-end", height: 96, gap: 2, marginTop: 12 },
  barSlot: { flex: 1, height: "100%", justifyContent: "flex-end" },
  barTrack: { flex: 1, justifyContent: "flex-end" },
  barBurn: { backgroundColor: "#2E4A3A", borderRadius: 2, position: "absolute", left: 0, right: 0, bottom: 0 },
  barIn: { backgroundColor: colors.green, borderRadius: 2, width: "55%", alignSelf: "flex-end" },
  weightRow: { flexDirection: "row", alignItems: "flex-end", height: 40, gap: 2, marginTop: 12 },
  weightTick: { flex: 1, backgroundColor: colors.orange, borderRadius: 2 },
  meta: { color: colors.muted, marginTop: 8, lineHeight: 18 },
  insight: { backgroundColor: colors.card, borderRadius: 22, padding: 16, marginTop: 16 },
  badge: { color: colors.green, fontWeight: "700", marginTop: 14 },
  insightText: { color: colors.text, marginTop: 10, lineHeight: 22, fontSize: 16 },
});
