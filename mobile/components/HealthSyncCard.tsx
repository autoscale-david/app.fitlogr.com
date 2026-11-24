import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { HealthConnection } from "../services/health";
import { colors } from "../theme";

export function HealthSyncCard({
  connection,
  syncing,
  onSync,
}: {
  connection: HealthConnection | null;
  syncing: boolean;
  onSync: () => void;
}) {
  const connected = connection?.connected === true;
  const unsupported = connection?.providerId === "unsupported";
  const label = connected ? "Sync Apple Health now" : "Connect Apple Health";
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Apple Health</Text>
      <Text style={styles.body}>{connection?.message ?? "Checking Apple Health…"}</Text>
      {connection?.lastSyncedAt ? <Text style={styles.meta}>Last synced {new Date(connection.lastSyncedAt).toLocaleString()}</Text> : null}
      {connection && !unsupported ? (
        <Pressable style={styles.button} disabled={syncing} onPress={onSync}>
          {syncing ? <ActivityIndicator color="#062214" /> : <Text style={styles.buttonText}>{label}</Text>}
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: 18,
    padding: 16,
    marginTop: 14,
  },
  cardTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  body: { color: colors.muted, marginTop: 6, lineHeight: 20 },
  meta: { color: colors.faint, marginTop: 8 },
  button: {
    marginTop: 14,
    backgroundColor: colors.green,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  buttonText: { color: "#062214", fontWeight: "800" },
});
