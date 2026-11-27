import "react-native-gesture-handler";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StoreProvider } from "../services/store";
import { colors } from "../theme";

function modalRoute(name: string): boolean {
  return name === "weight" || name === "meal/[id]" || name.startsWith("meal/");
}

export default function RootLayout() {
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
