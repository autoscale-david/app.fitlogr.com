import { base64UrlToJson, encodeUtf8, jsonToBase64Url, bytesToBase64Url, base64UrlToBytes } from "./encoding";

export interface AccessClaims {
  sub: string;
  sid: string;
  did: string;
  iat: number;
  exp: number;
  iss: "fitlogr";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encodeUtf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signAccessToken(claims: AccessClaims, secret: string): Promise<string> {
  const encoded = `${jsonToBase64Url({ alg: "HS256", typ: "JWT" })}.${jsonToBase64Url(claims)}`;
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encodeUtf8(encoded));
  return `${encoded}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export async function verifyAccessToken(token: string, secret: string, nowSeconds: number): Promise<AccessClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSignature) return null;
  let header: unknown;
  try {
    header = base64UrlToJson(encodedHeader);
  } catch {
    return null;
  }
  if (!isRecord(header) || header.alg !== "HS256") return null;
  const key = await hmacKey(secret);
  let signature: Uint8Array;
  try {
    signature = base64UrlToBytes(encodedSignature);
  } catch {
    return null;
  }
  const valid = await crypto.subtle.verify("HMAC", key, signature, encodeUtf8(`${encodedHeader}.${encodedPayload}`));
  if (!valid) return null;
  let payload: unknown;
  try {
    payload = base64UrlToJson(encodedPayload);
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;
  if (payload.iss !== "fitlogr") return null;
  if (typeof payload.sub !== "string" || typeof payload.sid !== "string" || typeof payload.did !== "string") return null;
  if (typeof payload.exp !== "number" || payload.exp < nowSeconds - 30) return null;
  return {
    sub: payload.sub,
    sid: payload.sid,
    did: payload.did,
    iat: typeof payload.iat === "number" ? payload.iat : nowSeconds,
    exp: payload.exp,
    iss: "fitlogr",
  };
}

export async function verifyRs256Jwt(token: string, jwk: JsonWebKey): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSignature) return null;
  let header: unknown;
  try {
    header = base64UrlToJson(encodedHeader);
  } catch {
    return null;
  }
  if (!isRecord(header) || header.alg !== "RS256") return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  let signature: Uint8Array;
  try {
    signature = base64UrlToBytes(encodedSignature);
  } catch {
    return null;
  }
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    encodeUtf8(`${encodedHeader}.${encodedPayload}`),
  );
  if (!valid) return null;
  try {
    const payload = base64UrlToJson(encodedPayload);
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

export function readJwtKid(token: string): string | null {
  const encodedHeader = token.split(".")[0];
  if (!encodedHeader) return null;
  try {
    const header = base64UrlToJson(encodedHeader);
    return isRecord(header) && typeof header.kid === "string" ? header.kid : null;
  } catch {
    return null;
  }
}
