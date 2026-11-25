import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { requestCameraPermissionsAsync, requestMediaLibraryPermissionsAsync, launchCameraAsync, launchImageLibraryAsync } from "expo-image-picker";
import { MealPhotoConsent } from "./MealPhotoConsent";
import { isExpoGo } from "../services/expoGo";
import { useStore } from "../services/store";
import { colors } from "../theme";

type PhotoAction = "camera" | "library" | "scan";

let scannedThisSession = false;

/** Log screen actions: analyze a meal photo, take one, or enter a meal by hand. */
export function MealPhotoPicker({ onManual }: { onManual: () => void }) {
  const store = useStore();
  const [consentOpen, setConsentOpen] = useState(false);
  const [pending, setPending] = useState<PhotoAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const canScan = !isExpoGo();

  useEffect(() => {
    if (!canScan || !store.ready || store.mode !== "account" || !store.photoConsent || scannedThisSession) return;
    scannedThisSession = true;
    setBusy(true);
    void store.scanMealPhotos().then((message) => {
      if (message) setNote(message);
      setBusy(false);
    });
  }, [store, canScan]);

  function start(action: PhotoAction) {
    if (store.mode !== "account") {
      Alert.alert("Sign in to analyze photos", "Meal photos are analyzed in your fitlogr account. You can still enter a meal manually.", [
        { text: "Not now", style: "cancel" },
        { text: "Sign in", onPress: () => router.push("/settings/account") },
      ]);
      return;
    }
    if (!store.photoConsent) {
      setPending(action);
      setConsentOpen(true);
      return;
    }
    void run(action);
  }

  async function run(action: PhotoAction) {
    setBusy(true);
    setNote(null);
    try {
      if (action === "scan") {
        setNote(await store.scanMealPhotos(true));
        return;
      }
      const uri = await pick(action);
      if (!uri) return;
      setNote(await store.addMealPhoto(uri));
    } catch (error) {
      setNote(error instanceof Error ? error.message : "The photo could not be analyzed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.wrap}>
      {!store.photoConsent && store.mode === "account" ? (
        <Pressable style={styles.banner} onPress={() => start("library")} accessibilityRole="button">
          <Ionicons name="shield-checkmark-outline" size={18} color={colors.green} />
          <Text style={styles.bannerText}>Allow meal photo analysis to log meals from photos.</Text>
        </Pressable>
      ) : null}
      <View style={styles.actions}>
        <Action icon="images-outline" label="Photos" primary disabled={busy} onPress={() => start("library")} />
        <Action icon="camera-outline" label="Camera" disabled={busy} onPress={() => start("camera")} />
        <Action icon="create-outline" label="Manual" onPress={onManual} />
      </View>
      {canScan && store.mode === "account" ? (
        <Pressable style={styles.scan} onPress={() => start("scan")} disabled={busy} hitSlop={8} accessibilityRole="button">
          <Text style={styles.scanText}>Scan recent photos</Text>
        </Pressable>
      ) : null}
      {busy ? (
        <View style={styles.busyRow}>
          <ActivityIndicator color={colors.green} />
          <Text style={styles.note}>Checking photo…</Text>
        </View>
      ) : null}
      {note ? <Text style={styles.note}>{note}</Text> : null}
      <MealPhotoConsent
        visible={consentOpen}
        onDecline={() => {
          setConsentOpen(false);
          setPending(null);
        }}
        onAgree={() => {
          setConsentOpen(false);
          const action = pending;
          setPending(null);
          void store.acceptPhotoConsent().then(() => {
            if (action) void run(action);
          });
        }}
      />
    </View>
  );
}

function Action({
  icon,
  label,
  primary,
  disabled,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  primary?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.action, primary && styles.actionPrimary, disabled && styles.actionDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label === "Manual" ? "Enter a meal manually" : label === "Camera" ? "Take a meal photo" : "Add a meal photo"}
    >
      <Ionicons name={icon} size={20} color={primary ? "#062214" : colors.text} />
      <Text style={[styles.actionText, primary && styles.actionTextPrimary]}>{label}</Text>
    </Pressable>
  );
}

async function pick(action: "camera" | "library"): Promise<string | null> {
  const permission =
    action === "camera" ? await requestCameraPermissionsAsync() : await requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    Alert.alert("Permission needed", action === "camera" ? "Camera access is off. Turn it on in iPhone Settings." : "Photo access is off. Turn it on in iPhone Settings.");
    return null;
  }
  const result =
    action === "camera"
      ? await launchCameraAsync({ mediaTypes: "images", quality: 1, exif: false })
      : await launchImageLibraryAsync({ mediaTypes: "images", quality: 1, exif: false });
  if (result.canceled) return null;
  return result.assets[0]?.uri ?? null;
}

const styles = StyleSheet.create({
  wrap: { marginTop: 12 },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#16301F",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
  },
  bannerText: { color: colors.text, fontSize: 14, lineHeight: 19, flex: 1 },
  actions: { flexDirection: "row", gap: 8 },
  action: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    borderRadius: 16,
    paddingVertical: 12,
    backgroundColor: colors.card,
  },
  actionPrimary: { backgroundColor: colors.green },
  actionDisabled: { opacity: 0.5 },
  actionText: { color: colors.text, fontWeight: "700", fontSize: 14 },
  actionTextPrimary: { color: "#062214" },
  scan: { alignSelf: "center", marginTop: 10 },
  scanText: { color: colors.muted, fontWeight: "700", fontSize: 14 },
  busyRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 8 },
  note: { color: colors.muted, textAlign: "center", marginTop: 8, fontSize: 13, lineHeight: 18 },
});
