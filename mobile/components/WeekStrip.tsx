import { Pressable, StyleSheet, Text, View } from "react-native";
import type { DayDotStatus } from "@fitlogr/shared";
import { addDays, dayNumber, weekdayLetter } from "../services/dates";
import { colors } from "../theme";

interface WeekStripProps {
  weekStart: string;
  selected: string;
  /** Met / missed against each day's plan; null shows no dot. */
  status: Readonly<Record<string, DayDotStatus>>;
  onSelect: (date: string) => void;
}

export function WeekStrip({ weekStart, selected, status, onSelect }: WeekStripProps) {
  const days = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));

  return (
    <View style={styles.row}>
      {days.map((date) => {
        const isSelected = date === selected;
        const dot = status[date] ?? null;
        return (
          <Pressable key={date} style={styles.day} onPress={() => onSelect(date)}>
            <View style={[styles.pill, isSelected && styles.pillSelected]}>
              <Text style={[styles.letter, isSelected && styles.letterSelected]}>{weekdayLetter(date)}</Text>
              <Text style={[styles.number, isSelected && styles.numberSelected]}>{dayNumber(date)}</Text>
            </View>
            <View style={[styles.dot, dot === "met" && styles.dotMet, dot === "missed" && styles.dotMissed]} />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 8,
    marginTop: 18,
  },
  day: { alignItems: "center", width: 42 },
  pill: {
    width: 42,
    height: 58,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  pillSelected: { backgroundColor: colors.selectedDay },
  letter: { color: colors.faint, fontSize: 12, fontWeight: "600" },
  letterSelected: { color: colors.muted },
  number: { color: colors.muted, fontSize: 16, fontWeight: "700" },
  numberSelected: { color: colors.text },
  dot: { width: 5, height: 5, borderRadius: 3, marginTop: 6, backgroundColor: "transparent" },
  dotMet: { backgroundColor: colors.green },
  dotMissed: { backgroundColor: colors.orange },
});
