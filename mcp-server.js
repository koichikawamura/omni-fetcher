#!/usr/bin/env node

import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import extractContent, { closeBrowser, FORMATS, DEFAULT_FORMAT } from './extractContent.js';
import { loadProxiesFromFile, listProxies } from './proxies.js';
import { pruneStaleRenders } from './cache.js';
import { suggestStrategy } from './knowledge.js';

const buildServer = () => {
  const server = new McpServer({
    name: "Omni Fetcher",
    version: "1.0.0"
  });

  server.registerTool(
    "extract",
    {
      title: "Extract Web Content",
      description:
        "Fetch a web page (rendered with a headless browser) and return it in the requested form. " +
        "Pick the cheapest form that meets the need, escalating only if it fails or is insufficient: " +
        "`mercury` and `defuddle` return clean article Markdown (try mercury first, defuddle if mercury misses content); " +
        "`rendered_html` returns the full rendered HTML (large; use when you need raw markup or the extractors fail); " +
        "`screenshot` returns a PNG image (most expensive; use only when visual layout matters or text extraction fails).",
      inputSchema: {
        url: z.string().describe("URL of the website to fetch"),
        format: z.enum(FORMATS).optional().describe(
          `Output form (default "${DEFAULT_FORMAT}"). Ordered cheap -> expensive: ${FORMATS.join(', ')}.`
        ),
        proxy: z.string().optional().describe(
          "Optional proxy for the headless browser. Either a full URL (e.g. socks5://localhost:1080, " +
          "http://user:pass@host:port) or a proxy id registered in the proxy database."
        )
      }
    },
    async ({ url, format, proxy }) => {
      try {
        console.error(`Handling extract request: ${url} [${format || DEFAULT_FORMAT}]${proxy ? ` via ${proxy}` : ''}`);
        const result = await extractContent(url, { format, proxy });
        console.error(`Successfully extracted content from: ${url}`);
        if (result.type === 'image') {
          return { content: [{ type: "image", data: result.data, mimeType: result.mimeType }] };
        }
        return { content: [{ type: "text", text: result.text }] };
      } catch (error) {
        console.error(`Error in extract: ${error.message}`);
        throw new Error(`Failed to extract content: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "list_proxies",
    {
      title: "List Proxies",
      description: "List proxies registered in the proxy database (id, url, location). Use an id as the `proxy` argument to `extract`.",
      inputSchema: {}
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(listProxies(), null, 2) }]
    })
  );

  server.registerTool(
    "suggest_strategy",
    {
      title: "Suggest Fetch Strategy",
      description:
        "Given a URL, return the recommended order of (format, proxy) to try for that site, " +
        "learned from past fetches (successes, hard failures, and implicit failures where a " +
        "cheaper format had to be escalated). Call this before `extract` to skip combinations " +
        "that tend to fail on the domain. With no history it returns the default cheap→expensive escalation.",
      inputSchema: {
        url: z.string().describe("URL (or any URL on the domain) to get a strategy for")
      }
    },
    async ({ url }) => ({
      content: [{ type: "text", text: JSON.stringify(suggestStrategy(url), null, 2) }]
    })
  );

  server.registerResource(
    "info",
    "resource://postlight/info",
    {
      title: "Omni Fetcher Info",
      description: "Information about the Omni Fetcher service",
      mimeType: "application/json"
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify({
            name: "Omni Fetcher",
            description: "MCP service that fetches web content as Markdown, raw HTML, or a screenshot",
            version: "1.0.0",
            formats: FORMATS,
            capabilities: ["extract", "list_proxies", "suggest_strategy"]
          })
        }
      ]
    })
  );

  return server;
};

const transportMode = (process.env.MCP_TRANSPORT || 'stdio').toLowerCase();
let httpServer = null;
let sweepTimer = null;

// Drop renders older than the cache TTL: once at startup, then on an interval
// for the long-running server (default hourly; override OMNI_CACHE_SWEEP_INTERVAL,
// in seconds; <=0 disables the recurring sweep).
const startCacheSweep = () => {
  const sweep = () => {
    try {
      const removed = pruneStaleRenders();
      if (removed > 0) console.error(`Cache sweep: removed ${removed} stale render(s)`);
    } catch (err) {
      console.error(`Cache sweep failed: ${err.message}`);
    }
  };
  sweep();
  const intervalSeconds = parseInt(process.env.OMNI_CACHE_SWEEP_INTERVAL || '3600', 10);
  if (intervalSeconds > 0) {
    sweepTimer = setInterval(sweep, intervalSeconds * 1000);
    sweepTimer.unref(); // never keep the process alive just for the sweep
  }
};

const startStdio = async () => {
  console.error('MCP Server starting (stdio transport)');
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP Server connected (stdio)');
};

const startHttp = async () => {
  const host = process.env.MCP_HOST || '127.0.0.1';
  const port = parseInt(process.env.MCP_PORT || '3000', 10);
  const path = process.env.MCP_PATH || '/mcp';

  httpServer = http.createServer(async (req, res) => {
    if (!req.url || !req.url.startsWith(path)) {
      res.writeHead(404).end('Not Found');
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed.' },
          id: null
        })
      );
      return;
    }

    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error(`HTTP transport error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null
          })
        );
      }
    }
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  console.error(`MCP Server listening on http://${host}:${port}${path}`);
};

const start = async () => {
  try {
    loadProxiesFromFile();
    startCacheSweep();
    if (transportMode === 'http') {
      await startHttp();
    } else {
      await startStdio();
    }
  } catch (error) {
    console.error(`Error starting MCP server: ${error.message}`);
    process.exit(1);
  }
};

const shutdown = async (signal) => {
  console.error(`Received ${signal}, shutting down`);
  if (sweepTimer) clearInterval(sweepTimer);
  if (httpServer) {
    await new Promise(resolve => httpServer.close(() => resolve()));
  }
  await closeBrowser();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  console.error(`Uncaught exception: ${err.message}`);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error(`Unhandled rejection: ${reason}`);
});

start();
