import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './db.js';

// The proxy database is seeded from a config file (OMNI_PROXIES_FILE, default
// ./proxies.json) at startup. Each entry: { id, url, location? }. Callers may
// then refer to a proxy by its short id instead of pasting the full URL.

const PROXIES_FILE = process.env.OMNI_PROXIES_FILE || path.join(process.cwd(), 'proxies.json');

export function loadProxiesFromFile() {
  if (!fs.existsSync(PROXIES_FILE)) {
    console.error(`[omni-fetcher] No proxy config at ${PROXIES_FILE}; proxy ids unavailable.`);
    return 0;
  }

  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(PROXIES_FILE, 'utf8'));
  } catch (err) {
    console.error(`[omni-fetcher] Failed to parse ${PROXIES_FILE}: ${err.message}`);
    return 0;
  }
  if (!Array.isArray(entries)) {
    console.error(`[omni-fetcher] ${PROXIES_FILE} must contain a JSON array of {id, url, location}.`);
    return 0;
  }

  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO proxies (id, url, location) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET url = excluded.url, location = excluded.location`
  );

  let count = 0;
  for (const e of entries) {
    if (!e || typeof e.id !== 'string' || typeof e.url !== 'string') {
      console.error(`[omni-fetcher] Skipping invalid proxy entry: ${JSON.stringify(e)}`);
      continue;
    }
    upsert.run(e.id, e.url, e.location ?? null);
    count++;
  }
  console.error(`[omni-fetcher] Loaded ${count} prox${count === 1 ? 'y' : 'ies'} from ${PROXIES_FILE}.`);
  return count;
}

export function listProxies() {
  return getDb().prepare('SELECT id, url, location FROM proxies ORDER BY id').all();
}

// A spec containing a scheme (e.g. http://, socks5://) is treated as a literal
// proxy URL. Otherwise it is looked up as an id in the proxy database.
export function resolveProxy(spec) {
  if (!spec) return undefined;
  if (spec.includes('://')) return spec;

  const row = getDb().prepare('SELECT url FROM proxies WHERE id = ?').get(spec);
  if (row) return row.url;

  throw new Error(
    `Unknown proxy id "${spec}". Provide a full proxy URL (e.g. socks5://host:port) or a known id.`
  );
}
