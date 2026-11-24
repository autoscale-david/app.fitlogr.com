import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { PickerScopeRequired, type HistoryProgress } from "../services/photos";
import { importFromGooglePhotos } from "../services/photos/picker";
import { AuthCancelled, useStore } from "../services/store";
import { colors } from "../theme";

const PRESETS = [7, 14, 30, 60, 90];

export function ImportHistoryCard({ signedIn }: { signedIn: boolean }) {
  const store = useStore();
  const [days, setDays] = useState(30);
  const [custom, setCustom] = useState("30");
  const [busy, setBusy] = useState<"photos" | "health" | "both" | "picker" | null>(null);
  const [progress, setProgress] = useState<HistoryProgress | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [cancel, setCancel] = useState<AbortController | null>(null);

  function choose(next: number) {
    const clamped = Math.min(180, Math.max(1, next));
    setDays(clamped);
    setCustom(String(clamped));
  }

  async function runPhotos(controller: AbortController) {
    const result = await store.scanHistory(days, setProgress, controller.signal);
    return result.message;
  }

  async function runHealth() {
    return store.importHealthHistory(days);
  }

  async function start(kind: "photos" | "health" | "both") {
    if (!signedIn) {
      setNote("Sign in with Google before importing history.");
      return;
    }
    const controller = new AbortController();
    setCancel(controller);
    setBusy(kind);
    setProgress({ scanned: 0, skipped: 0, meals: 0, nonMeals: 0, errors: 0 });
    try {
      const messages: string[] = [];
      if (kind !== "health") messages.push(await runPhotos(controller));
      if (kind !== "photos" && !controller.signal.aborted) messages.push(await runHealth());
      setNote(messages.filter(Boolean).join(" "));
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setBusy(null);
      setCancel(null);
    }
  }

  async function pickGoogle() {
    if (!signedIn) {
      setNote("Sign in with Google before picking photos.");
      return;
    }
    setBusy("picker");
    try {
      const summary = await importFromGooglePhotos();
      setNote(
        summary.total_picked === 0
          ? "No Google Photos were selected."
          : `Imported ${summary.meals_imported} meals from Google Photos. Skipped ${summary.non_meals_skipped} non-meals and ${summary.duplicates_skipped} duplicates.`,
      );
    } catch (error) {
      if (error instanceof PickerScopeRequired) {
        Alert.alert("Google Photos", "Allow fitlogr to open the Google Photos picker, then try again.", [
          { text: "Cancel", style: "cancel" },
          {
            text: "Reconnect Google",
            onPress: () => {
              void store.grantPickerAccess().catch((reconnectError: unknown) => {
                if (reconnectError instanceof AuthCancelled) return;
                setNote(reconnectError instanceof Error ? reconnectError.message : "Reconnect failed.");
              });
            },
          },
        ]);
      } else setNote(error instanceof Error ? error.message : "Google Photos import failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Import history</Text>
      <Text style={styles.body}>Look back a set number of days for meal photos and Apple Health. Meals stay on the day the photo was taken.</Text>
      <View style={styles.segment}>
        {PRESETS.map((preset) => (
          <Pressable key={preset} style={[styles.preset, days === preset && styles.presetOn]} onPress={() => choose(preset)}>
            <Text style={[styles.presetText, days === preset && styles.presetTextOn]}>{preset}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        value={custom}
        keyboardType="number-pad"
        onChangeText={setCustom}
        onEndEditing={() => choose(Number(custom) || days)}
        style={styles.input}
        placeholder="1–180 days"
        placeholderTextColor={colors.faint}
      />
      {progress && busy ? (
        <Text style={styles.body}>
          Scanned {progress.scanned}. Skipped {progress.skipped}. Meals {progress.meals}. Non-food {progress.nonMeals}. Errors {progress.errors}.
        </Text>
      ) : null}
      {note ? <Text style={styles.body}>{note}</Text> : null}
      <Pressable style={styles.button} disabled={busy !== null} onPress={() => void start("photos")}>
        {busy === "photos" ? <ActivityIndicator color="#062214" /> : <Text style={styles.buttonText}>Import photos (past {days} days)</Text>}
      </Pressable>
      <Pressable style={styles.secondary} disabled={busy !== null} onPress={() => void start("health")}>
        {busy === "health" ? <ActivityIndicator color={colors.text} /> : <Text style={styles.secondaryText}>Import Apple Health (past {days} days)</Text>}
      </Pressable>
      <Pressable style={styles.secondary} disabled={busy !== null} onPress={() => void start("both")}>
        {busy === "both" ? <ActivityIndicator color={colors.text} /> : <Text style={styles.secondaryText}>Import photos + Apple Health</Text>}
      </Pressable>
      <Pressable style={styles.secondary} disabled={busy !== null} onPress={() => void pickGoogle()}>
        {busy === "picker" ? <ActivityIndicator color={colors.text} /> : <Text style={styles.secondaryText}>Pick from Google Photos</Text>}
      </Pressable>
      {cancel ? (
        <Pressable style={styles.secondary} onPress={() => cancel.abort()}>
          <Text style={styles.secondaryText}>Cancel</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: 18, padding: 16, marginTop: 14 },
  title: { color: colors.text, fontSize: 17, fontWeight: "700" },
  body: { color: colors.muted, marginTop: 6, lineHeight: 20 },
  segment: { flexDirection: "row", gap: 8, marginTop: 12 },
  preset: { flex: 1, borderRadius: 12, paddingVertical: 10, alignItems: "center", backgroundColor: "#222428" },
  presetOn: { backgroundColor: "#163524" },
  presetText: { color: colors.muted, fontWeight: "700" },
  presetTextOn: { color: colors.green },
  input: { marginTop: 12, backgroundColor: "#222428", color: colors.text, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  button: { marginTop: 14, backgroundColor: colors.green, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  buttonText: { color: "#062214", fontWeight: "800" },
  secondary: { marginTop: 10, borderRadius: 12, borderWidth: 1, borderColor: "#2E3338", paddingVertical: 12, alignItems: "center" },
  secondaryText: { color: colors.text, fontWeight: "700" },
});
