import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { randomUuid } from "./encoding";

const ACCESS = "fitlogr.access";
const REFRESH = "fitlogr.refresh";
const EXPIRES = "fitlogr.expires";
const DEVICE = "fitlogr.device";
const KEYS = [ACCESS, REFRESH, EXPIRES, DEVICE];

/** Readable after the first unlock, including while the phone is locked for a background pass. */
const KEYCHAIN = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

export interface StoredSession {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: string | null;
}

export async function readSession(): Promise<StoredSession> {
  const [accessToken, refreshToken, expiresAt] = await Promise.all([
    SecureStore.getItemAsync(ACCESS, KEYCHAIN),
    SecureStore.getItemAsync(REFRESH, KEYCHAIN),
    SecureStore.getItemAsync(EXPIRES, KEYCHAIN),
  ]);
  return { accessToken, refreshToken, expiresAt };
}

export async function saveSession(session: { access_token: string; refresh_token: string; expires_at: string }): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(ACCESS, session.access_token, KEYCHAIN),
    SecureStore.setItemAsync(REFRESH, session.refresh_token, KEYCHAIN),
    SecureStore.setItemAsync(EXPIRES, session.expires_at, KEYCHAIN),
  ]);
}

export async function clearSession(): Promise<void> {
  await Promise.all(KEYS.slice(0, 3).map((key) => SecureStore.deleteItemAsync(key, KEYCHAIN)));
}

export async function deviceId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DEVICE, KEYCHAIN);
  if (existing) return existing;
  const created = randomUuid(await Crypto.getRandomBytesAsync(16));
  await SecureStore.setItemAsync(DEVICE, created, KEYCHAIN);
  return created;
}

/** Rewrites values saved before background access was required. Call once while the app is unlocked. */
export async function migrateKeychain(): Promise<void> {
  await Promise.all(
    KEYS.map(async (key) => {
      const current = await SecureStore.getItemAsync(key);
      if (!current) return;
      await SecureStore.setItemAsync(key, current, KEYCHAIN);
    }),
  );
}
