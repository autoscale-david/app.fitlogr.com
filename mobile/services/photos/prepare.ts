import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";
import { PHOTO_LIMITS, dHashFromLuma, pngLuma } from "@fitlogr/shared";

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
  const image = await context.renderAsync();
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
}

async function perceptualHash(uri: string): Promise<string | null> {
  try {
    const context = ImageManipulator.manipulate(uri, { maxWidth: 64, maxHeight: 64 });
    context.resize({ width: 9, height: 8 });
    const image = await context.renderAsync();
    const saved = await image.saveAsync({ format: SaveFormat.PNG, compress: 1 });
    const decoded = await pngLuma(await new File(saved.uri).bytes());
    return dHashFromLuma(decoded.luma, decoded.width, decoded.height);
  } catch {
    return null;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
