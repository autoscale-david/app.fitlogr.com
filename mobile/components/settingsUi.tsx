import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../theme";

/** Compact Settings styles shared by the Settings tab, its detail screens, and their cards. */
export const ui = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, marginTop: 8 },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
  body: { color: colors.muted, fontSize: 13, lineHeight: 18, marginTop: 4 },
  meta: { color: colors.faint, fontSize: 12, lineHeight: 16, marginTop: 4 },
  error: { color: colors.fat, fontSize: 13, marginTop: 4 },
  primary: { marginTop: 10, backgroundColor: colors.green, borderRadius: 10, paddingVertical: 9, alignItems: "center" },
  primaryText: { color: "#062214", fontWeight: "800", fontSize: 14 },
  secondary: { marginTop: 8, borderRadius: 10, borderWidth: 1, borderColor: "#2E3338", paddingVertical: 8, alignItems: "center" },
  secondaryText: { color: colors.text, fontWeight: "700", fontSize: 14 },
  danger: { marginTop: 8, borderRadius: 10, borderWidth: 1, borderColor: "#5A2A30", paddingVertical: 8, alignItems: "center" },
  dangerText: { color: colors.fat, fontWeight: "700", fontSize: 14 },
  input: { backgroundColor: "#222428", color: colors.text, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6, fontSize: 15 },
  inlineRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 8 },
  label: { color: colors.muted, fontSize: 14 },
});

/** Pushed Settings details screen: back chevron, title, and a compact scroll body. */
export function DetailScreen({ title, children }: { title: string; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.header, { paddingTop: insets.top + 4 }]}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.back} accessibilityRole="button" accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={22} color={colors.text} />
          <Text style={styles.backText}>Settings</Text>
        </Pressable>
        <Text style={styles.title}>{title}</Text>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
    </View>
  );
}

/** One tappable summary line in the Settings list; `leading` replaces the title (e.g. an avatar row). */
export function SummaryRow({
  title,
  lines,
  onPress,
  first,
  leading,
}: {
  title: string;
  lines: string[];
  onPress: () => void;
  first?: boolean;
  leading?: ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, !first && styles.rowDivider, pressed && styles.rowPressed]}
      accessibilityRole="button"
      accessibilityLabel={`${title}: ${lines.join(", ")}`}
    >
      {leading}
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        {lines.map((line, index) => (
          <Text key={index} style={styles.rowLine} numberOfLines={1}>
            {line}
          </Text>
        ))}
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.faint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 12, paddingBottom: 4 },
  back: { flexDirection: "row", alignItems: "center", marginLeft: -6, alignSelf: "flex-start", paddingVertical: 4 },
  backText: { color: colors.text, fontSize: 15 },
  title: { color: colors.text, fontSize: 24, fontWeight: "800", letterSpacing: -0.4, marginTop: 2 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 9 },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#2E3338" },
  rowPressed: { backgroundColor: colors.selectedDay },
  rowBody: { flex: 1, minWidth: 0 },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
  rowLine: { color: colors.muted, fontSize: 13, lineHeight: 17, marginTop: 1 },
});
