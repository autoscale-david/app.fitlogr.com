import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Image, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type ScrollViewInstance } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GoogleReconnectBanner, SyncStatusBanner } from "../../components/AccountBanners";
import { CaloriePlanCard } from "../../components/CaloriePlanCard";
import { ImportHistoryCard } from "../../components/ImportHistoryCard";
import { HealthSyncCard } from "../../components/HealthSyncCard";
import type { Goals } from "../../services/db";
import { AuthCancelled, useStore } from "../../services/store";
import { colors } from "../../theme";

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const store = useStore();
  const [draft, setDraft] = useState<Goals | null>(store.goals);
  const [busy, setBusy] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [openEndsSignal, setOpenEndsSignal] = useState(0);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const planY = useRef<number | null>(null);
  const params = useLocalSearchParams<{ focus?: string; at?: string }>();

  useEffect(() => {
    setDraft(store.goals);
  }, [store.goals, store.refreshToken]);

  useEffect(() => {
    if (params.focus !== "plan" && params.focus !== "plan-end") return;
    const focus = params.focus;
    const timer = setTimeout(() => {
      if (planY.current != null) scrollRef.current?.scrollTo({ y: Math.max(0, planY.current - 12), animated: true });
      if (focus === "plan-end") setOpenEndsSignal((signal) => signal + 1);
      router.setParams({ focus: "", at: "" });
    }, 250);
    return () => clearTimeout(timer);
  }, [params.focus, params.at]);

  if (!draft) {
    return <View style={styles.screen} />;
  }

  function save(next: Goals) {
    setDraft(next);
    void store.saveGoals(next);
  }

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.screen}
      contentContainerStyle={{ paddingTop: insets.top + 12, paddingHorizontal: 16, paddingBottom: 40 }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>Settings</Text>
      <Image source={require("../../assets/logo.png")} style={styles.logo} resizeMode="contain" />

      <GoogleReconnectBanner
        visible={store.googleReconnectRequired}
        busy={reconnecting}
        onReconnect={() => {
          setReconnecting(true);
          store
            .reconnectGoogle()
            .catch((error: unknown) => {
              if (error instanceof AuthCancelled) return;
              Alert.alert("Reconnect Google", error instanceof Error ? error.message : "Reconnect failed");
            })
            .finally(() => setReconnecting(false));
        }}
      />
      <SyncStatusBanner
        visible={store.mode === "account"}
        pending={store.pending}
        lastSyncedAt={store.lastSyncedAt}
        syncing={store.syncing}
        error={store.syncError}
        onRetry={() => void store.sync(true)}
      />

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Account</Text>
        {store.account ? (
          <>
            <Text style={styles.body}>{store.account.displayName || "Google account"}</Text>
            <Text style={styles.body}>{store.account.email}</Text>
            <Pressable
              style={styles.secondaryInline}
              onPress={() => {
                Alert.alert("Sign out", "This phone returns to the sample preview. Your fitlogr account stays on the server.", [
                  { text: "Cancel", style: "cancel" },
                  { text: "Sign out", style: "destructive", onPress: () => void store.signOut() },
                ]);
              }}
            >
              <Text style={styles.secondaryText}>Sign out</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.body}>
              Connect Google to save your plan, meals, and weight on fitlogr.com. Until then, this phone shows the sample day.
            </Text>
            <Pressable
              style={styles.button}
              disabled={busy}
              onPress={() => {
                setBusy(true);
                store
                  .signIn()
                  .catch((error: unknown) => {
                    if (error instanceof AuthCancelled) return;
                    Alert.alert("Google sign-in", error instanceof Error ? error.message : "Sign-in failed");
                  })
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? <ActivityIndicator color="#062214" /> : <Text style={styles.buttonText}>Continue with Google</Text>}
            </Pressable>
          </>
        )}
      </View>

      <ImportHistoryCard signedIn={store.mode === "account"} />

      <HealthSyncCard connection={store.health} syncing={store.syncing} onSync={() => void store.syncHealth()} />

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Units</Text>
        <View style={styles.segment}>
          <Segment label="Imperial" active={draft.unitSystem === "imperial"} onPress={() => save({ ...draft, unitSystem: "imperial" })} />
          <Segment label="Metric" active={draft.unitSystem === "metric"} onPress={() => save({ ...draft, unitSystem: "metric" })} />
        </View>
      </View>

      <View
        onLayout={(event) => {
          planY.current = event.nativeEvent.layout.y;
        }}
      >
        <CaloriePlanCard plan={draft.plan} onChange={(plan) => save({ ...draft, plan })} openEndsSignal={openEndsSignal} />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Daily targets</Text>
        <NumberField label="Protein (g)" value={draft.proteinTarget} onChange={(proteinTarget) => save({ ...draft, proteinTarget })} />
        <NumberField label="Carbs (g)" value={draft.carbsTarget} onChange={(carbsTarget) => save({ ...draft, carbsTarget })} />
        <NumberField label="Fat (g)" value={draft.fatTarget} onChange={(fatTarget) => save({ ...draft, fatTarget })} />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Data & privacy</Text>
        {store.mode === "account" ? (
          <>
            <Text style={styles.body}>Download a JSON copy of your fitlogr profile, meals, photos metadata, health records, and daily summaries.</Text>
            <Pressable
              style={styles.secondaryInline}
              disabled={exporting}
              onPress={() => {
                setExporting(true);
                store
                  .exportAccount()
                  .catch((error: unknown) => {
                    Alert.alert("Export", error instanceof Error ? error.message : "Export failed");
                  })
                  .finally(() => setExporting(false));
              }}
            >
              {exporting ? <ActivityIndicator color={colors.text} /> : <Text style={styles.secondaryText}>Export My Data</Text>}
            </Pressable>
            <Pressable style={styles.danger} onPress={() => setConfirmDelete(true)}>
              <Text style={styles.dangerText}>Delete Account</Text>
            </Pressable>
          </>
        ) : (
          <Text style={styles.body}>Sign in to export or delete the fitlogr account. The sample day stays on this phone.</Text>
        )}
      </View>

      <Modal visible={confirmDelete} transparent animationType="fade" onRequestClose={() => setConfirmDelete(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.cardTitle}>Delete your fitlogr account?</Text>
            <Text style={styles.body}>
              This permanently deletes your fitlogr profile, meals, health records, and settings. Your Google Photos library, including the fitlogr album and meal photos, will not be deleted.
            </Text>
            <Pressable
              style={styles.danger}
              disabled={deleting}
              onPress={() => {
                setDeleting(true);
                store
                  .deleteAccount()
                  .then(() => setConfirmDelete(false))
                  .catch((error: unknown) => {
                    Alert.alert("Delete account", error instanceof Error ? error.message : "Could not delete the account");
                  })
                  .finally(() => setDeleting(false));
              }}
            >
              {deleting ? <ActivityIndicator color={colors.fat} /> : <Text style={styles.dangerText}>Delete fitlogr data</Text>}
            </Pressable>
            <Pressable style={styles.secondaryInline} onPress={() => setConfirmDelete(false)}>
              <Text style={styles.secondaryText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {store.mode === "demo" ? (
        <Pressable style={styles.secondary} onPress={() => void store.restoreSample()}>
          <Text style={styles.secondaryText}>Restore sample day</Text>
        </Pressable>
      ) : null}
      <Text style={styles.version}>{store.mode === "account" ? "fitlogr 0.1.0 · Google account" : "fitlogr 0.1.0 · sample preview"}</Text>
    </ScrollView>
  );
}

function Segment({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable style={[styles.segmentItem, active && styles.segmentActive]} onPress={onPress}>
      <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{label}</Text>
    </Pressable>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={text}
        keyboardType="number-pad"
        onChangeText={setText}
        onEndEditing={() => {
          const parsed = Number(text);
          if (Number.isFinite(parsed) && parsed >= 0) onChange(Math.round(parsed));
          else setText(String(value));
        }}
        style={styles.input}
        placeholderTextColor={colors.faint}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  title: { color: colors.text, fontSize: 34, fontWeight: "800", letterSpacing: -0.6 },
  logo: { width: 220, height: 64, marginTop: 8, marginLeft: -8 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 18,
    padding: 16,
    marginTop: 14,
  },
  cardTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  body: { color: colors.muted, marginTop: 6, lineHeight: 20 },
  button: {
    marginTop: 14,
    backgroundColor: colors.green,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  buttonText: { color: "#062214", fontWeight: "800" },
  segment: { flexDirection: "row", gap: 8, marginTop: 12 },
  segmentItem: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: "center",
    backgroundColor: "#222428",
  },
  segmentActive: { backgroundColor: "#163524" },
  segmentText: { color: colors.muted, fontWeight: "700" },
  segmentTextActive: { color: colors.green },
  field: { marginTop: 12 },
  fieldLabel: { color: colors.muted, marginBottom: 6 },
  input: {
    backgroundColor: "#222428",
    color: colors.text,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  secondary: {
    marginTop: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#2E3338",
    paddingVertical: 12,
    alignItems: "center",
  },
  secondaryText: { color: colors.text, fontWeight: "700" },
  secondaryInline: {
    marginTop: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#2E3338",
    paddingVertical: 12,
    alignItems: "center",
  },
  sync: { color: colors.muted, marginTop: 8 },
  error: { color: colors.fat, marginTop: 8 },
  version: { color: colors.faint, textAlign: "center", marginTop: 16 },
  danger: {
    marginTop: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#5A2A30",
    paddingVertical: 12,
    alignItems: "center",
  },
  dangerText: { color: colors.fat, fontWeight: "700" },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.72)",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: { backgroundColor: colors.card, borderRadius: 18, padding: 16 },
});
