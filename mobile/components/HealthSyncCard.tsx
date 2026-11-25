import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { HealthConnection } from "../services/health";
import { ui } from "./settingsUi";

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
    <View style={ui.card}>
      <Text style={ui.cardTitle}>Apple Health</Text>
      <Text style={ui.body}>{connection?.message ?? "Checking Apple Health…"}</Text>
      {connection?.lastSyncedAt ? <Text style={ui.meta}>Last synced {new Date(connection.lastSyncedAt).toLocaleString()}</Text> : null}
      {connection && !unsupported ? (
        <Pressable style={ui.primary} disabled={syncing} onPress={onSync}>
          {syncing ? <ActivityIndicator color="#062214" /> : <Text style={ui.primaryText}>{label}</Text>}
        </Pressable>
      ) : null}
    </View>
  );
}
