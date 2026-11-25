import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { formatHeading, localDateISO } from "../services/dates";
import { useStore } from "../services/store";
import { colors, LB_PER_KG } from "../theme";

export default function WeightScreen() {
  const insets = useSafeAreaInsets();
  const store = useStore();
  const params = useLocalSearchParams<{ date?: string }>();
  const date = params.date || localDateISO();
  const metric = store.goals?.unitSystem === "metric";
  const unit = metric ? "kg" : "lb";
  const [value, setValue] = useState("");
  const [current, setCurrent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!store.ready) return;
    let cancelled = false;
    void store.loadDay(date).then((day) => {
      if (cancelled || day.weightKg == null) return;
      setCurrent((metric ? day.weightKg : day.weightKg * LB_PER_KG).toFixed(1));
    });
    return () => {
      cancelled = true;
    };
    // Load once per date; `store` changes identity on every sync tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, metric, store.ready]);

  const parsed = Number(value.replace(",", "."));
  const valid = value.trim() !== "" && Number.isFinite(parsed) && parsed > 0 && parsed < (metric ? 400 : 900);

  function save() {
    if (!valid || saving) return;
    setSaving(true);
    const weightKg = metric ? parsed : parsed / LB_PER_KG;
    void store.logWeight(date, weightKg).then(() => router.back());
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 12 }]}>
      <Stack.Screen options={{ presentation: "modal", headerShown: false }} />
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>Log weight</Text>
          <Text style={styles.body}>{formatHeading(date)}</Text>
        </View>
        <Pressable onPress={() => router.back()} hitSlop={10} accessibilityRole="button">
          <Text style={styles.cancelText}>Close</Text>
        </Pressable>
      </View>
      <View style={styles.inputRow}>
        <TextInput
          value={value}
          onChangeText={setValue}
          keyboardType="decimal-pad"
          placeholder={current ?? "0.0"}
          placeholderTextColor={colors.faint}
          style={styles.input}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={save}
          accessibilityLabel={`Weight in ${unit}`}
        />
        <Text style={styles.unit}>{unit}</Text>
      </View>
      <Pressable
        style={[styles.button, !valid && styles.buttonDisabled]}
        onPress={save}
        disabled={!valid || saving}
        accessibilityRole="button"
        accessibilityState={{ disabled: !valid }}
      >
        <Text style={styles.buttonText}>{saving ? "Saving…" : "Save"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 16 },
  header: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
  headerText: { flex: 1 },
  title: { color: colors.text, fontSize: 28, fontWeight: "800" },
  body: { color: colors.muted, marginTop: 2, fontSize: 14 },
  inputRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 18 },
  input: {
    flex: 1,
    minWidth: 0,
    backgroundColor: "#222428",
    color: colors.text,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 22,
    fontWeight: "700",
  },
  unit: { color: colors.muted, fontSize: 18, fontWeight: "700", width: 28 },
  button: { marginTop: 16, backgroundColor: colors.green, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { color: "#062214", fontWeight: "800" },
  cancelText: { color: colors.green, fontWeight: "700", fontSize: 16, paddingTop: 8 },
});
