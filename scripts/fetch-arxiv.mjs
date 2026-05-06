import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
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

const MAX_CHUNK    = 200;   // arXiv API max IDs per request
const KEEP_DAYS    = 180;   // days of history to retain
const RETRY_MAX    = 3;     // retries per request
const RETRY_DELAY  = 2000;  // ms between retries

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(__dirname, '..', 'data');

// ── Helpers ──────────────────────────────────────────────────────────────────
const pad2      = n  => String(n).padStart(2, '0');
const sleep     = ms => new Promise(r => setTimeout(r, ms));
const cleanText = s  => (s ?? '').replace(/\s+/g, ' ').trim();

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
    const resp = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp;
  } catch (e) {
    if (attempt < RETRY_MAX - 1) {
      console.warn(`  ↻ Retry ${attempt + 1}/${RETRY_MAX - 1} for ${url.slice(0, 80)}…`);
      await sleep(RETRY_DELAY * (attempt + 1));
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
  const absPattern = /href="\/abs\/([^"?#]+)"/gi;

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

// ── Parse arXiv API XML ───────────────────────────────────────────────────────
function parseArxivXml(xml) {
  const entries = [];
  const entryPattern = /<entry>([\s\S]*?)<\/entry>/g;
  let em;
  while ((em = entryPattern.exec(xml)) !== null) {
    const block = em[1];
    const get   = tag => {
      const r = new RegExp(`<${tag}[^>]*>([\s\S]*?)<\/${tag}>`, 'i').exec(block);
      return r ? cleanText(r[1]) : '';
    };
    const idUrl  = get('id');
    const title  = get('title');
    const summary = get('summary');
    if (!idUrl || !title || !summary) continue;

    // Authors
    const authors = [];
    const authorPattern = /<name>([\s\S]*?)<\/name>/g;
    let am2;
    while ((am2 = authorPattern.exec(block)) !== null) authors.push(cleanText(am2[1]));

    // Categories
    const cats = [];
    const catPattern = /<category[^>]+term="([^"]+)"/g;
    let cm;
    while ((cm = catPattern.exec(block)) !== null) cats.push(cm[1]);

    // Dates
    const published = get('published');
    const updated   = get('updated');

    entries.push({
      absId:      extractIdFromAbsUrl(idUrl),
      title,
      summary,
      published:  published || null,
      updated:    updated   || null,
      link:       idUrl,
      authors,
      categories: cats,
    });
  }
  return entries;
}

// ── Fetch metadata for a list of IDs ─────────────────────────────────────────
async function fetchMetaForIds(ids) {
  const map = new Map();
  const chunks = [];
  for (let i = 0; i < ids.length; i += MAX_CHUNK)
    chunks.push(ids.slice(i, i + MAX_CHUNK));

  for (const chunk of chunks) {
    const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(chunk.join(','))}&start=0&max_results=${chunk.length}`;
    try {
      const resp = await fetchWithRetry(url);
      const xml  = await resp.text();
      for (const p of parseArxivXml(xml))
        if (p.absId) map.set(p.absId, p);
    } catch (e) {
      console.warn(`  ⚠ API chunk failed: ${e.message}`);
    }
    await sleep(500); // be polite to arXiv
  }
  return map;
}

// ── Process one category for one date ────────────────────────────────────────
async function fetchCategory(catCode, ymd) {
  console.log(`  📡 Fetching ${catCode} / ${ymd}`);
  const url = `https://arxiv.org/catchup/${encodeURIComponent(catCode)}/${encodeURIComponent(ymd)}?abs=False`;

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

  if (allIds.length === 0) {
    console.log(`  ℹ No papers found for ${catCode}/${ymd}`);
    return { category: catCode, date: ymd, counts: { new:0, cross:0, repl:0 }, papersBySection: { new:[], cross:[], repl:[] } };
  }

  console.log(`  📄 ${catCode}/${ymd}: new=${idsBySection.new.length} cross=${idsBySection.cross.length} repl=${idsBySection.repl.length}`);

  const metaMap = await fetchMetaForIds(allIds);

  const papersBySection = { new: [], cross: [], repl: [] };
  for (const sec of ['new', 'cross', 'repl']) {
    for (const id of idsBySection[sec]) {
      const p = metaMap.get(normalizeId(id));
      if (p) papersBySection[sec].push({ ...p, catchupDate: ymd });
    }
  }

  return {
    category:        catCode,
    date:            ymd,
    generatedAt:     new Date().toISOString(),
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

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  let ymd = todayYmd();
  ymd = prevWeekday(ymd);
  console.log(`\n🚀 arXiv fetch started — target date: ${ymd}\n`);

  for (const catCode of CATEGORIES) {
    const dirName = categoryToDir(catCode);
    const outDir  = join(DATA_ROOT, dirName);
    mkdirSync(outDir, { recursive: true });

    const result = await fetchCategory(catCode, ymd);
    if (!result) continue;

    // Write dated file
    const dated = join(outDir, `${ymd}.json`);
    writeFileSync(dated, JSON.stringify(result, null, 2), 'utf8');
    console.log(`  ✅ Saved ${dated}`);

    // Write latest.json (symlink-free copy)
    const latest = join(outDir, 'latest.json');
    writeFileSync(latest, JSON.stringify(result, null, 2), 'utf8');
    console.log(`  ✅ Updated latest.json`);

    // Prune old files
    pruneOldFiles(outDir, KEEP_DAYS);

    await sleep(1000); // rate-limit between categories
  }

  console.log('\n✨ All done!\n');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
