import { useEffect, useState } from "react";
import { Alert, Image, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { caloriePlanSummary } from "@fitlogr/shared";
import { formatSyncedAt, SessionExpiredBanner } from "../../components/AccountBanners";
import { Segmented } from "../../components/planControls";
import { initials, SummaryRow, ui } from "../../components/settingsUi";
import { localDateISO } from "../../services/dates";
import { AuthCancelled, useStore } from "../../services/store";
import { useGoalsDraft } from "../../services/useGoalsDraft";
import { colors } from "../../theme";

const APP_VERSION_LABEL = "fitlogr v1.12";
const UNIT_OPTIONS = [
  { value: "imperial" as const, label: "Imperial" },
  { value: "metric" as const, label: "Metric" },
];

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const store = useStore();
  const [draft, save] = useGoalsDraft();
  const [reconnecting, setReconnecting] = useState(false);

  if (!draft) {
    return <View style={styles.screen} />;
  }

  const account = store.account;
  const plan = caloriePlanSummary(draft.plan, localDateISO());

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 12, paddingBottom: 24 }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>Settings</Text>

      <SessionExpiredBanner
        visible={store.sessionExpired}
        busy={reconnecting}
        onSignIn={() => {
          setReconnecting(true);
          store
            .signIn()
            .catch((error: unknown) => {
              if (error instanceof AuthCancelled) return;
              Alert.alert("Sign in", error instanceof Error ? error.message : "Sign-in failed");
            })
            .finally(() => setReconnecting(false));
        }}
      />

      <View style={[ui.card, styles.list]}>
        <SummaryRow
          first
          title={account ? account.displayName || "Google account" : "Account"}
          lines={account ? [account.email] : ["Not signed in · Connect Google to sync"]}
          leading={<Avatar name={account?.displayName || account?.email || null} />}
          onPress={() => router.push("/settings/account")}
        />
        <SummaryRow title="My Data" lines={dataSummary(store)} onPress={() => router.push("/settings/data")} />
        <SummaryRow title="Calorie Plan" lines={[plan.title, plan.today]} onPress={() => router.push("/settings/plan")} />
      </View>

      <View style={[ui.card, styles.unitsRow]}>
        <Text style={ui.cardTitle}>Units</Text>
        <Segmented
          options={UNIT_OPTIONS}
          value={draft.unitSystem}
          onChange={(unitSystem) => save({ ...draft, unitSystem })}
          style={styles.unitsSegment}
        />
      </View>

      <View style={ui.card}>
        <Text style={ui.cardTitle}>Daily targets</Text>
        <NumberField label="Protein (g)" value={draft.proteinTarget} onChange={(proteinTarget) => save({ ...draft, proteinTarget })} />
        <NumberField label="Carbs (g)" value={draft.carbsTarget} onChange={(carbsTarget) => save({ ...draft, carbsTarget })} />
        <NumberField label="Fat (g)" value={draft.fatTarget} onChange={(fatTarget) => save({ ...draft, fatTarget })} />
      </View>

      <View style={styles.footer}>
        <Image source={require("../../assets/logo.png")} style={styles.logo} resizeMode="contain" accessibilityLabel="fitlogr" />
        <Text style={styles.copyright}>{`(C) ${new Date().getFullYear()} - ${APP_VERSION_LABEL}`}</Text>
      </View>
    </ScrollView>
  );
}

function dataSummary(store: ReturnType<typeof useStore>): string[] {
  const imports = "Setup · Import · Export";
  if (store.mode !== "account") return ["Sample preview · sign in to sync", imports];
  if (store.syncError) return ["Sync needs attention · tap to retry", imports];
  if (store.syncing) return ["Syncing now", imports];
  if (store.pending > 0) return [`${store.pending} change${store.pending === 1 ? "" : "s"} waiting to sync`, imports];
  return [store.lastSyncedAt ? `Synced ${formatSyncedAt(store.lastSyncedAt)} · nothing waiting` : "Not synced yet", imports];
}

function Avatar({ name }: { name: string | null }) {
  return (
    <View style={styles.avatar}>
      <Text style={styles.avatarText}>{initials(name)}</Text>
    </View>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <View style={ui.inlineRow}>
      <Text style={ui.label}>{label}</Text>
      <TextInput
        value={text}
        keyboardType="number-pad"
        onChangeText={setText}
        onEndEditing={() => {
          const parsed = Number(text);
          if (Number.isFinite(parsed) && parsed >= 0) onChange(Math.round(parsed));
          else setText(String(value));
        }}
        style={[ui.input, styles.numberInput]}
        placeholderTextColor={colors.faint}
        accessibilityLabel={label}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  title: { color: colors.text, fontSize: 28, fontWeight: "800", letterSpacing: -0.5, marginBottom: 2 },
  list: { paddingHorizontal: 0, paddingVertical: 0, overflow: "hidden" },
  unitsRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  unitsSegment: { marginTop: 0, width: 190 },
  numberInput: { width: 76, textAlign: "right" },
  avatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: "#C48B78", alignItems: "center", justifyContent: "center" },
  avatarText: { color: "#2B1710", fontWeight: "800", fontSize: 13 },
  footer: { alignItems: "center", marginTop: 20 },
  logo: { width: 150, height: 42 },
  copyright: { color: colors.faint, fontSize: 11, marginTop: 2 },
});
