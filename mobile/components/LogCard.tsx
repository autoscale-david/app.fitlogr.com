import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";
import type { MealRecord, WorkoutRecord } from "../services/db";
import { formatCompactTime } from "../services/dates";
import { colors } from "../theme";
import { MealPhoto } from "./MealPhoto";

export function MealCard({ meal }: { meal: MealRecord }) {
  const icon = meal.name.includes("Chicken") ? "restaurant-outline" : meal.name.includes("Shake") ? "cafe-outline" : "nutrition-outline";
  const tint = meal.name.includes("Chicken") ? "#C47A45" : meal.name.includes("Shake") ? "#C46B8A" : "#7D9A45";
  return (
    <View style={styles.card}>
      {meal.photoId ? (
        <MealPhoto photoId={meal.photoId} />
      ) : (
        <View style={[styles.thumb, { backgroundColor: tint }]}>
          <Ionicons name={icon} size={28} color="#F7F3EA" />
        </View>
      )}
      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text style={styles.title} numberOfLines={1}>
            {meal.name}
          </Text>
          <Text style={styles.time}>{formatCompactTime(meal.eatenAt)}</Text>
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.kcal}>{meal.caloriesKcal} kcal</Text>
          <Ionicons name="pencil" size={13} color={colors.faint} />
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{meal.badge === "ai" ? "AI" : "Edited"}</Text>
          </View>
        </View>
        <View style={styles.bars}>
          <View style={[styles.bar, { backgroundColor: colors.protein, flex: meal.proteinG }]} />
          <View style={[styles.bar, { backgroundColor: colors.carbs, flex: meal.carbsG }]} />
          <View style={[styles.bar, { backgroundColor: colors.fat, flex: meal.fatG }]} />
        </View>
      </View>
    </View>
  );
}

export function WorkoutCard({ workout }: { workout: WorkoutRecord }) {
  return (
    <View style={styles.card}>
      <View style={[styles.thumb, styles.workoutThumb]}>
        <Ionicons name="watch-outline" size={28} color={colors.green} />
      </View>
      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>{workout.name}</Text>
          <Text style={styles.time}>{formatCompactTime(workout.startTime)}</Text>
        </View>
        <Text style={styles.burned}>{workout.caloriesKcal} kcal burned</Text>
        <Text style={styles.source}>
          {workout.durationMin} mins · {workout.source}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 12,
    backgroundColor: colors.card,
    borderRadius: 22,
    padding: 12,
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
  },
  thumb: {
    width: 74,
    height: 74,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  workoutThumb: { backgroundColor: "#12343A" },
  body: { flex: 1 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { flex: 1, color: colors.text, fontSize: 17, fontWeight: "700" },
  time: { color: colors.muted, fontSize: 13 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
  kcal: { color: colors.text, fontSize: 15, fontWeight: "600" },
  badge: {
    borderWidth: 1,
    borderColor: "#3A3E44",
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  badgeText: { color: colors.muted, fontSize: 12, fontWeight: "600" },
  bars: { flexDirection: "row", gap: 4, marginTop: 10, height: 4 },
  bar: { height: 4, borderRadius: 2, minWidth: 18 },
  burned: { color: colors.text, fontSize: 15, marginTop: 6, fontWeight: "600" },
  source: { color: colors.muted, fontSize: 13, marginTop: 4 },
});
