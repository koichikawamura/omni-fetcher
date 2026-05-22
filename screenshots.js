import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Settings-level screenshot storage. When OMNI_SCREENSHOT_DIR is set, screenshot
// requests write the PNG to that directory and `extract` returns a URL pointing
// at the file instead of inlining base64 — which keeps large images out of the
// MCP response (oversized base64 payloads can fail). This is a server-side
// setting only; clients cannot toggle it via the `extract` arguments.
//
// storeScreenshot() is the single seam. To serve images from a third-party store
// (S3, GCS, an upload endpoint, ...) instead of a local directory, rewrite ONLY
// this function to push `buffer` there and return its public URL. Nothing else —
// including stdio mode, which has no built-in HTTP server — depends on how or
// where the bytes are stored.

export function screenshotStorageEnabled() {
  return Boolean(process.env.OMNI_SCREENSHOT_DIR);
}

export function screenshotDir() {
  return process.env.OMNI_SCREENSHOT_DIR;
}

// Public URL prefix the stored files are reachable at. Defaults to the built-in
// same-port image route served by the HTTP transport; override for reverse
// proxies, external hosts, or a third-party store.
function baseUrl() {
  if (process.env.OMNI_SCREENSHOT_BASE_URL) {
    return process.env.OMNI_SCREENSHOT_BASE_URL.replace(/\/+$/, '');
  }
  const host = process.env.MCP_HOST || '127.0.0.1';
  const port = parseInt(process.env.MCP_PORT || '3000', 10);
  return `http://${host}:${port}/screenshots`;
}

// Unique, unguessable name per shot: 128 random bits, so concurrent users cannot
// collide and cannot enumerate or guess each other's screenshot URLs. Every
// screenshot is a distinct file (no overwrite), so storage grows until swept.
const NAME_RE = /^[0-9a-f]{32}\.png$/;
function newFilename() {
  return `${crypto.randomBytes(16).toString('hex')}.png`;
}

export async function storeScreenshot(buffer) {
  const dir = screenshotDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const name = newFilename();
  await fs.promises.writeFile(path.join(dir, name), buffer);
  return `${baseUrl()}/${name}`;
}

// Map a filename from the /screenshots/ route to a file on disk. Only names we
// generate are accepted, which also blocks path traversal. Returns null when
// storage is disabled or the name is not one of ours.
export function resolveScreenshotFile(name) {
  if (!screenshotStorageEnabled()) return null;
  if (!NAME_RE.test(name)) return null;
  return path.join(screenshotDir(), name);
}

// Lifetime of a stored screenshot before the sweep removes it, in seconds.
const TTL_SECONDS = parseInt(process.env.OMNI_SCREENSHOT_TTL || '86400', 10);

// Delete stored screenshots older than the TTL (by mtime). Since names are
// unique-per-shot, nothing else reclaims them; this is the only cleanup. No-op
// when storage is disabled or the dir does not exist yet. Returns the count
// removed.
export async function pruneStaleScreenshots() {
  if (!screenshotStorageEnabled()) return 0;
  const dir = screenshotDir();
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  const cutoff = Date.now() - TTL_SECONDS * 1000;
  let removed = 0;
  for (const name of names) {
    if (!NAME_RE.test(name)) continue; // never touch files we did not write
    const file = path.join(dir, name);
    try {
      const stat = await fs.promises.stat(file);
      if (stat.mtimeMs < cutoff) {
        await fs.promises.unlink(file);
        removed++;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; // raced with another sweep; ignore
    }
  }
  return removed;
}
