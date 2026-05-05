// ── Proxy services (ordered by reliability) ──
const PROXY_SERVICES = [
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
];

// ── Category definitions ──
const CATEGORIES = [
  { code: 'astro-ph',    label: 'Astrophysics (all)' },
  { code: 'astro-ph.CO', label: 'Cosmology & Nongalactic' },
  { code: 'astro-ph.EP', label: 'Earth & Planetary' },
  { code: 'astro-ph.GA', label: 'Astrophysics of Galaxies' },
  { code: 'astro-ph.HE', label: 'High Energy Phenomena' },
  { code: 'astro-ph.IM', label: 'Instrumentation & Methods' },
  { code: 'astro-ph.SR', label: 'Solar & Stellar' }
];

// ── App state ──
let selectedCategory  = 'astro-ph';
let currentSelectedCard = null;
let currentDateRange  = 1;
let sectionColumns    = { new: 2, cross: 2, repl: 2 };

// ─────────────────────────────────────────────
// Settings (localStorage)
// ─────────────────────────────────────────────
function saveSettings() {
  const settings = {
    theme:           document.body.className.replace('theme-', ''),
    dateRange:       currentDateRange,
    sectionColumns:  sectionColumns,
    pdfPreview:      document.getElementById('pdfPreviewToggle').checked,
    selectedCategory
  };
  localStorage.setItem('arxivSettings', JSON.stringify(settings));
}

function loadSettings() {
  const saved = localStorage.getItem('arxivSettings');
  if (!saved) return null;
  try { return JSON.parse(saved); }
  catch (e) { console.error('Failed to parse settings:', e); return null; }
}

function applySettings(settings) {
  if (!settings) return;
  if (settings.theme)           setTheme(settings.theme, false);
  if (settings.dateRange) {
    currentDateRange = settings.dateRange;
    document.querySelectorAll('.range-btn').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.getAttribute('data-range')) === settings.dateRange);
    });
  }
  if (settings.sectionColumns)  sectionColumns = settings.sectionColumns;
  if (settings.pdfPreview !== undefined)
    document.getElementById('pdfPreviewToggle').checked = settings.pdfPreview;
  if (settings.selectedCategory) selectedCategory = settings.selectedCategory;
}

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────
function pad2(n) { return String(n).padStart(2, '0'); }

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text ?? '';
  return div.innerHTML;
}

function cleanText(s) { return (s ?? '').replace(/\s+/g, ' ').trim(); }

function setStatus(message) {
  document.getElementById('content').innerHTML =
    `<div class="status">${message}<br/><span class="mono"> </span></div>`;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function normalizeId(id) { return (id || '').trim().replace(/v\d+$/i, ''); }

function extractIdFromAbsUrl(url) {
  const m = (url || '').match(/\/abs\/([^?#]+)/);
  return m && m[1] ? normalizeId(m[1]) : '';
}

// ─────────────────────────────────────────────
// Theme
// ─────────────────────────────────────────────
function setTheme(theme, save = true) {
  document.body.className = `theme-${theme}`;
  document.querySelectorAll('.theme-dot').forEach(dot => dot.classList.remove('active'));
  document.querySelector(`.theme-dot.${theme}`).classList.add('active');
  if (save) saveSettings();
}

// ─────────────────────────────────────────────
// Category tabs
// ─────────────────────────────────────────────
function renderCategoryTabs() {
  const container = document.getElementById('categoryTabs');
  if (!container) return;
  container.innerHTML = '';
  for (const cat of CATEGORIES) {
    const tab = document.createElement('div');
    tab.className = `category-tab ${cat.code === selectedCategory ? 'active' : ''}`;
    tab.textContent = cat.label;
    tab.onclick = () => {
      selectedCategory = cat.code;
      saveSettings();
      renderCategoryTabs();
      loadPapers();
    };
    container.appendChild(tab);
  }
}

// ─────────────────────────────────────────────
// Date helpers
// ─────────────────────────────────────────────
function setDateRange(days) {
  currentDateRange = days;
  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.getAttribute('data-range')) === days);
  });
  saveSettings();
  loadPapers();
}

