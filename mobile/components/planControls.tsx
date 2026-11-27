import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { colors } from "../theme";

/** Segmented control matching the Units (Imperial / Metric) picker. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  style,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.segment, style]}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            style={[styles.segmentItem, { flexGrow: Math.max(option.label.length, 8) }, active && styles.segmentActive]}
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
      <Text style={styles.stepperText}>{label === "-" ? "\u2212" : label}</Text>
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
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 15,
  },
  primary: { marginTop: 14, backgroundColor: colors.green, borderRadius: 10, paddingVertical: 10, alignItems: "center" },
  primaryText: { color: "#062214", fontWeight: "800", fontSize: 15 },
  label: { color: colors.muted },
  helper: { color: colors.muted, marginTop: 4, lineHeight: 17, fontSize: 13 },
});

const styles = StyleSheet.create({
  segment: { flexDirection: "row", gap: 6, marginTop: 8 },
  segmentItem: {
    flexBasis: 0,
    borderRadius: 10,
    paddingVertical: 7,
    paddingHorizontal: 4,
    alignItems: "center",
    backgroundColor: "#222428",
  },
  segmentActive: { backgroundColor: "#163524" },
  segmentText: { color: colors.muted, fontWeight: "700", fontSize: 14 },
  segmentTextActive: { color: colors.green },
  stepper: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: "#222428",
    alignItems: "center",
    justifyContent: "center",
  },
  stepperText: { color: colors.text, fontSize: 20, fontWeight: "700", lineHeight: 22 },
  disabled: { opacity: 0.4 },
  chip: {
    minWidth: 34,
    height: 34,
    paddingHorizontal: 10,
    borderRadius: 17,
    backgroundColor: "#222428",
    alignItems: "center",
    justifyContent: "center",
  },
  chipActive: { backgroundColor: "#163524", borderWidth: 1, borderColor: colors.green },
  chipText: { color: colors.muted, fontWeight: "700", fontSize: 14 },
  chipTextActive: { color: colors.green },
});
