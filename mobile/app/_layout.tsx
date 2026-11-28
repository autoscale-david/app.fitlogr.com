import "react-native-gesture-handler";
import { router, Stack } from "expo-router";
import { useEffect } from "react";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import "../services/crashLog";
import "../services/engine/background";
import { listenForNotificationOpens } from "../services/engine/notify";
import { StoreProvider } from "../services/store";
import { colors } from "../theme";

function modalRoute(name: string): boolean {
  return name === "weight" || name === "meal/[id]" || name.startsWith("meal/");
}

export default function RootLayout() {
  useEffect(() => listenForNotificationOpens((date) => router.push({ pathname: "/", params: { date } })), []);
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <StoreProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={({ route }) => ({
            headerShown: false,
            contentStyle: { backgroundColor: colors.bg },
            presentation: modalRoute(route.name) ? "modal" : "card",
          })}
        />
      </StoreProvider>
    </GestureHandlerRootView>
  );
}
