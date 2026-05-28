/**
 * Search module: builds inverted indexes from catalog + enrichment at load,
 * then answers queries with folded match + prefix scan + fuzzy fallback.
 *
 * Folding rules (Norwegian):
 *   ø, oe → o
 *   æ, ae → a
 *   å, aa → a
 *   plus NFD diacritic stripping (è é ê → e, etc.)
 */

// Pseudo-artists on nortabs.net are curated thematic buckets, not real
// artists ("Julesanger", "Salmer", "Lovsanger", …). Their children inherit
// these synonym tokens through the existing artist-enrichment path, so a
// search for `jul`, `barnesang`, `kristen` etc. surfaces the bucket plus
// all its songs without depending on the LLM-generated enrichment.
// Cutoff: ≥7 songs per bucket. Synonyms are kept tight — each one should
// be a term a user would plausibly type when looking for that theme.
const PSEUDO_ARTIST_TAGS = {
  388: 'lovsang lovsanger kristen gospel worship kirkemusikk menighet tilbedelse',         // Lovsanger
  173: 'jul julesang julesanger juletre julaften advent julenisse julmusikk',              // Julesanger
  270: 'barn barnesang barnesanger barnehage barnerim regle vuggesang sovevise',           // Barnesanger
  161: 'fotball fotballsang fotballsanger supporter tribune landslag supportersang',       // Fotballsanger
  426: 'salme salmer salmebok kirke kristen gudstjeneste begravelse hymne',                // Salmer
  309: '17 mai nasjonaldag grunnlovsdag norge norsk fedreland patriotisk',                 // 17. mai-sanger
  283: 'sorland sorlandet sorlandsvise sorlandsviser kyst kystkultur agder kristiansand',  // Sorlandsviser
  615: 'folkevise folkeviser folkesang folkemusikk folkemelodi tradisjonell slatt',        // Folkeviser
};

// Token alias groups: if ANY member of a group is indexed for an artist or
// song, ALL members get indexed for that same entity. The user's mental
// model: "Trondheim / Trondhjem / Trønder are the same place — finding one
// should find all." Members must be written in folded form (ø→o, æ→a, å→a).
// Append to the list as gaps surface — single edit, no other plumbing.
const TOKEN_ALIASES = [
  ['trondheim', 'trondhjem', 'tronder', 'tronderrock', 'trondelag', 'nidaros'],
  ['oslo', 'kristiania', 'christiania'],
  ['bergen', 'bergensk', 'bergenser'],
  ['stavanger', 'siddis'],
];

const _aliasLookup = (() => {
  const m = new Map();
  for (const group of TOKEN_ALIASES) {
    for (const member of group) {
      const others = group.filter(x => x !== member);
      const existing = m.get(member) ?? [];
      m.set(member, [...new Set([...existing, ...others])]);
    }
  }
  return m;
})();

function expandWithAliases(tokens) {
  const out = new Set(tokens);
  for (const t of tokens) {
    const siblings = _aliasLookup.get(t);
    if (siblings) for (const s of siblings) out.add(s);
  }
  return out;
}

let _artistIndex = new Map(); // token → Set<artistId>
let _songIndex = new Map();   // token → Set<songId>
let _bodyIndex = new Map();   // token → Set<tabId>
let _allTokens = [];          // sorted array of unique tokens (for prefix scan)
let _bodyIdf = new Map();     // token → IDF weight (rare tokens > common ones)
let _songIdf = new Map();
let _artistIdf = new Map();
let _totalTabs = 0;

let _artistById = new Map();
let _songById = new Map();
let _tabById = new Map();

// User-curated (UG-imported) entries are tabs the user actively sought out
// and imported — a strong relevance signal beyond pure token overlap. Boost
// matches in their favor over tangentially-tagged catalog entries. Marker
// in the lookup maps is `letter === null` (vs a real letter for catalog).
const UG_IMPORT_BOOST = 2.5;

