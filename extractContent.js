#!/usr/bin/env node

import Mercury from '@jocmp/mercury-parser';
import { Defuddle } from 'defuddle/node';
import { decode } from 'html-entities';
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { getCachedRender, setCachedRender } from './cache.js';
import { resolveProxy, loadProxiesFromFile } from './proxies.js';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Supported output forms, ordered cheap -> expensive. `rendered_html` and the
// two extractors all reuse the same cached rendered HTML; `screenshot` always
// drives a live browser and is the most expensive.
export const FORMATS = ['rendered_html', 'mercury', 'defuddle', 'screenshot'];
export const DEFAULT_FORMAT = 'mercury';

const browserPromises = new Map();

function launchOptions(proxy) {
  const opts = { headless: true };
  if (proxy) opts.proxy = { server: proxy };
  return opts;
}

async function launchOrInstall(proxy) {
  try {
    return await chromium.launch(launchOptions(proxy));
  } catch (err) {
    const message = err?.message || '';
    const looksLikeMissingBrowser =
      /Executable doesn't exist/i.test(message) ||
      /please run.*install/i.test(message) ||
      /browserType\.launch/i.test(message);

    if (!looksLikeMissingBrowser) throw err;

    console.error('[omni-fetcher] Chromium not found, installing (one-time, ~150MB)...');
    await new Promise((resolve, reject) => {
      const child = spawn('npx', ['--yes', 'playwright', 'install', 'chromium'], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      child.on('exit', code =>
        code === 0 ? resolve() : reject(new Error(`playwright install exited with code ${code}`))
      );
      child.on('error', reject);
    });
    return await chromium.launch(launchOptions(proxy));
  }
}

function getBrowser(proxy) {
  const key = proxy || '';
  if (!browserPromises.has(key)) {
    browserPromises.set(key, launchOrInstall(proxy));
  }
  return browserPromises.get(key);
}

export async function closeBrowser() {
  const entries = Array.from(browserPromises.entries());
  browserPromises.clear();
  for (const [, promise] of entries) {
    try {
      const browser = await promise;
      await browser.close();
    } catch (err) {
      console.error(`[omni-fetcher] Error closing browser: ${err.message}`);
    }
  }
}

function validateUrl(url) {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error(`Invalid URL: ${url}. Only HTTP and HTTPS protocols are supported.`);
  }
  try {
    new URL(url);
  } catch {
    throw new Error(`Invalid URL format: ${url}`);
  }
}

// Render a single page to HTML, preferring the cache. On a miss the page is
// rendered with Playwright (capturing the "next page" link too) and stored. If
// Playwright fails we fall back to a plain fetch of the raw HTML so the
// extractors still have something to work with.
async function renderPage(url, proxy) {
  const cached = getCachedRender(url, proxy);
  if (cached) {
    console.error(`[omni-fetcher] Cache hit: ${url}`);
    return cached;
  }

  console.error(`[omni-fetcher] Rendering: ${url}`);
  const browser = await getBrowser(proxy);
  const context = await browser.newContext({ userAgent: USER_AGENT });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const html = await page.content();
    const nextUrl = await findNextPageLinkSafe(page);
    setCachedRender(url, proxy, html, nextUrl);
    return { html, nextUrl };
  } catch (err) {
    console.error(`[omni-fetcher] Playwright failed for ${url}: ${err.message}. Falling back to plain fetch.`);
    const html = await plainFetch(url);
    setCachedRender(url, proxy, html, null);
    return { html, nextUrl: null };
  } finally {
    await context.close();
  }
}