function getDateList(endDate, days) {
  const dates = [];
  const dt = new Date(`${endDate}T00:00:00`);
  for (let i = 0; i < days; i++) {
    dates.push(`${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`);
    dt.setDate(dt.getDate() - 1);
  }
  return dates;
}

function isWeekendYmd(ymd) {
  const dow = new Date(`${ymd}T00:00:00`).getDay();
  return (dow === 0 || dow === 6) ? dow : -1;
}

function getPreviousFriday(ymd) {
  const dt  = new Date(`${ymd}T00:00:00`);
  const dow = dt.getDay();
  if (dow === 0) dt.setDate(dt.getDate() - 2);
  else if (dow === 6) dt.setDate(dt.getDate() - 1);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

function setupDateInput() {
  const dateInput = document.getElementById('day');
  dateInput.addEventListener('change', function () {
    if (!this.value) return;
    if (isWeekendYmd(this.value) !== -1) {
      this.value = getPreviousFriday(this.value);
      loadPapers();
    }
  });
}

// ─────────────────────────────────────────────
// Network: proxy fetch with fallback
// ─────────────────────────────────────────────
async function fetchWithProxy(url, accept, proxyIndex = 0) {
  if (proxyIndex >= PROXY_SERVICES.length) throw new Error('All proxy services failed');
  const proxyUrl = PROXY_SERVICES[proxyIndex](url);
  try {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(proxyUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'Accept': accept }
    });
    clearTimeout(timeoutId);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    if (!text || text.length < 50) throw new Error('Empty response');
    return text;
  } catch (e) {
    return fetchWithProxy(url, accept, proxyIndex + 1);
  }
}

// ─────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────
function parseCatchupByHeadings(htmlText) {
  const doc  = new DOMParser().parseFromString(htmlText, 'text/html');
  const root = doc.querySelector('#content') || doc;
  const h3s  = Array.from(root.querySelectorAll('h3'));
  const out  = { new: [], cross: [], repl: [] };

  function keyFor(t) {
    const s = cleanText(t).toLowerCase();
    if (s.startsWith('new submissions'))   return 'new';
    if (s.startsWith('cross submissions') || s.startsWith('cross-lists') || s.startsWith('cross lists')) return 'cross';
    if (s.startsWith('replacement submissions') || s.startsWith('replacements')) return 'repl';
    return null;
  }

  for (const h3 of h3s) {
    const key = keyFor(h3.textContent || '');
    if (!key) continue;
    let node = h3.nextElementSibling;
    while (node) {
      if (node.tagName?.toLowerCase() === 'h3') break;
      for (const a of node.querySelectorAll('a[href*="/abs/"]')) {
        const id = extractIdFromAbsUrl(a.getAttribute('href') || '');
        if (id) out[key].push(id);
      }
      node = node.nextElementSibling;
    }
  }
  return out;
}

function parseArxivApi(xmlText) {
  const xmlDoc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (xmlDoc.querySelector('parsererror')) throw new Error('API XML parsing failed');

  const papers = [];
  for (const entry of xmlDoc.getElementsByTagName('entry')) {
    const title   = cleanText(entry.getElementsByTagName('title')[0]?.textContent);
    const summary = cleanText(entry.getElementsByTagName('summary')[0]?.textContent);
    const idUrl   = entry.getElementsByTagName('id')[0]?.textContent;
    if (!title || !summary || !idUrl) continue;

    const published = entry.getElementsByTagName('published')[0]?.textContent;
    const updated   = entry.getElementsByTagName('updated')[0]?.textContent;

    papers.push({
      absId:     extractIdFromAbsUrl(idUrl),
      title, summary,
      published: published ? new Date(published) : null,
      updated:   updated   ? new Date(updated)   : null,
      link:      idUrl,
      authors:   Array.from(entry.getElementsByTagName('author'))
                   .map(a => a.getElementsByTagName('name')[0]?.textContent?.trim())
                   .filter(Boolean),
      categories: Array.from(entry.getElementsByTagName('category'))
                   .map(c => c.getAttribute('term'))
                   .filter(Boolean)
    });
  }
  return papers;
}

