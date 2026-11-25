import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { ui } from "./settingsUi";

export function GoogleReconnectBanner({
  visible,
  busy,
  onReconnect,
}: {
  visible: boolean;
  busy?: boolean;
  onReconnect: () => void;
}) {
  if (!visible) return null;
  return (
    <View style={[ui.card, styles.banner]}>
      <Text style={ui.cardTitle}>Reconnect Google</Text>
      <Text style={ui.body}>
        Google Photos access was revoked. Your meals stay here. Reconnect to keep saving new photos to your fitlogr album.
      </Text>
      <Pressable style={ui.primary} disabled={busy} onPress={onReconnect}>
        {busy ? <ActivityIndicator color="#062214" /> : <Text style={ui.primaryText}>Reconnect Google</Text>}
      </Pressable>
    </View>
  );
}

export function SyncStatusBanner({
  visible,
  pending,
  lastSyncedAt,
  syncing,
  error,
  onRetry,
}: {
  visible: boolean;
  pending: number;
  lastSyncedAt: string | null;
  syncing: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (!visible) return null;
  const waiting = pending > 0;
  const synced = lastSyncedAt ? new Date(lastSyncedAt).toLocaleString() : "Not synced yet";
  return (
    <View style={ui.card}>
      <Text style={ui.cardTitle}>{waiting ? "Waiting to sync" : syncing ? "Syncing" : "Sync"}</Text>
      <Text style={ui.body}>
        {waiting ? `${pending} change${pending === 1 ? "" : "s"} on this phone` : "Nothing waiting"}
        {" · "}
        {syncing ? "Syncing now" : `Last synced ${synced}`}
      </Text>
      {error ? <Text style={ui.error}>{error}</Text> : null}
      <Pressable style={ui.secondary} disabled={syncing} onPress={onRetry}>
        <Text style={ui.secondaryText}>{syncing ? "Syncing…" : "Retry Sync"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { backgroundColor: "#2A2116" },
});
