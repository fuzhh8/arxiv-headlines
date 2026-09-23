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
Each opening targets the current arXiv announcement day (or Friday on a
weekend); when that cache entry is missing, the on-demand service fetches and
stores it before rendering. When an arXiv HTML version is available, the server
stores up to eight research figures and their captions for lazy-loaded card
previews and the full figure gallery.

The interface also includes advanced sorting/filtering, dedicated favorite/
to-read/read views, click-to-load PDF review, and direct arXiv, PDF, and NASA ADS
links. Paper lists are paginated (24 per page by default, configurable to 12 or
48) so week-long feeds do not render hundreds of cards, figures, and MathJax
expressions at once. The right detail panel and PDF preview are off by default;
both can be enabled under Settings. Custom date ranges are limited to the three
calendar months ending on the selected date, and the control shows its earliest
valid start date. Cache reads are concurrency-limited so broad ranges do not
issue an unbounded burst of browser requests.

Favorites, To read, and Read remain available locally by default. In Settings,
users can opt into cross-device sync: the site generates a private sync code,
which must be copied to the other device. The code is the access credential, so
it should not be shared publicly. The Render API hashes it before selecting the
stored record. When R2 is configured, these records are durable; otherwise they
use only the server's local development storage. The same Settings panel also
has an optional feedback form; feedback is saved to the configured R2 bucket.

Run locally from this directory (Node.js 18 or newer):

```bash
node server.mjs
```

`npm start` is an equivalent shortcut when npm is installed.

## GitHub Pages + Render API + durable R2 cache

The production split uses three services:

- GitHub Pages hosts the static UI and repository cache.
- Render runs `arxiv-headlines`, the Node fetch API, which wakes only for
  uncached dates or ongoing figure extraction.
- Cloudflare R2 preserves runtime cache JSON across Render restarts.

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

### 2. Configure the Render API

1. Open [Render](https://dashboard.render.com/) and choose **New → Blueprint**,
   or keep the existing `arxiv-headlines` web service.
2. Connect `fuzhh8/arxiv-headlines`, select `main`, and use `render.yaml`.
3. On the `arxiv-headlines` web service, set these secret environment variables:

   - `CACHE_S3_ENDPOINT`
   - `CACHE_S3_BUCKET`
   - `CACHE_S3_ACCESS_KEY_ID`
   - `CACHE_S3_SECRET_ACCESS_KEY`

4. Redeploy once after saving the secrets. Verify
   `https://YOUR-SERVICE.onrender.com/api/health` returns `"cache":"s3"`.

### 3. Configure GitHub Pages

1. In the GitHub repository, open **Settings → Secrets and variables → Actions
   → Variables**.
2. Create the repository variable `ARXIV_API_BASE_URL` with the value
   `https://YOUR-SERVICE.onrender.com` (no trailing slash).
3. Open **Settings → Pages** and select **GitHub Actions** as the source.
4. Open **Actions → Deploy GitHub Pages → Run workflow** once.
5. Use `https://fuzhh8.github.io/arxiv-headlines/` as the normal website URL.


The Pages workflow builds `dist/`, injects the public Render API URL into
`config.js`, and deploys the artifact. It also republishes after the scheduled
`Fetch arXiv Papers` workflow completes successfully. R2 credentials remain
only on Render and are never exposed to GitHub Pages.

The API still works without R2 and falls back to the local filesystem, which is
convenient for development but not durable on a free Render web service.

The API includes CORS headers for this split deployment. Never place R2
credentials in `config.js`, GitHub repository variables, or browser files; the
only GitHub variable is the public Render URL.

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
