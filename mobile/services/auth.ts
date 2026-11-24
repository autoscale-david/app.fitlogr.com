import * as Crypto from "expo-crypto";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";
import Constants from "expo-constants";
import { api } from "./api";
import { deviceTimeZone } from "./dates";
import { base64ToBase64Url, bytesToBase64Url } from "./encoding";
import { deviceId } from "./session";

export class AuthCancelled extends Error {
  constructor() {
    super("Sign-in cancelled");
    this.name = "AuthCancelled";
  }
}

export async function signInWithGoogle() {
  const verifierBytes = await Crypto.getRandomBytesAsync(32);
  const verifier = bytesToBase64Url(verifierBytes);
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
    encoding: Crypto.CryptoEncoding.BASE64,
  });
  const challenge = base64ToBase64Url(digest);
  const redirectUri = Linking.createURL("auth/callback");
  const device = {
    id: await deviceId(),
    platform: Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : "web",
    app_version: Constants.expoConfig?.version,
    os_version: String(Platform.Version),
  } as const;
  const started = await api.startGoogle({
    redirect_uri: redirectUri,
    client_challenge: challenge,
    timezone: deviceTimeZone(),
    device,
  });
  WebBrowser.maybeCompleteAuthSession();
  const result = await WebBrowser.openAuthSessionAsync(started.authorize_url, redirectUri);
  if (result.type !== "success") throw new AuthCancelled();
  const error = readParam(result.url, "error");
  if (error) throw new Error(signInMessage(error));
  const exchangeCode = readParam(result.url, "exchange_code");
  if (!exchangeCode) throw new Error("Google sign-in did not finish");
  return api.exchange({
    exchange_code: exchangeCode,
    client_verifier: verifier,
    device,
  });
}

function readParam(url: string, key: string): string | null {
  try {
    return new URL(url).searchParams.get(key);
  } catch {
    const match = new RegExp(`[?&]${key}=([^&]+)`).exec(url);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  }
}

function signInMessage(error: string): string {
  if (error === "access_denied") return "Google sign-in was cancelled";
  if (error === "email_required") return "Google did not share a verified email";
  if (error === "invalid_token") return "Google sign-in could not be verified";
  return "fitlogr could not finish sign-in";
}
