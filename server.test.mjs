import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createArxivServer } from './server.mjs';

function payloadFor(category, date) {
  return {
    schemaVersion: 1,
    status: 'ok',
    source: 'test',
    category,
    date,
    generatedAt: new Date().toISOString(),
    counts: { new: 1, cross: 0, repl: 0 },
    papersBySection: {
      new: [{ absId: '2609.00001', title: 'Test paper' }],
      cross: [],
      repl: []
    }
  };
}

async function withServer(run, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'arxiv-headlines-server-'));
  const dataRoot = join(root, 'data');
  writeFileSync(join(root, 'index.html'), '<h1>test</h1>', 'utf8');
  let fetchCalls = 0;

  const fakeFetcher = overrides.fetcher || (async (category, date, options) => {
    fetchCalls++;
    await new Promise(resolve => setTimeout(resolve, 30));
    const payload = payloadFor(category, date);
    const dir = join(options.dataRoot, category.replaceAll('.', '-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${date}.json`), JSON.stringify(payload), 'utf8');
    return payload;
  });

  const server = createArxivServer({
    root,
    dataRoot,
    fetcher: fakeFetcher,
    ...(overrides.enricher ? { enricher: overrides.enricher } : {}),
    ...(overrides.cacheStore ? { cacheStore: overrides.cacheStore } : {})
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run({ baseUrl, dataRoot, getFetchCalls: () => fetchCalls });
  } finally {
    server.close();
    await once(server, 'close');
    rmSync(root, { recursive: true, force: true });
  }
}

test('serves the site and health endpoint', async () => {
  await withServer(async ({ baseUrl }) => {
    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<h1>test<\/h1>/);

    const health = await fetch(`${baseUrl}/api/health`).then(response => response.json());
    assert.equal(health.ok, true);
    assert.ok(health.categories.includes('astro-ph'));
  });
});

test('fetches a missing day once, persists it, and then uses the cache', async () => {
  await withServer(async ({ baseUrl, getFetchCalls }) => {
    const request = () => fetch(`${baseUrl}/api/fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'astro-ph', date: '2026-09-15' })
    }).then(response => response.json());

    const [first, second] = await Promise.all([request(), request()]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(getFetchCalls(), 1);

    const third = await request();
    assert.equal(third.source, 'cache');
    assert.equal(getFetchCalls(), 1);

    const cached = await fetch(`${baseUrl}/data/astro-ph/2026-09-15.json`);
    assert.equal(cached.status, 200);
    assert.equal((await cached.json()).papersBySection.new[0].title, 'Test paper');
  });
});

test('rejects unsupported categories and invalid dates', async () => {
  await withServer(async ({ baseUrl, getFetchCalls }) => {
    const response = await fetch(`${baseUrl}/api/fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: '../private', date: '2026-02-31' })
    });

    assert.equal(response.status, 400);
    assert.equal((await response.json()).ok, false);
    assert.equal(getFetchCalls(), 0);
  });
});

test('syncs saved lists by a private sync code', async () => {
  const syncCode = 'this_is_a_private_sync_code_12345';
  const objects = new Map();
  const cacheStore = {
    enabled: true,
    kind: 's3',
    async readObject(key) { return objects.get(key) || null; },
    async writeObject(key, value) { objects.set(key, value); return true; }
  };
  await withServer(async ({ baseUrl }) => {
    const saved = await fetch(`${baseUrl}/api/user-state/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        syncCode,
        state: {
          favorites: ['2609.00001v2'],
          readingStates: { '2609.00002': 'queue', 'not-an-arxiv-id': 'read' }
        }
      })
    });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.equal(savedBody.durable, true);
    assert.deepEqual(savedBody.state.favorites, ['2609.00001']);
    assert.deepEqual(savedBody.state.readingStates, { '2609.00002': 'queue' });
    assert.match(savedBody.state.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

    const loaded = await fetch(`${baseUrl}/api/user-state/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ syncCode })
    });
    assert.equal(loaded.status, 200);
    assert.deepEqual((await loaded.json()).state.favorites, ['2609.00001']);

  }, { cacheStore });
  assert.equal([...objects.keys()].filter(key => key.startsWith('user-state/')).length, 1);
});

