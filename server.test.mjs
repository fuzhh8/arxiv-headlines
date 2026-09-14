import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

async function withServer(run) {
  const root = mkdtempSync(join(tmpdir(), 'arxiv-headlines-server-'));
  const dataRoot = join(root, 'data');
  writeFileSync(join(root, 'index.html'), '<h1>test</h1>', 'utf8');
  let fetchCalls = 0;

  const fakeFetcher = async (category, date, options) => {
    fetchCalls++;
    await new Promise(resolve => setTimeout(resolve, 30));
    const payload = payloadFor(category, date);
    const dir = join(options.dataRoot, category.replaceAll('.', '-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${date}.json`), JSON.stringify(payload), 'utf8');
    return payload;
  };

  const server = createArxivServer({ root, dataRoot, fetcher: fakeFetcher });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run({ baseUrl, getFetchCalls: () => fetchCalls });
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
