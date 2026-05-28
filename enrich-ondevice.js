// On-device LLM enrichment via Chrome's built-in Prompt API (Gemini Nano).
// Extracted from spike/ug-enrich-spike.html, hardened with JSON5 + the
// project's standard balanced-block + salvage recovery for imperfect output.
//
// Public surface:
//   getAvailability()  → "available" | "downloadable" | "downloading" | "unavailable" | "no-api"
//   isAvailable()      → boolean (true only for "available")
//   enrichOne(tab)     → { search_text, language, themes[], mood[], occasion[], key_phrases[] }
//                        Throws if both attempts fail to parse.
//   resetSession()     → drop the cached base session (e.g. between runs)
//
// Requires global JSON5 (vendor/json5.min.js) loaded before this module.

const SYSTEM = `You enrich a guitar-tab catalog with search metadata for a music search engine. Output ONE JSON object only — no markdown fences, no commentary. Fields:
"search_text" (flat lowercase keyword string blending themes/mood/occasion/key phrases, 30-60 words),
"language" (string),
"themes" (array of strings),
"mood" (array of strings),
"occasion" (array of strings like wedding/funeral/breakup; [] if none),
"key_phrases" (array of 3-5 verbatim memorable lyric lines from the body).
Focus on lyric content; ignore chord notation and any header/tabber noise.`;

// Same brevity discipline as the Python pipeline's STRICT_SUFFIX.
const STRICT = `\n\nOutput MUST be exactly ONE valid JSON object that starts with { and ends with }. No prose before or after. Keep each array to 3-5 short items.`;

// ---- lenient JSON recovery (mirrors archive/proxy/enrich.js + enrich-private.py) ----
function stripReasoning(t) {
  return (t || '')
    .replace(/(?:<think>)?[\s\S]*?<\/think>\s*/gi, '')
    .replace(/<reflection>[\s\S]*?<\/reflection>\s*/gi, '')
    .trim();
}
function stripFences(t) {
  return t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}
function firstBalancedJsonBlock(text) {
  let depth = 0, start = -1, inStr = false, escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inStr) { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') { depth--; if (depth === 0 && start >= 0) return text.slice(start, i + 1); }
  }
  return null;
}
function salvageTruncatedJson(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  text = text.slice(start);
  let depth = 0, brackets = 0, inStr = false, escape = false;
  for (const ch of text) {
    if (escape) { escape = false; continue; }
    if (inStr) { if (ch === '\\') escape = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '[') brackets++;
    else if (ch === ']') brackets--;
  }
  let s = text;
  if (inStr) s += '"';
  while (brackets-- > 0) s += ']';
  while (depth-- > 0) s += '}';
  s = s.replace(/,\s*([}\]])/g, '$1');
  try { return JSON5.parse(s); } catch { return null; }
}
function parseEnrichment(raw) {
  const t = stripFences(stripReasoning(raw));
  const block = firstBalancedJsonBlock(t) ?? t;
  try { return JSON5.parse(block); } catch {}
  const salvaged = salvageTruncatedJson(t);
  if (salvaged) return salvaged;
  throw new Error('unparseable: ' + raw.slice(0, 70).replace(/\n/g, ' '));
}

// ---- on-device model ----
let _baseSession = null;

export async function getAvailability() {
  if (typeof LanguageModel === 'undefined') return 'no-api';
  try { return await LanguageModel.availability(); }
  catch { return 'unavailable'; }
}
export async function isAvailable() {
  return (await getAvailability()) === 'available';
}

export function resetSession() {
  if (_baseSession) { try { _baseSession.destroy?.(); } catch {} }
  _baseSession = null;
}

async function ensureBase(opts = {}) {
  if (typeof LanguageModel === 'undefined')
    throw new Error('No LanguageModel API. Chrome with the Prompt API flag is required.');
  const avail = await LanguageModel.availability();
  if (avail === 'unavailable')
    throw new Error('Gemini Nano is unavailable in this browser/profile.');
  if (!_baseSession) {
    _baseSession = await LanguageModel.create({
      expectedInputs:  [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
      initialPrompts:  [{ role: 'system', content: SYSTEM }],
      // The monitor only fires while the model is downloading — for a user
      // who already has Gemini Nano provisioned, this is a no-op. For first-
      // time users (or anyone Chrome is re-downloading the model for) it
      // gives the UI a hook to surface the 2-4 GB transfer instead of
      // appearing frozen for several minutes.
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          opts.onDownloadProgress?.({ loaded: e.loaded, total: e.total });
        });
      },
    });
  }
  return _baseSession;
}

/**
 * Prime the on-device session. Triggers a Gemini Nano download if the model
 * isn't yet provisioned (Chrome handles that under the hood); opts.onDownloadProgress
 * gets {loaded, total} events while that runs. Subsequent calls (or calls
 * after the model is already available) resolve immediately.
 */
export async function prepareModel(opts = {}) {
  return ensureBase(opts);
}

/**
 * Enrich a single tab via on-device LLM. `tab` needs at least
 * { artist, song, body }. Clones the base session per call so each prompt
 * gets a fresh context — accumulating many bodies in one session would blow
 * Gemini Nano's input quota. Retries once on parse failure (Nano is
 * nondeterministic; a re-roll usually succeeds when the first parse fails).
 */
export async function enrichOne(tab, opts = {}) {
  const base = await ensureBase(opts);
  const user = `Artist: ${tab.artist}\nSong: ${tab.song}\nBody:\n---\n${tab.body || ''}\n---${STRICT}`;
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const session = await base.clone();
    try {
      const raw = await session.prompt(user);
      return parseEnrichment(raw);
    } catch (err) {
      lastErr = err;
    } finally {
      try { session.destroy?.(); } catch {}
    }
  }
  throw lastErr;
}
