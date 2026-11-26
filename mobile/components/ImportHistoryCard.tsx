import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { getMediaLibraryPermissionsAsync, requestMediaLibraryPermissionsAsync } from "expo-image-picker";
import { PickerScopeRequired, type HistoryProgress } from "../services/photos";
import { importFromGooglePhotos } from "../services/photos/picker";
import { api } from "../services/api";
import { AuthCancelled, useStore } from "../services/store";
import { isExpoGo } from "../services/expoGo";
import { ui } from "./settingsUi";
import { colors } from "../theme";

const RANGES = [
  { label: "1 month", days: 30 },
  { label: "3 months", days: 90 },
  { label: "12 months", days: 365 },
] as const;

const APPLE_PHOTOS_SYNCED = "apple_photos_synced_at";
const GOOGLE_PHOTOS_SYNCED = "google_photos_synced_at";
const NATIVE_APP = "Needs the fitlogr iPhone app.";
const NATIVE_IMPORT = "Importing Apple Health and scanning the whole photo library need the fitlogr iPhone app.";

type Busy = "health" | "health-connect" | "apple-photos" | "google-photos" | "apple-sync" | "google-sync" | null;

interface ImportCounts {
  photos: number;
  total: number;
  meals: number;
  workouts: number;
}

const EMPTY_COUNTS: ImportCounts = { photos: 0, total: 0, meals: 0, workouts: 0 };