export function fold(s) {
  return String(s).toLowerCase()
    .replace(/ø/g, 'o').replace(/æ/g, 'a').replace(/å/g, 'a')
    .replace(/oe/g, 'o').replace(/ae/g, 'a').replace(/aa/g, 'a')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function tokenize(folded) {
  if (!folded) return [];
  return folded.split(' ').filter(t => t.length >= 2);
}

function addToIndex(index, token, id) {
  let set = index.get(token);
  if (!set) { set = new Set(); index.set(token, set); }
  set.add(id);
}

export function buildIndex(catalog, enrichment, privateBundle = null) {
  _artistIndex = new Map();
  _songIndex = new Map();
  _bodyIndex = new Map();
  _artistById = new Map();
  _songById = new Map();
  _tabById = new Map();
  const allTokenSet = new Set();

  for (const [letter, bucket] of Object.entries(catalog?.letters ?? {})) {
    for (const artist of bucket.artists) {
      const baseEnrich = enrichment?.artists?.[artist.id]?.search_text ?? '';
      const tagText = PSEUDO_ARTIST_TAGS[artist.id] ?? '';
      const aEnrich = tagText ? `${baseEnrich} ${tagText}` : baseEnrich;
      const aTokens = expandWithAliases(tokenize(fold(`${artist.name} ${aEnrich}`)));
      for (const t of aTokens) {
        addToIndex(_artistIndex, t, artist.id);
        allTokenSet.add(t);
      }
      _artistById.set(artist.id, { artist, letter });

      for (const song of artist.songs) {
        const sEnrich = enrichment?.songs?.[song.id]?.search_text ?? '';
        const sTokens = expandWithAliases(tokenize(fold(`${artist.name} ${aEnrich} ${song.name} ${sEnrich}`)));
        for (const t of sTokens) {
          addToIndex(_songIndex, t, song.id);
          allTokenSet.add(t);
        }
        _songById.set(song.id, { song, artist, letter });

        for (const tab of song.tabs) {
          const bTokens = tokenize(fold(tab.body || ''));
          for (const t of bTokens) {
            addToIndex(_bodyIndex, t, tab.id);
            allTokenSet.add(t);
          }
          _tabById.set(tab.id, { tab, song, artist, letter });
        }
      }
    }
  }

  // Merge private bundle (UG-import + LLM enrichment) into the same indexes,
  // so UG entries compete with nortabs.net entries in search results — not
  // just available through Sangbøker. Enrichment is inline on each entry
  // (built by build-private-bundle.py), shaped the same as enrichment.json.
  // letter: null marks these refs as non-letter-browseable, matching catalog.js.
  for (const artist of Object.values(privateBundle?.artists ?? {})) {
    const aEnrich = artist.enrichment?.search_text ?? '';
    const aTokens = expandWithAliases(tokenize(fold(`${artist.name} ${aEnrich}`)));
    for (const t of aTokens) {
      addToIndex(_artistIndex, t, artist.id);
      allTokenSet.add(t);
    }
    const syntheticArtist = { id: artist.id, name: artist.name, songs: [] };
    _artistById.set(artist.id, { artist: syntheticArtist, letter: null });

    for (const sid of artist.song_ids ?? []) {
      const song = privateBundle.songs?.[sid];
      if (!song) continue;
      const sEnrich = song.enrichment?.search_text ?? '';
      const sTokens = expandWithAliases(tokenize(fold(`${artist.name} ${aEnrich} ${song.name} ${sEnrich}`)));
      for (const t of sTokens) {
        addToIndex(_songIndex, t, song.id);
        allTokenSet.add(t);
      }
      const syntheticSong = { id: song.id, name: song.name, tabs: [] };
      syntheticArtist.songs.push(syntheticSong);
      _songById.set(song.id, { song: syntheticSong, artist: syntheticArtist, letter: null });

      for (const tid of song.tab_ids ?? []) {
        const tab = privateBundle.tabs?.[tid];
        if (!tab) continue;
        const bTokens = tokenize(fold(tab.body || ''));
        for (const t of bTokens) {
          addToIndex(_bodyIndex, t, tab.id);
          allTokenSet.add(t);
        }
        syntheticSong.tabs.push(tab);
        _tabById.set(tab.id, { tab, song: syntheticSong, artist: syntheticArtist, letter: null });
      }
    }
  }

  _allTokens = [...allTokenSet].sort();

  // Precompute IDF for all three indexes. Rare tokens get high weight, common
  // ones (jeg, vil, på, ...) get near-zero — so a phrase like "jeg vil tjene
  // penger på kroppen min" is matched on its distinctive tokens, not "jeg".
  _totalTabs = _tabById.size || 1;
  const totalSongs = _songById.size || 1;
  const totalArtists = _artistById.size || 1;
  const idfFor = (index, total) => {
    const out = new Map();
    const maxRaw = Math.log(total + 1);
    for (const [token, set] of index) {
      const df = set.size;
      const raw = Math.log((total + 1) / (df + 1));
      out.set(token, Math.max(0.05, Math.min(1.0, raw / maxRaw)));
    }
    return out;
  };
  _bodyIdf = idfFor(_bodyIndex, _totalTabs);
  _songIdf = idfFor(_songIndex, totalSongs);
  _artistIdf = idfFor(_artistIndex, totalArtists);

  return {
    artistTokens: _artistIndex.size,
    songTokens: _songIndex.size,
    bodyTokens: _bodyIndex.size,
    uniqueTokens: _allTokens.length,
    totalTabs: _totalTabs,
  };
}

function prefixMatches(prefix) {
  if (!prefix) return [];
  let lo = 0, hi = _allTokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (_allTokens[mid] < prefix) lo = mid + 1;
    else hi = mid;
  }
  const out = [];
  for (let i = lo; i < _allTokens.length; i++) {
    if (!_allTokens[i].startsWith(prefix)) break;
    out.push(_allTokens[i]);
  }
  return out;
}

