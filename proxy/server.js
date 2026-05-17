// HTTP server for the Phase 2.5 enrichment proxy.
//
// Stack: built-in node:http, node:fs (for .env load), node:path. One npm
// dep (better-sqlite3). No express, no router, no framework — single
// endpoint with a small switch handles it.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cacheKey } from './shared/hash-key.js';
import { openCache } from './cache.js';
import { makeEnricher } from './enrich.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Tiny .env loader. Real apps use dotenv; this is one file and we want
// zero deps for it. Format: lines like KEY=value, # for comments.
function loadDotenv(envPath) {
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadDotenv(path.join(HERE, '.env'));

const PORT = Number(process.env.PORT) || 8787;
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const CACHE_PATH = path.join(HERE, process.env.CACHE_PATH || 'enrichment-cache.json');
const ALLOW_DEV_ROUTES = process.env.NODE_ENV !== 'production';

const cache = openCache(CACHE_PATH);
const enricher = makeEnricher(process.env);

console.log(`[proxy] starting on :${PORT}`);
console.log(`[proxy] mode: ${enricher.mode} (model: ${enricher.modelTag})`);
console.log(`[proxy] cache: ${CACHE_PATH} (${cache.count()} entries)`);
console.log(`[proxy] cors origins: ${CORS_ORIGINS.join(', ') || '(none — same-origin only)'}`);

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Force-Refresh');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readJsonBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (err) { reject(new Error(`Invalid JSON: ${err.message}`)); }
    });
    req.on('error', reject);
  });
}

async function handleEnrichTab(req, res) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  const { artist, song, body, chordnames } = payload;
  if (!artist || !song) {
    return sendJson(res, 400, { error: 'artist and song are required' });
  }
  const forceRefresh = req.headers['x-force-refresh'] === '1';
  const key = await cacheKey(artist, song);

  if (!forceRefresh) {
    const cached = cache.get(key);
    if (cached) {
      // Log only metadata. Body content never logged.
      console.log(`[enrich] ${artist} / ${song} :: HIT (${cached.modelUsed})`);
      return sendJson(res, 200, {
        enrichment: cached.enrichment,
        cache: 'hit',
        model_used: cached.modelUsed,
      });
    }
  }

  let result;
  try {
    result = await enricher.enrich({ artist, song, body, chordnames });
  } catch (err) {
    console.error(`[enrich] ${artist} / ${song} :: ERROR ${err.message}`);
    return sendJson(res, 502, { error: `LLM call failed: ${err.message}` });
  }
  cache.put(key, artist, song, result.enrichment, result.modelUsed);
  console.log(
    `[enrich] ${artist} / ${song} :: MISS (${result.modelUsed}, ${result.msTaken}ms` +
    (result.tokenCount ? `, ${result.tokenCount} tok` : '') +
    ')'
  );
  return sendJson(res, 200, {
    enrichment: result.enrichment,
    cache: forceRefresh ? 'forced' : 'miss',
    model_used: result.modelUsed,
  });
}

const server = http.createServer(async (req, res) => {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health' && req.method === 'GET') {
    return sendJson(res, 200, {
      status: 'ok',
      mode: enricher.mode,
      model: enricher.modelTag,
      cache_entries: cache.count(),
    });
  }

  if (url.pathname === '/enrich-tab' && req.method === 'POST') {
    return handleEnrichTab(req, res);
  }

  if (
    ALLOW_DEV_ROUTES &&
    req.method === 'DELETE' &&
    url.pathname.startsWith('/cache/')
  ) {
    const key = url.pathname.slice('/cache/'.length);
    const ok = cache.del(key);
    return sendJson(res, ok ? 200 : 404, { deleted: ok });
  }

  return sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`[proxy] listening on http://localhost:${PORT}`);
});

// Graceful shutdown so SQLite WAL flushes cleanly on Ctrl+C.
function shutdown() {
  console.log('\n[proxy] shutting down…');
  server.close(() => {
    cache.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
