import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Crypto from "expo-crypto";
import type { MealRecord } from "../../services/db";
import { atLocalTime, localDateISO } from "../../services/dates";
import { randomUuid } from "../../services/encoding";
import { useStore } from "../../services/store";
import { colors } from "../../theme";

export default function MealScreen() {
  const insets = useSafeAreaInsets();
  const store = useStore();
  const params = useLocalSearchParams<{ id: string; date?: string }>();
  const creating = params.id === "new";
  const [name, setName] = useState("");
  const [calories, setCalories] = useState("0");
  const [protein, setProtein] = useState("0");
  const [carbs, setCarbs] = useState("0");
  const [fat, setFat] = useState("0");
  const [pendingCreate, setPendingCreate] = useState(creating);
  const [ready, setReady] = useState(creating);
  const [localDate, setLocalDate] = useState(params.date || localDateISO());
  const [eatenAt, setEatenAt] = useState<string | null>(null);

  useEffect(() => {
    if (creating || !params.id) return;
    let cancelled = false;
    void store.readMeal(params.id).then((meal) => {
      if (cancelled || !meal) return;
      setName(meal.name);
      setCalories(String(meal.caloriesKcal));
      setProtein(String(meal.proteinG));
      setCarbs(String(meal.carbsG));
      setFat(String(meal.fatG));
      setPendingCreate(meal.pendingCreate);
      setLocalDate(meal.localDate);
      setEatenAt(meal.eatenAt);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
    // Load once. `store` changes identity as sync state updates and must not reset the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creating, params.id]);

  async function save() {
    const meal: MealRecord = {
      id: creating ? randomUuid(await Crypto.getRandomBytesAsync(16)) : params.id,
      localDate,
      name: name.trim() || "Meal",
      eatenAt: eatenAt ?? atLocalTime(localDate, new Date().getHours(), new Date().getMinutes()),
      caloriesKcal: numberValue(calories),
      proteinG: numberValue(protein),
      carbsG: numberValue(carbs),
      fatG: numberValue(fat),
      badge: "edited",
    };
    await store.saveMeal(meal, pendingCreate || creating);
    router.back();
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ paddingTop: insets.top + 12, paddingHorizontal: 16, paddingBottom: 32 }}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ presentation: "modal", headerShown: false }} />
      <Text style={styles.title}>{creating ? "Add meal" : "Edit meal"}</Text>
      {!ready ? null : (
        <>
          <Field label="Name" value={name} onChange={setName} keyboard="default" />
          <Field label="Calories" value={calories} onChange={setCalories} />
          <Field label="Protein (g)" value={protein} onChange={setProtein} />
          <Field label="Carbs (g)" value={carbs} onChange={setCarbs} />
          <Field label="Fat (g)" value={fat} onChange={setFat} />
          <Pressable style={styles.button} onPress={() => void save()}>
            <Text style={styles.buttonText}>Save</Text>
          </Pressable>
          {creating ? null : (
            <Pressable
              style={styles.delete}
              onPress={() => {
                Alert.alert("Delete meal", "Remove this meal from the day?", [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Delete",
                    style: "destructive",
                    onPress: () => {
                      void store.deleteMeal(params.id, pendingCreate).then(() => router.back());
                    },
                  },
                ]);
              }}
            >
              <Text style={styles.deleteText}>Delete meal</Text>
            </Pressable>
          )}
        </>
      )}
      <Pressable onPress={() => router.back()} style={styles.cancel}>
        <Text style={styles.cancelText}>Close</Text>
      </Pressable>
    </ScrollView>
  );
}

function Field({
  label,
  value,
  onChange,
  keyboard = "number-pad",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  keyboard?: "default" | "number-pad";
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput value={value} onChangeText={onChange} keyboardType={keyboard} style={styles.input} placeholderTextColor={colors.faint} />
    </View>
  );
}

function numberValue(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  title: { color: colors.text, fontSize: 28, fontWeight: "800" },
  field: { marginTop: 14 },
  label: { color: colors.muted, marginBottom: 6 },
  input: {
    backgroundColor: "#222428",
    color: colors.text,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  button: { marginTop: 20, backgroundColor: colors.green, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  buttonText: { color: "#062214", fontWeight: "800" },
  delete: { marginTop: 12, alignItems: "center", paddingVertical: 12 },
  deleteText: { color: colors.fat, fontWeight: "700" },
  cancel: { marginTop: 8, alignItems: "center", paddingVertical: 12 },
  cancelText: { color: colors.muted, fontWeight: "700" },
});
