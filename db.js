import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Persistent state lives in a stable per-user directory by default, NOT the cwd,
// so the server behaves the same whether launched via `npx` (arbitrary cwd) or
// directly. Override the whole directory with OMNI_DATA_DIR, or individual paths
// with OMNI_DB_PATH / OMNI_PROXIES_FILE.
export function dataDir() {
  return process.env.OMNI_DATA_DIR || path.join(os.homedir(), '.omni-fetcher');
}

// Single shared SQLite connection. node:sqlite (built-in, Node 22.5+) is used
// instead of a native module so the server runs with no compile step.
let db = null;

export function getDb() {
  if (db) return db;

  const dbPath = process.env.OMNI_DB_PATH || path.join(dataDir(), 'omni-fetcher.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
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