// ─────────────────────────────────────────────
// Data fetching
// ─────────────────────────────────────────────
async function fetchPapersForIds(ids) {
  const idChunks = chunkArray(ids, 200);

  // Fetch all chunks in parallel
  const results = await Promise.all(idChunks.map(chunk => {
    const apiUrl =
      `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(chunk.join(','))}` +
      `&start=0&max_results=${encodeURIComponent(chunk.length)}`;
    return fetchWithProxy(apiUrl, 'application/atom+xml, application/xml, text/xml');
  }));

  const all = [];
  for (const xmlText of results) all.push(...parseArxivApi(xmlText));

  const byAbsId = new Map();
  for (const p of all) if (p.absId) byAbsId.set(p.absId, p);
  return byAbsId;
}

// ─────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────
function setSectionColumns(section, cols) {
  sectionColumns[section] = cols;
  saveSettings();
  if (window.__LAST_RENDER_META__) renderSections(window.__LAST_RENDER_META__);
}

function renderPreviewEmpty() {
  return `<div class="preview-muted">Click on a paper card to see the abstract and PDF preview here.</div>`;
}

function renderPapersGrid(papers, sec) {
  if (!papers.length) return `<div class="info">No papers available</div>`;

  const cols = sectionColumns[sec] || 2;
  let html = `<div class="papers-grid cols-${cols}">`;

  for (const p of papers) {
    const authorsText = p.authors?.length
      ? `${p.authors.slice(0, 3).join(', ')}${p.authors.length > 3 ? ' et al.' : ''}`
      : 'Unknown authors';
    const dateStr = p.published
      ? p.published.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      : '';

    html += `
      <div class="paper-card" tabindex="0"
           data-absid="${escapeHtml(p.absId)}"
           data-sec="${escapeHtml(sec || '')}"
           data-date="${escapeHtml(p.catchupDate || '')}">
        <div class="paper-title">${escapeHtml(p.title)}</div>
        <div class="paper-authors">${escapeHtml(authorsText)}</div>
        ${dateStr ? `<div class="paper-date">📅 ${escapeHtml(dateStr)}</div>` : ''}
        <div class="paper-footer">
          <a class="paper-link" href="${escapeHtml(p.link)}" target="_blank" onclick="event.stopPropagation()">Open arXiv</a>
          <a class="paper-link" href="https://arxiv.org/pdf/${escapeHtml(p.absId)}.pdf" target="_blank" onclick="event.stopPropagation()">Open PDF</a>
        </div>
      </div>`;
  }
  return html + `</div>`;
}

function setPreviewPaper(paper) {
  const abstractPane = document.getElementById('abstractPane');
  const pdfPane      = document.getElementById('pdfPane');
  if (!abstractPane || !pdfPane) return;

  // Update selected card highlight
  if (currentSelectedCard) currentSelectedCard.classList.remove('selected');
  for (const card of document.querySelectorAll('.paper-card')) {
    if (card.getAttribute('data-absid') === paper.absId) {
      card.classList.add('selected');
      currentSelectedCard = card;
      break;
    }
  }

  // Render abstract
  const authors = (paper.authors || []).filter(Boolean);
  const authorsFull = authors.length <= 6
    ? authors.join(', ')
    : `${authors.slice(0, 6).join(', ')}, et al.`;

  abstractPane.innerHTML = `
    <div class="preview-title">${escapeHtml(paper.title || '')}</div>
    <div class="preview-meta"><div>${escapeHtml(authorsFull || 'Unknown')}</div></div>
    <div class="preview-abstract">${escapeHtml(paper.summary || '')}</div>`;

  // Render PDF pane
  const showPdf = document.getElementById('pdfPreviewToggle').checked;
  const pdfCard = pdfPane.closest('.pdf-card');

  if (showPdf) {
    if (pdfCard) pdfCard.style.display = 'flex';
    const pdfUrl = `https://arxiv.org/pdf/${paper.absId}.pdf`;
    pdfPane.innerHTML = `
      <div class="pdf-section-title">
        <span>📄 PDF Preview</span>
        <div class="pdf-actions">
          <a class="pdf-btn secondary" href="${escapeHtml(pdfUrl)}" target="_blank">Open in New Tab</a>
        </div>
      </div>
      <div class="pdf-viewer-container">
        <iframe class="pdf-iframe" src="${escapeHtml(pdfUrl)}#view=FitH" title="PDF Preview"></iframe>
      </div>`;
  } else {
    if (pdfCard) pdfCard.style.display = 'none';
  }

  if (window.MathJax)
    MathJax.typesetPromise([abstractPane]).catch(err => console.log('MathJax error:', err));
}

