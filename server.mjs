import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createObjectCacheStore } from './cache-store.mjs';
import { createUserStore, validateUserState } from './user-store.mjs';
import {
  CATEGORIES,
  categoryToDir,
  enrichAndStoreCategoryFigures,
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

function validateSyncCode(value) {
  const syncCode = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(syncCode)) {
    throw new Error('Sync code is invalid');
  }
  return syncCode;
}

function validateFeedback(payload) {
  const message = String(payload?.message || '').trim();
  const email = String(payload?.email || '').trim();
  if (message.length < 3 || message.length > 2000) {
    throw new Error('Feedback must be between 3 and 2000 characters');
  }
  if (email.length > 254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new Error('Feedback email is invalid');
  }
  return { message, ...(email ? { email } : {}) };
}

async function readLocalCachedPayload(dataRoot, category, date) {
  const path = join(dataRoot, categoryToDir(category), `${date}.json`);
  try {
    const payload = JSON.parse(await readFile(path, 'utf8'));
    return isValidCachedPayload(payload, category, date) ? payload : null;
  } catch (_) {
    return null;
  }
}

async function writeLocalCachedPayload(dataRoot, payload) {
  const dir = join(dataRoot, categoryToDir(payload.category));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${payload.date}.json`), JSON.stringify(payload, null, 2), 'utf8');
}

function cacheProgress(payload) {
  const complete = payload?.figuresStatus === 'complete' ? 1 : 0;
  const processed = Number(payload?.figureCounts?.processed || 0);
  const timestamp = Date.parse(payload?.figuresUpdatedAt || payload?.figuresGeneratedAt || payload?.generatedAt || 0) || 0;
  return [complete, processed, timestamp];
}

function newerPayload(local, remote) {
  if (!local) return remote;
  if (!remote) return local;
  const left = cacheProgress(local);
  const right = cacheProgress(remote);
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return right[index] > left[index] ? remote : local;
  }
  return local;
}

async function readCachedPayload(dataRoot, category, date, cacheStore) {
  const localPromise = readLocalCachedPayload(dataRoot, category, date);
  let remote = null;
  if (cacheStore.enabled) {
    try {
      remote = await cacheStore.read(category, date);
      if (!isValidCachedPayload(remote, category, date)) remote = null;
    } catch (error) {
      console.warn(`[cache] Could not read ${category}/${date} from ${cacheStore.kind}: ${error.message}`);
    }
  }

  const local = await localPromise;
  const selected = newerPayload(local, remote);
  if (selected === remote && remote) await writeLocalCachedPayload(dataRoot, remote);
  return selected;
}

function createOnDemandFetcher({ dataRoot, fetcher, enricher, cacheStore }) {
  const metadataInFlight = new Map();
  const figureJobs = new Map();
  let figureQueue = Promise.resolve();

  function publicFigureStatus(job, payload = null) {
    if (job) {
      return {
        phase: job.phase,
        processed: job.processed,
        total: job.total,
        found: job.found,
        ...(job.error ? { error: job.error } : {})
      };
    }

    if (payload?.figuresStatus === 'pending') {
      return { phase: 'queued', processed: 0, total: payload.figureCounts?.total || 0, found: 0 };
    }
    return {
      phase: payload ? 'complete' : 'missing',
      processed: payload?.figureCounts?.processed || 0,
      total: payload?.figureCounts?.total || 0,
      found: payload?.figureCounts?.found || 0
    };
  }

  function startFigureJob(category, date, payload) {
    if (payload?.figuresStatus !== 'pending') return null;

    const key = `${category}/${date}`;
    if (figureJobs.has(key)) return figureJobs.get(key);

    const job = {
      phase: 'queued',
      processed: 0,
      total: payload.figureCounts?.total || 0,
      found: 0,
      error: '',
      priorityIds: [],
      persistQueue: Promise.resolve()
    };
    figureJobs.set(key, job);

    const run = figureQueue.then(async () => {
      job.phase = 'figures';
      const enriched = await enricher(category, date, {
        dataRoot,
        getPriorityIds: () => job.priorityIds,
        onProgress(progress) {
          job.processed = progress.processed;
          job.total = progress.total;
          job.found = progress.found;
          const checkpointReady = progress.processed > 0 &&
            (progress.processed % 2 === 0 || progress.processed === progress.total);
          if (cacheStore.enabled && checkpointReady) {
            job.persistQueue = job.persistQueue.then(async () => {
              const checkpoint = await readLocalCachedPayload(dataRoot, category, date);
              if (checkpoint) await cacheStore.write(checkpoint);
            }).catch(error => {
              console.warn(`[cache] Could not persist figure checkpoint for ${category}/${date}: ${error.message}`);
            });
          }
        }
      });
      await job.persistQueue;
      if (cacheStore.enabled) await cacheStore.write(enriched);
      job.phase = 'complete';
      job.processed = enriched.figureCounts?.processed || job.processed;
      job.total = enriched.figureCounts?.total || job.total;
      job.found = enriched.figureCounts?.found || job.found;
    }).catch(error => {
      job.phase = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      console.error(`[figures] ${category}/${date}: ${job.error}`);
    });

    job.promise = run;
    figureQueue = run;
    return job;
  }

  async function ensureCached(category, date) {
    validateFetchTarget(category, date);
    const cached = await readCachedPayload(dataRoot, category, date, cacheStore);
    if (cached) {
      const job = startFigureJob(category, date, cached);
      return { source: 'cache', payload: cached, figures: publicFigureStatus(job, cached) };
    }

    const key = `${category}/${date}`;
    let task = metadataInFlight.get(key);
    if (!task) {
      task = fetcher(category, date, {
        dataRoot,
        prune: true,
        updateLatest: true,
        includeFigures: false
      });
      metadataInFlight.set(key, task);
    }

    try {
      const payload = await task;
      if (!isValidCachedPayload(payload, category, date)) {
        throw new Error('Fetcher returned an invalid cache payload');
      }
      if (cacheStore.enabled) {
        try {
          await cacheStore.write(payload);
        } catch (error) {
          console.warn(`[cache] Could not persist metadata for ${category}/${date}: ${error.message}`);
        }
      }
      const job = startFigureJob(category, date, payload);
      return { source: 'fetched', payload, figures: publicFigureStatus(job, payload) };
    } finally {
      if (metadataInFlight.get(key) === task) metadataInFlight.delete(key);
    }

  }

  async function getStatus(category, date) {
    validateFetchTarget(category, date);
    const key = `${category}/${date}`;
    const job = figureJobs.get(key);
    if (job) return publicFigureStatus(job);
    const cached = await readCachedPayload(dataRoot, category, date, cacheStore);
    return publicFigureStatus(null, cached);
  }

  async function getCached(category, date) {
    validateFetchTarget(category, date);
    const job = figureJobs.get(`${category}/${date}`);
    if (job && ['queued', 'figures'].includes(job.phase)) {
      return readLocalCachedPayload(dataRoot, category, date);
    }
    return readCachedPayload(dataRoot, category, date, cacheStore);
  }

  function prioritize(category, date, ids) {
    validateFetchTarget(category, date);
    const key = `${category}/${date}`;
    const job = figureJobs.get(key);
    if (!job) return false;
    job.priorityIds = [...new Set(
      (Array.isArray(ids) ? ids : [])
        .map(id => String(id || '').trim().replace(/v\d+$/i, ''))
        .filter(id => /^\d{4}\.\d{4,5}$|^[a-z-]+(?:\.[A-Z]+)?\/\d{7}$/i.test(id))
    )].slice(0, 100);
    return true;
  }

  return { ensureCached, getStatus, getCached, prioritize };
}

export function createArxivServer(options = {}) {
  const root = resolve(options.root || DEFAULT_ROOT);
  const dataRoot = resolve(options.dataRoot || join(root, 'data'));
  const fetcher = options.fetcher || fetchAndStoreCategory;
  const enricher = options.enricher || enrichAndStoreCategoryFigures;
  const cacheStore = options.cacheStore || createObjectCacheStore(options.env || process.env);
  const userStore = options.userStore || createUserStore({ root, cacheStore });
  const corsOrigin = options.corsOrigin ?? process.env.CORS_ORIGIN ?? '*';
  const onDemand = createOnDemandFetcher({ dataRoot, fetcher, enricher, cacheStore });

  return createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');

    try {
      if (requestUrl.pathname.startsWith('/api/')) {
        res.setHeader('Access-Control-Allow-Origin', corsOrigin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
        res.setHeader('Vary', 'Origin');
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }
      }

      if (requestUrl.pathname === '/api/health') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'Method not allowed' });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          service: 'arxiv-headlines',
          categories: CATEGORIES,
          cache: cacheStore.kind,
          userState: userStore.kind
        });
        return;
      }

      if (requestUrl.pathname === '/api/user-state/load') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'Use POST to load saved lists' });
          return;
        }
        const body = await readJsonBody(req);
        const syncCode = validateSyncCode(body.syncCode);
        const state = await userStore.loadState(syncCode);
        sendJson(res, 200, { ok: true, state, durable: userStore.durable });
        return;
      }

      if (requestUrl.pathname === '/api/user-state/save') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'Use POST to save reading lists' });
          return;
        }
        const body = await readJsonBody(req);
        const syncCode = validateSyncCode(body.syncCode);
        const state = await userStore.saveState(syncCode, validateUserState(body.state));
        sendJson(res, 200, { ok: true, state, durable: userStore.durable });
        return;
      }

      if (requestUrl.pathname === '/api/feedback') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'Use POST to submit feedback' });
          return;
        }
        const body = await readJsonBody(req);
        const result = await userStore.saveFeedback(validateFeedback(body));
        sendJson(res, 201, { ok: true, ...result });
        return;
      }

      if (requestUrl.pathname === '/api/cache') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: 'Method not allowed' });
          return;
        }
        const category = String(requestUrl.searchParams.get('category') || '');
        const date = String(requestUrl.searchParams.get('date') || '');
        const payload = await onDemand.getCached(category, date);
        if (!payload) {
          sendJson(res, 404, { ok: false, error: 'Cache entry not found' });
          return;
        }
        sendJson(res, 200, payload);
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
        const result = await onDemand.ensureCached(category, date);
        sendJson(res, 200, {
          ok: true,
          source: result.source,
          category,
          date,
          counts: result.payload.counts,
          figures: result.figures
        });
        return;
      }

      if (requestUrl.pathname === '/api/fetch/status') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'Method not allowed' });
          return;
        }
        const category = String(requestUrl.searchParams.get('category') || '');
        const date = String(requestUrl.searchParams.get('date') || '');
        const figures = await onDemand.getStatus(category, date);
        sendJson(res, 200, { ok: true, category, date, figures });
        return;
      }

      if (requestUrl.pathname === '/api/fetch/prioritize') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'Method not allowed' });
          return;
        }
        const body = await readJsonBody(req);
        const category = String(body.category || '');
        const date = String(body.date || '');
        const accepted = onDemand.prioritize(category, date, body.ids);
        sendJson(res, 200, { ok: true, accepted, category, date });
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
      if (requested === '.private-state' || requested.startsWith('.private-state/')) {
        sendJson(res, 403, { ok: false, error: 'Forbidden path' });
        return;
      }
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
      const isInputError = /^(Unsupported arXiv category|Date must|Invalid calendar date|Request body|Sync code|Feedback)/.test(message);
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
