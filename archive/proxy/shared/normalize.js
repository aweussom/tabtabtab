// Title + artist normalization for cache-key derivation.
//
// Used by BOTH the proxy server (Node) AND the browser client. The cache
// key (`sha256(normalized(artist) + '|' + normalized(song))`) only works
// if both sides agree byte-for-byte on what "normalized" means — so this
// file is the single source of truth. Pure ESM, no Node-specific or
// browser-specific imports.
//
// Folding rules (same posture as `search.js`'s `foldQuery`):
//   - Lowercase
//   - Strip leading/trailing whitespace
//   - Collapse internal whitespace runs to single space
//   - Norwegian / Scandinavian diacritics → ASCII (ø→o, æ→a, å→a, é→e, etc.)
//   - Drop punctuation that's commonly inconsistent across sources
//     (apostrophes, quotes, dots, commas, parens, brackets)
//   - Keep & between words ("salt & pepper")
//
// Conservative on purpose: a normalization that's too aggressive merges
// genuinely distinct songs into one cache entry, which is much worse
// than missing a few cache hits on punctuation variants.

const DIACRITIC_MAP = {
  'å': 'a', 'ä': 'a', 'â': 'a', 'à': 'a', 'á': 'a', 'ã': 'a',
  'ø': 'o', 'ö': 'o', 'ô': 'o', 'ò': 'o', 'ó': 'o', 'õ': 'o',
  'æ': 'a',
  'é': 'e', 'è': 'e', 'ê': 'e', 'ë': 'e',
  'í': 'i', 'ì': 'i', 'î': 'i', 'ï': 'i',
  'ú': 'u', 'ù': 'u', 'û': 'u', 'ü': 'u',
  'ý': 'y', 'ÿ': 'y',
  'ñ': 'n',
  'ç': 'c',
};

const PUNCT_DROP_RE = /['"`’‘“”.,!?;:()\[\]{}…/\\]/g;

export function normalize(s) {
  if (s == null) return '';
  let out = String(s).toLowerCase().trim();
  let folded = '';
  for (const ch of out) {
    folded += DIACRITIC_MAP[ch] ?? ch;
  }
  folded = folded.replace(PUNCT_DROP_RE, '');
  folded = folded.replace(/\s+/g, ' ').trim();
  return folded;
}

/** Compose the canonical cache-key input string. */
export function cacheKeyInput(artist, song) {
  return `${normalize(artist)}|${normalize(song)}`;
}
