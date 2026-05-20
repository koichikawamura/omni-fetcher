import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

// Single shared SQLite connection. node:sqlite (built-in, Node 22.5+) is used
// instead of a native module so the server runs with no compile step.
let db = null;

export function getDb() {
  if (db) return db;

  const dbPath = process.env.OMNI_DB_PATH || path.join(process.cwd(), 'omni-fetcher.db');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS rendered_html (
      url        TEXT NOT NULL,
      proxy      TEXT NOT NULL,
      html       TEXT NOT NULL,
      next_url   TEXT,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (url, proxy)
    );

    CREATE TABLE IF NOT EXISTS proxies (
      id       TEXT PRIMARY KEY,
      url      TEXT NOT NULL,
      location TEXT
    );
  `);

  return db;
}
