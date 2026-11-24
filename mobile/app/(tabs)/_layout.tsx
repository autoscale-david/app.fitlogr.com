import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { colors } from "../../theme";

function tint(color: unknown): string {
  return typeof color === "string" ? color : colors.muted;
}

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.green,
        tabBarInactiveTintColor: "#7E868E",
        tabBarStyle: {
          backgroundColor: colors.bg,
          borderTopColor: "#1C1F23",
          borderTopWidth: 1,
        },
        tabBarLabelStyle: { fontSize: 12, fontWeight: "600" },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Log",
          tabBarIcon: ({ color, size }) => <Ionicons name="create-outline" color={tint(color)} size={size} />,
        }}
      />
      <Tabs.Screen
        name="review"
        options={{
          title: "Review",
          tabBarIcon: ({ color, size }) => <Ionicons name="calendar-outline" color={tint(color)} size={size} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color, size }) => <Ionicons name="settings-outline" color={tint(color)} size={size} />,
        }}
      />
    </Tabs>
  );
}
