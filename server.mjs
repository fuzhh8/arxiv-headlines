import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATEGORIES,
  categoryToDir,
  fetchAndStoreCategory,
  validateFetchTarget
} from './scripts/fetch-arxiv.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = __dirname;
const MAX_BODY_BYTES = 16 * 1024;

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
};

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large');
    chunks.push(chunk);
  }

  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (_) {
    throw new Error('Request body must be valid JSON');
  }
}

function isValidCachedPayload(payload, category, date) {
  return payload?.schemaVersion === 1 &&
    payload?.status === 'ok' &&
    payload?.category === category &&
    payload?.date === date &&
    ['new', 'cross', 'repl'].every(section => Array.isArray(payload?.papersBySection?.[section]));
}

async function readCachedPayload(dataRoot, category, date) {
  const path = join(dataRoot, categoryToDir(category), `${date}.json`);
  try {
    const payload = JSON.parse(await readFile(path, 'utf8'));
    return isValidCachedPayload(payload, category, date) ? payload : null;
  } catch (_) {
    return null;
  }
}

function createOnDemandFetcher({ dataRoot, fetcher }) {
  const inFlight = new Map();

  return async function ensureCached(category, date) {
    validateFetchTarget(category, date);
    const cached = await readCachedPayload(dataRoot, category, date);
    if (cached) return { source: 'cache', payload: cached };

    const key = `${category}/${date}`;
    let task = inFlight.get(key);
    if (!task) {
      task = fetcher(category, date, {
        dataRoot,
        prune: true,
        updateLatest: true
      });
      inFlight.set(key, task);
    }

    try {
      const payload = await task;
      if (!isValidCachedPayload(payload, category, date)) {
        throw new Error('Fetcher returned an invalid cache payload');
      }
      return { source: 'fetched', payload };
    } finally {
      if (inFlight.get(key) === task) inFlight.delete(key);
    }
  };
}

export function createArxivServer(options = {}) {
  const root = resolve(options.root || DEFAULT_ROOT);
  const dataRoot = resolve(options.dataRoot || join(root, 'data'));
  const fetcher = options.fetcher || fetchAndStoreCategory;
  const ensureCached = createOnDemandFetcher({ dataRoot, fetcher });

  return createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');

    try {
      if (requestUrl.pathname === '/api/health') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'Method not allowed' });
          return;
        }
        sendJson(res, 200, { ok: true, service: 'arxiv-headlines', categories: CATEGORIES });
        return;
      }

      if (requestUrl.pathname === '/api/fetch') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'Use POST for on-demand fetching' });
          return;
        }

        const body = await readJsonBody(req);
        const category = String(body.category || '');
        const date = String(body.date || '');
        const result = await ensureCached(category, date);
        sendJson(res, 200, {
          ok: true,
          source: result.source,
          category,
          date,
          counts: result.payload.counts
        });
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed' });
        return;
      }

      let pathname;
      try {
        pathname = decodeURIComponent(requestUrl.pathname);
      } catch (_) {
        sendJson(res, 400, { ok: false, error: 'Invalid URL encoding' });
        return;
      }

      const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const filePath = resolve(root, requested);
      const rel = relative(root, filePath);
      if (rel.startsWith(`..${sep}`) || rel === '..' || resolve(filePath) === resolve(root)) {
        sendJson(res, 403, { ok: false, error: 'Forbidden path' });
        return;
      }

      const info = await stat(filePath);
      if (!info.isFile()) throw Object.assign(new Error('Not found'), { code: 'ENOENT' });

      const content = await readFile(filePath);
      const contentType = MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
      const cacheControl = /\.(?:html|json)$/i.test(filePath) ? 'no-cache' : 'public, max-age=3600';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': content.length,
        'Cache-Control': cacheControl
      });
      if (req.method === 'HEAD') res.end();
      else res.end(content);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        sendJson(res, 404, { ok: false, error: 'Not found' });
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      const isInputError = /^(Unsupported arXiv category|Date must|Invalid calendar date|Request body)/.test(message);
      console.error(`[server] ${req.method} ${requestUrl.pathname}: ${message}`);
      sendJson(res, isInputError ? 400 : 502, { ok: false, error: message });
    }
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const port = Number(process.env.PORT || 8000);
  const host = process.env.HOST || '127.0.0.1';
  const server = createArxivServer();
  server.listen(port, host, () => {
    console.log(`arXiv Headlines: http://${host}:${port}`);
    console.log('Missing dates will be fetched and cached automatically.');
  });
}
