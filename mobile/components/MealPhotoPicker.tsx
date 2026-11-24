import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { requestCameraPermissionsAsync, requestMediaLibraryPermissionsAsync, launchCameraAsync, launchImageLibraryAsync } from "expo-image-picker";
import { MealPhotoConsent } from "./MealPhotoConsent";
import { useStore } from "../services/store";
import { colors } from "../theme";

let scannedThisSession = false;

export function MealPhotoPicker() {
  const store = useStore();
  const [consentOpen, setConsentOpen] = useState(false);
  const [pending, setPending] = useState<"camera" | "library" | "scan" | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!store.ready || store.mode !== "account" || !store.photoConsent || scannedThisSession) return;
    scannedThisSession = true;
    setBusy(true);
    void store.scanMealPhotos().then((message) => {
      if (message) setNote(message);
      setBusy(false);
    });
  }, [store]);

  function start(action: "camera" | "library" | "scan") {
    if (store.mode !== "account") {
      Alert.alert("Sign in required", "Sign in with Google before a meal photo can be analyzed.");
      return;
    }
    if (!store.photoConsent) {
      setPending(action);
      setConsentOpen(true);
      return;
    }
    void run(action);
  }

  async function run(action: "camera" | "library" | "scan") {
    setBusy(true);
    setNote(null);
    try {
      if (action === "scan") {
        setNote(await store.scanMealPhotos());
        return;
      }
      const uri = await pick(action);
      if (!uri) return;
      setNote(await store.addMealPhoto(uri));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.wrap}>
      {!store.photoConsent && store.mode === "account" ? (
        <Pressable style={styles.banner} onPress={() => start("library")}>
          <Text style={styles.bannerText}>Allow meal photo analysis before photos are sent.</Text>
        </Pressable>
      ) : null}
      <Pressable style={styles.button} onPress={() => start("library")} disabled={busy}>
        <Text style={styles.buttonText}>{busy ? "Checking photo…" : "Add meal photo"}</Text>
      </Pressable>
      <View style={styles.row}>
        <Pressable onPress={() => start("camera")} disabled={busy}>
          <Text style={styles.link}>Take photo</Text>
        </Pressable>
        <Pressable onPress={() => start("scan")} disabled={busy}>
          <Text style={styles.link}>Scan library</Text>
        </Pressable>
      </View>
      {busy ? <ActivityIndicator color={colors.green} style={{ marginTop: 8 }} /> : null}
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

async function pick(action: "camera" | "library"): Promise<string | null> {
  const permission =
    action === "camera" ? await requestCameraPermissionsAsync() : await requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    Alert.alert("Permission needed", action === "camera" ? "Camera access is off." : "Photo library access is off.");
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
  wrap: { marginTop: 8 },
  banner: { backgroundColor: "#1C2A22", borderRadius: 14, padding: 12, marginBottom: 10 },
  bannerText: { color: colors.text, fontSize: 14, lineHeight: 19 },
  button: {
    borderRadius: 16,
    backgroundColor: colors.green,
    paddingVertical: 14,
    alignItems: "center",
  },
  buttonText: { color: "#062214", fontWeight: "800" },
  row: { flexDirection: "row", justifyContent: "space-between", marginTop: 10, paddingHorizontal: 8 },
  link: { color: colors.muted, fontWeight: "700" },
  note: { color: colors.muted, textAlign: "center", marginTop: 8, fontSize: 13 },
});
