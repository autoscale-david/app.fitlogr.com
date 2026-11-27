import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import type { LogAlert } from "@fitlogr/shared";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export async function postAlerts(alerts: readonly LogAlert[]): Promise<void> {
  const pending = alerts.filter((alert) => !alert.inApp);
  if (pending.length === 0 || Platform.OS === "web") return;
  const permission = await Notifications.getPermissionsAsync();
  if (permission.status !== "granted") return;
  for (const alert of pending) {
    await Notifications.scheduleNotificationAsync({
      content: { title: alert.title, body: alert.body, data: { date: alert.localDate } },
      trigger: null,
    });
  }
}

export async function ensureNotificationPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.status === "granted") return true;
  if (!current.canAskAgain) return false;
  const next = await Notifications.requestPermissionsAsync();
  return next.status === "granted";
}

export function listenForNotificationOpens(open: (date: string) => void): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const date = response.notification.request.content.data?.date;
    if (typeof date === "string") open(date);
  });
  return () => subscription.remove();
}
