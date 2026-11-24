import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { localDateISO } from "../services/dates";
import { useStore } from "../services/store";
import { colors, LB_PER_KG } from "../theme";

export default function WeightScreen() {
  const insets = useSafeAreaInsets();
  const store = useStore();
  const params = useLocalSearchParams<{ date?: string }>();
  const date = params.date || localDateISO();
  const metric = store.goals?.unitSystem === "metric";
  const [value, setValue] = useState("");

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 12 }]}>
      <Stack.Screen options={{ presentation: "modal", headerShown: false }} />
      <Text style={styles.title}>Log weight</Text>
      <Text style={styles.body}>{date}</Text>
      <TextInput
        value={value}
        onChangeText={setValue}
        keyboardType="decimal-pad"
        placeholder={metric ? "kg" : "lb"}
        placeholderTextColor={colors.faint}
        style={styles.input}
      />
      <Pressable
        style={styles.button}
        onPress={() => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed <= 0) return;
          const weightKg = metric ? parsed : parsed / LB_PER_KG;
          void store.logWeight(date, weightKg).then(() => router.back());
        }}
      >
        <Text style={styles.buttonText}>Save</Text>
      </Pressable>
      <Pressable onPress={() => router.back()} style={styles.cancel}>
        <Text style={styles.cancelText}>Close</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 16 },
  title: { color: colors.text, fontSize: 28, fontWeight: "800" },
  body: { color: colors.muted, marginTop: 6 },
  input: {
    marginTop: 16,
    backgroundColor: "#222428",
    color: colors.text,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 20,
  },
  button: { marginTop: 16, backgroundColor: colors.green, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  buttonText: { color: "#062214", fontWeight: "800" },
  cancel: { marginTop: 12, alignItems: "center", paddingVertical: 12 },
  cancelText: { color: colors.muted, fontWeight: "700" },
});
