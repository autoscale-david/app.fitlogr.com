import { useEffect, useState } from "react";
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Goals } from "../../services/db";
import { useStore } from "../../services/store";
import { colors } from "../../theme";

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const store = useStore();
  const [draft, setDraft] = useState<Goals | null>(store.goals);

  useEffect(() => {
    setDraft(store.goals);
  }, [store.goals, store.refreshToken]);

  if (!draft) {
    return <View style={styles.screen} />;
  }

  function save(next: Goals) {
    setDraft(next);
    void store.saveGoals(next);
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ paddingTop: insets.top + 12, paddingHorizontal: 16, paddingBottom: 40 }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>Settings</Text>
      <Image source={require("../../assets/logo.png")} style={styles.logo} resizeMode="contain" />

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Account</Text>
        <Text style={styles.body}>Not connected. Google sign-in is the next stage, after this screen is comfortable in Expo Go.</Text>
        <Pressable
          style={styles.button}
          onPress={() =>
            Alert.alert(
              "Google sign-in",
              "Sign-in will connect this phone to fitlogr.com and Google Photos. The Log screen already works offline.",
            )
          }
        >
          <Text style={styles.buttonText}>Continue with Google</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Units</Text>
        <View style={styles.segment}>
          <Segment label="Imperial" active={draft.unitSystem === "imperial"} onPress={() => save({ ...draft, unitSystem: "imperial" })} />
          <Segment label="Metric" active={draft.unitSystem === "metric"} onPress={() => save({ ...draft, unitSystem: "metric" })} />
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Daily targets</Text>
        <NumberField label="Base calories" value={draft.baseKcal} onChange={(baseKcal) => save({ ...draft, baseKcal })} />
        <NumberField label="Protein (g)" value={draft.proteinTarget} onChange={(proteinTarget) => save({ ...draft, proteinTarget })} />
        <NumberField label="Carbs (g)" value={draft.carbsTarget} onChange={(carbsTarget) => save({ ...draft, carbsTarget })} />
        <NumberField label="Fat (g)" value={draft.fatTarget} onChange={(fatTarget) => save({ ...draft, fatTarget })} />
      </View>

      <Pressable
        style={styles.secondary}
        onPress={() => {
          void store.restoreSample();
        }}
      >
        <Text style={styles.secondaryText}>Restore sample day</Text>
      </Pressable>
      <Text style={styles.version}>fitlogr 0.1.0 · local preview</Text>
    </ScrollView>
  );
}

function Segment({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable style={[styles.segmentItem, active && styles.segmentActive]} onPress={onPress}>
      <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{label}</Text>
    </Pressable>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={text}
        keyboardType="number-pad"
        onChangeText={setText}
        onEndEditing={() => {
          const parsed = Number(text);
          if (Number.isFinite(parsed) && parsed >= 0) onChange(Math.round(parsed));
          else setText(String(value));
        }}
        style={styles.input}
        placeholderTextColor={colors.faint}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  title: { color: colors.text, fontSize: 34, fontWeight: "800", letterSpacing: -0.6 },
  logo: { width: 220, height: 64, marginTop: 8, marginLeft: -8 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 18,
    padding: 16,
    marginTop: 14,
  },
  cardTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  body: { color: colors.muted, marginTop: 6, lineHeight: 20 },
  button: {
    marginTop: 14,
    backgroundColor: colors.green,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  buttonText: { color: "#062214", fontWeight: "800" },
  segment: { flexDirection: "row", gap: 8, marginTop: 12 },
  segmentItem: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: "center",
    backgroundColor: "#222428",
  },
  segmentActive: { backgroundColor: "#163524" },
  segmentText: { color: colors.muted, fontWeight: "700" },
  segmentTextActive: { color: colors.green },
  field: { marginTop: 12 },
  fieldLabel: { color: colors.muted, marginBottom: 6 },
  input: {
    backgroundColor: "#222428",
    color: colors.text,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  secondary: {
    marginTop: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#2E3338",
    paddingVertical: 12,
    alignItems: "center",
  },
  secondaryText: { color: colors.text, fontWeight: "700" },
  version: { color: colors.faint, textAlign: "center", marginTop: 16 },
});
