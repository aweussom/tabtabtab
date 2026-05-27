// Sha256 cache-key derivation that works in BOTH Node and browser.
//
// Node ≥15 has `globalThis.crypto.subtle` available, so the same Web
// Crypto code path works server-side AND client-side without a Node
// `require('crypto')` branch. Single implementation, no drift.

import { cacheKeyInput } from './normalize.js';

const encoder = new TextEncoder();

function bytesToHex(buf) {
  const view = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, '0');
  }
  return out;
}

/** Resolve the sha256 cache key for an `(artist, song)` pair. */
export async function cacheKey(artist, song) {
  const input = cacheKeyInput(artist, song);
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    encoder.encode(input)
  );
  return bytesToHex(digest);
}
