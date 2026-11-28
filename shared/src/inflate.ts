/**
 * Decompresses zlib data (RFC 1950 around RFC 1951 deflate) in plain JavaScript.
 *
 * The phone's JavaScript engine has no `DecompressionStream`, so the PNG reader cannot lean on the
 * platform. This follows the reference decoder's canonical-Huffman method: slow per bit, which does
 * not matter for the 9x8 image it is used on. The checksum at the end is not verified.
 */
export function inflateZlib(data: Uint8Array, maxOutput = 1 << 24): Uint8Array {
  const cmf = data[0];
  const flags = data[1];
  if (cmf === undefined || flags === undefined) throw new Error("Truncated zlib data");
  if ((cmf & 0x0f) !== 8 || ((cmf << 8) | flags) % 31 !== 0) throw new Error("Not zlib data");
  if (flags & 0x20) throw new Error("zlib preset dictionaries are not supported");
  return inflateRaw(data.subarray(2), maxOutput);
}

interface Huffman {
  count: Uint16Array;
  symbol: Uint16Array;
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function buildHuffman(lengths: ArrayLike<number>, from: number, to: number): Huffman {
  const count = new Uint16Array(16);
  for (let index = from; index < to; index += 1) count[lengths[index] ?? 0]! += 1;
  count[0] = 0;
  const offsets = new Uint16Array(16);
  for (let length = 1; length < 15; length += 1) offsets[length + 1] = (offsets[length] ?? 0) + (count[length] ?? 0);
  const symbol = new Uint16Array(to - from);
  for (let index = from; index < to; index += 1) {
    const length = lengths[index] ?? 0;
    if (length !== 0) {
      symbol[offsets[length]!] = index - from;
      offsets[length]! += 1;
    }
  }
  return { count, symbol };
}

let fixedTables: { lengths: Huffman; distances: Huffman } | null = null;

function fixed(): { lengths: Huffman; distances: Huffman } {
  if (fixedTables) return fixedTables;
  const lengths = new Uint8Array(288);
  for (let index = 0; index < 288; index += 1) lengths[index] = index < 144 ? 8 : index < 256 ? 9 : index < 280 ? 7 : 8;
  const distances = new Uint8Array(30).fill(5);
  fixedTables = { lengths: buildHuffman(lengths, 0, 288), distances: buildHuffman(distances, 0, 30) };
  return fixedTables;
}

function inflateRaw(source: Uint8Array, maxOutput: number): Uint8Array {
  let position = 0;
  let bitBuffer = 0;
  let bitCount = 0;
  let out = new Uint8Array(Math.min(maxOutput, Math.max(256, source.length * 4)));
  let outLength = 0;

  const bits = (need: number): number => {
    if (need === 0) return 0;
    while (bitCount < need) {
      const byte = source[position];
      if (byte === undefined) throw new Error("Truncated deflate data");
      position += 1;
      bitBuffer |= byte << bitCount;
      bitCount += 8;
    }
    const value = bitBuffer & ((1 << need) - 1);
    bitBuffer >>>= need;
    bitCount -= need;
    return value;
  };

  const decode = (table: Huffman): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let length = 1; length <= 15; length += 1) {
      code |= bits(1);
      const count = table.count[length] ?? 0;
      if (code - count < first) return table.symbol[index + (code - first)] ?? 0;
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new Error("Invalid deflate code");
  };

  const reserve = (extra: number): void => {
    if (outLength + extra > maxOutput) throw new Error("Deflate output is too large");
    if (outLength + extra <= out.length) return;
    const grown = new Uint8Array(Math.min(maxOutput, Math.max(out.length * 2, outLength + extra)));
    grown.set(out.subarray(0, outLength));
    out = grown;
  };

  const block = (lengthTable: Huffman, distanceTable: Huffman): void => {
    for (;;) {
      let symbol = decode(lengthTable);
      if (symbol < 256) {
        reserve(1);
        out[outLength] = symbol;
        outLength += 1;
        continue;
      }
      if (symbol === 256) return;
      symbol -= 257;
      const lengthBase = LENGTH_BASE[symbol];
      if (lengthBase === undefined) throw new Error("Invalid deflate length");
      const length = lengthBase + bits(LENGTH_EXTRA[symbol] ?? 0);
      const distanceSymbol = decode(distanceTable);
      const distanceBase = DISTANCE_BASE[distanceSymbol];
      if (distanceBase === undefined) throw new Error("Invalid deflate distance");
      const distance = distanceBase + bits(DISTANCE_EXTRA[distanceSymbol] ?? 0);
      if (distance > outLength) throw new Error("Deflate distance is too far back");
      reserve(length);
      // Byte by byte on purpose: the source and destination may overlap.
      for (let copied = 0; copied < length; copied += 1) {
        out[outLength] = out[outLength - distance] ?? 0;
        outLength += 1;
      }
    }
  };

  let last = 0;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuffer = 0;
      bitCount = 0;
      const low = source[position];
      const high = source[position + 1];
      if (low === undefined || high === undefined || position + 4 > source.length) throw new Error("Truncated deflate data");
      const length = low | (high << 8);
      position += 4;
      if (position + length > source.length) throw new Error("Truncated deflate data");
      reserve(length);
      out.set(source.subarray(position, position + length), outLength);
      outLength += length;
      position += length;
    } else if (type === 1) {
      const tables = fixed();
      block(tables.lengths, tables.distances);
    } else if (type === 2) {
      const lengthCodes = bits(5) + 257;
      const distanceCodes = bits(5) + 1;
      const codeLengthCodes = bits(4) + 4;
      if (lengthCodes > 286 || distanceCodes > 30) throw new Error("Invalid deflate header");
      const lengths = new Uint8Array(320);
      for (let index = 0; index < codeLengthCodes; index += 1) lengths[CODE_LENGTH_ORDER[index] ?? 0] = bits(3);
      const codeLengthTable = buildHuffman(lengths, 0, 19);
      lengths.fill(0);
      let index = 0;
      while (index < lengthCodes + distanceCodes) {
        const symbol = decode(codeLengthTable);
        if (symbol < 16) {
          lengths[index] = symbol;
          index += 1;
          continue;
        }
        let value = 0;
        let repeat = 0;
        if (symbol === 16) {
          if (index === 0) throw new Error("Invalid deflate header");
          value = lengths[index - 1] ?? 0;
          repeat = 3 + bits(2);
        } else if (symbol === 17) repeat = 3 + bits(3);
        else repeat = 11 + bits(7);
        if (index + repeat > lengthCodes + distanceCodes) throw new Error("Invalid deflate header");
        for (; repeat > 0; repeat -= 1) {
          lengths[index] = value;
          index += 1;
        }
      }
      if (lengths[256] === 0) throw new Error("Invalid deflate header");
      block(buildHuffman(lengths, 0, lengthCodes), buildHuffman(lengths, lengthCodes, lengthCodes + distanceCodes));
    } else {
      throw new Error("Invalid deflate block");
    }
  } while (!last);

  return out.slice(0, outLength);
}
