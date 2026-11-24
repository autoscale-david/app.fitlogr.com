import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function HomeScreen() {
  const appVersion = Constants.expoConfig?.version ?? "0.1.0";
  const runtimeVersion = Updates.runtimeVersion ?? "dev";
  const channel = Updates.channel || "development";
  const updateId = Updates.updateId ? Updates.updateId.slice(0, 8) : "embedded";

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.brand}>fitlogr</Text>
        <Text style={styles.tagline}>
          Take photos. Wear your watch. Know your progress.
        </Text>
        <View style={styles.metaList}>
          <MetaRow label="Version" value={appVersion} />
          <MetaRow label="Runtime" value={runtimeVersion} />
          <MetaRow label="Channel" value={channel} />
          <MetaRow label="Update" value={updateId} />
        </View>
      </View>
    </SafeAreaView>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0F172A",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 400,
    backgroundColor: "#1E293B",
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: "#334155",
  },
  brand: {
    fontSize: 32,
    fontWeight: "700",
    color: "#F8FAFC",
    letterSpacing: -0.5,
  },
  tagline: {
    marginTop: 8,
    fontSize: 15,
    lineHeight: 22,
    color: "#94A3B8",
  },
  metaList: {
    marginTop: 24,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: "#334155",
    gap: 10,
  },
  metaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  metaLabel: {
    fontSize: 13,
    color: "#94A3B8",
  },
  metaValue: {
    fontSize: 13,
    fontWeight: "600",
    color: "#38BDF8",
  },
});
