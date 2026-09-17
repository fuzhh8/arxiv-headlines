import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const start = html.indexOf('function paginationItems');
const end = html.indexOf('/* Saved-paper views */', start);
const dateStart = html.indexOf('function offsetDate');
const dateEnd = html.indexOf('function categoryToDataDir', dateStart);
const searchStart = html.indexOf('function normalizeSearchText');
const searchEnd = html.indexOf('function highlightText', searchStart);
const captionStart = html.indexOf('function escapeLatexText');
const captionEnd = html.indexOf('/* Favorites */', captionStart);

assert.ok(start >= 0 && end > start, 'pagination source block should exist');
assert.ok(dateStart >= 0 && dateEnd > dateStart, 'date range source block should exist');
assert.ok(searchStart >= 0 && searchEnd > searchStart, 'search helper source block should exist');
assert.ok(captionStart >= 0 && captionEnd > captionStart, 'caption helper source block should exist');
const paginationSource = html.slice(start, end);
const dateSource = html.slice(dateStart, dateEnd);
const searchSource = html.slice(searchStart, searchEnd);
const captionSource = html.slice(captionStart, captionEnd);

test('inline browser scripts parse as JavaScript', () => {
  const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(inlineScripts.length >= 2);
  for (const [, source] of inlineScripts) new Function(source);
});

test('right panel and PDF preview are off by default', () => {
  assert.doesNotMatch(html, /id="previewPanelToggle"[^>]*\bchecked\b/);
  assert.doesNotMatch(html, /id="pdfPreviewToggle"[^>]*\bchecked\b/);
  assert.match(html, /settingsVersion:\s*3/);
});

