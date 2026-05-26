// LLM passthrough — two modes:
//
//   - Stub mode (default when PROXY_API_BASE is empty): returns canned
//     enrichment shaped like crawler/enrich.py's SONG_PROMPT output, so
//     the server + cache + browser flow can be developed end-to-end
//     without burning LLM credits or needing Ollama running.
//
//   - Real mode (PROXY_API_BASE set): POSTs to an OpenAI-compatible
//     /chat/completions endpoint. Works against:
//       * Local Ollama: PROXY_API_BASE=http://localhost:11434/v1
//         (no API key needed — Authorization header is omitted when
//         PROXY_API_KEY is empty)
//       * Ollama Cloud: PROXY_API_BASE=https://ollama.com/v1 + key
//       * Mimo V2 Pro: PROXY_API_BASE=https://api.mimo.xiaomi.com/v1 + key
//
// Patterns ported from C:/devel/aweussom/python/{evaluator,critique-llm}:
// system + user message split, <think>-block stripping (Qwen3 family),
// temperature 0.7, 600s timeout, 3-attempt exponential backoff retry.

// User-imported UG bookmarks are ~99.9% English. Norwegian-language tabs
// are served by the public catalog and its Claude/OpenAI nightly enrichment
// (see PLAN.md Phase 2.5 "Language scope"). So the proxy prompt does NOT
// ask for cross-language synonyms — Qwen3.6 is "pretty good, not
// fantastic", and a tighter single-language prompt produces cleaner output
// per the same instinct that picked Qwen3.6 in the first place.
const SYSTEM_PROMPT = `\
You are enriching a guitar-tab catalog with search metadata for a web app.

Output ONE JSON object only — no markdown fences, no commentary, no surrounding text.

Required fields (all optional except search_text):
{
  "search_text": "flat lowercase keywords: themes, mood, occasion, alt-titles, key lyric phrases. 30-80 words.",
  "language": "english | norsk | mixed | unknown",
  "themes": ["love", "heartbreak", "childhood", "faith", ...],
  "mood": ["melancholy", "joyful", "anthemic", ...],
  "occasion": ["wedding", "christmas", "funeral", "breakup", ...],
  "alt_titles": {"en": "alternate or shortened English title, if any"},
  "key_phrases": ["3-5 memorable lyric phrases from the body, verbatim or near-verbatim"],
  "display_suppress": [0, 1, 2]
}

Rules:
- Focus on LYRIC content when deriving themes/mood/key_phrases. Ignore chord
  notation, fingering diagrams, legal preambles, email headers, tabber notes.
- key_phrases must come from the body text (verbatim or very close).
- display_suppress: 0-indexed line numbers in body.split("\\n") that are NOT
  part of the song itself — UG #PLEASE NOTE legal preambles, USENET-era
  email headers (From:/To:/Subject:/Date:/Message-Id:), tabber commentary,
  capo/tuning notes, author signatures, separator lines. Do NOT include
  chord-only lines, [tab]...[/tab] fingering diagrams, or section markers
  like [Intro]/[Verse]/[Chorus] — those ARE part of the tab. Empty array
  is correct when the body has no noise to suppress.
- No markdown fences. No commentary. Just the JSON object.`;

function buildUserMessage({ artist, song, body }) {
  // Full body — no truncation. Ollama Cloud flat-rate sub makes token cost
  // irrelevant, and the LLM needs actual lyrics (which were getting
  // truncated out under the old 800-char cap when blurb consumed the
  // first ~400 chars). See PLAN.md Phase 2.5 "Bench v2 update".
  return `Artist: ${artist}\nSong: ${song}\nTab body (verbatim from the source; may contain UG legal preambles, USENET email headers, tabber commentary, capo/tuning notes, and tabber signatures alongside chord notation and actual lyrics):\n---\n${body || ''}\n---`;
}

/** Strip <think>...</think> / <reflection>...</reflection> blocks emitted
 * by Qwen3 + other reasoning models. Pattern matches both standard
 * paired tags AND the unclosed-opening variant (some models drop the
 * <think> opener but keep </think>). Same regex shape as used in
 * critique-llm/shared/llm_provider.py. */
function stripReasoningTags(text) {
  let out = text.replace(/(?:<think>)?[\s\S]*?<\/think>\s*/gi, '');
  out = out.replace(/<reflection>[\s\S]*?<\/reflection>\s*/gi, '');
  return out.trim();
}

