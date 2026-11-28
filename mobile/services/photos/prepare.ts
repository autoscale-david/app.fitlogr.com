import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";
import { PHOTO_LIMITS, dHashFromLuma, pngLuma } from "@fitlogr/shared";
import { debugLog, describeError } from "../debugLog";

export interface PreparedMealImage {
  uri: string;
  sha256: string;
  dhash: string | null;
  width: number;
  height: number;
}

/** Resize to at most 1280px, re-encode as JPEG (this drops EXIF and GPS), and hash the bytes. */
export async function prepareMealImage(uri: string): Promise<PreparedMealImage> {
  const context = ImageManipulator.manipulate(uri, {
    maxWidth: PHOTO_LIMITS.maxEdgePx,
    maxHeight: PHOTO_LIMITS.maxEdgePx,
  });
  let image: Awaited<ReturnType<typeof context.renderAsync>> | null = null;
  try {
    image = await context.renderAsync();
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: PHOTO_LIMITS.jpegQuality });
    const bytes = await new File(saved.uri).bytes();
    const sha256 = await sha256Hex(bytes);
    return {
      uri: saved.uri,
      sha256,
      dhash: await perceptualHash(uri),
      width: saved.width,
      height: saved.height,
    };
  } finally {
    // Each holds a decoded image in native memory. An import goes through thousands of photos.
    release(image);
    release(context);
  }
}

function release(shared: { release(): void } | null): void {
  try {
    shared?.release();
  } catch {
    // Already released.
  }
}

let hashFailureLogged = false;

async function perceptualHash(uri: string): Promise<string | null> {
  const context = ImageManipulator.manipulate(uri, { maxWidth: 64, maxHeight: 64 });
  let image: Awaited<ReturnType<typeof context.renderAsync>> | null = null;
  try {
    context.resize({ width: 9, height: 8 });
    image = await context.renderAsync();
    const saved = await image.saveAsync({ format: SaveFormat.PNG, compress: 1 });
    const decoded = await pngLuma(await new File(saved.uri).bytes());
    return dHashFromLuma(decoded.luma, decoded.width, decoded.height);
  } catch (error) {
    // Without this hash two shots of the same plate are logged as two meals, so say so once.
    if (!hashFailureLogged) debugLog("photo", `near-duplicate hash could not be computed: ${describeError(error)}`);
    hashFailureLogged = true;
    return null;
  } finally {
    release(image);
    release(context);
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
