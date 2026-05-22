import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';

// Escalation ladder: the order a client is expected to climb when a cheaper
// form is insufficient. A later index means "more effort / more of a last
// resort", and is what implicit-failure detection compares against. (This is
// the recommended escalation, distinct from the FORMATS array order.)
export const ESCALATION = ['mercury', 'defuddle', 'rendered_html', 'screenshot'];

function escalationRank(format) {
  const i = ESCALATION.indexOf(format);
  return i === -1 ? ESCALATION.length : i;
}

// Window during which a later, more effortful fetch of the same url is taken as
// evidence that the earlier (cheaper) one didn't satisfy the caller.
const SUPERSEDE_WINDOW_MS = 15 * 60 * 1000;

// Minimum extracted words / rendered bytes below which a "successful"
// navigation is really an empty result.
const MIN_WORDS = 30;
const MIN_HTML_BYTES = 500;

// Conservative signatures of anti-bot / challenge interstitials served with a
// 200 (so navigation "succeeds" but the body is a wall, not the page).
const BLOCK_SIGNATURES = [
  /just a moment/i,
  /checking your browser/i,
  /attention required/i,
  /cf-browser-verification|cf-challenge/i,
  /captcha/i,
  /access denied/i,
  /are you a (human|robot)/i,
  /verify you are human/i,
];

export function domainOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function classifyNavError(message = '') {
  if (/ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_NETWORK_CHANGED/i.test(message)) return 'reset';
  if (/timeout|ERR_TIMED_OUT/i.test(message)) return 'timeout';
  if (/ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_UNREACHABLE/i.test(message)) return 'dns';
  if (/403|forbidden|ERR_HTTP2_PROTOCOL_ERROR/i.test(message)) return 'antibot';
  return 'other';
}

// Decide the outcome of a non-error fetch from what came back. `html` is the
// rendered markup (first page); `wordCount` is the extracted word count for the
// parser formats (omit for screenshot / rendered_html).
export function classifyResult({ format, html = '', wordCount = null }) {
  if (html && BLOCK_SIGNATURES.some(re => re.test(html))) {
    return { outcome: 'blocked', errorClass: 'antibot' };
  }
  if (format === 'screenshot') {
    return { outcome: 'success', errorClass: null };
  }
  if (format === 'rendered_html') {
    return html.length >= MIN_HTML_BYTES
      ? { outcome: 'success', errorClass: null }
      : { outcome: 'empty', errorClass: null };
  }
  // mercury / defuddle
  return wordCount !== null && wordCount >= MIN_WORDS
    ? { outcome: 'success', errorClass: null }
    : { outcome: 'empty', errorClass: null };
}

function bumpStats(db, domain, format, proxy, outcome, now) {
  const success = outcome === 'success' ? 1 : 0;
  const failure = success ? 0 : 1;
  db.prepare(
    `INSERT INTO fetch_stats
       (domain, format, proxy, successes, failures, last_outcome,
        last_success_at, last_failure_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(domain, format, proxy) DO UPDATE SET
       successes       = successes + ?,
       failures        = failures + ?,
       last_outcome    = ?,
       last_success_at = CASE WHEN ?=1 THEN ? ELSE last_success_at END,
       last_failure_at = CASE WHEN ?=1 THEN ? ELSE last_failure_at END,
       updated_at      = ?`
  ).run(
    domain, format, proxy, success, failure, outcome,
    success ? now : null, failure ? now : null, now,
    success, failure, outcome,
    success, now,
    failure, now,
    now
  );
}

// Implicit-failure pass: a fresh, more effortful fetch of the same url within
// the window means earlier cheaper attempts didn't cut it. Mark them superseded
// and charge a soft failure against their stats.
function applyImplicitSupersede(db, { domain, url, format, now }) {
  const rank = escalationRank(format);
  const since = now - SUPERSEDE_WINDOW_MS;
  const priors = db
    .prepare(
      `SELECT id, format, proxy FROM fetch_log
       WHERE url = ? AND superseded = 0 AND outcome IN ('success','empty') AND created_at >= ?`
    )
    .all(url, since);

  for (const p of priors) {
    if (escalationRank(p.format) >= rank) continue; // only cheaper attempts
    db.prepare('UPDATE fetch_log SET superseded = 1 WHERE id = ?').run(p.id);
    db.prepare(
      `UPDATE fetch_stats
         SET failures = failures + 1, last_outcome = 'superseded',
             last_failure_at = ?, updated_at = ?
       WHERE domain = ? AND format = ? AND proxy = ?`
    ).run(now, now, domain, p.format, p.proxy);
    console.error(`[omni-fetcher] Implicit failure: ${p.format} on ${domain} superseded by ${format}`);
  }
}

// Record one attempt. `proxy` is the spec the caller passed ('' = none) so a
// recommendation can be replayed verbatim. Returns the fetch id.
export function recordFetch({ url, format, proxy = '', outcome, errorClass = null }) {
  const db = getDb();
  const now = Date.now();
  const domain = domainOf(url);
  const id = randomUUID();

  db.prepare(
    `INSERT INTO fetch_log (id, domain, url, format, proxy, outcome, error_class, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, domain, url, format, proxy, outcome, errorClass, now);

  bumpStats(db, domain, format, proxy, outcome, now);

  // Escalating to a more effortful format is itself the dissatisfaction signal,
  // regardless of whether this attempt then succeeded — the caller already
  // judged the cheaper result insufficient.
  applyImplicitSupersede(db, { domain, url, format, now });
  return id;
}

// Rank a stats row: net successes, with a recency tilt so a combo that worked
// recently outranks stale wins, and recent-only failures sink.
function scoreRow(row, now) {
  const recencyBoost = row.last_success_at && now - row.last_success_at < 7 * 24 * 3600 * 1000 ? 1 : 0;
  return row.successes - row.failures + recencyBoost;
}

// Build a strategy report for a url's domain. Simple now (an ordered list of
// recommendations plus the raw counts and a one-line summary); the shape leaves
// room for richer reports later.
export function suggestStrategy(url) {
  const db = getDb();
  const domain = domainOf(url);
  const now = Date.now();

  const rows = db
    .prepare(
      `SELECT format, proxy, successes, failures, last_outcome, last_success_at, last_failure_at
       FROM fetch_stats WHERE domain = ?`
    )
    .all(domain);

  if (rows.length === 0) {
    return {
      domain,
      hasHistory: false,
      recommended: ESCALATION.map(format => ({ format, proxy: '' })),
      summary: `No history for ${domain} yet. Try the default escalation: ${ESCALATION.join(' → ')}.`,
    };
  }

  const ranked = rows
    .map(r => ({ ...r, score: scoreRow(r, now) }))
    .sort((a, b) => b.score - a.score);

  const recommended = ranked.map(r => ({
    format: r.format,
    proxy: r.proxy,
    successes: r.successes,
    failures: r.failures,
    lastOutcome: r.last_outcome,
  }));

  const top = ranked[0];
  const proxyLabel = top.proxy ? ` via ${top.proxy}` : '';
  const summary =
    `For ${domain}: best so far is ${top.format}${proxyLabel} ` +
    `(${top.successes} ok / ${top.failures} bad). ` +
    `Recommended order: ${recommended.map(r => r.format + (r.proxy ? `(${r.proxy})` : '')).join(' → ')}.`;

  return { domain, hasHistory: true, recommended, summary };
}
