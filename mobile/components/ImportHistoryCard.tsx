import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { getMediaLibraryPermissionsAsync, requestMediaLibraryPermissionsAsync } from "expo-image-picker";
import { useStore } from "../services/store";
import { isExpoGo } from "../services/expoGo";
import { ui } from "./settingsUi";
import { colors } from "../theme";

const RANGES = [
  { label: "3 months", days: 90 },
  { label: "12 months", days: 365 },
] as const;

const APPLE_PHOTOS_SYNCED = "apple_photos_synced_at";
const NATIVE_APP = "Needs the fitlogr iPhone app.";
const LIMITED_ACCESS = "Limited access: only selected photos are visible. Tap to allow all photos in Settings.";
const NATIVE_IMPORT = "Importing Apple Health and scanning the whole photo library need the fitlogr iPhone app.";

const HISTORY_DAYS = "photo_history_days";

type Busy = "health-connect" | "apple-sync" | null;

export function ImportHistoryCard({ signedIn }: { signedIn: boolean }) {
  const store = useStore();
  const storeRef = useRef(store);
  storeRef.current = store;
  const expoGo = isExpoGo();
  const [days, setDays] = useState<90 | 365>(90);
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<string | null>(null);
  const [applePhotos, setApplePhotos] = useState(false);
  /** iOS "Limited Access": connected, but new photos are invisible to the automatic scan. */
  const [applePhotosLimited, setApplePhotosLimited] = useState(false);
  const [applePhotosSynced, setApplePhotosSynced] = useState<string | null>(null);

  const refreshConnections = useCallback(async () => {
    const current = storeRef.current;
    setApplePhotosSynced(await current.readLocal(APPLE_PHOTOS_SYNCED));
    // The range chosen in setup, or here earlier. Without this the card always showed 3 months.
    setDays(Number(await current.readLocal(HISTORY_DAYS)) > 90 ? 365 : 90);
    const library = await photoLibraryAccess();
    setApplePhotos(library !== "none");
    setApplePhotosLimited(library === "limited");
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
      if (current.granted && current.accessPrivileges === "limited") {
        // iOS only changes Limited to Full Access from its own Settings screen.
        await Linking.openSettings();
        return;
      }
      const permission = current.granted ? current : await requestMediaLibraryPermissionsAsync();
      setApplePhotos(permission.granted);
      setApplePhotosLimited(permission.granted && permission.accessPrivileges === "limited");
      if (!permission.granted) {
        if (!permission.canAskAgain) await Linking.openSettings();
        else setNote("Photo library access is off. You can still pick a photo when iOS asks.");
        return;
      }
      if (permission.accessPrivileges === "limited") {
        setNote(LIMITED_ACCESS);
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

  const healthConnected = store.health?.connected === true;
  const healthDetail = expoGo ? NATIVE_APP : healthConnected ? connectedLine(store.health?.lastSyncedAt ?? null) : healthProblem(store.health?.message);

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
          detail={applePhotosLimited ? LIMITED_ACCESS : applePhotos ? connectedLine(applePhotosSynced) : null}
          busy={busy === "apple-sync"}
          onPress={() => void connectApplePhotos()}
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
                  onPress={() => {
                    if (range.days === days || expoGo) return;
                    setDays(range.days);
                    setNote(null);
                    // Only moves the window: the engine picks up where it left off and reports through photoScan.
                    void store.scanHistory(range.days, () => undefined, new AbortController().signal).catch((error: unknown) => {
                      setNote(error instanceof Error ? error.message : "The import could not start.");
                    });
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={range.label}
                  accessibilityState={{ selected: days === range.days }}
                >
                  <Text style={[styles.presetText, days === range.days && styles.presetTextOn]}>{range.label}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={ui.meta}>Apple Photos and Apple Health import on their own for this window.</Text>
            {store.photoScan.active || store.photoScan.message ? (
              <View style={styles.status}>
                {store.photoScan.active ? <ActivityIndicator color={colors.green} /> : null}
                <Text style={[ui.body, styles.statusText]}>{store.photoScan.message ?? "Checking your photos…"}</Text>
              </View>
            ) : null}
            {expoGo ? <Text style={ui.meta}>{NATIVE_IMPORT}</Text> : null}
            {note ? <Text style={ui.body}>{note}</Text> : null}
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

async function photoLibraryAccess(): Promise<"full" | "limited" | "none"> {
  try {
    const permission = await getMediaLibraryPermissionsAsync();
    if (!permission.granted) return "none";
    return permission.accessPrivileges === "limited" ? "limited" : "full";
  } catch {
    return "none";
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
  status: { flexDirection: "row", alignItems: "center", gap: 8 },
  statusText: { flex: 1 },
});
