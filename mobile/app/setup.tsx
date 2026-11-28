import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, AppState, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getClassifier } from "../services/engine/classifier";
import { runPass } from "../services/engine/runPass";
import { ensureNotificationPermission } from "../services/engine/notify";
import { libraryAccess, type LibraryAccess } from "../services/photos/library";
import { AuthCancelled, useStore } from "../services/store";
import { colors } from "../theme";
import { ui } from "../components/settingsUi";

const STEPS = ["Sign in", "Photos", "Apple Health", "Alerts", "History", "Done"] as const;

export default function SetupScreen() {
  const insets = useSafeAreaInsets();
  const store = useStore();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [photos, setPhotos] = useState<LibraryAccess | null>(null);
  const [days, setDays] = useState<90 | 365>(90);
  const classifier = getClassifier();

  const refresh = useCallback(async () => {
    try {
      setPhotos(await libraryAccess(false));
    } catch {
      setPhotos(null);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  // Coming back from iOS Settings does not refocus the screen, so re-check photo access on return.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  /** Moves on from one specific step. A late callback from an earlier step then cannot skip the current one. */
  function leave(from: number) {
    setNote(null);
    setStep((current) => (current === from ? Math.min(STEPS.length - 1, from + 1) : current));
  }

  async function finish() {
    await store.writeLocal("setup_done", "1");
    await store.writeLocal("photo_history_days", String(days));
    // The first pass over months of photos takes minutes. It runs on while the Log shows its progress.
    if (store.mode === "account") void runPass({ reason: "setup", active: true, historyDays: days });
    router.replace("/");
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingTop: insets.top + 16, paddingHorizontal: 16, paddingBottom: 32 }}>
      <Text style={styles.kicker}>
        {step + 1} of {STEPS.length}
      </Text>
      <Text style={styles.title}>{STEPS[step]}</Text>
      {step === 0 ? (
        <>
          <Text style={ui.body}>Sign in so meals and Apple Health can sync. You can look around the sample day first.</Text>
          <Pressable
            style={ui.primary}
            disabled={busy}
            onPress={() => {
              setBusy(true);
              store
                .signIn()
                .then(() => leave(0))
                .catch((error: unknown) => {
                  if (error instanceof AuthCancelled) return;
                  setNote(error instanceof Error ? error.message : "Sign-in failed");
                })
                .finally(() => setBusy(false));
            }}
          >
            {busy ? <ActivityIndicator color="#062214" /> : <Text style={ui.primaryText}>Sign in with Google</Text>}
          </Pressable>
          <Pressable style={ui.secondary} disabled={busy} onPress={() => leave(0)}>
            <Text style={ui.secondaryText}>Look around first</Text>
          </Pressable>
        </>
      ) : null}
      {step === 1 ? (
        <>
          <Text style={ui.body}>Only a photo that looks like food is sent, and only after you agree. Everything else stays on this phone.</Text>
          {!classifier.available ? <Text style={ui.body}>Automatic scanning needs the fitlogr iPhone app. Adding a photo by hand still works.</Text> : null}
          {photos === "denied" ? <Text style={ui.body}>Photo access is off. Turn on full access in Settings.</Text> : null}
          {photos === "limited" ? (
            <Text style={ui.body}>Limited access only sees photos you picked. New meals will be missed until you allow all photos.</Text>
          ) : null}
          {!store.photoConsent ? (
            // Two taps on this step: agree first, then iOS asks for photo access.
            <Pressable style={ui.primary} onPress={() => void store.acceptPhotoConsent()}>
              <Text style={ui.primaryText}>Agree to photo analysis</Text>
            </Pressable>
          ) : photos === "full" ? (
            <Pressable style={ui.primary} onPress={() => leave(1)}>
              <Text style={ui.primaryText}>Continue</Text>
            </Pressable>
          ) : (
            <Pressable
              style={ui.primary}
              onPress={() => {
                void libraryAccess(true)
                  .then((access) => {
                    setPhotos(access);
                    if (access === "full") leave(1);
                    else if (access === "limited" || access === "denied") void Linking.openSettings();
                  })
                  .catch(() => setNote("Photo access needs the fitlogr iPhone app."));
              }}
            >
              <Text style={ui.primaryText}>{photos === "limited" || photos === "denied" ? "Open Settings" : "Allow all photos"}</Text>
            </Pressable>
          )}
          <Pressable style={ui.secondary} onPress={() => leave(1)}>
            <Text style={ui.secondaryText}>Skip for now</Text>
          </Pressable>
        </>
      ) : null}
      {step === 2 ? (
        <>
          <Text style={ui.body}>Apple Health fills in weight, burn, steps, and workouts from your watch.</Text>
          <Pressable
            style={ui.primary}
            disabled={busy}
            onPress={() => {
              setBusy(true);
              store
                .syncHealth()
                .then(() => leave(2))
                .catch((error: unknown) => setNote(error instanceof Error ? error.message : "Apple Health could not connect"))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? <ActivityIndicator color="#062214" /> : <Text style={ui.primaryText}>Connect Apple Health</Text>}
          </Pressable>
          <Pressable style={ui.secondary} disabled={busy} onPress={() => leave(2)}>
            <Text style={ui.secondaryText}>Skip for now</Text>
          </Pressable>
        </>
      ) : null}
      {step === 3 ? (
        <>
          <Text style={ui.body}>fitlogr can tell you when a meal is logged and when today's calories are used up.</Text>
          <Pressable
            style={ui.primary}
            onPress={() => {
              void ensureNotificationPermission().finally(() => leave(3));
            }}
          >
            <Text style={ui.primaryText}>Allow alerts</Text>
          </Pressable>
          <Pressable style={ui.secondary} onPress={() => leave(3)}>
            <Text style={ui.secondaryText}>Skip for now</Text>
          </Pressable>
        </>
      ) : null}
      {step === 4 ? (
        <>
          <Text style={ui.body}>fitlogr looks back through Apple Photos and Apple Health for this long, then keeps going on its own.</Text>
          <View style={styles.row}>
            <Pressable style={[styles.choice, days === 90 && styles.choiceOn]} onPress={() => setDays(90)}>
              <Text style={styles.choiceText}>3 months</Text>
            </Pressable>
            <Pressable style={[styles.choice, days === 365 && styles.choiceOn]} onPress={() => setDays(365)}>
              <Text style={styles.choiceText}>12 months</Text>
            </Pressable>
          </View>
          <Pressable style={ui.primary} onPress={() => leave(4)}>
            <Text style={ui.primaryText}>Continue</Text>
          </Pressable>
        </>
      ) : null}
      {step === 5 ? (
        <>
          <Text style={ui.body}>That's the setup. fitlogr will log new meals when you open it, and when the phone allows a background refresh.</Text>
          <Pressable style={ui.primary} onPress={() => void finish()}>
            <Text style={ui.primaryText}>Start logging</Text>
          </Pressable>
        </>
      ) : null}
      {note ? <Text style={ui.error}>{note}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  kicker: { color: colors.faint, fontSize: 13, fontWeight: "700" },
  title: { color: colors.text, fontSize: 28, fontWeight: "800", marginTop: 4, marginBottom: 8 },
  row: { flexDirection: "row", gap: 8, marginTop: 12 },
  choice: { flex: 1, backgroundColor: "#222428", borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  choiceOn: { backgroundColor: "#163524" },
  choiceText: { color: colors.text, fontWeight: "700" },
});
