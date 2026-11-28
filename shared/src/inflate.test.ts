import { deflateSync, constants } from "node:zlib";
import { describe, expect, it } from "vitest";
import { inflateZlib } from "./inflate";

/** A small repeatable generator, so a failure can be reproduced. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function sample(kind: string, size: number, next: () => number): Uint8Array {
  const out = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    if (kind === "noise") out[index] = Math.floor(next() * 256);
    else if (kind === "few") out[index] = Math.floor(next() * 4) * 60;
    else if (kind === "runs") out[index] = Math.floor(index / (1 + Math.floor(next() * 3))) & 255;
    else out[index] = (index * 7 + (next() < 0.05 ? 1 : 0)) & 255;
  }
  return out;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

describe("inflateZlib", () => {
  it("matches zlib across sizes, data shapes, levels and strategies", () => {
    const next = random(20261128);
    const strategies = [constants.Z_DEFAULT_STRATEGY, constants.Z_FILTERED, constants.Z_HUFFMAN_ONLY, constants.Z_RLE, constants.Z_FIXED];
    let cases = 0;
    for (const kind of ["noise", "few", "runs", "ramp"]) {
      for (const size of [0, 1, 2, 9, 73, 217, 1000, 9000, 70_000]) {
        for (const level of [0, 1, 6, 9]) {
          for (const strategy of strategies) {
            const input = sample(kind, size, next);
            const packed = new Uint8Array(deflateSync(input, { level, strategy }));
            const output = inflateZlib(packed);
            // Compared by hand: a deep-equal over large arrays is slow enough to time the test out.
            if (!same(output, input)) throw new Error(`mismatch for ${kind}, size ${size}, level ${level}, strategy ${strategy}`);
            cases += 1;
          }
        }
      }
    }
    expect(cases).toBe(4 * 9 * 4 * 5);
  }, 60_000);

  it("rejects data that is not zlib, is cut short, or would grow too large", () => {
    expect(() => inflateZlib(new Uint8Array([1, 2, 3, 4]))).toThrow();
    const packed = new Uint8Array(deflateSync(new Uint8Array(5000).fill(7)));
    expect(() => inflateZlib(packed.subarray(0, packed.length - 8))).toThrow();
    expect(() => inflateZlib(packed, 100)).toThrow("too large");
  });
});