async function plainFetch(url) {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Fetch failed (${res.status} ${res.statusText}) for ${url}`);
  return res.text();
}

// Walk pagination links, rendering each page (cache-aware), and return the
// ordered list of { url, html }. `visited` guards against loops.
async function crawl(startUrl, proxy) {
  const visited = new Set();
  const pages = [];
  let currentUrl = startUrl;

  while (currentUrl && !visited.has(currentUrl)) {
    visited.add(currentUrl);
    const { html, nextUrl } = await renderPage(currentUrl, proxy);
    pages.push({ url: currentUrl, html });
    currentUrl = nextUrl;
  }
  return pages;
}

async function takeScreenshot(url, proxy) {
  console.error(`[omni-fetcher] Screenshotting: ${url}`);
  const browser = await getBrowser(proxy);
  const context = await browser.newContext({ userAgent: USER_AGENT });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    return await page.screenshot({ fullPage: true, type: 'png' });
  } finally {
    await context.close();
  }
}

async function parseWithDefuddle(html, url) {
  // Defuddle logs progress to stdout, which would corrupt the stdio JSON-RPC
  // stream. Route console.log to stderr for the duration of the call.
  const originalLog = console.log;
  console.log = (...args) => console.error(...args);
  try {
    return await Defuddle(html, url, { markdown: true });
  } finally {
    console.log = originalLog;
  }
}

/**
 * Extract a URL in the requested form.
 *
 * @param {string} url
 * @param {{ proxy?: string, format?: string }} [options]
 *   `proxy` may be a full proxy URL or a known proxy id.
 *   `format` is one of FORMATS (default "mercury").
 * @returns {Promise<{ type: 'text', text: string } | { type: 'image', data: string, mimeType: string }>}
 */
const extractContent = async (url, options = {}) => {
  validateUrl(url);
  const format = options.format || DEFAULT_FORMAT;
  if (!FORMATS.includes(format)) {
    throw new Error(`Unknown format "${format}". Expected one of: ${FORMATS.join(', ')}.`);
  }
  const proxy = resolveProxy(options.proxy) || process.env.MERCURY_PROXY || undefined;

  if (format === 'screenshot') {
    const buffer = await takeScreenshot(url, proxy);
    return { type: 'image', data: buffer.toString('base64'), mimeType: 'image/png' };
  }

  const pages = await crawl(url, proxy);

  if (format === 'rendered_html') {
    const text = pages.length === 1
      ? pages[0].html
      : pages.map((p, i) => `<!-- omni-fetcher page ${i + 1}: ${p.url} -->\n${p.html}`).join('\n\n');
    return { type: 'text', text };
  }

  if (format === 'defuddle') {
    const parsed = [];
    for (const p of pages) {
      const r = await parseWithDefuddle(p.html, p.url);
      parsed.push({
        title: r.title,
        author: r.author,
        date_published: r.published,
        excerpt: r.description,
        content: r.content,
        domain: r.domain,
      });
    }
    return { type: 'text', text: formatMarkdown(parsed, url, { rawContent: true }) };
  }

  // mercury
  const parsed = [];
  for (const p of pages) {
    parsed.push(await Mercury.parse(p.url, { html: p.html }));
  }
  return { type: 'text', text: formatMarkdown(parsed, url) };
};

async function findNextPageLinkSafe(page) {
  try {
    if (!page.url() || page.url() === 'about:blank') return null;
    return await findNextPageLink(page);
  } catch {
    return null;
  }
}

async function findNextPageLink(page) {
  return page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'));
    const nextLink = links.find(link => {
      const text = (link.textContent || '').toLowerCase();
      return (
        text.includes('next') ||
        text.includes('次へ') ||
        text.includes('次ページ') ||
        text.includes('→') ||
        text.includes('▶') ||
        link.getAttribute('rel') === 'next'
      );
    });
    if (nextLink && nextLink.href) return nextLink.href;

    const currentPage = document.querySelector(
      '.pagination .current, [aria-current="page"], .pagination .active'
    );
    if (currentPage) {
      const sibling = currentPage.nextElementSibling;
      if (sibling) {
        if (sibling.tagName === 'A' && sibling.href) return sibling.href;
        const innerA = sibling.querySelector && sibling.querySelector('a[href]');
        if (innerA && innerA.href) return innerA.href;
      }
    }
    return null;
  });
}

function unescapeText(text) {
  if (!text) return '';
  return decode(text)
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\');
}

// Shared Markdown assembler for the extractor formats. `rawContent` leaves the
// page content untouched (Defuddle already emits Markdown); otherwise content is
// unescaped (Mercury emits escaped HTML-ish text).
function formatMarkdown(pages, originalUrl, { rawContent = false } = {}) {
  if (!pages.length) return 'No content found';

  const firstPage = pages[0];
  let markdown = `# ${unescapeText(firstPage.title || 'No Title')}\n\n`;

  if (firstPage.author) {
    markdown += `*Author: ${unescapeText(firstPage.author)}*\n\n`;
  }

  if (firstPage.date_published) {
    const publishDate = new Date(firstPage.date_published);
    if (!isNaN(publishDate)) {
      markdown += `*Published: ${publishDate.toLocaleDateString()}*\n\n`;
    }
  }

  if (firstPage.excerpt) {
    markdown += `## Summary\n${unescapeText(firstPage.excerpt)}\n\n`;
  }

  markdown += `## Content\n`;

  pages.forEach((page, index) => {
    if (page.content) {
      if (index > 0) {
        markdown += `\n\n### Page ${index + 1}\n\n`;
      }
      markdown += (rawContent ? page.content : unescapeText(page.content)) + '\n\n';
    }
  });

  if (firstPage.domain) {
    markdown += `---\nSource: [${unescapeText(firstPage.domain)}](${originalUrl})\n`;
  }

  return markdown;
}

export default extractContent;

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node extractContent.js <url> [format] [proxy]');
    console.error(`  format: ${FORMATS.join(' | ')} (default: ${DEFAULT_FORMAT})`);
    process.exit(1);
  }
  const [url, format, proxy] = args;
  loadProxiesFromFile();
  extractContent(url, { format, proxy })
    .then(async result => {
      if (result.type === 'image') {
        console.error(`[omni-fetcher] (${result.mimeType}, ${result.data.length} base64 chars)`);
        console.log(result.data);
      } else {
        console.log(result.text);
      }
      await closeBrowser();
    })
    .catch(async err => {
      console.error(`Error: ${err.message}`);
      await closeBrowser();
      process.exit(1);
    });
}