/** Strip markdown fences (```json ... ``` or ``` ... ```) around JSON
 * payloads. Defensive — most prompts ask for no fences, but Qwen3 and
 * cousins occasionally add them anyway. */
function stripCodeFences(text) {
  return text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

/** First balanced top-level `{...}` block in `text`, or null.
 * String-aware so braces inside JSON strings don't shift the depth count —
 * same trick crawler/enrich.py uses for LLM trailing-prose tolerance. */
function firstBalancedJsonBlock(text) {
  let depth = 0;
  let start = -1;
  let inStr = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inStr) { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseLlmJson(rawContent) {
  const stripped = stripReasoningTags(rawContent);
  const fenceless = stripCodeFences(stripped);
  const candidate = firstBalancedJsonBlock(fenceless) ?? fenceless;
  try {
    return JSON.parse(candidate);
  } catch (err) {
    throw new Error(`LLM output was not valid JSON: ${err.message}`);
  }
}

function stubEnrichment(artist, song) {
  // Deterministic-ish canned shape so the client can demo the flow
  // without a key OR a running Ollama. Same field names as the real
  // prompt so client code doesn't need a "stub-vs-real" branch.
  return {
    search_text: `${String(song).toLowerCase()} ${String(artist).toLowerCase()} stub enrichment placeholder`,
    language: 'unknown',
    themes: ['stub'],
    mood: ['placeholder'],
    occasion: [],
    alt_titles: {},
    key_phrases: [],
    display_suppress: [],
    _stub: true,
  };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callLlm({ apiBase, apiKey, model, system, user, temperature, timeoutMs }) {
  const url = `${apiBase.replace(/\/$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        stream: false,
        temperature,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 200)}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

export function makeEnricher(env) {
  const apiBase = (env.PROXY_API_BASE || '').trim();
  const apiKey = (env.PROXY_API_KEY || '').trim();
  const model = (env.PROXY_MODEL || '').trim();
  const temperature = Number(env.PROXY_TEMPERATURE ?? 0.7);
  const timeoutMs = Number(env.PROXY_TIMEOUT_MS ?? 600_000);
  const retryAttempts = Math.max(1, Number(env.PROXY_RETRY_ATTEMPTS ?? 3));
  const retryBackoffBase = Number(env.PROXY_RETRY_BACKOFF_BASE_MS ?? 5_000);
  const retryBackoffMax = Number(env.PROXY_RETRY_BACKOFF_MAX_MS ?? 60_000);

  // Stub-mode gate: API_BASE empty (or model empty) means we're not
  // configured for a real LLM. API_KEY emptiness alone is NOT a gate
  // because local Ollama doesn't need a key.
  const useStub = !apiBase || !model;

  return {
    mode: useStub ? 'stub' : 'real',
    modelTag: useStub ? 'stub' : model,
    async enrich({ artist, song, body }) {
      const t0 = Date.now();

      if (useStub) {
        return {
          enrichment: stubEnrichment(artist, song),
          modelUsed: 'stub',
          msTaken: Date.now() - t0,
          tokenCount: null,
        };
      }

      const user = buildUserMessage({ artist, song, body });
      let lastErr;
      for (let attempt = 1; attempt <= retryAttempts; attempt++) {
        try {
          const data = await callLlm({
            apiBase, apiKey, model,
            system: SYSTEM_PROMPT, user, temperature, timeoutMs,
          });
          const content = data?.choices?.[0]?.message?.content ?? '';
          if (!content) throw new Error('Empty content in LLM response');
          const enrichment = parseLlmJson(content);
          return {
            enrichment,
            modelUsed: model,
            msTaken: Date.now() - t0,
            tokenCount: data?.usage?.total_tokens ?? null,
          };
        } catch (err) {
          lastErr = err;
          if (attempt >= retryAttempts) break;
          const delay = Math.min(retryBackoffBase * (2 ** (attempt - 1)), retryBackoffMax);
          const jitter = Math.random() * delay * 0.1;
          const wait = delay + jitter;
          console.warn(`[enrich] attempt ${attempt}/${retryAttempts} failed: ${err.message} — retrying in ${Math.round(wait)}ms`);
          await sleep(wait);
        }
      }
      throw lastErr ?? new Error('LLM call failed for unknown reasons');
    },
  };
}
