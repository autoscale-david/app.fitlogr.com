import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  END_DATE_QUICK_OPTIONS,
  PICK_A_DATE_LABEL,
  addCalendarDays,
  endDateAfterWeeks,
  formatFullDate,
  weekdayOf,
  type Weekday,
} from "@fitlogr/shared";
import { Sheet } from "./Sheet";
import { colors } from "../theme";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SUNDAY_FIRST: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const HEADER_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function shiftMonth(first: string, months: number): string {
  const year = Number(first.slice(0, 4));
  const month = Number(first.slice(5, 7)) - 1 + months;
  const nextYear = year + Math.floor(month / 12);
  const nextMonth = ((month % 12) + 12) % 12;
  return `${nextYear}-${String(nextMonth + 1).padStart(2, "0")}-01`;
}

function CalendarGrid({
  value,
  today,
  minDate,
  onSelect,
}: {
  value: string | null;
  today: string;
  minDate?: string;
  onSelect: (date: string) => void;
}) {
  const [month, setMonth] = useState(monthStart(value ?? minDate ?? today));
  useEffect(() => setMonth(monthStart(value ?? minDate ?? today)), [value, minDate, today]);

  const leading = SUNDAY_FIRST.indexOf(weekdayOf(month));
  const days: string[] = [];
  for (let date = month; date.slice(0, 7) === month.slice(0, 7); date = addCalendarDays(date, 1)) days.push(date);
  const cells: (string | null)[] = [...Array.from({ length: leading }, () => null), ...days];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = Array.from({ length: cells.length / 7 }, (_, index) => cells.slice(index * 7, index * 7 + 7));

  return (
    <View style={styles.calendar}>
      <View style={styles.monthRow}>
        <Pressable onPress={() => setMonth(shiftMonth(month, -1))} hitSlop={10} accessibilityLabel="Previous month">
          <Ionicons name="chevron-back" size={20} color={colors.muted} />
        </Pressable>
        <Text style={styles.monthTitle}>
          {MONTH_NAMES[Number(month.slice(5, 7)) - 1]} {month.slice(0, 4)}
        </Text>
        <Pressable onPress={() => setMonth(shiftMonth(month, 1))} hitSlop={10} accessibilityLabel="Next month">
          <Ionicons name="chevron-forward" size={20} color={colors.muted} />
        </Pressable>
      </View>
      <View style={styles.week}>
        {HEADER_LETTERS.map((letter, index) => (
          <Text key={`${letter}-${index}`} style={styles.headerLetter}>
            {letter}
          </Text>
        ))}
      </View>
      {weeks.map((week, row) => (
        <View key={row} style={styles.week}>
          {week.map((date, column) => {
            if (!date) return <View key={column} style={styles.cell} />;
            const disabled = minDate != null && date < minDate;
            const selected = date === value;
            return (
              <Pressable
                key={date}
                style={[styles.cell, selected && styles.cellSelected, date === today && !selected && styles.cellToday]}
                disabled={disabled}
                onPress={() => onSelect(date)}
                accessibilityRole="button"
                accessibilityLabel={formatFullDate(date)}
                accessibilityState={{ selected, disabled }}
              >
                <Text style={[styles.cellText, disabled && styles.cellDisabled, selected && styles.cellTextSelected]}>{Number(date.slice(8))}</Text>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

export function DatePickerSheet({
  visible,
  title,
  value,
  today,
  minDate,
  onClose,
  onSelect,
}: {
  visible: boolean;
  title: string;
  value: string;
  today: string;
  minDate?: string;
  onClose: () => void;
  onSelect: (date: string) => void;
}) {
  return (
    <Sheet visible={visible} title={title} onClose={onClose}>
      <CalendarGrid value={value} today={today} minDate={minDate} onSelect={onSelect} />
    </Sheet>
  );
}

/** Ends sheet: quick options count from the start date, or pick an inclusive end on/after the start. */
export function EndDateSheet({
  visible,
  startDate,
  endDate,
  today,
  onClose,
  onSelect,
}: {
  visible: boolean;
  startDate: string;
  endDate: string | null;
  today: string;
  onClose: () => void;
  onSelect: (date: string | null) => void;
}) {
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    if (visible) setPicking(false);
  }, [visible]);

  return (
    <Sheet visible={visible} title="Ends" onClose={onClose}>
      {picking ? (
        <CalendarGrid value={endDate} today={today} minDate={startDate} onSelect={onSelect} />
      ) : (
        <View style={styles.options}>
          {END_DATE_QUICK_OPTIONS.map((option) => {
            const date = option.weeks == null ? null : endDateAfterWeeks(startDate, option.weeks);
            const selected = date === endDate;
            return (
              <Pressable key={option.label} style={styles.option} onPress={() => onSelect(date)} accessibilityRole="button">
                <Text style={[styles.optionText, selected && styles.optionSelected]}>{option.label}</Text>
                <Text style={styles.optionDate}>{date ? formatFullDate(date) : ""}</Text>
              </Pressable>
            );
          })}
          <Pressable style={styles.option} onPress={() => setPicking(true)} accessibilityRole="button">
            <Text style={styles.optionText}>{PICK_A_DATE_LABEL}</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.muted} />
          </Pressable>
        </View>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  calendar: { marginTop: 8 },
  monthRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 8 },
  monthTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  week: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
  headerLetter: { width: 40, textAlign: "center", color: colors.faint, fontSize: 12, fontWeight: "600" },
  cell: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  cellSelected: { backgroundColor: colors.green },
  cellToday: { borderWidth: 1, borderColor: colors.faint },
  cellText: { color: colors.text, fontSize: 15, fontWeight: "600" },
  cellTextSelected: { color: "#062214", fontWeight: "800" },
  cellDisabled: { color: "#3A3E44" },
  options: { marginTop: 4 },
  option: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#2E3338",
  },
  optionText: { color: colors.text, fontSize: 16, fontWeight: "600" },
  optionSelected: { color: colors.green },
  optionDate: { color: colors.muted },
});