function renderSections(meta) {
  const content = document.getElementById('content');
  let html = '';

  if (meta.dateRange?.length > 1) {
    html += `
      <div class="info">
        📅 Showing papers from ${escapeHtml(meta.dateRange[meta.dateRange.length - 1])}
        to ${escapeHtml(meta.dateRange[0])} (${meta.dateRange.length} days)
      </div>`;
  }

  html += `
    <div class="content-split">
      <div id="listPane"></div>
      <div class="preview-panels">
        <div class="abstract-card" id="abstractPane">${renderPreviewEmpty()}</div>
        <div class="pdf-card" id="pdfPane">
          <div class="preview-muted">PDF will appear here when you select a paper.</div>
        </div>
      </div>
    </div>`;

  content.innerHTML = html;

  let listHtml = '';
  for (const sec of ['new', 'cross', 'repl']) {
    if (!meta.enabled[sec]) continue;
    const title = sec === 'new' ? 'New submissions' : sec === 'cross' ? 'Cross submissions' : 'Replacement submissions';
    const cols  = sectionColumns[sec] || 2;

    listHtml += `
      <div class="section">
        <div class="section-title">
          <div class="left">${escapeHtml(title)}
            <span class="pill">showing ${escapeHtml(String(meta.shownCounts[sec]))} / ${escapeHtml(String(meta.counts[sec]))}</span>
          </div>
          <div class="right">
            <div class="column-toggle-mini">
              <button class="col-btn ${cols === 1 ? 'active' : ''}" onclick="setSectionColumns('${sec}', 1)">I</button>
              <button class="col-btn ${cols === 2 ? 'active' : ''}" onclick="setSectionColumns('${sec}', 2)">II</button>
            </div>
          </div>
        </div>
        ${renderPapersGrid(meta.papersBySection[sec], sec)}
      </div>`;
  }

  document.getElementById('listPane').innerHTML = listHtml;

  const firstPaper = meta.papersBySection.new?.[0] || meta.papersBySection.cross?.[0] || meta.papersBySection.repl?.[0] || null;
  if (firstPaper) setPreviewPaper(firstPaper);

  if (window.MathJax)
    MathJax.typesetPromise([document.getElementById('listPane')]).catch(err => console.log('MathJax error:', err));
}

// ─────────────────────────────────────────────
// Main load function
// ─────────────────────────────────────────────
function getEnabled() { return { new: true, cross: true, repl: true }; }

