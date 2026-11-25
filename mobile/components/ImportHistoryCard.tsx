import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { PickerScopeRequired, type HistoryProgress } from "../services/photos";
import { importFromGooglePhotos } from "../services/photos/picker";
import { AuthCancelled, useStore } from "../services/store";
import { router } from "expo-router";
import { isExpoGo } from "../services/expoGo";
import { ui } from "./settingsUi";
import { colors } from "../theme";

const PRESETS = [7, 14, 30, 60, 90];

export function ImportHistoryCard({ signedIn }: { signedIn: boolean }) {
  const store = useStore();
  const [days, setDays] = useState(30);
  const [custom, setCustom] = useState("");
  const expoGo = isExpoGo();
  const [busy, setBusy] = useState<"photos" | "health" | "both" | "picker" | null>(null);
  const [progress, setProgress] = useState<HistoryProgress | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [cancel, setCancel] = useState<AbortController | null>(null);

  function choose(next: number) {
    const clamped = Math.min(180, Math.max(1, Math.round(next)));
    setDays(clamped);
    setCustom(PRESETS.includes(clamped) ? "" : String(clamped));
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
    <View style={ui.card}>
      <Text style={ui.cardTitle}>Import history</Text>
      <Text style={ui.body}>
        {expoGo
          ? "Pick past meal photos from Google Photos. Meals stay on the day the photo was taken."
          : "Look back a set number of days for meal photos and Apple Health. Meals stay on the day the photo was taken."}
      </Text>
      {!signedIn ? (
        <>
          <Text style={ui.body}>Sign in with Google to import your history.</Text>
          <Pressable style={ui.primary} onPress={() => router.push("/settings/account")} accessibilityRole="button">
            <Text style={ui.primaryText}>Sign in</Text>
          </Pressable>
        </>
      ) : (
        <>
          {expoGo ? null : (
            <>
              <View style={styles.segment}>
                {PRESETS.map((preset) => (
                  <Pressable
                    key={preset}
                    style={[styles.preset, days === preset && styles.presetOn]}
                    onPress={() => choose(preset)}
                    accessibilityRole="button"
                    accessibilityLabel={`${preset} days`}
                    accessibilityState={{ selected: days === preset }}
                  >
                    <Text style={[styles.presetText, days === preset && styles.presetTextOn]}>{preset}</Text>
                  </Pressable>
                ))}
                <TextInput
                  value={custom}
                  keyboardType="number-pad"
                  onChangeText={setCustom}
                  onEndEditing={() => {
                    if (custom.trim() !== "") choose(Number(custom) || days);
                  }}
                  style={[ui.input, styles.custom, !PRESETS.includes(days) && styles.customOn]}
                  placeholder="Days"
                  placeholderTextColor={colors.faint}
                  accessibilityLabel="Other number of days, 1 to 180"
                />
              </View>
              <Text style={ui.meta}>Past {days} days</Text>
            </>
          )}
          {progress && busy ? (
            <Text style={ui.body}>
              Scanned {progress.scanned}. Skipped {progress.skipped}. Meals {progress.meals}. Non-food {progress.nonMeals}. Errors {progress.errors}.
            </Text>
          ) : null}
          {note ? <Text style={ui.body}>{note}</Text> : null}
          {expoGo ? null : (
            <>
              <Pressable style={ui.primary} disabled={busy !== null} onPress={() => void start("both")} accessibilityRole="button">
                {busy === "both" ? <ActivityIndicator color="#062214" /> : <Text style={ui.primaryText}>Import photos + Apple Health</Text>}
              </Pressable>
              <View style={styles.pair}>
                <Pressable style={[ui.secondary, styles.pairButton]} disabled={busy !== null} onPress={() => void start("photos")} accessibilityRole="button">
                  {busy === "photos" ? <ActivityIndicator color={colors.text} /> : <Text style={ui.secondaryText}>Photos only</Text>}
                </Pressable>
                <Pressable style={[ui.secondary, styles.pairButton]} disabled={busy !== null} onPress={() => void start("health")} accessibilityRole="button">
                  {busy === "health" ? <ActivityIndicator color={colors.text} /> : <Text style={ui.secondaryText}>Apple Health only</Text>}
                </Pressable>
              </View>
            </>
          )}
          <Pressable style={expoGo ? ui.primary : ui.secondary} disabled={busy !== null} onPress={() => void pickGoogle()} accessibilityRole="button">
            {busy === "picker" ? (
              <ActivityIndicator color={expoGo ? "#062214" : colors.text} />
            ) : (
              <Text style={expoGo ? ui.primaryText : ui.secondaryText}>Pick from Google Photos</Text>
            )}
          </Pressable>
          {expoGo ? <Text style={ui.meta}>Scanning the whole photo library and Apple Health import need the fitlogr iPhone app.</Text> : null}
          {cancel ? (
            <Pressable style={ui.secondary} onPress={() => cancel.abort()} accessibilityRole="button">
              <Text style={ui.secondaryText}>Cancel</Text>
            </Pressable>
          ) : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  segment: { flexDirection: "row", gap: 6, marginTop: 8 },
  preset: { flex: 1, borderRadius: 10, paddingVertical: 7, alignItems: "center", backgroundColor: "#222428" },
  presetOn: { backgroundColor: "#163524" },
  presetText: { color: colors.muted, fontWeight: "700", fontSize: 14 },
  presetTextOn: { color: colors.green },
  custom: { width: 58, textAlign: "center" },
  customOn: { borderWidth: 1, borderColor: colors.green },
  pair: { flexDirection: "row", gap: 8 },
  pairButton: { flex: 1 },
});
