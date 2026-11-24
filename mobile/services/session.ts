import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { randomUuid } from "./encoding";

const ACCESS = "fitlogr.access";
const REFRESH = "fitlogr.refresh";
const EXPIRES = "fitlogr.expires";
const DEVICE = "fitlogr.device";

export interface StoredSession {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: string | null;
}

export async function readSession(): Promise<StoredSession> {
  const [accessToken, refreshToken, expiresAt] = await Promise.all([
    SecureStore.getItemAsync(ACCESS),
    SecureStore.getItemAsync(REFRESH),
    SecureStore.getItemAsync(EXPIRES),
  ]);
  return { accessToken, refreshToken, expiresAt };
}

export async function saveSession(session: { access_token: string; refresh_token: string; expires_at: string }): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(ACCESS, session.access_token),
    SecureStore.setItemAsync(REFRESH, session.refresh_token),
    SecureStore.setItemAsync(EXPIRES, session.expires_at),
  ]);
}

export async function clearSession(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(ACCESS),
    SecureStore.deleteItemAsync(REFRESH),
    SecureStore.deleteItemAsync(EXPIRES),
  ]);
}

export async function deviceId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DEVICE);
  if (existing) return existing;
  const created = randomUuid(await Crypto.getRandomBytesAsync(16));
  await SecureStore.setItemAsync(DEVICE, created);
  return created;
}
