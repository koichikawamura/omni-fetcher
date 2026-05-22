# omni-fetcher

An MCP server for fetching web content in whatever form you need. Every page is first rendered with a headless Chromium (Playwright) so JavaScript-rendered content is captured, then returned as clean Markdown, raw HTML, or a screenshot. Rendered HTML is cached per URL/proxy, and proxies can be referenced by short id from a local database.

## Tool: `extract`

| Argument | Type | Required | Description |
|---|---|:-:|---|
| `url` | string | yes | URL of the page to fetch |
| `format` | enum | no | Output form (default `mercury`). One of `rendered_html`, `mercury`, `defuddle`, `screenshot`. |
| `proxy` | string | no | Full proxy URL (`http://host:port`, `socks5://host:port`, `http://user:pass@host:port`) **or** a proxy id registered in the proxy database. Overrides `MERCURY_PROXY` for this call. |

### Formats (cheap → expensive)

Pick the cheapest form that meets the need and escalate only if it fails or is insufficient:

| Format | Returns | When to use |
|---|---|---|
| `mercury` | Article Markdown via [Mercury Parser](https://github.com/jocmp/mercury-parser) | Default; clean article text. |
| `defuddle` | Article Markdown via [Defuddle](https://github.com/kepano/defuddle) | When Mercury misses content — a second opinion extractor. |
| `rendered_html` | Full rendered HTML | When you need raw markup, or both extractors fail. (Large output.) |
| `screenshot` | Full-page PNG (base64 image) | Most expensive; when visual layout matters or text extraction fails. |

`mercury`, `defuddle`, and `rendered_html` all reuse the same cached rendered HTML and follow pagination links automatically. `screenshot` always drives a live browser and is not cached.

The headless browser runs through [`playwright-extra`](https://www.npmjs.com/package/playwright-extra) with the [stealth plugin](https://www.npmjs.com/package/puppeteer-extra-plugin-stealth), which masks the automation fingerprint (`navigator.webdriver`, `window.chrome`, WebGL vendor, …) that some sites use to detect and reset bots. Navigation waits on `domcontentloaded` and retries once on transient connection resets. This still won't beat the strongest anti-bot stacks — pairing with a residential proxy helps there.

## Tool: `list_proxies`

Returns the registered proxies (`id`, `url`, `location`) so you know which ids you can pass to `extract`.

## Proxy database

Proxies are seeded from a JSON config file at startup (see `proxies.example.json`):

```json
[
  { "id": "jp-tokyo", "url": "socks5://localhost:1080", "location": "Tokyo, JP" },
  { "id": "us-east", "url": "http://user:pass@proxy.example.com:3128", "location": "Virginia, US" }
]
```

Save it as `~/.omni-fetcher/proxies.json` (the default location — created on first run; or point `OMNI_PROXIES_FILE` / `OMNI_DATA_DIR` elsewhere). After that you can call `extract` with `proxy: "jp-tokyo"` instead of the full URL. A `proxy` value containing `://` is always treated as a literal URL; otherwise it is looked up as an id.

## Tool: `suggest_strategy`

Returns the recommended order of `(format, proxy)` to try for a URL's domain, learned from past fetches. Call it before `extract` to skip combinations that tend to fail on that site.

| Argument | Type | Required | Description |
|---|---|:-:|---|
| `url` | string | yes | URL (or any URL on the domain) to get a strategy for |

```json
{
  "domain": "example.com",
  "hasHistory": true,
  "recommended": [
    { "format": "defuddle", "proxy": "jp-tokyo", "successes": 4, "failures": 0, "lastOutcome": "success" },
    { "format": "mercury", "proxy": "", "successes": 1, "failures": 3, "lastOutcome": "superseded" }
  ],
  "summary": "For example.com: best so far is defuddle via jp-tokyo (4 ok / 0 bad). …"
}
```

With no history it returns the default escalation `mercury → defuddle → rendered_html → screenshot`.

### How the knowledge is gathered

Every `extract` records its outcome into the SQLite knowledge base (`fetch_log` + `fetch_stats`, same DB file), keyed per `domain × format × proxy`:

- **Hard failures** the server can judge precisely: navigation errors (connection reset, timeout, DNS), anti-bot/challenge pages (Cloudflare "Just a moment…", captcha, 403), and empty results.
- **Implicit failures**: if the same URL is re-fetched soon after with a *more effortful* format (the escalation order above), the earlier attempt is marked superseded and penalized — the act of escalating signals the cheaper result wasn't good enough.

Content-*quality* judgments (beyond empty/blocked) are intentionally left to the calling agent; an explicit feedback tool may be added later.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` (Streamable HTTP). |
| `MCP_HOST` | `127.0.0.1` | Bind address when `MCP_TRANSPORT=http`. |
| `MCP_PORT` | `3000` | Bind port when `MCP_TRANSPORT=http`. |
| `MCP_PATH` | `/mcp` | URL path when `MCP_TRANSPORT=http`. |
| `MERCURY_PROXY` | — | Default proxy for the headless browser, used when no `proxy` argument is given. |
| `OMNI_DATA_DIR` | `~/.omni-fetcher` | Directory holding the SQLite DB and proxy config. Used so `npx` works regardless of cwd. |
| `OMNI_DB_PATH` | `<OMNI_DATA_DIR>/omni-fetcher.db` | SQLite file holding the render cache and proxy database. |
| `OMNI_CACHE_TTL` | `86400` | Rendered-HTML cache lifetime, in seconds. |
| `OMNI_CACHE_SWEEP_INTERVAL` | `3600` | How often the server bulk-deletes renders older than `OMNI_CACHE_TTL`, in seconds. Runs once at startup, then on this interval; `0` or less disables the recurring sweep (startup-only). |
| `OMNI_PROXIES_FILE` | `<OMNI_DATA_DIR>/proxies.json` | JSON file seeding the proxy database. |

## Usage

### Claude Desktop (local stdio)

```json
{
    "mcpServers": {
        "omni-fetcher": {
            "command": "npx",
            "args": ["@koichikawamura/omni-fetcher", "omni-fetcher-mcp"]
        }
    }
}
```

No paths to configure: the SQLite cache and proxy database default to `~/.omni-fetcher/`, so this works under `npx` regardless of the working directory. Drop a `proxies.json` in that directory to register proxies by id.

### Remote MCP (Streamable HTTP)

```sh
MCP_TRANSPORT=http \
MCP_HOST=127.0.0.1 \
MCP_PORT=3030 \
npx @koichikawamura/omni-fetcher omni-fetcher-mcp
```

Clients reach it at `http://<host>:<port>/mcp`. Pair with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) on the client side, or register directly as a connector in Claude.ai / ChatGPT if the endpoint is gated by an OAuth-aware proxy.

### CLI (ad-hoc testing)

```sh
node extractContent.js <url> [format] [proxy]
# e.g.
node extractContent.js https://example.com defuddle
node extractContent.js https://example.com screenshot   # prints base64 PNG to stdout
```

## Requirements

- Node.js 22.5+ (uses the built-in `node:sqlite` module — no native build step)
- Playwright Chromium (auto-installed on first launch if missing)

## License

MIT — see [LICENSE](LICENSE).
