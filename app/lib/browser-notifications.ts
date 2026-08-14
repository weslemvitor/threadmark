import {
  resolveBrowserNotificationState,
  type BrowserNotificationState,
} from "./investigation-notifications";

export const SUPPORT_NOTIFICATION_PREFERENCE_KEY =
  "threadmark:investigation-notifications";

export type { BrowserNotificationState } from "./investigation-notifications";

function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function getBrowserNotificationState(): BrowserNotificationState {
  const supported = notificationsSupported();
  const optedIn =
    supported &&
    window.localStorage.getItem(SUPPORT_NOTIFICATION_PREFERENCE_KEY) === "enabled";
  return resolveBrowserNotificationState({
    supported,
    permission: supported ? Notification.permission : "default",
    optedIn,
  });
}

export async function enableBrowserNotifications(): Promise<BrowserNotificationState> {
  if (!notificationsSupported()) return "unsupported";

  const permission =
    Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();

  if (permission !== "granted") {
    window.localStorage.removeItem(SUPPORT_NOTIFICATION_PREFERENCE_KEY);
    return permission === "denied" ? "blocked" : "disabled";
  }

  window.localStorage.setItem(SUPPORT_NOTIFICATION_PREFERENCE_KEY, "enabled");
  return "enabled";
}

export function disableBrowserNotifications(): BrowserNotificationState {
  if (!notificationsSupported()) return "unsupported";
  window.localStorage.removeItem(SUPPORT_NOTIFICATION_PREFERENCE_KEY);
  return Notification.permission === "denied" ? "blocked" : "disabled";
}

export function showBrowserNotification(input: {
  title: string;
  body: string;
  tag: string;
  onClick?: () => void;
}): boolean {
  if (getBrowserNotificationState() !== "enabled") return false;

  const notification = new Notification(input.title, {
    body: input.body,
    tag: input.tag,
  });
  notification.onclick = () => {
    notification.close();
    window.focus();
    input.onClick?.();
  };
  return true;
}