test('serves a durable object-cache entry to a cross-origin static site', async () => {
  const date = '2026-09-17';
  const remotePayload = {
    ...payloadFor('astro-ph', date),
    figuresStatus: 'complete',
    figureCounts: { processed: 1, total: 1, found: 1 }
  };
  const writes = [];
  const cacheStore = {
    enabled: true,
    kind: 's3',
    async read(category, requestedDate) {
      return category === 'astro-ph' && requestedDate === date ? remotePayload : null;
    },
    async write(payload) {
      writes.push(payload);
      return true;
    }
  };

  await withServer(async ({ baseUrl, dataRoot }) => {
    const response = await fetch(`${baseUrl}/api/cache?category=astro-ph&date=${date}`, {
      headers: { Origin: 'https://static.example' }
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal((await response.json()).date, date);

    const localMirror = JSON.parse(readFileSync(join(dataRoot, 'astro-ph', `${date}.json`), 'utf8'));
    assert.equal(localMirror.figureCounts.found, 1);

    const preflight = await fetch(`${baseUrl}/api/fetch`, { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
  }, { cacheStore });

  assert.deepEqual(writes, []);
});

test('returns metadata first and reports background figure progress', async () => {
  let enrichCalls = 0;
  let observedPriorityIds = [];
  let testDataRoot = '';

  const fetcher = async (category, date, options) => {
    assert.equal(options.includeFigures, false);
    const payload = {
      ...payloadFor(category, date),
      figuresStatus: 'pending',
      figureCounts: { processed: 0, total: 2, found: 0 }
    };
    const dir = join(options.dataRoot, category.replaceAll('.', '-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${date}.json`), JSON.stringify(payload), 'utf8');
    return payload;
  };

  const enricher = async (category, date, options) => {
    enrichCalls++;
    options.onProgress({ processed: 0, total: 2, found: 0 });
    await new Promise(resolve => setTimeout(resolve, 20));
    observedPriorityIds = options.getPriorityIds();
    options.onProgress({ processed: 1, total: 2, found: 1 });
    await new Promise(resolve => setTimeout(resolve, 20));
    options.onProgress({ processed: 2, total: 2, found: 2 });

    const path = join(options.dataRoot, category.replaceAll('.', '-'), `${date}.json`);
    const payload = JSON.parse(readFileSync(path, 'utf8'));
    payload.figuresStatus = 'complete';
    payload.figureCounts = { processed: 2, total: 2, found: 2 };
    writeFileSync(path, JSON.stringify(payload), 'utf8');
    return payload;
  };

  await withServer(async ({ baseUrl, dataRoot }) => {
    testDataRoot = dataRoot;
    const response = await fetch(`${baseUrl}/api/fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'astro-ph', date: '2026-09-16' })
    }).then(result => result.json());

    assert.equal(response.ok, true);
    assert.ok(['queued', 'figures'].includes(response.figures.phase));

    const prioritized = await fetch(`${baseUrl}/api/fetch/prioritize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'astro-ph',
        date: '2026-09-16',
        ids: ['2609.00002v3', 'invalid', '2609.00001']
      })
    }).then(result => result.json());
    assert.equal(prioritized.ok, true);
    assert.equal(prioritized.accepted, true);

    let status;
    for (let attempt = 0; attempt < 20; attempt++) {
      status = await fetch(`${baseUrl}/api/fetch/status?category=astro-ph&date=2026-09-16`)
        .then(result => result.json());
      if (status.figures.phase === 'complete') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    assert.equal(status.figures.phase, 'complete');
    assert.equal(status.figures.processed, 2);
    assert.equal(status.figures.found, 2);
  }, { fetcher, enricher });

  assert.equal(enrichCalls, 1);
  assert.deepEqual(observedPriorityIds, ['2609.00002', '2609.00001']);
  assert.ok(testDataRoot);
});
