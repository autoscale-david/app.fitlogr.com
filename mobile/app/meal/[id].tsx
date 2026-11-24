import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Crypto from "expo-crypto";
import { round1 } from "@fitlogr/shared";
import { MealPhoto } from "../../components/MealPhoto";
import type { MealItemRecord, MealRecord } from "../../services/db";
import { atLocalTime, localDateISO } from "../../services/dates";
import { randomUuid } from "../../services/encoding";
import { useStore } from "../../services/store";
import { colors } from "../../theme";

interface ItemDraft {
  id: string;
  name: string;
  quantity: string;
  unit: string;
  estimatedGrams: number | null;
  calories: string;
  protein: string;
  carbs: string;
  fat: string;
  isUserEdited: boolean;
}

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
  const [items, setItems] = useState<ItemDraft[]>([]);
  const [photoId, setPhotoId] = useState<string | null>(null);
  const [aiMeal, setAiMeal] = useState(false);
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
      setItems((meal.items ?? []).map(toDraft));
      setPhotoId(meal.photoId ?? null);
      setAiMeal(meal.badge === "ai");
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

  const itemTotals = items.reduce(
    (sum, item) => ({
      calories: sum.calories + numberValue(item.calories, 1),
      protein: sum.protein + numberValue(item.protein, 1),
      carbs: sum.carbs + numberValue(item.carbs, 1),
      fat: sum.fat + numberValue(item.fat, 1),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );

  function editItem(id: string, patch: Partial<ItemDraft>) {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch, isUserEdited: true } : item)));
  }

  async function save() {
    const mealItems: MealItemRecord[] | undefined =
      items.length > 0
        ? items.map((item) => ({
            id: item.id,
            name: item.name.trim() || "Food",
            quantity: Math.max(numberValue(item.quantity, 2), 0.01),
            unit: item.unit.trim() || "serving",
            estimatedGrams: item.estimatedGrams,
            caloriesKcal: numberValue(item.calories, 1),
            proteinG: numberValue(item.protein, 1),
            carbsG: numberValue(item.carbs, 1),
            fatG: numberValue(item.fat, 1),
            isUserEdited: true,
          }))
        : undefined;
    const meal: MealRecord = {
      id: creating ? randomUuid(await Crypto.getRandomBytesAsync(16)) : params.id,
      localDate,
      name: name.trim() || "Meal",
      eatenAt: eatenAt ?? atLocalTime(localDate, new Date().getHours(), new Date().getMinutes()),
      caloriesKcal: mealItems ? round1(itemTotals.calories) : numberValue(calories),
      proteinG: mealItems ? round1(itemTotals.protein) : numberValue(protein, 1),
      carbsG: mealItems ? round1(itemTotals.carbs) : numberValue(carbs, 1),
      fatG: mealItems ? round1(itemTotals.fat) : numberValue(fat, 1),
      badge: "edited",
      photoId,
      items: mealItems,
    };
    await store.saveMeal(meal, pendingCreate || creating);
    router.back();
  }

  function remove() {
    const excluding = Boolean(photoId);
    Alert.alert(
      excluding ? "Not a meal" : "Delete meal",
      excluding ? "Exclude this photo so it is never imported again?" : "Remove this meal from the day?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: excluding ? "Exclude" : "Delete",
          style: "destructive",
          onPress: () => {
            void store.deleteMeal(params.id, pendingCreate, photoId).then(() => router.back());
          },
        },
      ],
    );
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
          {photoId ? <View style={styles.photo}><MealPhoto photoId={photoId} size={220} radius={18} detailed /></View> : null}
          <Field label="Name" value={name} onChange={setName} keyboard="default" />
          {items.length > 0 ? (
            <>
              <Text style={styles.section}>Foods</Text>
              {items.map((item) => (
                <View key={item.id} style={styles.item}>
                  <Text style={styles.estimate}>{item.isUserEdited ? "Edited" : aiMeal ? "AI estimate" : "Estimate"}</Text>
                  <Field label="Item" value={item.name} onChange={(value) => editItem(item.id, { name: value })} keyboard="default" />
                  <Field label="Calories" value={item.calories} onChange={(value) => editItem(item.id, { calories: value })} />
                  <Field label="Protein (g)" value={item.protein} onChange={(value) => editItem(item.id, { protein: value })} />
                  <Field label="Carbs (g)" value={item.carbs} onChange={(value) => editItem(item.id, { carbs: value })} />
                  <Field label="Fat (g)" value={item.fat} onChange={(value) => editItem(item.id, { fat: value })} />
                </View>
              ))}
              <Text style={styles.totals}>
                {round1(itemTotals.calories)} kcal · {round1(itemTotals.protein)}p · {round1(itemTotals.carbs)}c · {round1(itemTotals.fat)}f
              </Text>
            </>
          ) : (
            <>
              <Field label="Calories" value={calories} onChange={setCalories} />
              <Field label="Protein (g)" value={protein} onChange={setProtein} />
              <Field label="Carbs (g)" value={carbs} onChange={setCarbs} />
              <Field label="Fat (g)" value={fat} onChange={setFat} />
            </>
          )}
          <Pressable style={styles.button} onPress={() => void save()}>
            <Text style={styles.buttonText}>Save</Text>
          </Pressable>
          {creating ? null : (
            <Pressable style={styles.delete} onPress={remove}>
              <Text style={styles.deleteText}>{photoId ? "Exclude / Not a meal" : "Delete meal"}</Text>
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

function toDraft(item: MealItemRecord): ItemDraft {
  return {
    id: item.id,
    name: item.name,
    quantity: String(item.quantity),
    unit: item.unit,
    estimatedGrams: item.estimatedGrams,
    calories: String(item.caloriesKcal),
    protein: String(item.proteinG),
    carbs: String(item.carbsG),
    fat: String(item.fatG),
    isUserEdited: item.isUserEdited,
  };
}

function Field({
  label,
  value,
  onChange,
  keyboard = "decimal-pad",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  keyboard?: "default" | "decimal-pad";
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput value={value} onChangeText={onChange} keyboardType={keyboard} style={styles.input} placeholderTextColor={colors.faint} />
    </View>
  );
}

function numberValue(value: string, decimals = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  const factor = 10 ** decimals;
  return Math.round(parsed * factor) / factor;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  title: { color: colors.text, fontSize: 28, fontWeight: "800" },
  photo: { marginTop: 16, alignItems: "flex-start" },
  section: { color: colors.muted, marginTop: 18, fontWeight: "700", letterSpacing: 0.4 },
  item: { marginTop: 8, backgroundColor: colors.card, borderRadius: 16, padding: 12 },
  estimate: { color: colors.green, fontSize: 12, fontWeight: "800" },
  totals: { color: colors.text, marginTop: 12, fontWeight: "700" },
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
