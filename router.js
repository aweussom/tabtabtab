function parseQuery(qs) {
  const out = {};
  if (!qs) return out;
  for (const pair of qs.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq));
    const v = eq < 0 ? '' : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
    out[k] = v;
  }
  return out;
}

export function parseHash() {
  const raw = location.hash.slice(1);
  const qIdx = raw.indexOf('?');
  const path = qIdx < 0 ? raw : raw.slice(0, qIdx);
  const query = qIdx < 0 ? {} : parseQuery(raw.slice(qIdx + 1));

  const parts = path.split('/').filter(Boolean).map(p => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  if (parts.length === 0) return { name: 'home' };

  const [head, arg] = parts;
  // `sb` query param: when navigating from a songbook, we propagate the
  // songbook id so the tab/song view can render a "back to songbook" button.
  const sb = query.sb || null;
  // Catalog IDs are numeric; private (UG-imported) IDs are strings like
  // "ug-12345". Keep them as strings; only convert pure-digit args to numbers.
  const isNumericId = /^\d+$/.test(arg ?? '');
  const parseId = () => (isNumericId ? Number(arg) : arg);
  if (head === 'letter' && arg) return { name: 'letter', letter: arg.toLowerCase() };
  if (head === 'artist' && arg) return { name: 'artist', id: parseId() };
  if (head === 'song' && arg) return { name: 'song', id: parseId(), sb };
  if (head === 'tab' && arg) return { name: 'tab', id: parseId(), sb };
  if (head === 'songbooks') return { name: 'songbooks' };
  if (head === 'songbook' && arg) return { name: 'songbook', id: arg };
  if (head === 'import' && arg === 'ug') return { name: 'import-ug' };
  if (head === 'share') {
    const ids = (query.ids || '').split(',').map(Number).filter(n => Number.isFinite(n));
    return { name: 'share', shareName: query.name || t('shared_songbook'), tab_ids: ids };
  }
  return { name: 'home' };
}

export function startRouter(onChange) {
  window.addEventListener('hashchange', () => onChange(parseHash()));
  onChange(parseHash());
}
import { t } from './i18n.js';
