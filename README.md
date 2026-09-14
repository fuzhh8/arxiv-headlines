# arxiv-headlines

Cache-first arXiv headlines site. A scheduled GitHub Action fetches each
category once per weekday and stores same-origin JSON under `data/`. When the
site is run with its Node server, selecting an uncached date automatically
fetches that category from arXiv, stores the result locally, and reloads it into
the page. The paper list is returned first; research figures continue through a
rate-limited background queue with live progress in the page and are merged into
the cards when ready. Concurrent requests for the same category/date share one
fetch, and pending figure work resumes after a page or server restart.

The browser-only live/CORS-proxy path remains as a fallback for static hosting.
The latest valid cached date is selected automatically. When an arXiv HTML
version is available, the server stores up to eight research figures and their
captions for lazy-loaded card previews and the full figure gallery.

The interface also includes advanced sorting/filtering, dedicated favorite/
to-read/read views, click-to-load PDF review, and direct arXiv, PDF, and NASA ADS
links. Paper lists are paginated (24 per page by default, configurable to 12 or
48) so week-long feeds do not render hundreds of cards, figures, and MathJax
expressions at once. User states stay in browser `localStorage`.

Run locally from this directory (Node.js 18 or newer):

```bash
node server.mjs
```

`npm start` is an equivalent shortcut when npm is installed.

## Run the fetch service on the web

GitHub Pages can only serve the cached static files; it cannot run the
`/api/fetch` backend. Deploy this repository as a Render **Web Service** to make
date-triggered fetching available from the public website:

1. Open [Render](https://dashboard.render.com/) and choose **New → Blueprint**.
2. Connect `fuzhh8/arxiv-headlines` and select the `main` branch.
3. Render reads `render.yaml`; confirm the `arxiv-headlines` web service.
4. After deployment, use the generated `https://...onrender.com` address as the
   website URL. The page and fetch API then run on the same origin.

The included Blueprint uses Render's free plan. Free services can sleep while
idle and use an ephemeral filesystem, so on-demand cache files can disappear
after a restart or redeploy. The repository's committed cache remains. For
durable runtime caches, attach a persistent disk on a paid plan or move cache
storage to an external object store.

Then open <http://127.0.0.1:8000/>. Opening `index.html` directly is not
supported because browsers block the JSON cache requests from `file://` pages.
Do not use `python -m http.server` if you want automatic on-demand fetching;
that server can only serve existing files and does not provide `/api/fetch`.

Refresh today's cache locally:

```bash
node scripts/fetch-arxiv.mjs
```

Backfill a specific date:

```bash
node scripts/fetch-arxiv.mjs 2026-09-11
```

Run parser tests:

```bash
npm test
```
