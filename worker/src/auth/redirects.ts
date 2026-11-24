/**
 * App return URLs are allowlisted. This is intentionally stricter than an
 * environment flag: production still accepts Expo Go (`exp://` and
 * `https://auth.expo.io`) so a preview opened in Expo Go can finish Google
 * sign-in, but only for the fitlogr slug and known Expo hosts. Anything else
 * is rejected before it is stored.
 */
const FITLOGR_NATIVE = /^fitlogr:\/\/auth\/callback\/?$/;
const EXPO_AUTH_PROXY =
  /^https:\/\/auth\.expo\.io\/@[A-Za-z0-9_-]+\/fitlogr(?:\/auth\/callback|\/--\/auth\/callback)?\/?$/;

function isExpoHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "exp.host" || hostname === "u.expo.dev") return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    return hostname.split(".").every((part) => Number(part) <= 255);
  }
  return hostname.endsWith(".exp.direct") || hostname.endsWith(".expo.dev");
}

function isExpoPath(pathname: string): boolean {
  if (pathname === "/--/auth/callback" || pathname === "/--/auth/callback/") return true;
  return /^\/@[A-Za-z0-9._-]+\/fitlogr\/--\/auth\/callback\/?$/.test(pathname);
}

export function isAllowedAppRedirect(value: string): boolean {
  if (value.length > 500 || /[\s\\]/.test(value) || value.includes("@") && !value.includes("://")) return false;
  if (FITLOGR_NATIVE.test(value) || EXPO_AUTH_PROXY.test(value)) return validatedUrl(value);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol !== "exp:") return false;
  if (!isExpoHost(url.hostname) || !isExpoPath(url.pathname)) return false;
  return true;
}

function validatedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function redirectWithParams(redirectUri: string, params: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}
