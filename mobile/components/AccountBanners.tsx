import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { ui } from "./settingsUi";
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
  compact,
}: {
  visible: boolean;
  /** Shows a single quiet line while everything is synced; the full card returns when changes wait or sync fails. */
  compact?: boolean;
  pending: number;
  lastSyncedAt: string | null;
  syncing: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (!visible) return null;
  const waiting = pending > 0;
  const synced = lastSyncedAt ? `Synced ${formatSyncedAt(lastSyncedAt)}` : "Not synced yet";
  if (compact && !waiting && !error) {
    return <Text style={styles.quiet}>{syncing ? "Syncing now…" : `${synced} · pull down to refresh`}</Text>;
  }
  return (
    <View style={ui.card}>
      <Text style={ui.cardTitle}>{error ? "Sync needs attention" : waiting ? "Waiting to sync" : "Sync"}</Text>
      <Text style={ui.body}>
        {waiting ? `${pending} change${pending === 1 ? "" : "s"} saved on this phone` : "Nothing waiting"}
        {" · "}
        {syncing ? "Syncing now" : synced}
      </Text>
      {error ? <Text style={ui.error}>{error}</Text> : null}
      <Pressable style={ui.secondary} disabled={syncing} onPress={onRetry} accessibilityRole="button">
        <Text style={ui.secondaryText}>{syncing ? "Syncing…" : error ? "Retry sync" : "Sync now"}</Text>
      </Pressable>
    </View>
  );
}

/** "7:05 AM" today, otherwise "Nov 24, 7:05 AM". */
export function formatSyncedAt(iso: string): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

const styles = StyleSheet.create({
  banner: { backgroundColor: "#2A2116" },
  quiet: { color: colors.faint, fontSize: 12, marginTop: 8 },
});