// Damerau-Levenshtein distance, capped at maxDist for speed.
function distance(a, b, maxDist = 3) {
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev2 = new Array(n + 1).fill(0);
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        curr[j] = Math.min(curr[j], prev2[j - 2] + 1);
      }
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDist) return maxDist + 1;
    [prev2, prev, curr] = [prev, curr, prev2];
  }
  return prev[n];
}

function bumpScore(map, id, delta) {
  const cur = map.get(id) ?? { hits: 0, score: 0 };
  cur.hits++;
  cur.score += delta;
  map.set(id, cur);
}

export function search(query, opts = {}) {
  const { favoriteTabIds = new Set() } = opts;
  const folded = fold(query);
  const tokens = tokenize(folded);
  if (!tokens.length) return { artists: [], songs: [], bodyHits: [], suggest: null, total: 0 };

  const artistScores = new Map();
  const songScores = new Map();
  const tabScores = new Map();
  let anyHit = false;

  // Prefix-match heuristic: short queries (1-3 tokens) are exploratory —
  // user might be mid-typing or guessing spelling, so prefix expansion +
  // semantic match helps ("ryba" → Rybak; "barnsanger" → barnesanger).
  // Long queries (4+ tokens) signal the user knows what they want and is
  // typing a phrase/quote; exact match kills prefix-explosion noise.
  const isPhraseQuery = tokens.length >= 4;

  // In phrase mode (4+ tokens), skip songIndex/artistIndex contributions
  // entirely. Common short tokens (jeg, vil, på) would otherwise add noise
  // even at exact match. Body propagation alone drives the songs frame —
  // the song that contains the phrase wins, full stop.
  const usesNameIndexes = !isPhraseQuery;

  for (const qt of tokens) {
    if (usesNameIndexes) {
      // Dedup prefix-match contributions PER query-token: an entry indexed
      // under multiple morphological variants of the same root (e.g. enrichment
      // search_text saying both "mountain" and "mountains") should be rewarded
      // for matching the query, not multiplied by variant count. Take the best
      // per entry per qt; sum across qt's only.
      const matched = prefixMatches(qt);
      const aBestPerQt = new Map();
      const sBestPerQt = new Map();
      for (const t of matched) {
        const exactBonus = t === qt ? 1.0 : 0.6;
        const aIdf = _artistIdf.get(t) ?? 0.5;
        const sIdf = _songIdf.get(t) ?? 0.5;
        for (const aid of (_artistIndex.get(t) ?? [])) {
          const score = exactBonus * aIdf * 10;
          if ((aBestPerQt.get(aid) ?? 0) < score) aBestPerQt.set(aid, score);
          anyHit = true;
        }
        for (const sid of (_songIndex.get(t) ?? [])) {
          const score = exactBonus * sIdf * 5;
          if ((sBestPerQt.get(sid) ?? 0) < score) sBestPerQt.set(sid, score);
          anyHit = true;
        }
      }
      for (const [aid, score] of aBestPerQt) bumpScore(artistScores, aid, score);
      for (const [sid, score] of sBestPerQt) bumpScore(songScores, sid, score);
    }
    // Body index uses EXACT match + IDF in BOTH modes. The distinctive tokens
    // (tjene, kroppen, fairytale) dominate via high IDF; common-token noise
    // (jeg, på) is suppressed.
    const idf = _bodyIdf.get(qt) ?? 0.5;
    for (const tid of (_bodyIndex.get(qt) ?? [])) {
      bumpScore(tabScores, tid, idf * 4);
      anyHit = true;
    }
  }

  // Songbook boost: tabs the user has bookmarked get a 4x score multiplier.
  // Per user direction: "Høyt — stor boost, men kvalitet kan fortsatt slo."
  for (const [tid, cur] of tabScores) {
    if (favoriteTabIds.has(tid)) cur.score *= 4;
  }

  // Propagate body matches up to the songs frame: when a user types a
  // remembered lyric, the song that contains it should dominate Sanger.
  //
  // Dedup by song: a song with N tabs would otherwise multiply its body
  // score by N (each tab contributes), unfairly inflating multi-tab songs.
  // We take the MAX body score across the song's tabs as its "best evidence".
  const bestBodyPerSong = new Map(); // sid → max tab score
  for (const [tid, cur] of tabScores) {
    const ref = _tabById.get(tid);
    if (!ref) continue;
    const sid = ref.song.id;
    const prev = bestBodyPerSong.get(sid) ?? 0;
    if (cur.score > prev) bestBodyPerSong.set(sid, cur.score);
  }
  for (const [sid, bodyScore] of bestBodyPerSong) {
    const boost = bodyScore * 3.0;
    const existing = songScores.get(sid);
    if (existing) {
      existing.score += boost;
    } else {
      songScores.set(sid, { score: boost, hits: 1 });
    }
  }

  // Lyrics frame is keyed by song: multiple tabs of the same song should
  // collapse to one row. Keep the highest-scoring tab as the representative.
  const bodySongMap = new Map(); // songId → { song, artist, letter, score, hits, bestTabId }
  for (const [tid, cur] of tabScores) {
    const ref = _tabById.get(tid);
    if (!ref) continue;
    const existing = bodySongMap.get(ref.song.id);
    if (!existing || cur.score > existing.score) {
      bodySongMap.set(ref.song.id, {
        song: ref.song,
        artist: ref.artist,
        letter: ref.letter,
        score: cur.score,
        hits: cur.hits,
        bestTabId: tid,
      });
    }
  }

  // UG-import boost: user-curated entries (letter === null) get a flat
  // multiplier. The user actively imported these — they're a stronger
  // relevance signal than tangentially-tagged catalog entries with the
  // same token overlap. Catalog can still win on stronger token coverage.
  for (const [aid, cur] of artistScores) {
    if (_artistById.get(aid)?.letter === null) cur.score *= UG_IMPORT_BOOST;
  }
  for (const [sid, cur] of songScores) {
    if (_songById.get(sid)?.letter === null) cur.score *= UG_IMPORT_BOOST;
  }
  for (const entry of bodySongMap.values()) {
    if (entry.letter === null) entry.score *= UG_IMPORT_BOOST;
  }

  const sortByScore = (a, b) => b[1].score - a[1].score || b[1].hits - a[1].hits;
  const sortBodyHits = (a, b) => b.score - a.score || b.hits - a.hits;
  const limit = 20;

  const sortedArtists = [...artistScores.entries()].sort(sortByScore).slice(0, limit)
    .map(([id]) => _artistById.get(id)).filter(Boolean);
  const sortedSongs = [...songScores.entries()].sort(sortByScore).slice(0, limit)
    .map(([id]) => _songById.get(id)).filter(Boolean);
  const sortedBodyHits = [...bodySongMap.values()].sort(sortBodyHits).slice(0, limit);

  // "Mente du..." only when nothing hit and we have a single query token
  // worth correcting. Multi-token miss is usually a hopeless query.
  let suggest = null;
  if (!anyHit && tokens.length === 1) {
    const qt = tokens[0];
    if (qt.length >= 3) {
      let best = null, bestDist = Infinity;
      for (const t of _allTokens) {
        if (Math.abs(t.length - qt.length) > 2) continue;
        const d = distance(qt, t, 2);
        if (d < bestDist) {
          bestDist = d;
          best = t;
          if (d === 1) break;
        }
      }
      if (best && bestDist <= 2 && bestDist > 0) suggest = best;
    }
  }

  return {
    artists: sortedArtists,
    songs: sortedSongs,
    bodyHits: sortedBodyHits,
    suggest,
    total: sortedArtists.length + sortedSongs.length + sortedBodyHits.length,
  };
}