export function ImportHistoryCard({ signedIn }: { signedIn: boolean }) {
  const store = useStore();
  const storeRef = useRef(store);
  storeRef.current = store;
  const expoGo = isExpoGo();
  const [days, setDays] = useState<30 | 90 | 365>(30);
  const [busy, setBusy] = useState<Busy>(null);
  const [progress, setProgress] = useState<HistoryProgress | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [cancel, setCancel] = useState<AbortController | null>(null);
  const [counts, setCounts] = useState<ImportCounts>(EMPTY_COUNTS);
  const [applePhotos, setApplePhotos] = useState(false);
  const [applePhotosSynced, setApplePhotosSynced] = useState<string | null>(null);
  const [googlePhotos, setGooglePhotos] = useState(false);
  const [googlePhotosSynced, setGooglePhotosSynced] = useState<string | null>(null);

  const refreshConnections = useCallback(async () => {
    const current = storeRef.current;
    const [appleStamp, googleStamp] = await Promise.all([
      current.readLocal(APPLE_PHOTOS_SYNCED),
      current.readLocal(GOOGLE_PHOTOS_SYNCED),
    ]);
    setApplePhotosSynced(appleStamp);
    setGooglePhotosSynced(googleStamp);
    setApplePhotos(await photoLibraryGranted());
    if (current.mode !== "account") {
      setGooglePhotos(false);
      return;
    }
    try {
      const me = await api.me();
      const scopes = me.google.status === "active" ? me.google.scopes : [];
      setGooglePhotos(scopes.some((scope) => scope.includes("photospicker")));
    } catch {
      setGooglePhotos(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refreshConnections();
    }, [refreshConnections]),
  );

  async function stamp(key: string, setter: (value: string) => void) {
    const iso = new Date().toISOString();
    await store.writeLocal(key, iso);
    setter(iso);
  }

  async function connectHealth() {
    if (expoGo || busy) return;
    setBusy("health-connect");
    setNote(null);
    try {
      const connection = await store.syncHealth();
      if (connection && !connection.connected) setNote(connection.message);
    } finally {
      setBusy(null);
    }
  }

  async function connectApplePhotos() {
    if (busy) return;
    setBusy("apple-sync");
    setNote(null);
    try {
      const current = await getMediaLibraryPermissionsAsync();
      const permission = current.granted ? current : await requestMediaLibraryPermissionsAsync();
      setApplePhotos(permission.granted);
      if (!permission.granted) {
        setNote("Photo library access is off. You can still pick a photo when iOS asks.");
        return;
      }
      // Picking photos works here. Scanning the whole library is the import button, and only the iPhone app can do it.
      if (expoGo || store.mode !== "account") return;
      const message = await store.scanMealPhotos(true);
      await stamp(APPLE_PHOTOS_SYNCED, setApplePhotosSynced);
      if (message) setNote(message);
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Apple Photos could not connect.");
    } finally {
      setBusy(null);
    }
  }

  async function connectGooglePhotos() {
    if (busy) return;
    if (googlePhotos) {
      setBusy("google-sync");
      try {
        await store.sync(true);
        await refreshConnections();
      } catch (error) {
        setNote(error instanceof Error ? error.message : "Google Photos could not sync.");
      } finally {
        setBusy(null);
      }
      return;
    }
    setBusy("google-sync");
    setNote(null);
    try {
      await store.grantPickerAccess();
      setGooglePhotos(true);
    } catch (error) {
      if (error instanceof AuthCancelled) return;
      setNote(error instanceof Error ? error.message : "Google Photos could not connect.");
    } finally {
      setBusy(null);
      void refreshConnections();
    }
  }

  async function importApplePhotos() {
    if (!signedIn) {
      setNote("Sign in with Google before importing history.");
      return;
    }
    const controller = new AbortController();
    setCancel(controller);
    setBusy("apple-photos");
    setProgress({ scanned: 0, skipped: 0, meals: 0, nonMeals: 0, errors: 0 });
    setNote(null);
    try {
      const result = await store.scanHistory(days, setProgress, controller.signal);
      setCounts({ photos: result.meals, total: result.scanned, meals: result.meals, workouts: 0 });
      setNote(result.message);
      if (result.meals > 0) await stamp(APPLE_PHOTOS_SYNCED, setApplePhotosSynced);
      setApplePhotos(true);
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setBusy(null);
      setCancel(null);
      setProgress(null);
    }
  }

  async function importHealth() {
    if (!signedIn) {
      setNote("Sign in with Google before importing history.");
      return;
    }
    setBusy("health");
    setNote(null);
    try {
      const result = await store.importHealthHistory(days);
      setCounts({ photos: 0, total: result.total, meals: 0, workouts: result.workouts });
      setNote(result.message);
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setBusy(null);
    }
  }

  async function importGoogle() {
    if (!signedIn) {
      setNote("Sign in with Google before picking photos.");
      return;
    }
    setBusy("google-photos");
    setNote(null);
    try {
      const summary = await importFromGooglePhotos();
      setCounts({
        photos: summary.meals_imported,
        total: summary.total_picked,
        meals: summary.meals_imported,
        workouts: 0,
      });
      if (summary.meals_imported > 0) await stamp(GOOGLE_PHOTOS_SYNCED, setGooglePhotosSynced);
      setGooglePhotos(true);
      try {
        await store.sync(true);
      } catch {
        // The meals are already on the account. The next sync will finish pulling them.
      }
      setNote(
        summary.total_picked === 0
          ? "No Google Photos were selected."
          : `Imported ${summary.meals_imported} meals from Google Photos.`,
      );
    } catch (error) {
      if (error instanceof PickerScopeRequired) {
        Alert.alert("Google Photos", error.message, [
          { text: "Cancel", style: "cancel" },
          {
            text: "Reconnect Google",
            onPress: () => {
              void connectGooglePhotos();
            },
          },
        ]);
      } else setNote(error instanceof Error ? error.message : "Google Photos import failed.");
    } finally {
      setBusy(null);
    }
  }

  const healthConnected = store.health?.connected === true;
  const healthDetail = expoGo ? NATIVE_APP : healthConnected ? connectedLine(store.health?.lastSyncedAt ?? null) : healthProblem(store.health?.message);
  const locked = busy !== null;

  return (
    <>
      <View style={ui.card}>
        <Text style={ui.cardTitle}>Setup</Text>
        <SetupRow
          first
          title="Connect Apple Health"
          detail={healthDetail}
          disabled={expoGo}
          busy={busy === "health-connect"}
          onPress={() => void connectHealth()}
        />
        <SetupRow
          title="Connect Apple Photos"
          detail={applePhotos ? connectedLine(applePhotosSynced) : null}
          busy={busy === "apple-sync"}
          onPress={() => void connectApplePhotos()}
        />
        <SetupRow
          title="Connect Google Photos"
          detail={googlePhotos ? connectedLine(googlePhotosSynced) : null}
          busy={busy === "google-sync"}
          onPress={() => void connectGooglePhotos()}
        />
      </View>

      <View style={ui.card}>
        <Text style={ui.cardTitle}>Import historical data</Text>
        {!signedIn ? (
          <>
            <Text style={ui.body}>Sign in with Google to import your history.</Text>
            <Pressable style={ui.primary} onPress={() => router.push("/settings/account")} accessibilityRole="button">
              <Text style={ui.primaryText}>Sign in</Text>
            </Pressable>
          </>
        ) : (
          <>
            <View style={styles.segment}>
              {RANGES.map((range) => (
                <Pressable
                  key={range.days}
                  style={[styles.preset, days === range.days && styles.presetOn]}
                  onPress={() => setDays(range.days)}
                  accessibilityRole="button"
                  accessibilityLabel={range.label}
                  accessibilityState={{ selected: days === range.days }}
                >
                  <Text style={[styles.presetText, days === range.days && styles.presetTextOn]}>{range.label}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={ui.meta}>These months scan Apple Health and the iPhone photo library.</Text>
            {progress && busy === "apple-photos" ? (
              <Text style={ui.body}>
                Scanned {progress.scanned}. Meals {progress.meals}. Skipped {progress.skipped}.
              </Text>
            ) : null}
            <Pressable
              style={[ui.secondary, expoGo && styles.disabled]}
              disabled={locked || expoGo}
              onPress={() => void importHealth()}
              accessibilityRole="button"
            >
              {busy === "health" ? <ActivityIndicator color={colors.text} /> : <Text style={ui.secondaryText}>Import Apple Health</Text>}
            </Pressable>
            <Pressable
              style={[ui.secondary, expoGo && styles.disabled]}
              disabled={locked || expoGo}
              onPress={() => void importApplePhotos()}
              accessibilityRole="button"
            >
              {busy === "apple-photos" ? <ActivityIndicator color={colors.text} /> : <Text style={ui.secondaryText}>Import Apple Photos</Text>}
            </Pressable>
            {expoGo ? <Text style={ui.meta}>{NATIVE_IMPORT}</Text> : null}
            <Pressable style={ui.secondary} disabled={locked} onPress={() => void importGoogle()} accessibilityRole="button">
              {busy === "google-photos" ? <ActivityIndicator color={colors.text} /> : <Text style={ui.secondaryText}>Pick from Google Photos</Text>}
            </Pressable>
            <Text style={ui.meta}>Google Photos only shares photos you pick. It cannot list your library or limit a session to these months.</Text>
            {note ? <Text style={ui.body}>{note}</Text> : null}
            <Text style={ui.body}>Photos imported: {counts.photos}</Text>
            <Text style={ui.body}>
              Total: {counts.total}, Meals: {counts.meals}, Workouts: {counts.workouts}
            </Text>
            {cancel ? (
              <Pressable style={ui.secondary} onPress={() => cancel.abort()} accessibilityRole="button">
                <Text style={ui.secondaryText}>Cancel</Text>
              </Pressable>
            ) : null}
          </>
        )}
      </View>
    </>
  );
}

function healthProblem(message: string | undefined): string | null {
  if (!message || message.startsWith("Connect Apple Health")) return null;
  return message;
}

async function photoLibraryGranted(): Promise<boolean> {
  try {
    const permission = await getMediaLibraryPermissionsAsync();
    return permission.granted;
  } catch {
    return false;
  }
}

function connectedLine(iso: string | null): string {
  if (!iso) return "Connected";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Connected";
  return `Connected. Last synced: ${date.toLocaleString()}`;
}

function SetupRow({
  title,
  detail,
  disabled,
  busy,
  onPress,
  first,
}: {
  title: string;
  detail: string | null;
  disabled?: boolean;
  busy?: boolean;
  onPress: () => void;
  first?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={[styles.row, !first && styles.rowDivider]}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled || busy) }}
      accessibilityLabel={detail ? `${title}. ${detail}` : title}
    >
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, disabled && styles.rowTitleOff]}>{title}</Text>
        {detail ? <Text style={ui.body}>{detail}</Text> : null}
      </View>
      {busy ? <ActivityIndicator color={colors.green} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  segment: { flexDirection: "row", gap: 6, marginTop: 8 },
  preset: { flex: 1, borderRadius: 10, paddingVertical: 7, alignItems: "center", backgroundColor: "#222428" },
  presetOn: { backgroundColor: "#163524" },
  presetText: { color: colors.muted, fontWeight: "700", fontSize: 13 },
  presetTextOn: { color: colors.green },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 9 },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#2E3338" },
  rowBody: { flex: 1, minWidth: 0 },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
  rowTitleOff: { color: colors.muted, fontWeight: "600" },
  disabled: { opacity: 0.45 },
});
