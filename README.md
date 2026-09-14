# arxiv-headlines

Cache-first arXiv headlines site. A scheduled GitHub Action fetches each
category once per weekday and stores same-origin JSON under `data/`. When the
site is run with its Node server, selecting an uncached date automatically
fetches that category from arXiv, stores the result locally, and reloads it into
the page. The paper list is returned first; research figures continue through a
rate-limited background queue with live progress in the page and are merged into
the cards incrementally. Papers visible on the current pagination page are moved
to the front of the figure queue; the cache checkpoints every two papers, so
available images appear without waiting for the whole date to finish. Concurrent
requests for the same category/date share one fetch, and pending figure work
resumes after a page or server restart.

The browser-only live/CORS-proxy path remains as a fallback for static hosting.
The latest valid cached date is selected automatically. When an arXiv HTML
version is available, the server stores up to eight research figures and their
captions for lazy-loaded card previews and the full figure gallery.

The interface also includes advanced sorting/filtering, dedicated favorite/
to-read/read views, click-to-load PDF review, and direct arXiv, PDF, and NASA ADS
links. Paper lists are paginated (24 per page by default, configurable to 12 or
48) so week-long feeds do not render hundreds of cards, figures, and MathJax
expressions at once. The right detail panel and PDF preview are off by default;
both can be enabled under Settings. User states stay in browser `localStorage`.

Run locally from this directory (Node.js 18 or newer):

```bash
node server.mjs
```

`npm start` is an equivalent shortcut when npm is installed.

## Static site + fetch API + durable R2 cache

The included Render Blueprint now creates two services:

- `arxiv-headlines-static`: the static UI and repository cache on Render's CDN.
- `arxiv-headlines`: the Node fetch API, which wakes only for uncached dates or
  ongoing figure extraction.

Cloudflare R2 is the durable source of truth for runtime JSON caches. The API
reads R2 after a restart, mirrors the selected entry to its temporary local
filesystem, and writes metadata plus progressive figure checkpoints back to R2.
The R2 bucket can remain private because browsers read it through `/api/cache`.

### 1. Create the R2 bucket and token

1. In Cloudflare, open **Storage & databases → R2 → Overview** and create a
   bucket such as `arxiv-headlines`.
2. Under **Manage R2 API Tokens**, create an Object Read & Write token scoped to
   that bucket only.
3. Copy the Access Key ID, Secret Access Key, and S3 endpoint. The endpoint is
   `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` and the R2 region is `auto`.

### 2. Configure and deploy Render

1. Open [Render](https://dashboard.render.com/) and choose **New → Blueprint**.
2. Connect `fuzhh8/arxiv-headlines` and select the `main` branch.
3. Render reads `render.yaml`; confirm both services.
4. On the `arxiv-headlines` web service, set these secret environment variables:

   - `CACHE_S3_ENDPOINT`
   - `CACHE_S3_BUCKET`
   - `CACHE_S3_ACCESS_KEY_ID`
   - `CACHE_S3_SECRET_ACCESS_KEY`

5. Redeploy the web service once after saving the secrets. Open the
   `arxiv-headlines-static` URL for normal use.

The static build receives the API's generated Render URL automatically and
writes it to public `config.js`; credentials are never exposed to the browser.
`GET /api/health` reports `"cache":"s3"` when all four variables are present.

The API still works without R2 and falls back to the local filesystem, which is
convenient for development but not durable on a free Render web service.

To use GitHub Pages instead of the Render static site, set `apiBaseUrl` in
`config.js` to the public `https://...onrender.com` API URL before publishing.
The API includes CORS headers for this split deployment. Never place R2
credentials in `config.js` or any other browser file.

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
