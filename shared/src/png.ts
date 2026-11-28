import { inflateZlib } from "./inflate";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export interface PngLuma {
  width: number;
  height: number;
  luma: Uint8Array;
}

/**
 * Decode a small non-interlaced PNG into row-major 8-bit grayscale. Used for dHash.
 * Accepts 8 and 16 bits per channel: an iPhone with a wide-colour screen writes 16.
 */
export async function pngLuma(bytes: Uint8Array): Promise<PngLuma> {
  if (!hasSignature(bytes)) throw new Error("Not a PNG");
  let width = 0;
  let height = 0;
  let colorType = -1;
  let bytesPerSample = 1;
  const idat: Uint8Array[] = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    const dataStart = offset + 8;
    const next = dataStart + length + 4;
    if (length < 0 || next > bytes.length) throw new Error("Truncated PNG");
    const data = bytes.subarray(dataStart, dataStart + length);
    if (type === "IHDR") {
      width = readUint32(data, 0);
      height = readUint32(data, 4);
      const bitDepth = data[8];
      colorType = data[9] ?? -1;
      if ((bitDepth !== 8 && bitDepth !== 16) || data[12] !== 0) throw new Error("Unsupported PNG");
      bytesPerSample = bitDepth / 8;
      if (width < 1 || height < 1 || width > 64 || height > 64) throw new Error("Unexpected PNG size");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = next;
  }
  const channels = channelsFor(colorType);
  if (!width || !height || channels === 0) throw new Error("Incomplete PNG");
  const compressed = concat(idat);
  const inflated = inflateZlib(compressed, 1 << 20);
  const bytesPerPixel = channels * bytesPerSample;
  const stride = width * bytesPerPixel;
  const expected = height * (stride + 1);
  if (inflated.length < expected) throw new Error("Truncated PNG pixels");
  const samples = unfilter(inflated, width, height, bytesPerPixel);
  // A 16-bit sample is stored high byte first, and the high byte is the 8-bit value.
  const raw = bytesPerSample === 1 ? samples : samples.filter((_, index) => index % 2 === 0);
  const luma = new Uint8Array(width * height);
  for (let index = 0; index < luma.length; index += 1) {
    const pixel = index * channels;
    if (channels === 1) luma[index] = raw[pixel] ?? 0;
    else {
      const red = raw[pixel] ?? 0;
      const green = raw[pixel + 1] ?? 0;
      const blue = raw[pixel + 2] ?? 0;
      luma[index] = Math.round(0.299 * red + 0.587 * green + 0.114 * blue);
    }
  }
  return { width, height, luma };
}

function hasSignature(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function channelsFor(colorType: number): number {
  if (colorType === 0) return 1;
  if (colorType === 2) return 3;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  return 0;
}

function unfilter(data: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = data[offset] ?? 0;
    offset += 1;
    for (let x = 0; x < stride; x += 1) {
      const raw = data[offset] ?? 0;
      offset += 1;
      const left = x >= channels ? (out[y * stride + x - channels] ?? 0) : 0;
      const up = y > 0 ? (out[(y - 1) * stride + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= channels ? (out[(y - 1) * stride + x - channels] ?? 0) : 0;
      let value = raw;
      if (filter === 1) value = (raw + left) & 255;
      else if (filter === 2) value = (raw + up) & 255;
      else if (filter === 3) value = (raw + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) value = (raw + paeth(left, up, upLeft)) & 255;
      else if (filter !== 0) throw new Error("Unsupported PNG filter");
      out[y * stride + x] = value;
    }
  }
  return out;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
}

function concat(chunks: Uint8Array[], knownLength?: number): Uint8Array {
  const total = knownLength ?? chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}
