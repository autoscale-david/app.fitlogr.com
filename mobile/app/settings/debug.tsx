import { useCallback, useState } from "react";
import { ActivityIndicator, Platform, Pressable, Share, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { DetailScreen, ui } from "../../components/settingsUi";
import { clearDebugLog, debugLog } from "../../services/debugLog";
import { buildDebugReport, buildLabel } from "../../services/debugReport";
import { runPass } from "../../services/engine/runPass";
import { colors } from "../../theme";

/**
 * Everything needed to diagnose the app from a distance, as text that can be copied out.
 * "Copy or share" opens the iOS share sheet, which has Copy at the top.
 */
export default function DebugLogsScreen() {
  const [report, setReport] = useState<string | null>(null);
  const [busy, setBusy] = useState<"load" | "pass" | null>("load");

  const load = useCallback(async () => {
    setBusy((current) => current ?? "load");
    try {
      setReport(await buildDebugReport());
    } catch (error) {
      setReport(`The report could not be built: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <DetailScreen title="Debug logs">
      <Text style={ui.body}>
        What this build is, what the phone allows, where each photo stands, and the recent activity log. It has no password, token, email
        or photo in it. Build {buildLabel()}.
      </Text>
      <Pressable
        style={ui.primary}
        disabled={!report}
        onPress={() => {
          if (report) void Share.share({ message: report }).catch(() => undefined);
        }}
        accessibilityRole="button"
      >
        <Text style={ui.primaryText}>Copy or share the report</Text>
      </Pressable>
      <View style={styles.row}>
        <Pressable style={[ui.secondary, styles.action]} disabled={busy !== null} onPress={() => void load()} accessibilityRole="button">
          <Text style={ui.secondaryText}>Refresh</Text>
        </Pressable>
        <Pressable
          style={[ui.secondary, styles.action]}
          disabled={busy !== null}
          onPress={() => {
            setBusy("pass");
            debugLog("debug", "Check now tapped");
            void runPass({ reason: "manual", active: true })
              .catch(() => undefined)
              .then(load);
          }}
          accessibilityRole="button"
        >
          <Text style={ui.secondaryText}>{busy === "pass" ? "Checking…" : "Check photos now"}</Text>
        </Pressable>
        <Pressable
          style={[ui.secondary, styles.action]}
          disabled={busy !== null}
          onPress={() => {
            void clearDebugLog().then(load);
          }}
          accessibilityRole="button"
        >
          <Text style={ui.secondaryText}>Clear log</Text>
        </Pressable>
      </View>
      {busy ? <ActivityIndicator color={colors.green} style={styles.spinner} /> : null}
      {report ? (
        <Text style={styles.report} selectable>
          {report}
        </Text>
      ) : null}
    </DetailScreen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 8 },
  action: { flex: 1 },
  spinner: { marginTop: 12 },
  report: {
    color: colors.muted,
    fontSize: 11,
    lineHeight: 15,
    marginTop: 12,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
});
