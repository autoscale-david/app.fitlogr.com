/**
 * App return URLs are allowlisted before they are stored and again before the
 * Google callback redirects. Expo Go (including an EAS Update) builds
 * `exp://` or `exps://` links such as
 * `exp://u.expo.dev/update/<id>/--/auth/callback`. Standalone builds use
 * `fitlogr://auth/callback`. Anything else is rejected before it is stored.
 */
const PROJECT_ID = "1964593c-a6a0-49e5-a35b-240cf2bf254e";
const OWNER_PATH = "/@davidcgweb/fitlogr";
const EXPO_AUTH_PROXY =
  /^https:\/\/auth\.expo\.io\/@[A-Za-z0-9_-]+\/fitlogr(?:\/auth\/callback|\/--\/auth\/callback)?\/?$/;
const UPDATE_ID = "[A-Za-z0-9][A-Za-z0-9_-]{7,80}";

function isNativeCallback(url: URL): boolean {
  return url.hostname === "auth" && (url.pathname === "/callback" || url.pathname === "/callback/");
}

function isExpoCallback(pathname: string): boolean {
  return /\/(?:--\/)?auth\/callback\/?$/.test(pathname);
}

function isPrivateOrLoopback(hostname: string): boolean {
  if (hostname === "localhost") return true;
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b] = octets;
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  return a === 172 && b >= 16 && b <= 31;
}

function isExpoTunnel(hostname: string): boolean {
  return hostname.endsWith(".exp.direct") && !hostname.endsWith("..exp.direct");
}

function exactDevCallback(pathname: string): boolean {
  const path = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return path === "/--/auth/callback" || path === "/auth/callback";
}

function expoUpdateCallback(pathname: string): boolean {
  const path = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return (
    new RegExp(`^/update/${UPDATE_ID}/(?:--/)?auth/callback$`).test(path) ||
    new RegExp(`^/${PROJECT_ID}/(?:--/)?auth/callback$`).test(path) ||
    new RegExp(`^${OWNER_PATH}/(?:--/)?auth/callback$`).test(path)
  );
}

function ownerCallback(pathname: string): boolean {
  const path = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return new RegExp(`^${OWNER_PATH}/(?:--/)?auth/callback$`).test(path);
}

function expoGoHostAllowed(hostname: string, pathname: string): boolean {
  if (hostname === "u.expo.dev") return expoUpdateCallback(pathname);
  if (hostname === "exp.host") return ownerCallback(pathname);
  if (isPrivateOrLoopback(hostname) || isExpoTunnel(hostname)) return exactDevCallback(pathname);
  return false;
}

export function isAllowedAppRedirect(value: string): boolean {
  if (value.length === 0 || value.length > 500 || /[\s\\]/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;

  if (url.protocol === "fitlogr:") {
    return !url.search && !url.port && isNativeCallback(url);
  }
  if (url.protocol === "exp+fitlogr:") {
    return isNativeCallback(url) || isExpoCallback(url.pathname);
  }
  if (url.protocol === "https:") {
    return !url.search && EXPO_AUTH_PROXY.test(value);
  }
  if (url.protocol === "exp:" || url.protocol === "exps:") {
    return expoGoHostAllowed(url.hostname, url.pathname);
  }
  return false;
}

export function redirectWithParams(redirectUri: string, params: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}
