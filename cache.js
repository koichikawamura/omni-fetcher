import { getDb } from './db.js';

// Rendered HTML is cached per (url, proxy). A request that reuses the same url
// and proxy skips the headless browser entirely. Entries older than the TTL are
// treated as misses (and pruned) so content does not go permanently stale.
const TTL_SECONDS = parseInt(process.env.OMNI_CACHE_TTL || '86400', 10);

function proxyKey(proxy) {
  return proxy || '';
}

export function getCachedRender(url, proxy) {
  const db = getDb();
  const row = db
    .prepare('SELECT html, next_url, fetched_at FROM rendered_html WHERE url = ? AND proxy = ?')
    .get(url, proxyKey(proxy));
  if (!row) return null;

  const ageSeconds = Date.now() / 1000 - row.fetched_at;
  if (ageSeconds > TTL_SECONDS) {
    db.prepare('DELETE FROM rendered_html WHERE url = ? AND proxy = ?').run(url, proxyKey(proxy));
    return null;
  }

  return { html: row.html, nextUrl: row.next_url || null };
}

// Bulk-delete every render older than the TTL. getCachedRender only prunes the
// single key it is asked about, so URLs that are rendered once and never
// re-requested would otherwise linger forever; this sweeps them. Returns the
// number of rows removed.
export function pruneStaleRenders() {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - TTL_SECONDS;
  const result = db.prepare('DELETE FROM rendered_html WHERE fetched_at < ?').run(cutoff);
  return Number(result.changes);
}

export function setCachedRender(url, proxy, html, nextUrl) {
  const db = getDb();
  db.prepare(
    `INSERT INTO rendered_html (url, proxy, html, next_url, fetched_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(url, proxy) DO UPDATE SET
       html = excluded.html,
       next_url = excluded.next_url,
       fetched_at = excluded.fetched_at`
  ).run(url, proxyKey(proxy), html, nextUrl || null, Math.floor(Date.now() / 1000));
}
