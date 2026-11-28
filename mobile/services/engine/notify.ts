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
  let handled: string | null = null;
  const handle = (response: Notifications.NotificationResponse) => {
    const id = response.notification.request.identifier;
    if (id === handled) return;
    handled = id;
    const date = response.notification.request.content.data?.date;
    if (typeof date === "string") open(date);
  };
  const subscription = Notifications.addNotificationResponseReceivedListener(handle);
  // The usual case: iOS had closed the app, and the tap is what launched it. That tap happened
  // before this listener existed, so it is read here instead.
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const launch = Notifications.getLastNotificationResponse();
    if (launch) {
      Notifications.clearLastNotificationResponse();
      // After the first screen is up; navigating before that is ignored.
      timer = setTimeout(() => handle(launch), 400);
    }
  } catch {
    // Not available on this platform.
  }
  return () => {
    if (timer) clearTimeout(timer);
    subscription.remove();
  };
}
