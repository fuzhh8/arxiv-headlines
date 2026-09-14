import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const start = html.indexOf('function paginationItems');
const end = html.indexOf('/* Saved-paper views */', start);

assert.ok(start >= 0 && end > start, 'pagination source block should exist');
const paginationSource = html.slice(start, end);

test('inline browser scripts parse as JavaScript', () => {
  const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(inlineScripts.length >= 2);
  for (const [, source] of inlineScripts) new Function(source);
});

test('right panel and PDF preview are off by default', () => {
  assert.doesNotMatch(html, /id="previewPanelToggle"[^>]*\bchecked\b/);
  assert.doesNotMatch(html, /id="pdfPreviewToggle"[^>]*\bchecked\b/);
  assert.match(html, /settingsVersion:\s*2/);
});

test('static frontend routes cache and fetch requests through its configured API', () => {
  assert.match(html, /ARXIV_HEADLINES_CONFIG\?\.apiBaseUrl/);
  assert.match(html, /apiUrl\(`\/api\/cache\?/);
  assert.match(html, /fetch\(apiUrl\('\/api\/fetch'\)/);
});

test('mobile figure gallery keeps a viewport-fixed close control', () => {
  assert.match(html, /height:\s*100dvh/);
  assert.match(html, /#figureClose\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?width:\s*48px;[\s\S]*?height:\s*48px;/);
  assert.match(html, /safe-area-inset-top/);
});

function loadPagination(pageSize = 24, currentPage = 1) {
  return new Function('pageSize', 'currentPage', `
    ${paginationSource}
    return {
      paginationItems,
      renderPagination,
      sliceSectionGroups,
      getCurrentPage: () => currentPage
    };
  `)(pageSize, currentPage);
}

test('pagination keeps a compact window around the current page', () => {
  const { paginationItems } = loadPagination();
  assert.deepEqual(paginationItems(5, 10), [1, 'ellipsis', 3, 4, 5, 6, 7, 'ellipsis', 10]);
});

test('one page slices across section boundaries without exceeding page size', () => {
  const pagination = loadPagination(24, 3);
  const groups = [
    { sec: 'new', papers: Array.from({ length: 58 }, (_, i) => `n${i}`) },
    { sec: 'cross', papers: Array.from({ length: 12 }, (_, i) => `c${i}`) },
    { sec: 'repl', papers: Array.from({ length: 43 }, (_, i) => `r${i}`) }
  ];

  const result = pagination.sliceSectionGroups(groups);
  assert.equal(result.totalItems, 113);
  assert.deepEqual(result.visibleGroups.map(group => group.visiblePapers.length), [10, 12, 2]);
  assert.equal(result.visibleGroups.flatMap(group => group.visiblePapers).length, 24);
});

test('out-of-range pages clamp to the final page', () => {
  const pagination = loadPagination(24, 99);
  const result = pagination.sliceSectionGroups([
    { sec: 'new', papers: Array.from({ length: 113 }, (_, i) => i) }
  ]);

  assert.equal(pagination.getCurrentPage(), 5);
  assert.equal(result.visibleGroups[0].visiblePapers.length, 17);
});
