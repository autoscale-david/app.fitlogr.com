import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";

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
    <View style={styles.banner}>
      <Text style={styles.title}>Reconnect Google</Text>
      <Text style={styles.body}>
        Google Photos access was revoked. Your meals stay here. Reconnect to keep saving new photos to your fitlogr album.
      </Text>
      <Pressable style={styles.button} disabled={busy} onPress={onReconnect}>
        {busy ? <ActivityIndicator color="#062214" /> : <Text style={styles.buttonText}>Reconnect Google</Text>}
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
    <View style={styles.sync}>
      <Text style={styles.title}>{waiting ? "Waiting to sync" : syncing ? "Syncing" : "Sync"}</Text>
      <Text style={styles.body}>
        {waiting ? `${pending} change${pending === 1 ? "" : "s"} on this phone` : "Nothing waiting"}
        {" · "}
        {syncing ? "Syncing now" : `Last synced ${synced}`}
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable style={styles.secondary} disabled={syncing} onPress={onRetry}>
        <Text style={styles.secondaryText}>{syncing ? "Syncing…" : "Retry Sync"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: "#2A2116",
    borderRadius: 18,
    padding: 16,
    marginBottom: 12,
  },
  sync: {
    backgroundColor: colors.card,
    borderRadius: 18,
    padding: 16,
    marginBottom: 12,
  },
  title: { color: colors.text, fontSize: 16, fontWeight: "700" },
  body: { color: colors.muted, marginTop: 6, lineHeight: 20 },
  error: { color: colors.fat, marginTop: 8 },
  button: {
    marginTop: 12,
    backgroundColor: colors.green,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  buttonText: { color: "#062214", fontWeight: "800" },
  secondary: {
    marginTop: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#2E3338",
    paddingVertical: 12,
    alignItems: "center",
  },
  secondaryText: { color: colors.text, fontWeight: "700" },
});
