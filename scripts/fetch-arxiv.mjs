import { writeFileSync, mkdirSync, readdirSync, unlinkSync, readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

// ── Config ──────────────────────────────────────────────────────────────────
const CATEGORIES = [
  'astro-ph',
  'astro-ph.CO',
  'astro-ph.EP',
  'astro-ph.GA',
  'astro-ph.HE',
  'astro-ph.IM',
  'astro-ph.SR',
];

const KEEP_DAYS    = 180;   // days of history to retain
const RETRY_MAX    = 3;     // retries per request
const RETRY_DELAY  = 5000;  // base delay for API throttling/backoff
const USER_AGENT   = 'arxiv-headlines-bot/1.0 (https://github.com/fuzhh8/arxiv-headlines)';
const THUMBNAIL_WORKERS = 2;
const thumbnailCache = new Map();

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(__dirname, '..', 'data');

// ── Helpers ──────────────────────────────────────────────────────────────────
const pad2      = n  => String(n).padStart(2, '0');
const sleep     = ms => new Promise(r => setTimeout(r, ms));
const cleanText = s  => (s ?? '').replace(/\s+/g, ' ').trim();

function decodeHtml(text) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '
  };

  return (text ?? '')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, value) => {
      const codePoint = value[0].toLowerCase() === 'x'
        ? parseInt(value.slice(1), 16)
        : parseInt(value, 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _;
    })
    .replace(/&([a-z]+);/gi, (entity, name) => named[name.toLowerCase()] ?? entity);
}

