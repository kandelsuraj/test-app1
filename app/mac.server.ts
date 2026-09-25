/**
 * Keyed BLAKE2s-256 (RFC 7693), the MAC that signs calculator prices.
 *
 * Node's crypto has no keyed BLAKE2s, so it is implemented here. The
 * price-transform function carries a verifier-only port in
 * extensions/price-transform/src/mac.js that starts from keyState() instead of
 * the key; keep the two in sync.
 *
 * Why not HMAC-SHA256: the function runs in an interpreter with an instruction
 * limit, where each SHA-256 block costs ~1.5M instructions and HMAC needs at
 * least two per line. Keyed BLAKE2s needs one BLAKE2s block for a short message
 * once the key block is precomputed.
 */

const IV = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
];

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

function compress(h: Uint32Array, block: Uint8Array, counter: number, last: boolean) {
  const m = new Uint32Array(16);
  for (let i = 0; i < 16; i += 1) {
    const j = i * 4;
    m[i] = block[j] | (block[j + 1] << 8) | (block[j + 2] << 16) | (block[j + 3] << 24);
  }

  const v = new Uint32Array(16);
  v.set(h);
  v.set(IV, 8);
  v[12] ^= counter;
  v[13] ^= Math.floor(counter / 0x100000000);
  if (last) v[14] = ~v[14];

  const mix = (a: number, b: number, c: number, d: number, x: number, y: number) => {
    v[a] = v[a] + v[b] + x;
    v[d] = rotr(v[d] ^ v[a], 16);
    v[c] = v[c] + v[d];
    v[b] = rotr(v[b] ^ v[c], 12);
    v[a] = v[a] + v[b] + y;
    v[d] = rotr(v[d] ^ v[a], 8);
    v[c] = v[c] + v[d];
    v[b] = rotr(v[b] ^ v[c], 7);
  };

  for (const s of SIGMA) {
    mix(0, 4, 8, 12, m[s[0]], m[s[1]]);
    mix(1, 5, 9, 13, m[s[2]], m[s[3]]);
    mix(2, 6, 10, 14, m[s[4]], m[s[5]]);
    mix(3, 7, 11, 15, m[s[6]], m[s[7]]);
    mix(0, 5, 10, 15, m[s[8]], m[s[9]]);
    mix(1, 6, 11, 12, m[s[10]], m[s[11]]);
    mix(2, 7, 8, 13, m[s[12]], m[s[13]]);
    mix(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }

  for (let i = 0; i < 8; i += 1) h[i] ^= v[i] ^ v[i + 8];
}

function wordsToHex(h: Uint32Array) {
  return Buffer.from(new Uint8Array(new Uint32Array(h).buffer)).toString("hex");
}

/** State after the key block, for a 1–32 byte key and a 32-byte digest. */
function afterKeyBlock(key: Uint8Array) {
  if (key.length < 1 || key.length > 32) {
    throw new Error("BLAKE2s keys are 1 to 32 bytes");
  }
  const h = new Uint32Array(IV);
  h[0] ^= 0x01010000 ^ (key.length << 8) ^ 32;

  const block = new Uint8Array(64);
  block.set(key);
  compress(h, block, 64, false);
  return h;
}

/**
 * What the price-transform function stores instead of the key: the state after
 * the key block, as 64 hex characters. It can mint tags just like the key can,
 * so it is exactly as secret.
 */
export function keyState(key: Uint8Array) {
  return wordsToHex(afterKeyBlock(key));
}

/** Hex keyed BLAKE2s-256 of a non-empty UTF-8 message. */
export function blake2sMac(key: Uint8Array, message: string) {
  const bytes = new Uint8Array(Buffer.from(message, "utf8"));
  if (bytes.length === 0) throw new Error("Nothing to sign");

  const h = afterKeyBlock(key);
  let counter = 64;
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const remaining = bytes.length - offset;
    const last = remaining <= 64;
    const block = new Uint8Array(64);
    block.set(bytes.subarray(offset, offset + 64));
    counter += last ? remaining : 64;
    compress(h, block, counter, last);
  }
  return wordsToHex(h);
}
