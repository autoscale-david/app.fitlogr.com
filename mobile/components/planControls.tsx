import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";

/** Segmented control matching the Units (Imperial / Metric) picker. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.segment}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            style={[styles.segmentItem, active && styles.segmentActive]}
            onPress={() => onChange(option.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
          >
            <Text style={[styles.segmentText, active && styles.segmentTextActive]} numberOfLines={1}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function StepperButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      style={[styles.stepper, disabled && styles.disabled]}
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label === "-" ? "Decrease" : "Increase"}
    >
      <Text style={styles.stepperText}>{label}</Text>
    </Pressable>
  );
}

export function Chip({ label, active, onPress, disabled }: { label: string; active: boolean; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      style={[styles.chip, active && styles.chipActive]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

export const controlStyles = StyleSheet.create({
  input: {
    backgroundColor: "#222428",
    color: colors.text,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  primary: { marginTop: 18, backgroundColor: colors.green, borderRadius: 12, paddingVertical: 13, alignItems: "center" },
  primaryText: { color: "#062214", fontWeight: "800", fontSize: 16 },
  label: { color: colors.muted },
  helper: { color: colors.muted, marginTop: 6, lineHeight: 20 },
});

const styles = StyleSheet.create({
  segment: { flexDirection: "row", gap: 8, marginTop: 12 },
  segmentItem: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 4,
    alignItems: "center",
    backgroundColor: "#222428",
  },
  segmentActive: { backgroundColor: "#163524" },
  segmentText: { color: colors.muted, fontWeight: "700" },
  segmentTextActive: { color: colors.green },
  stepper: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "#222428",
    alignItems: "center",
    justifyContent: "center",
  },
  stepperText: { color: colors.text, fontSize: 22, fontWeight: "700", lineHeight: 24 },
  disabled: { opacity: 0.4 },
  chip: {
    minWidth: 40,
    height: 40,
    paddingHorizontal: 12,
    borderRadius: 20,
    backgroundColor: "#222428",
    alignItems: "center",
    justifyContent: "center",
  },
  chipActive: { backgroundColor: "#163524", borderWidth: 1, borderColor: colors.green },
  chipText: { color: colors.muted, fontWeight: "700" },
  chipTextActive: { color: colors.green },
});
