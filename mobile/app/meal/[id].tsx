import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Crypto from "expo-crypto";
import { round1 } from "@fitlogr/shared";
import { MealPhoto } from "../../components/MealPhoto";
import type { MealItemRecord, MealRecord } from "../../services/db";
import { atLocalTime, formatHeading, localDateISO } from "../../services/dates";
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
  const [calories, setCalories] = useState("");
  const [protein, setProtein] = useState("");
  const [carbs, setCarbs] = useState("");
  const [fat, setFat] = useState("");
  const [saving, setSaving] = useState(false);
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

  const canSave = !saving && (items.length > 0 || name.trim() !== "" || numberValue(calories) > 0);

  async function save() {
    if (!canSave) return;
    setSaving(true);
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
    try {
      await store.saveMeal(meal, pendingCreate || creating);
      router.back();
    } catch (error) {
      setSaving(false);
      Alert.alert("Meal not saved", error instanceof Error ? error.message : "Try again.");
    }
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
      keyboardDismissMode="on-drag"
    >
      <Stack.Screen options={{ presentation: "modal", headerShown: false }} />
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>{creating ? "Add meal" : "Edit meal"}</Text>
          <Text style={styles.date}>{formatHeading(localDate)}</Text>
        </View>
        <Pressable onPress={() => router.back()} hitSlop={10} accessibilityRole="button">
          <Text style={styles.cancelText}>Close</Text>
        </Pressable>
      </View>
      {!ready ? null : (
        <>
          {photoId ? <View style={styles.photo}><MealPhoto photoId={photoId} size={220} radius={18} detailed /></View> : null}
          <Field label="Name" value={name} onChange={setName} keyboard="default" placeholder="e.g. Chicken salad" />
          {items.length > 0 ? (
            <>
              <Text style={styles.section}>Foods</Text>
              {items.map((item) => (
                <View key={item.id} style={styles.item}>
                  <Text style={styles.estimate}>{item.isUserEdited ? "Edited" : aiMeal ? "AI estimate" : "Estimate"}</Text>
                  <Field label="Item" value={item.name} onChange={(value) => editItem(item.id, { name: value })} keyboard="default" />
                  <Field label="Calories (kcal)" value={item.calories} onChange={(value) => editItem(item.id, { calories: value })} />
                  <MacroFields
                    protein={item.protein}
                    carbs={item.carbs}
                    fat={item.fat}
                    onChange={(patch) => editItem(item.id, patch)}
                  />
                </View>
              ))}
              <Text style={styles.totals}>
                {round1(itemTotals.calories)} kcal · {round1(itemTotals.protein)}g protein · {round1(itemTotals.carbs)}g carbs · {round1(itemTotals.fat)}g fat
              </Text>
            </>
          ) : (
            <>
              <Field label="Calories (kcal)" value={calories} onChange={setCalories} placeholder="0" />
              <MacroFields
                protein={protein}
                carbs={carbs}
                fat={fat}
                onChange={(patch) => {
                  if (patch.protein !== undefined) setProtein(patch.protein);
                  if (patch.carbs !== undefined) setCarbs(patch.carbs);
                  if (patch.fat !== undefined) setFat(patch.fat);
                }}
              />
            </>
          )}
          <Pressable
            style={[styles.button, !canSave && styles.buttonDisabled]}
            onPress={() => void save()}
            disabled={!canSave}
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSave }}
          >
            <Text style={styles.buttonText}>{saving ? "Saving…" : "Save"}</Text>
          </Pressable>
          {creating ? (
            !canSave && !saving ? <Text style={styles.hint}>Enter a name or calories to save.</Text> : null
          ) : (
            <Pressable style={styles.delete} onPress={remove} accessibilityRole="button">
              <Text style={styles.deleteText}>{photoId ? "Not a meal" : "Delete meal"}</Text>
            </Pressable>
          )}
        </>
      )}
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
  placeholder,
  style,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  keyboard?: "default" | "decimal-pad";
  placeholder?: string;
  style?: object;
}) {
  return (
    <View style={[styles.field, style]}>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        keyboardType={keyboard}
        placeholder={placeholder}
        style={styles.input}
        placeholderTextColor={colors.faint}
        accessibilityLabel={label}
      />
    </View>
  );
}

function MacroFields({
  protein,
  carbs,
  fat,
  onChange,
}: {
  protein: string;
  carbs: string;
  fat: string;
  onChange: (patch: { protein?: string; carbs?: string; fat?: string }) => void;
}) {
  return (
    <View style={styles.macroRow}>
      <Field label="Protein (g)" value={protein} onChange={(value) => onChange({ protein: value })} placeholder="0" style={styles.macroField} />
      <Field label="Carbs (g)" value={carbs} onChange={(value) => onChange({ carbs: value })} placeholder="0" style={styles.macroField} />
      <Field label="Fat (g)" value={fat} onChange={(value) => onChange({ fat: value })} placeholder="0" style={styles.macroField} />
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
  header: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
  headerText: { flex: 1 },
  title: { color: colors.text, fontSize: 28, fontWeight: "800" },
  date: { color: colors.muted, marginTop: 2, fontSize: 14 },
  macroRow: { flexDirection: "row", gap: 8 },
  macroField: { flex: 1 },
  buttonDisabled: { opacity: 0.45 },
  hint: { color: colors.muted, textAlign: "center", marginTop: 10, fontSize: 13 },
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
  cancelText: { color: colors.green, fontWeight: "700", fontSize: 16, paddingTop: 8 },
});