test('static frontend routes cache and fetch requests through its configured API', () => {
  assert.match(html, /ARXIV_HEADLINES_CONFIG\?\.apiBaseUrl/);
  assert.match(html, /apiUrl\(`\/api\/cache\?/);
  assert.match(html, /fetch\(apiUrl\('\/api\/fetch'\)/);
});

test('startup targets today instead of a stale latest cache snapshot', () => {
  assert.match(
    html,
    /document\.getElementById\('day'\)\.value\s*=\s*defaultArxivDate\(\);/
  );
  assert.doesNotMatch(html, /latestPayload\?\.date\s*\|\|\s*defaultArxivDate\(\)/);
});

test('figure gallery fits the whole image first and offers optional touch panning at 1:1', () => {
  assert.match(html, /height:\s*100dvh/);
  assert.doesNotMatch(html, /id="figureCloseMobile"/);
  assert.match(html, /<\/div>\s*<button class="figure-mobile-close-bottom" id="figureCloseBottom"/);
  assert.match(html, /\.figure-stage\.is-fit img\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;[\s\S]*?object-fit:\s*contain;/);
  assert.match(html, /\.figure-stage\.is-actual\s*\{[\s\S]*?overflow:\s*auto;[\s\S]*?touch-action:\s*pan-x pan-y pinch-zoom;/);
  assert.match(html, /\.figure-stage\.is-actual img\s*\{[\s\S]*?width:\s*auto;[\s\S]*?height:\s*auto;[\s\S]*?max-width:\s*none;[\s\S]*?max-height:\s*none;/);
  assert.match(html, /id="figureStage"/);
  assert.match(html, /id="figureZoomToggle"/);
  assert.match(html, /setFigureZoomMode\('fit'\)/);
  assert.match(html, /\.figure-modal-title\s*\{\s*display:\s*none;/);
  assert.match(html, /\.figure-mobile-close-bottom\s*\{[\s\S]*?bottom:\s*max\(10px, env\(safe-area-inset-bottom\)\)/);
  assert.match(html, /safe-area-inset-top/);
  assert.match(html, /\['figureClose', 'figureCloseBottom'\]/);
});

test('search is tokenized, partial, accent-insensitive, and typo tolerant', () => {
  const { normalizeSearchText, paperMatchesSearch, paperSearchScore } = new Function(`
    ${searchSource}
    return { normalizeSearchText, paperMatchesSearch, paperSearchScore };
  `)();
  const paper = {
    absId: '2609.12345',
    title: 'Neutron-star radii in cosmological simulations',
    authors: ['José García'],
    summary: 'A precision analysis of dense matter.',
    categories: ['astro-ph.HE']
  };
  assert.equal(normalizeSearchText('José'), 'jose');
  assert.equal(paperMatchesSearch(paper, 'neutr radii'), true);
  assert.equal(paperMatchesSearch(paper, 'neutrn cosmologicla'), true);
  assert.equal(paperMatchesSearch(paper, 'jose dense'), true);
  assert.equal(paperMatchesSearch(paper, 'exoplanet'), false);

  assert.equal(paperMatchesSearch(paper, 'title:neutrn'), true);
  assert.equal(paperMatchesSearch(paper, 'author:garcia'), true);
  assert.equal(paperMatchesSearch(paper, 'abstract:"dense matter"'), true);
  assert.equal(paperMatchesSearch(paper, 'cat:astro-ph.he'), true);
  assert.equal(paperMatchesSearch(paper, 'id:2609'), true);
  assert.equal(paperMatchesSearch(paper, 'neutron -cosmological'), false);
  assert.equal(paperMatchesSearch(paper, 'exoplanet OR neutron'), true);
  assert.equal(paperMatchesSearch(paper, 'NS'), true);
  assert.equal(paperMatchesSearch({ title: 'Constraints on galaxy formation' }, 'NS'), false);

  const abstractOnly = {
    absId: '2609.54321',
    title: 'Precision constraints from new observations',
    authors: ['A. Researcher'],
    summary: 'We determine the neutron star radius.',
    categories: ['astro-ph.HE']
  };
  assert.ok(
    paperSearchScore(paper, 'neutron') > paperSearchScore(abstractOnly, 'neutron'),
    'title matches should rank above abstract-only matches'
  );
});

test('advanced search help documents supported query syntax', () => {
  assert.match(html, /id="searchHelpButton"/);
  assert.match(html, /id="searchHelpPanel"/);
  assert.match(html, /title:planet/);
  assert.match(html, /author:smith/);
  assert.match(html, /exoplanet OR biosignature/);
  assert.match(html, /function parseAdvancedQuery/);
  assert.match(html, /searchScore/);
});

test('card clicks open an accessible floating paper panel', () => {
  assert.match(html, /id="paperQuickView"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /if \(p\) openPaperQuickView\(p, card\)/);
  assert.match(html, /paper-quickview-dialog/);
});

test('figure captions preserve and typeset LaTeX', () => {
  assert.match(html, /captionWithLatex\(figure\.caption\)/);
  assert.match(html, /MathJax\?\.typesetPromise\?\.\(\[caption\]\)/);
  assert.match(html, /figure\?\.captionLatex \|\| figure\?\.caption/);

  const { captionWithLatex } = new Function('cleanText', 'escapeHtml', `
    ${captionSource}
    return { captionWithLatex };
  `)(value => String(value || '').replace(/\s+/g, ' ').trim(), value => String(value));
  const rendered = captionWithLatex('Radius R = $2.08\\,M_{\\odot}$ from data.');
  assert.match(rendered, /\\\(\\text\{Radius\}\\\)/);
  assert.match(rendered, /\\\(R\\\)/);
  assert.match(rendered, /\\\(=\\\)/);
  assert.match(rendered, /\\\(2\.08\\,M_\{\\odot\}\\\)/);
  assert.match(rendered, /\\\(\\text\{from\}\\\)/);
});

test('settings include a persistent monochrome newspaper format', () => {
  assert.match(html, /setFormat\('newspaper'\)/);
  assert.match(html, /setFormat\('cosmic'\)/);
  assert.match(html, /body\.theme-newspaper/);
  assert.match(html, /FORMATS = new Set\(\['cosmic', 'newspaper'\]\)/);
  assert.doesNotMatch(html, /class="theme-dot newspaper"/);
  assert.match(html, /Cosmic accent color/);
  assert.match(html, /body\.theme-newspaper \.paper-card/);
  assert.match(html, /body\.theme-newspaper \.paper-visual img\s*\{\s*filter:\s*none\s*!important;/);
});

test('landscape phones reserve a compact control rail for the figure gallery', () => {
  assert.match(html, /orientation:\s*landscape[\s\S]*?max-height:\s*520px/);
  assert.match(html, /\.figure-dialog\s*\{[\s\S]*?padding:[\s\S]*?108px/);
  assert.match(html, /\.figure-modal-foot\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?width:\s*82px;/);
  assert.match(html, /\.figure-mobile-close-bottom\s*\{[\s\S]*?width:\s*82px;/);
});

test('navigation and filter controls keep a stable responsive layout', () => {
  assert.match(html, /\.category-tabs\s*\{[\s\S]*?flex-wrap:\s*nowrap;[\s\S]*?overflow-x:\s*auto;/);
  assert.match(html, /id="savedTabs"[^>]*aria-label="Reading lists"/);
  assert.match(html, /\.saved-tabs\s*\{[\s\S]*?position:\s*static;/);
  assert.match(html, /savedContainer\.appendChild\(tab\)/);
  assert.match(html, /\.controls\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:/);
  assert.match(html, /@media \(max-width:\s*1250px\)[\s\S]*?\.range-control\s*\{[\s\S]*?grid-column:\s*1 \/ -1;/);
  assert.match(html, /@media \(max-width:\s*650px\)[\s\S]*?\.range-btn\s*\{[\s\S]*?calc\(50% - 4px\)/);
  assert.match(html, /class="group date-control"/);
  assert.match(html, /class="group range-control"/);
});

test('newspaper is the default format and reading lists scroll normally', () => {
  assert.match(html, /<body class="format-newspaper theme-newspaper">/);
  assert.match(html, /let selectedFormat = 'newspaper';/);
  assert.match(html, /class="format-option active" data-format="newspaper"/);
  assert.doesNotMatch(html, /\.saved-tabs\s*\{[\s\S]*?position:\s*sticky;/);
});

test('custom start date builds an inclusive range and enforces safe bounds', () => {
  const { getDateList } = new Function('pad2', 'defaultArxivDate', `
    ${dateSource}
    return { getDateList };
  `)(value => String(value).padStart(2, '0'), () => '2026-09-14');

  assert.deepEqual(getDateList('2026-09-14', 'custom', '2026-09-10'), [
    '2026-09-14', '2026-09-13', '2026-09-12', '2026-09-11', '2026-09-10'
  ]);
  assert.throws(() => getDateList('2026-09-14', 'custom', '2026-09-15'), /must not be after/);
  assert.throws(() => getDateList('2026-09-14', 'custom', '2026-01-01'), /at most 90 days/);
  assert.match(html, /data-range="custom"/);
  assert.match(html, /id="rangeStart" type="date"/);
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
