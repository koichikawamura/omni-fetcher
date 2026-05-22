# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP server (`@koichikawamura/omni-fetcher`) exposing an `extract` tool: given a URL, it renders the page with headless Chromium (Playwright) so JS content is captured, then returns it in one of four forms — `mercury` (Mercury Parser Markdown), `defuddle` (Defuddle Markdown), `rendered_html`, or `screenshot` (PNG, returned as a base64 image or — when screenshot storage is configured — a URL). Rendered HTML is cached per URL/proxy in SQLite; proxies can be referenced by id from a SQLite-backed database seeded from a config file. A second `list_proxies` tool reports registered proxies. ESM only (`"type": "module"`). No build step, no test framework, no linter.

**Node 22.5+ required** — persistence uses the built-in `node:sqlite` module on purpose, so there is no native dependency to compile. (`better-sqlite3` was tried first and fails to build against Node 26's V8.)

## Commands

```sh
npm install                                           # deps; Playwright Chromium NOT installed here
node mcp-server.js                                    # run MCP server (stdio, default)
MCP_TRANSPORT=http MCP_PORT=3030 node mcp-server.js   # run over Streamable HTTP at /mcp
node extractContent.js <url> [format] [proxy]         # exercise the engine directly, no MCP
```

The CLI form of `extractContent.js` is the fastest way to test extraction changes (prints text, or base64 PNG for `screenshot`, then exits). There is no test suite; verify against real URLs. Playwright's Chromium auto-installs on first launch failure via `launchOrInstall` — no manual step.

## Architecture

Split by responsibility:

- **`mcp-server.js`** — transport/protocol only. Registers `extract` + `list_proxies` tools and an `info` resource, calls `loadProxiesFromFile()` at startup, then connects a `StdioServerTransport` or `StreamableHTTPServerTransport` per `MCP_TRANSPORT`. HTTP mode is **stateless**: `buildServer()` runs fresh per request (`sessionIdGenerator: undefined`), torn down on response close. SIGINT/SIGTERM call `closeBrowser()` before exit. Screenshot results are returned as an `image` content block (base64) or, when screenshot storage is on, a `text` block holding the URL; everything else as `text`. In HTTP mode a `GET /screenshots/<file>` route on the same port serves stored screenshots (guarded by `resolveScreenshotFile`). Also runs the cache sweep at startup + on an interval (`startCacheSweep`).
- **`extractContent.js`** — the engine + standalone CLI (the `import.meta.url === file://...` guard). Default export `extractContent(url, { proxy, format })` returns `{ type: 'text', text }`, `{ type: 'image', data, mimeType }`, or (screenshots with storage enabled) `{ type: 'image_url', url, mimeType }`. Also exports `closeBrowser`, `FORMATS`, `DEFAULT_FORMAT`.
- **`db.js`** — single shared `node:sqlite` connection (`getDb()`), creates the `rendered_html` and `proxies` tables. WAL mode. Persistent state defaults to a per-user dir (`dataDir()` → `~/.omni-fetcher`), **not the cwd**, so `npx` launches behave consistently; override with `OMNI_DATA_DIR` / `OMNI_DB_PATH` / `OMNI_PROXIES_FILE`.
- **`cache.js`** — `getCachedRender` / `setCachedRender`, keyed by `(url, proxy)`; entries past `OMNI_CACHE_TTL` are treated as misses and pruned on read. `pruneStaleRenders()` is the bulk age-based sweep (`DELETE … WHERE fetched_at < now - TTL`) for URLs never re-requested; the server runs it at startup and every `OMNI_CACHE_SWEEP_INTERVAL` seconds (default `3600`, `<=0` disables the interval). The CLI does not sweep.
- **`proxies.js`** — `loadProxiesFromFile` (seeds the `proxies` table from `OMNI_PROXIES_FILE`), `listProxies`, and `resolveProxy`.
- **`screenshots.js`** — optional server-side screenshot storage, enabled when `OMNI_SCREENSHOT_DIR` is set. `storeScreenshot(buffer)` writes the PNG under a unique, unguessable random name (`crypto.randomBytes(16)` hex — distinct per shot so concurrent users can't collide or enumerate URLs) and returns a public URL (`OMNI_SCREENSHOT_BASE_URL`, default `http://<MCP_HOST>:<MCP_PORT>/screenshots`). It is the **single seam**: to back screenshots with a third-party store (S3, an upload endpoint, …), rewrite only this function — nothing else, including stdio mode, depends on how the bytes are stored. `resolveScreenshotFile(name)` maps a `/screenshots/` request to a file, accepting only our generated names (which also blocks path traversal). Since names are unique-per-shot, `pruneStaleScreenshots()` (mtime older than `OMNI_SCREENSHOT_TTL`, default 1 day; only touches files matching our name pattern) is the only cleanup — the server runs it inside the same sweep tick as the render cache. When enabled, `extractContent`'s screenshot branch returns `{ type: 'image_url', url, mimeType }` instead of base64 `image`; the server turns that into a text content block.
- **`knowledge.js`** — per-site fetch knowledge. `recordFetch` writes every attempt to `fetch_log` and aggregates into `fetch_stats` (keyed `domain × format × proxy`); `classifyResult`/`classifyNavError` derive the outcome; `suggestStrategy` ranks `(format, proxy)` for a domain. Backs the `suggest_strategy` tool.

Cross-cutting behaviors worth knowing before editing:

- **stdout is sacred in stdio mode.** The JSON-RPC stream lives on stdout, so nothing else may write there. All logging uses `console.error`. **Defuddle logs to stdout via `console.log`** — `parseWithDefuddle` temporarily reassigns `console.log` to `console.error` around the call. Don't remove that guard, and never add a bare `console.log` to the request path.
- **Anti-bot / stealth.** Chromium is driven via `playwright-extra` with `puppeteer-extra-plugin-stealth`, applied once at module load (`chromium.use(StealthPlugin())`). It masks the headless fingerprint sites reset on. `newContext` adds locale/timezone/viewport/`Accept-Language`. Navigation goes through `gotoResilient` (`domcontentloaded`, one retry on transient resets like `ERR_CONNECTION_RESET`); **never reintroduce `networkidle`** — it caused screenshot connection resets on ad-heavy sites. `takeScreenshot` instead uses `autoScroll` to trigger lazy images.
- **Browser pooling by proxy.** `browserPromises` is a module-level `Map` keyed by proxy URL (`''` for none). Browsers launch lazily, are reused across requests, and are only closed by `closeBrowser()` on shutdown — never per request. Each render gets a fresh `context`/`page`. Don't close the shared browser per-request.
- **Render path & cache.** `renderPage(url, proxy)` checks the cache, else Playwright-renders, captures the next-page link, and stores `{html, nextUrl}`. On Playwright failure it falls back to a plain `fetch` of raw HTML (no proxy, `nextUrl: null`) and caches that. All non-screenshot formats consume this cached HTML; `screenshot` (`takeScreenshot`) bypasses the cache and always renders live.
- **Pagination.** `crawl` follows next-page links into an ordered page list, assembled by `formatMarkdown` (shared by mercury and defuddle; `rawContent: true` skips unescaping since Defuddle already emits Markdown). `findNextPageLink` uses text/`rel=next`/pagination-CSS heuristics including Japanese (`次へ`, `次ページ`); `visited` guards loops.
- **Proxy resolution order.** `resolveProxy(spec)` (a `://` URL is literal, else looked up as an id — unknown id throws) → `MERCURY_PROXY` → none.
- **Fetch knowledge / learning.** `extractContent` records every attempt via `recordFetch`. The server only judges *objective* outcomes (nav errors, anti-bot pages, empty); content **quality** is deliberately not assessed server-side (the calling agent is better placed to). Stats are keyed by the **proxy spec the caller passed** (not the resolved URL) so a suggestion can be replayed verbatim. Implicit failures fire whenever a more-effortful format (`ESCALATION` order) re-fetches the same URL within a window — independent of whether that re-fetch succeeded.

## Provenance & roadmap

Built up from a clone of `mercury-parser` (see `dev_notes/omni-fetcher.md`, "Phase 0"). The upstream parser dependency `@jocmp/mercury-parser` keeps its original name — do not rename it.