function textFromHtml(html) {
  return cleanText(decodeHtml(
    (html ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')
  ));
}

function normalizeId(id) {
  return (id || '').trim().replace(/v\d+$/i, '');
}

function extractIdFromAbsUrl(url) {
  const m = (url || '').match(/\/abs\/([^?#]+)/);
  return m?.[1] ? normalizeId(m[1]) : '';
}

function todayYmd() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())}`;
}

function prevWeekday(ymd) {
  // If weekend, roll back to Friday
  const dt  = new Date(`${ymd}T00:00:00Z`);
  const dow = dt.getUTCDay();
  if (dow === 0) dt.setUTCDate(dt.getUTCDate() - 2); // Sunday → Friday
  if (dow === 6) dt.setUTCDate(dt.getUTCDate() - 1); // Saturday → Friday
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth()+1)}-${pad2(dt.getUTCDate())}`;
}

function categoryToDir(code) {
  // Replace dots with dashes for safe directory names: astro-ph.CO → astro-ph-CO
  return code.replace(/\./g, '-');
}

// ── Fetch with retry ─────────────────────────────────────────────────────────
async function fetchWithRetry(url, options = {}, attempt = 0) {
  try {
    const resp = await fetch(url, {
      ...options,
      headers: { 'User-Agent': USER_AGENT, ...options.headers },
      signal: AbortSignal.timeout(30000)
    });

    if (!resp.ok) {
      const error = new Error(`HTTP ${resp.status}`);
      error.retryAfter = Number(resp.headers.get('retry-after')) || 0;
      throw error;
    }

    return resp;
  } catch (e) {
    if (attempt < RETRY_MAX - 1) {
      console.warn(`  ↻ Retry ${attempt + 1}/${RETRY_MAX - 1} for ${url.slice(0, 80)}…`);
      const retryAfterMs = (Number(e.retryAfter) || 0) * 1000;
      const backoff = Math.max(retryAfterMs, RETRY_DELAY * (attempt + 1));
      await sleep(backoff);
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw e;
  }
}

// ── Parse arXiv catchup HTML ──────────────────────────────────────────────────
function parseCatchupHtml(html) {
  // Node.js has no DOMParser — use regex on the raw HTML
  const out = { new: [], cross: [], repl: [] };

  // Split by <h3> tags
  const h3Pattern = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  // arXiv currently emits links such as `href ="/abs/2609.10622"`.
  // Allow whitespace around `=` and either quote style so harmless markup
  // changes do not silently turn a full catchup page into an empty result.
  const absPattern = /href\s*=\s*["']\/abs\/([^"'?#]+)["']/gi;

  // Find all h3 positions and their text
  const sections = [];
  let m;
  while ((m = h3Pattern.exec(html)) !== null) {
    const text = m[1].replace(/<[^>]+>/g, '').trim().toLowerCase();
    let key = null;
    if (text.startsWith('new submissions'))                                              key = 'new';
    else if (text.startsWith('cross') || text.startsWith('cross-list'))                 key = 'cross';
    else if (text.startsWith('replacement') || text.startsWith('replacements'))         key = 'repl';
    if (key) sections.push({ key, start: m.index + m[0].length });
  }

  for (let i = 0; i < sections.length; i++) {
    const { key, start } = sections[i];
    const end = sections[i + 1]?.start ?? html.length;
    const chunk = html.slice(start, end);
    absPattern.lastIndex = 0;
    let am;
    while ((am = absPattern.exec(chunk)) !== null) {
      const id = normalizeId(am[1]);
      if (id) out[key].push(id);
    }
  }

  return out;
}

// ── Parse paper metadata embedded by catchup?abs=True ─────────────────────────
function parseCatchupPapers(html, ymd) {
  const map = new Map();
  const entryPattern = /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi;
  let entryMatch;

  while ((entryMatch = entryPattern.exec(html)) !== null) {
    const heading = entryMatch[1];
    const body = entryMatch[2];
    const absMatch = heading.match(/href\s*=\s*["']\/abs\/([^"'?#]+)["']/i);
    const htmlMatch = heading.match(/href\s*=\s*["'](https:\/\/arxiv\.org\/html\/[^"']+)["']/i);
    const absId = normalizeId(absMatch?.[1]);
    const htmlUrl = htmlMatch?.[1] ? decodeHtml(htmlMatch[1]) : null;
    const titleMatch = body.match(/class\s*=\s*["'][^"']*\blist-title\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const authorsMatch = body.match(/class\s*=\s*["'][^"']*\blist-authors\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const subjectsMatch = body.match(/class\s*=\s*["'][^"']*\blist-subjects\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const summaryMatch = body.match(/<p\b[^>]*class\s*=\s*["'][^"']*\bmathjax\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);

    const title = textFromHtml(titleMatch?.[1]).replace(/^Title:\s*/i, '');
    const summary = textFromHtml(summaryMatch?.[1]);
    if (!absId || !title || !summary) continue;

    const authors = [];
    const authorPattern = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
    let authorMatch;
    while ((authorMatch = authorPattern.exec(authorsMatch?.[1] || '')) !== null) {
      const author = textFromHtml(authorMatch[1]);
      if (author) authors.push(author);
    }

    const subjectText = textFromHtml(subjectsMatch?.[1]).replace(/^Subjects:\s*/i, '');
    const categories = [...subjectText.matchAll(/\(([a-z-]+(?:\.[A-Z]+)?)\)/g)].map(match => match[1]);

    map.set(absId, {
      absId,
      title,
      summary,
      published: `${ymd}T00:00:00.000Z`,
      updated: null,
      link: `https://arxiv.org/abs/${absId}`,
      htmlUrl,
      authors,
      categories
    });
  }

  return map;
}

function extractFigures(html, htmlUrl, limit = 8) {
  const figurePattern = /<figure\b[^>]*>([\s\S]*?)<\/figure>/gi;
  const figures = [];
  const seen = new Set();
  let figureMatch;

  while ((figureMatch = figurePattern.exec(html)) !== null && figures.length < limit) {
    const figure = figureMatch[1];
    const imageMatch = figure.match(/<img\b(?=[^>]*\bltx_graphics\b)[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/i);
    if (!imageMatch) continue;

    const captionMatch = figure.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i);
    const caption = textFromHtml(captionMatch?.[1]).replace(/^Figure\s+\d+[:.]?\s*/i, '');

    try {
      const imageUrl = new URL(decodeHtml(imageMatch[1]), htmlUrl).href;
      const parsed = new URL(imageUrl);
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'arxiv.org') continue;
      if (seen.has(imageUrl)) continue;

      seen.add(imageUrl);
      figures.push({
        url: imageUrl,
        caption: (caption || `Figure ${figures.length + 1} from the paper`).slice(0, 2000)
      });
    } catch (_) {}
  }

  return figures;
}

function extractFirstFigure(html, htmlUrl) {
  const figures = extractFigures(html, htmlUrl, 8);
  if (!figures.length) return null;
  return {
    figures,
    thumbnailUrl: figures[0].url,
    thumbnailAlt: figures[0].caption.slice(0, 300)
  };
}

async function fetchPaperThumbnail(paper) {
  if (!paper.htmlUrl) return null;
  if (thumbnailCache.has(paper.absId)) return thumbnailCache.get(paper.absId);

  const task = (async () => {
    try {
      const resp = await fetchWithRetry(paper.htmlUrl);
      return extractFirstFigure(await resp.text(), paper.htmlUrl);
    } catch (e) {
      console.warn(`  ⚠ Thumbnail unavailable for ${paper.absId}: ${e.message}`);
      return null;
    }
  })();

  thumbnailCache.set(paper.absId, task);
  return task;
}

async function enrichWithThumbnails(papers, options = {}) {
  const queue = [...papers.values()].filter(paper => paper.htmlUrl);
  let cursor = 0;
  let found = 0;
  let processed = 0;

  options.onProgress?.({ processed, total: queue.length, found });

  async function worker() {
    while (cursor < queue.length) {
      const paper = queue[cursor++];
      const thumbnail = await fetchPaperThumbnail(paper);
      if (thumbnail) {
        Object.assign(paper, thumbnail);
        found++;
      }
      processed++;
      options.onProgress?.({ processed, total: queue.length, found });
      await sleep(250);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(THUMBNAIL_WORKERS, queue.length) }, () => worker())
  );
  console.log(`  🖼 Thumbnails: ${found}/${queue.length} HTML papers`);
  return { processed, total: queue.length, found };
}

// ── Process one category for one date ────────────────────────────────────────
async function fetchCategory(catCode, ymd, options = {}) {
  console.log(`  📡 Fetching ${catCode} / ${ymd}`);
  const url = `https://arxiv.org/catchup/${encodeURIComponent(catCode)}/${encodeURIComponent(ymd)}?abs=True`;

  let html;
  try {
    const resp = await fetchWithRetry(url, { headers: { 'User-Agent': 'arxiv-headlines-bot/1.0' } });
    html = await resp.text();
  } catch (e) {
    console.warn(`  ⚠ Catchup fetch failed for ${catCode}/${ymd}: ${e.message}`);
    return null;
  }

  const idsBySection = parseCatchupHtml(html);
  const allIds = [...new Set([
    ...idsBySection.new,
    ...idsBySection.cross,
    ...idsBySection.repl,
  ])];

  const declaredTotalMatch = html.match(/Total of\s+(\d+)\s+entr(?:y|ies)/i);
  if (!declaredTotalMatch) {
    throw new Error(`Invalid catchup response for ${catCode}/${ymd}: entry total not found`);
  }

  const declaredTotal = Number(declaredTotalMatch[1]);
  if (declaredTotal > 0 && allIds.length === 0) {
    throw new Error(
      `Catchup parser found 0 IDs for ${catCode}/${ymd}, but arXiv reports ${declaredTotal} entries`
    );
  }

  if (allIds.length === 0) {
    console.log(`  ℹ No papers found for ${catCode}/${ymd}`);
    return {
      schemaVersion: 1,
      status: 'ok',
      source: 'arxiv-catchup',
      category: catCode,
      date: ymd,
      generatedAt: new Date().toISOString(),
      counts: { new:0, cross:0, repl:0 },
      papersBySection: { new:[], cross:[], repl:[] }
    };
  }

  console.log(`  📄 ${catCode}/${ymd}: new=${idsBySection.new.length} cross=${idsBySection.cross.length} repl=${idsBySection.repl.length}`);

  const metaMap = parseCatchupPapers(html, ymd);
  if (metaMap.size === 0) {
    throw new Error(
      `Catchup metadata parser returned 0 of ${allIds.length} papers for ${catCode}/${ymd}; refusing to overwrite cached data`
    );
  }

  let figureCounts = { processed: 0, total: 0, found: 0 };
  if (options.includeFigures !== false) {
    figureCounts = await enrichWithThumbnails(metaMap, { onProgress: options.onProgress });
  } else {
    figureCounts.total = [...metaMap.values()].filter(paper => paper.htmlUrl).length;
  }

  const papersBySection = { new: [], cross: [], repl: [] };
  for (const sec of ['new', 'cross', 'repl']) {
    for (const id of idsBySection[sec]) {
      const p = metaMap.get(normalizeId(id));
      if (p) papersBySection[sec].push({ ...p, catchupDate: ymd });
    }
  }

  return {
    schemaVersion:    1,
    status:           'ok',
    source:           'arxiv-catchup',
    category:        catCode,
    date:            ymd,
    generatedAt:     new Date().toISOString(),
    figuresStatus:   options.includeFigures === false ? 'pending' : 'complete',
    figureCounts,
    counts: {
      new:   papersBySection.new.length,
      cross: papersBySection.cross.length,
      repl:  papersBySection.repl.length,
    },
    papersBySection,
  };
}

// ── Prune old files ───────────────────────────────────────────────────────────
function pruneOldFiles(dir, keepDays) {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - keepDays);
  const cutoffYmd = `${cutoff.getUTCFullYear()}-${pad2(cutoff.getUTCMonth()+1)}-${pad2(cutoff.getUTCDate())}`;

  let pruned = 0;
  try {
    for (const f of readdirSync(dir)) {
      // Match YYYY-MM-DD.json
      if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) continue;
      const fileYmd = f.replace('.json', '');
      if (fileYmd < cutoffYmd) {
        unlinkSync(join(dir, f));
        pruned++;
      }
    }
  } catch (_) {}
  if (pruned > 0) console.log(`  🗑 Pruned ${pruned} old file(s) from ${dir}`);
}

function validateFetchTarget(catCode, ymd) {
  if (!CATEGORIES.includes(catCode)) {
    throw new Error(`Unsupported arXiv category: ${catCode}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    throw new Error('Date must use YYYY-MM-DD format');
  }

  const parsed = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== ymd) {
    throw new Error(`Invalid calendar date: ${ymd}`);
  }
}

function shouldUpdateLatest(latestPath, ymd) {
  try {
    const current = JSON.parse(readFileSync(latestPath, 'utf8'));
    return !current?.date || ymd >= current.date;
  } catch (_) {
    return true;
  }
}

async function fetchAndStoreCategory(catCode, ymd, options = {}) {
  validateFetchTarget(catCode, ymd);

  const dataRoot = options.dataRoot || DATA_ROOT;
  const outDir = join(dataRoot, categoryToDir(catCode));
  mkdirSync(outDir, { recursive: true });

  const result = await fetchCategory(catCode, ymd, {
    includeFigures: options.includeFigures,
    onProgress: options.onProgress
  });
  if (!result) {
    throw new Error(`arXiv did not return data for ${catCode}/${ymd}`);
  }

  const dated = join(outDir, `${ymd}.json`);
  writeFileSync(dated, JSON.stringify(result, null, 2), 'utf8');
  console.log(`  ✅ Saved ${dated}`);

  const latest = join(outDir, 'latest.json');
  if (options.updateLatest !== false && shouldUpdateLatest(latest, ymd)) {
    writeFileSync(latest, JSON.stringify(result, null, 2), 'utf8');
    console.log('  ✅ Updated latest.json');
  } else if (options.updateLatest !== false) {
    console.log('  ℹ Kept newer latest.json');
  }

  if (options.prune !== false) pruneOldFiles(outDir, KEEP_DAYS);
  return result;
}

async function enrichAndStoreCategoryFigures(catCode, ymd, options = {}) {
  validateFetchTarget(catCode, ymd);

  const dataRoot = options.dataRoot || DATA_ROOT;
  const outDir = join(dataRoot, categoryToDir(catCode));
  const dated = join(outDir, `${ymd}.json`);
  const payload = JSON.parse(readFileSync(dated, 'utf8'));

  if (payload?.category !== catCode || payload?.date !== ymd || !payload?.papersBySection) {
    throw new Error(`Invalid cached payload for ${catCode}/${ymd}`);
  }

  const uniquePapers = new Map();
  for (const section of ['new', 'cross', 'repl']) {
    for (const paper of payload.papersBySection[section] || []) {
      if (paper?.absId && !uniquePapers.has(paper.absId)) uniquePapers.set(paper.absId, { ...paper });
    }
  }

  const figureCounts = await enrichWithThumbnails(uniquePapers, { onProgress: options.onProgress });

  for (const section of ['new', 'cross', 'repl']) {
    payload.papersBySection[section] = (payload.papersBySection[section] || []).map(paper => {
      const enriched = uniquePapers.get(paper.absId);
      if (!enriched) return paper;
      return {
        ...paper,
        ...(enriched.figures ? { figures: enriched.figures } : {}),
        ...(enriched.thumbnailUrl ? { thumbnailUrl: enriched.thumbnailUrl } : {}),
        ...(enriched.thumbnailAlt ? { thumbnailAlt: enriched.thumbnailAlt } : {})
      };
    });
  }

  payload.figuresStatus = 'complete';
  payload.figureCounts = figureCounts;
  payload.figuresGeneratedAt = new Date().toISOString();
  writeFileSync(dated, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`  ✅ Added figures to ${dated}`);

  const latest = join(outDir, 'latest.json');
  if (shouldUpdateLatest(latest, ymd)) {
    writeFileSync(latest, JSON.stringify(payload, null, 2), 'utf8');
    console.log('  ✅ Updated latest.json figures');
  }

  return payload;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  let ymd = process.argv[2] || todayYmd();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    throw new Error('Optional date must use YYYY-MM-DD format');
  }
  ymd = prevWeekday(ymd);
  console.log(`\n🚀 arXiv fetch started — target date: ${ymd}\n`);

  for (const catCode of CATEGORIES) {
    await fetchAndStoreCategory(catCode, ymd);

    await sleep(1000); // rate-limit between categories
  }

  console.log('\n✨ All done!\n');
}

export {
  CATEGORIES,
  categoryToDir,
  enrichAndStoreCategoryFigures,
  fetchAndStoreCategory,
  parseCatchupHtml,
  parseCatchupPapers,
  extractFigures,
  extractFirstFigure,
  validateFetchTarget
};

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch(e => { console.error('Fatal:', e); process.exit(1); });
}