async function loadPapers() {
  const dateInput  = document.getElementById('day');
  const selectedYmd = dateInput.value;
  const enabled    = getEnabled();

  if (!selectedYmd) { setStatus('Please select a date.'); return; }

  try {
    const dateList = getDateList(selectedYmd, currentDateRange);
    setStatus(`Loading ${dateList.length} day(s) in parallel...`);

    const allIdsBySection = { new: [], cross: [], repl: [] };
    const seenIds         = { new: new Set(), cross: new Set(), repl: new Set() };

    // Fetch all catchup pages in parallel
    await Promise.all(dateList.map(async (date) => {
      const catchupUrl = `https://arxiv.org/catchup/${encodeURIComponent(selectedCategory)}/${encodeURIComponent(date)}?abs=False`;
      try {
        const htmlText     = await fetchWithProxy(catchupUrl, 'text/html');
        const idsBySection = parseCatchupByHeadings(htmlText);
        for (const sec of ['new', 'cross', 'repl']) {
          for (const id of idsBySection[sec]) {
            if (!seenIds[sec].has(id)) {
              seenIds[sec].add(id);
              allIdsBySection[sec].push({ id, date });
            }
          }
        }
      } catch (e) { console.warn(`Failed to load ${date}:`, e); }
    }));

    const counts      = { new: allIdsBySection.new.length, cross: allIdsBySection.cross.length, repl: allIdsBySection.repl.length };
    const shownCounts = { new: counts.new, cross: counts.cross, repl: counts.repl };
    const papersBySection = { new: [], cross: [], repl: [] };

    for (const sec of ['new', 'cross', 'repl']) {
      if (!enabled[sec] || !allIdsBySection[sec].length) continue;
      setStatus(`Loading metadata: ${sec} (${allIdsBySection[sec].length})…`);

      const ids     = allIdsBySection[sec].map(item => item.id);
      const byAbsId = await fetchPapersForIds(ids);

      for (const item of allIdsBySection[sec]) {
        const p = byAbsId.get(normalizeId(item.id));
        if (p) { p.catchupDate = item.date; papersBySection[sec].push(p); }
      }
    }

    // Build global lookup map for preview
    window.__PAPER_BY_ID__ = new Map();
    for (const sec of ['new', 'cross', 'repl'])
      for (const p of papersBySection[sec])
        if (p?.absId) window.__PAPER_BY_ID__.set(p.absId, p);

    const renderMeta = { category: selectedCategory, date: selectedYmd, dateRange: dateList, enabled, counts, shownCounts, papersBySection };
    window.__LAST_RENDER_META__ = renderMeta;
    renderSections(renderMeta);

  } catch (e) { console.error('Load failed:', e); }
}

// ─────────────────────────────────────────────
// Event listeners
// ─────────────────────────────────────────────
document.addEventListener('click', (e) => {
  const card = e.target?.closest?.('.paper-card');
  if (!card) return;
  const p = window.__PAPER_BY_ID__?.get?.(card.getAttribute('data-absid') || '');
  if (p) setPreviewPaper(p);
});

document.addEventListener('focusin', (e) => {
  const card = e.target?.closest?.('.paper-card');
  if (!card) return;
  const p = window.__PAPER_BY_ID__?.get?.(card.getAttribute('data-absid') || '');
  if (p) setPreviewPaper(p);
});

document.getElementById('pdfPreviewToggle').addEventListener('change', function () {
  saveSettings();
  if (currentSelectedCard) {
    const p = window.__PAPER_BY_ID__?.get?.(currentSelectedCard.getAttribute('data-absid'));
    if (p) setPreviewPaper(p);
  }
});

// Back to top
const backToTopBtn = document.getElementById('backToTop');
function updateBackToTop() {
  if (backToTopBtn) backToTopBtn.style.display = window.scrollY > 500 ? 'flex' : 'none';
}
window.addEventListener('scroll', updateBackToTop, { passive: true });
backToTopBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

// ─────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────
window.onload = () => {
  try {
    const savedSettings = loadSettings();
    renderCategoryTabs();
    setupDateInput();

    let initialDate = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    })();
    if (isWeekendYmd(initialDate) !== -1) initialDate = getPreviousFriday(initialDate);

    document.getElementById('day').value = initialDate;
    document.getElementById('day').addEventListener('change', loadPapers);

    if (savedSettings) { applySettings(savedSettings); renderCategoryTabs(); }

    updateBackToTop();
    setTimeout(loadPapers, 250);
  } catch (e) { console.error('Init failed:', e); }
};