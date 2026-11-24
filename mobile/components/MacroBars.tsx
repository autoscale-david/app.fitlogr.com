import { StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";

interface Macro {
  label: string;
  value: number;
  target: number;
  color: string;
}

export function MacroBars({ macros }: { macros: Macro[] }) {
  return (
    <View style={styles.card}>
      {macros.map((macro) => {
        const ratio = macro.target > 0 ? Math.min(macro.value / macro.target, 1) : 0;
        return (
          <View key={macro.label} style={styles.column}>
            <Text style={styles.label}>{macro.label}</Text>
            <Text style={styles.value}>
              {macro.value}g
              <Text style={styles.target}> / {macro.target}g</Text>
            </Text>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${ratio * 100}%`, backgroundColor: macro.color }]} />
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 12,
    backgroundColor: colors.card,
    borderRadius: 22,
    paddingVertical: 16,
    paddingHorizontal: 8,
    flexDirection: "row",
  },
  column: { flex: 1, paddingHorizontal: 10 },
  label: { color: colors.text, fontSize: 16, fontWeight: "700" },
  value: { color: colors.text, fontSize: 15, marginTop: 6, fontWeight: "600" },
  target: { color: colors.muted, fontWeight: "500" },
  track: {
    marginTop: 10,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#2A2D31",
    overflow: "hidden",
  },
  fill: { height: 4, borderRadius: 2 },
});
