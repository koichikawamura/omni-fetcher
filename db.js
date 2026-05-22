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
    -- Supports the periodic age-based sweep in cache.js (pruneStaleRenders).
    CREATE INDEX IF NOT EXISTS idx_rendered_html_fetched_at ON rendered_html (fetched_at);

    CREATE TABLE IF NOT EXISTS proxies (
      id       TEXT PRIMARY KEY,
      url      TEXT NOT NULL,
      location TEXT
    );

    -- One row per fetch attempt. Powers implicit-failure detection (a later,
    -- more effortful re-fetch of the same url supersedes an earlier one) and is
    -- the source from which fetch_stats is aggregated.
    CREATE TABLE IF NOT EXISTS fetch_log (
      id          TEXT PRIMARY KEY,
      domain      TEXT NOT NULL,
      url         TEXT NOT NULL,
      format      TEXT NOT NULL,
      proxy       TEXT NOT NULL,          -- proxy spec as the caller passed it ('' = none)
      outcome     TEXT NOT NULL,          -- success | blocked | empty | error
      error_class TEXT,                   -- reset | timeout | antibot | dns | other | NULL
      superseded  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fetch_log_url ON fetch_log (url, created_at);
    CREATE INDEX IF NOT EXISTS idx_fetch_log_domain ON fetch_log (domain, created_at);

    -- Aggregated per-site knowledge: how each (format, proxy) combination has
    -- fared on a given domain. Drives suggest_strategy.
    CREATE TABLE IF NOT EXISTS fetch_stats (
      domain          TEXT NOT NULL,
      format          TEXT NOT NULL,
      proxy           TEXT NOT NULL,
      successes       INTEGER NOT NULL DEFAULT 0,
      failures        INTEGER NOT NULL DEFAULT 0,
      last_outcome    TEXT,
      last_success_at INTEGER,
      last_failure_at INTEGER,
      updated_at      INTEGER NOT NULL,
      PRIMARY KEY (domain, format, proxy)
    );
  `);

  return db;
}
