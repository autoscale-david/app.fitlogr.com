/**
 * App return URLs are allowlisted before they are stored and again before the
 * Google callback redirects. An EAS Update opened from its QR code is
 * `exp://u.expo.dev/<project>/group/<group>/`. Expo Go's `Linking.createURL`
 * (SDK 58) appends `/--/auth/callback` onto that path and, when the linking
 * URI already ends in `/`, emits a double slash:
 * `exp://u.expo.dev/<project>/group/<group>//--/auth/callback`.
 * Standalone builds use `fitlogr://auth/callback`. Anything else is rejected.
 */
const PROJECT_ID = "1964593c-a6a0-49e5-a35b-240cf2bf254e";
const OWNER_PATH = "/@davidcgweb/fitlogr";
const EXPO_AUTH_PROXY =
  /^https:\/\/auth\.expo\.io\/@[A-Za-z0-9_-]+\/fitlogr(?:\/auth\/callback|\/--\/auth\/callback)?\/?$/;
const UPDATE_ID = "[A-Za-z0-9][A-Za-z0-9_-]{7,80}";
const EXPO_GO_HOSTS = new Set(["u.expo.dev", "exp.host", "expo.dev"]);

function isNativeCallback(url: URL): boolean {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (url.hostname === "auth" && path === "/callback") return true;
  return url.hostname === "" && path === "/auth/callback";
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

function normalizePath(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, "/");
  if (collapsed.length > 1 && collapsed.endsWith("/")) return collapsed.slice(0, -1);
  return collapsed;
}

/** Path before `/--/auth/callback`, or before `/auth/callback` when the Expo marker is absent. */
function callbackBase(pathname: string): string | null {
  const path = normalizePath(pathname);
  const marked = /^(.*)\/--\/auth\/callback$/.exec(path);
  if (marked) return marked[1] ?? "";
  const plain = /^(.*)\/auth\/callback$/.exec(path);
  return plain ? plain[1] ?? "" : null;
}

function isFitlogrExperience(base: string): boolean {
  if (base.includes("..")) return false;
  if (base === `/${PROJECT_ID}` || base === OWNER_PATH) return true;
  return (
    new RegExp(`^/${PROJECT_ID}/group/${UPDATE_ID}$`).test(base) ||
    new RegExp(`^/update/${UPDATE_ID}$`).test(base)
  );
}

/**
 * `new URL("exp:///u.expo.dev/...")` has an empty host and the real host in
 * the path. Pull that host back out so the same rules apply. Node and workerd
 * (compatibility date 2026-11-23) both parse it this way.
 */
function expoGoLocation(url: URL): { hostname: string; pathname: string } | null {
  if (url.hostname) return { hostname: url.hostname, pathname: url.pathname };
  const nested = /^\/(u\.expo\.dev|exp\.host|expo\.dev)(\/.*)$/.exec(url.pathname);
  if (!nested?.[1] || !nested[2]) return null;
  return { hostname: nested[1], pathname: nested[2] };
}

function expoGoHostAllowed(hostname: string, pathname: string): boolean {
  const base = callbackBase(pathname);
  if (base === null || base.includes("..")) return false;
  if (isPrivateOrLoopback(hostname) || isExpoTunnel(hostname)) return base === "";
  if (!EXPO_GO_HOSTS.has(hostname)) return false;
  if (hostname === "u.expo.dev") return isFitlogrExperience(base);
  return base === OWNER_PATH;
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
    const location = expoGoLocation(url);
    return location !== null && expoGoHostAllowed(location.hostname, location.pathname);
  }
  return false;
}

/** Scheme, host, and path only. Query values are omitted and the result is capped at 180 characters. */
export function describeRejectedRedirect(value: string): string {
  try {
    const url = new URL(value);
    const host = url.host || url.hostname;
    return `${url.protocol}//${host}${url.pathname}`.slice(0, 180);
  } catch {
    return value.replace(/[\s\\]/g, "").slice(0, 180);
  }
}

export function redirectWithParams(redirectUri: string, params: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}
