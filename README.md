# AI Website & Shorts Factory

An automated, self-hosted pipeline that turns comments from **your own YouTube channel** into
**live websites** and **vertical YouTube Shorts** with real browser footage, local AI narration and
burned-in subtitles — monitored from a single operator dashboard.

It is built to run for days on a small VPS, not to demo a happy path. Every stage reports what
actually happened: if a credential, binary or integration is missing, the run is marked as a
**dry-run artifact**, the reason is stored on the job, and nothing is published by accident.

```
YouTube comments (official Data API v3)
        │  filter spam / duplicates / prompt injection
        ▼
Random eligible comment ──► OpenRouter (free model) ──► project brief (validated JSON)
        │                                                     │
        │                                                     ▼
        │                                     static site (HTML/CSS/JS) + repair loop
        │                                                     │
        │                                   static + Playwright validation, screenshot
        │                                                     │
        │                                     deploy (GitHub Pages / Netlify / local)
        │                                                     │
        │                                  verify live URL ──► record 1080×1920 in Chromium
        ▼                                                     │
script (hook → context → features → CTA) ──► Piper/espeak TTS ──► measured segment timings
                                                               │
                                            SRT + ASS subtitles (from measured audio)
                                                               │
                                            FFmpeg: H.264/AAC 1080×1920, burned subs
                                                               │
                                            validated ──► YouTube Shorts upload (private by default)
```

---

## Contents

- [What is actually automated](#what-is-actually-automated)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [Google Cloud / YouTube OAuth setup](#google-cloud--youtube-oauth-setup)
- [OpenRouter setup](#openrouter-setup)
- [Hosting / deployment providers](#hosting--deployment-providers)
- [Local testing and dry-run](#local-testing-and-dry-run)
- [Production deployment](#production-deployment)
- [Dashboard](#dashboard)
- [CLI reference](#cli-reference)
- [Pipeline stages, retries and recovery](#pipeline-stages-retries-and-recovery)
- [Free-tier reality check](#free-tier-reality-check)
- [Security model](#security-model)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Project structure](#project-structure)
- [License](#license)

---

## What is actually automated

| Stage | Implementation | Honest failure mode |
|---|---|---|
| Comment collection | `commentThreads.list` with `allThreadsRelatedToChannelId`, pagination, 1 unit/page | Unauthorized or quota-exhausted → poll stops, warning in dashboard |
| Comment selection | Random eligible unused comment, dedupe by id + content hash + near-duplicate similarity | No eligible comment → job fails with `no_comment` (no retry storm) |
| Idea generation | OpenRouter free models, strict JSON schema, on-disk cache | All models fail → deterministic offline template, flagged `offline-template` |
| Website generation | Plain HTML/CSS/JS, validator, up to 2 AI repair attempts | Still invalid → job fails at `build_site`, site never deployed |
| Website testing | Static validation + Playwright load/console/blank/overflow/interaction checks | No Chromium → `static-only` mode, clearly labelled (never "passed") |
| Deployment | GitHub Pages, Netlify, or local preview served by this app | Missing credentials → falls back to local, marked simulated |
| Recording | Real Chromium at 1080×1920, eased scroll, one real interaction | Browser cannot launch → optional screenshot Ken-Burns fallback, or fail closed |
| Script + narration | OpenRouter script, Piper/espeak per-segment synthesis, measured durations | No TTS → silent dry-run track (blocked from upload) |
| Subtitles | Cues derived from measured clip windows, SRT + ASS, sync verifier | Sync check fails → job stops before rendering |
| Rendering | FFmpeg filter graph, libx264 + AAC, burned ASS subtitles | Validation failure (codec/size/audio) → job fails, file kept for inspection |
| Upload | Resumable `videos.insert`, private first, checksum dedupe | Not connected, quota bucket empty, or dry-run artifact → upload skipped with reason |

## Requirements

**Required**

- Node.js **22.5+** (needed for the built-in `node:sqlite` fallback when `better-sqlite3` cannot compile) — managed platforms: see [`docs/deployment.md`](docs/deployment.md)
- FFmpeg with `libx264`, `aac` and `libass` (for burned subtitles), plus `ffprobe` if available
- Chromium/Chrome for Playwright — install with `npx playwright install --with-deps chromium`
- A writable directory for SQLite, generated sites, videos and recordings

**Recommended**

- Piper TTS (offline, high quality) or `espeak-ng` (fallback, low quality but zero setup)
- DejaVu fonts (or any font with the glyphs your narration needs) for subtitle rendering

**External accounts (all optional for local development)**

- OpenRouter API key (free models)
- Google Cloud project with the YouTube Data API v3 enabled and an OAuth client
- GitHub token with `repo` scope (Pages) **or** a Netlify auth token

Verify everything at once:

```bash
node src/cli.js doctor
```

## Quick start

```bash
git clone <your-repo-url> ai-website-factory
cd ai-website-factory

cp .env.example .env
# edit .env: at minimum DASHBOARD_PASSWORD and SESSION_SECRET

npm install
npx playwright install --with-deps chromium     # browser for testing + recording

node src/cli.js init        # creates data dirs, runs SQLite migrations
node src/cli.js doctor      # prints exactly what is available and what is missing

npm start                   # http://localhost:3000  (dashboard + worker + scheduler)
```

Sign in with `DASHBOARD_PASSWORD`. The dashboard opens on the overview tab; the worker starts
immediately and will poll comments on its interval.

Generate one website + video from a comment you supply (no YouTube account needed):

```bash
node src/cli.js generate \
  --comment "I wish someone made a simple meal planner that works offline for a family of four on a tight budget." \
  --author "@demo_viewer"
```

Without OpenRouter, Chromium or Piper this still exercises every local stage, and the job will
clearly tell you which stage needed a real integration.

### FFmpeg

```bash
# Debian / Ubuntu
sudo apt-get update && sudo apt-get install -y ffmpeg fonts-dejavu-core

# macOS
brew install ffmpeg

# Windows: install a build from https://www.gyan.dev/ffmpeg/builds/ and put ffmpeg/ffprobe on PATH
```

If FFmpeg is somewhere unusual, set `FFMPEG_PATH` and `FFPROBE_PATH`. The app also detects
`ffmpeg-static` (npm) and the `imageio-ffmpeg` Python binary before falling back to `PATH`.

## Environment variables

Full list with comments: [`.env.example`](.env.example). The important ones:

| Variable | Default | Purpose |
|---|---|---|
| `DASHBOARD_PASSWORD` | `changeme` in dev, **empty in production** | Dashboard login. Production refuses to log anyone in without it |
| `SESSION_SECRET` | derived in dev | HMAC key for session cookies. Set it in production |
| `BASE_URL` | `http://localhost:3000` | Used for OAuth redirects and links |
| `DATABASE_PATH` | `data/factory.sqlite` | SQLite file (put it on persistent storage) |
| `OPENROUTER_API_KEY` | — | Enables AI idea/site/script generation |
| `OPENROUTER_MODELS` | 3 free models | Ordered fallback list |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | YouTube OAuth |
| `GOOGLE_REDIRECT_URI` | `${BASE_URL}/auth/google/callback` | Must match Google Cloud exactly |
| `DEPLOY_PROVIDER` | `local` | `local`, `github-pages` or `netlify` |
| `GITHUB_TOKEN` / `GITHUB_OWNER` | — | GitHub Pages deployment |
| `TTS_ENGINE` | `piper` | `piper`, `espeak` or `silent` |
| `PIPER_MODEL` | — | Path to a Piper `.onnx` voice |
| `ALLOW_PUBLIC_UPLOAD` | `false` | Must be `true` before a public upload is possible |
| `UPLOAD_PRIVACY` | `private` | `private`, `unlisted` or `public` |
| `DAILY_JOB_LIMIT` / `DAILY_UPLOAD_LIMIT` | `3` / `1` | Safety caps (also editable in the dashboard) |
| `DRY_RUN` | `false` | Forces every external integration into dry-run |
| `POLL_SCHEDULE` | `interval` | `interval` (tick every minute, honours the poll interval) or `cron` |
| `COMMENT_POLL_INTERVAL_MINUTES` | `20` | How often to look for new comments in interval mode |
| `VIDEO_MAX_DURATION_SEC` | `58` | Hard cap for a Short (YouTube allows 180; 58 is ad-free) |
| `CHROMIUM_EXECUTABLE_PATH` | auto-detect | Use a system Chromium instead of the bundled build |
| `ALLOW_SCREENSHOT_FALLBACK` | `true` | Animate a screenshot when video recording fails |
| `ALLOW_SKIP_VIDEO_WITHOUT_BROWSER` | `false` | On a host with no Chromium, finish the job with site + script + narration and an explicit "no video produced" flag instead of failing |

Runtime-automation settings (limits, polling interval, model override, privacy) are stored in
SQLite and editable from **Settings**. Credentials and binary paths are environment-only by design.

## Google Cloud / YouTube OAuth setup

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create (or pick) a project.
2. **APIs & Services → Library → YouTube Data API v3 → Enable.**
3. **OAuth consent screen**: choose *External*, fill the app name/support email, add your Google
   account under *Test users* while the app is unverified.
4. Add scopes:
   - `https://www.googleapis.com/auth/youtube.readonly` (read your channel comments)
   - `https://www.googleapis.com/auth/youtube.upload` (publish Shorts)
5. **Credentials → Create credentials → OAuth client ID → Web application.**
   Add the redirect URI exactly, e.g. `http://localhost:3000/auth/google/callback` for local use
   and `https://your-domain.com/auth/google/callback` in production.
6. Put the client id/secret into `.env`, restart, open **Settings → Connect channel**, and approve
   the consent screen with the channel account.
7. Confirm in the dashboard: the YouTube capability chip turns green and shows the channel name.

Notes that matter in practice:

- Use a **Web application** client (not "Desktop"), so the redirect URI is fixed and validated.
- Unverified OAuth apps can be limited: uploads may be **locked to private** until your app passes
  Google's compliance audit. Start private (the default here) and publish deliberately.
- Comment polling uses `commentThreads.list`, which costs 1 unit per page. The default project
  quota is 10,000 units/day. Quota resets at **midnight Pacific Time**.
- Uploads have their own quota bucket. Since the June 2026 API change the default is **100 uploads
  calls/day at 1 unit each**; older projects were billed ~1600 units from the shared pool. Both are
  configurable (`YOUTUBE_UPLOAD_DAILY_LIMIT`, `QUOTA_COST_UPLOAD`,
  `YOUTUBE_UPLOAD_USES_SHARED_QUOTA=true`).
- Never commit `credentials/` or `.env`. The app never logs tokens (the logger scrubs them).

Detailed walkthrough with screenshots-in-words: [`docs/youtube-oauth.md`](docs/youtube-oauth.md).

More: [`docs/operations.md`](docs/operations.md) (deployment, backups, monitoring, failure
playbook), [`docs/security.md`](docs/security.md) (threat model and controls),
[`docs/free-tier-strategy.md`](docs/free-tier-strategy.md) (what is actually free).

## OpenRouter setup

1. Create a key at <https://openrouter.ai/keys>.
2. Put it in `.env` as `OPENROUTER_API_KEY`.
3. Pick models. Free ids end in `:free`; the default list is:

   ```
   meta-llama/llama-3.3-70b-instruct:free,google/gemma-3-27b-it:free,qwen/qwen-2.5-72b-instruct:free
   ```

4. Optionally override the model from **Settings** (stored in SQLite, takes precedence).
5. Set a referral URL (`OPENROUTER_REFERER`) and title so your usage is attributable.

Free models are rate limited, can be temporarily unavailable, and occasionally return malformed
JSON. The client therefore: falls back across the model list, retries once with a "JSON only"
instruction, caches responses on disk (`data/ai-cache`, 7 days), and finally falls back to a
deterministic offline template that is flagged in the UI.

## Hosting / deployment providers

`DEPLOY_PROVIDER` selects where generated sites live.

### `local` (default)

Served by this app at `/sites/<siteId>/` with a restrictive CSP. Real content, real URL — but only
public if this app is reachable from the internet. Always labelled *local preview*, never
"deployed". Recording works because the pipeline serves the site on an ephemeral local port.

### `github-pages`

- Create a token with `repo` scope (classic) or fine-grained *Contents: write* + *Pages: write* for
  repositories owned by you/an org you administer.
- Set `GITHUB_TOKEN`, `GITHUB_OWNER` (user or org), optional `GITHUB_REPO_PREFIX`.
- Each site gets its **own** repository (`<prefix>-<siteId>`). The deployer refuses to touch an
  existing repository, so nothing is ever overwritten.
- Pages is enabled from the branch root; the URL (`https://<owner>.github.io/<repo>/`) is verified
  with retries before recording (first publication can take 30–120 s).
- Free tier: public repos are free, site soft limit ~1 GB, ~10 builds/hour, 100 GB/month bandwidth.
  Private-repo Pages requires a paid plan — the repo visibility is configurable.

### `netlify`

- Create a personal access token, set `NETLIFY_AUTH_TOKEN` (and `NETLIFY_SITE_ID` to reuse one site
  instead of creating a new one per build).
- Files are zipped locally (no third-party CLI) and posted to Netlify's deploy API; the deploy is
  polled until `ready`.
- Free tier: 100 GB bandwidth and 300 build minutes/month. Static deploys are cheap but not
  unlimited.

## Local testing and dry-run

```bash
npm test                      # 76 tests: unit + integration, no network required
node src/cli.js selftest      # validate the built-in offline site template
node src/cli.js seed-demo     # insert 4 safe demo comments
npm run run-once              # process one job through the worker
npm run doctor                # environment report
DRY_RUN=true npm start        # every external call is simulated
```

Testing tools:

- `node src/cli.js filter-test --comment "..."` → shows sanitization and eligibility decision.
- `npm run generate -- --comment "..."` → full pipeline for one manual comment.
- `node src/cli.js healthcheck --json` → exit code 1 when the worker heartbeat is stale.

On a machine without Chromium the pipeline will validate and deploy the site, then stop at
`record_site` with an explicit instruction. It does **not** fabricate footage.

## Production deployment

> Managed platform (Render, Railway, Fly, Coolify, Back4App…)? Read
> [`docs/deployment.md`](docs/deployment.md) first. Two things trip every first deploy: a
> `requirements.txt` in the repository root makes buildpacks pick **Python**, and Node **20** cannot
> load `node:sqlite`. The repo now ships `.node-version`, `Procfile`, `nixpacks.toml` and
> `render.yaml`, and the legacy bot lives in `legacy/telegram-bot/`.

### VPS (recommended)

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg fonts-dejavu-core git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

git clone <repo> /opt/shorts-factory && cd /opt/shorts-factory
npm ci --omit=dev
npx playwright install --with-deps chromium
cp .env.example .env && nano .env     # production values
node src/cli.js init
```

Example systemd unit (`/etc/systemd/system/shorts-factory.service`):

```ini
[Unit]
Description=AI Website & Shorts Factory
After=network-online.target

[Service]
Type=simple
User=shorts
WorkingDirectory=/opt/shorts-factory
Environment=NODE_ENV=production
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
# graceful shutdown (SQLite + worker state)
KillSignal=SIGTERM
TimeoutStopSec=40

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now shorts-factory
sudo journalctl -u shorts-factory -f
```

Put nginx/Caddy in front for TLS and set `BASE_URL=https://your-domain.com`. The app trusts one
proxy hop (`trust proxy = 1`); adjust if you terminate TLS elsewhere.

**Scaling pattern**: run two processes against the same SQLite file — `WORKER_ENABLED=false` for the
web/dashboard process and `WORKER_ENABLED=true SCHEDULER_ENABLED=true` for the worker process.
SQLite WAL handles the concurrency; keep both on the same host and the same disk.

### Docker

```bash
docker build -t shorts-factory .
docker run -d --name shorts-factory \
  --env-file .env -p 3000:3000 \
  -v shorts-data:/app/data \
  -v shorts-sites:/app/generated-sites \
  -v shorts-videos:/app/generated-videos \
  -v shorts-recordings:/app/recordings \
  -v shorts-credentials:/app/credentials \
  shorts-factory
```

The image includes FFmpeg, Chromium and DejaVu fonts. Piper is not bundled (install it in your own
derived image with `scripts/install-piper.sh` if you want higher-quality voices).

### Backups & monitoring

- Back up `data/factory.sqlite*` (use `sqlite3 .backup`, not a live `cp`), `credentials/` and,
  optionally, `generated-sites/`.
- Health: `GET /healthz` (public, no secrets) and `node src/cli.js healthcheck`.
- Watch the dashboard's *API errors and quota warnings* panel; the worker also records the last
  error in the SQLite `worker_state` row.

## Dashboard

`http://localhost:3000` (password from `DASHBOARD_PASSWORD`).

- **Overview** — worker live/paused, active job stage + progress, counters for comments, jobs,
  websites, videos and uploads, integration capability chips, quota usage, recent jobs, latest
  website thumbnails, manual "generate from comment" form, start/pause/resume, poll-now.
- **Jobs** — searchable, filterable history; per job: comment, status, stage, progress, links to the
  site, MP4, YouTube; cancel and retry; detail drawer with the full job log, verdicts and warnings.
- **Comments** — discovered/eligible/used/rejected counts and the raw stored comments.
- **Logs** — structured, scrubbed, filterable by level/job/text with optional live refresh.
- **Settings** — daily job/upload limits, polling interval, target video length, queue depth,
  privacy, AI model override, YouTube connect/disconnect, and a read-only view of the environment
  configuration.

All state-changing API calls require an `X-Requested-With: dashboard` header (CSRF defence) in
addition to the HttpOnly `SameSite=Strict` session cookie.

## CLI reference

```bash
node src/cli.js init                       # dirs + migrations
node src/cli.js doctor [--json]            # integration report
node src/cli.js worker [--no-scheduler]    # persistent worker only
node src/cli.js server                     # dashboard only (same as npm start)
node src/cli.js generate --comment "..." [--author "@x"] [--max-attempts 1]
node src/cli.js run-once                   # enqueue + process one job from existing comments
node src/cli.js seed-demo                  # demo comments
node src/cli.js filter-test --comment "…"  # inspect the comment filter
node src/cli.js selftest                   # validate the offline template
node src/cli.js healthcheck [--json]
node src/cli.js google-auth --import credentials/youtube-token.json
node src/cli.js reset --yes                # clear jobs/sites/videos/uploads (records only)
```

`generate`/`run-once` exit `0` on success and `1` on failure, so they work in cron/CI.

## Pipeline stages, retries and recovery

```
select_comment → generate_idea → build_site → test_site → deploy_site →
write_script → narrate → record_site → subtitles → render_video → upload_video → done
```

- One job at a time; the queue is SQLite (`jobs` table) with explicit states: `queued`, `running`,
  `retrying`, `succeeded`, `failed`, `canceled`.
- After every stage the job's `state_json` and `progress` are written. On restart,
  `recoverInterruptedJobs()` puts `running` jobs back to `retrying` (or `canceled` if a cancel was
  requested) and the worker resumes from the first incomplete stage — artifacts already produced are
  reused.
- Failures are classified: retryable (network, 5xx, 429, hosting hiccup, missing browser) use
  exponential backoff (`JOB_BACKOFF_BASE_MS` … `JOB_BACKOFF_MAX_MS`) up to `JOB_MAX_ATTEMPTS`;
  validation failures are **not** retried forever.
- Retry-After headers are honoured by the HTTP layer; quota exhaustion pauses polling until the next
  day instead of hammering the API.
- Duplicate prevention: unique comment ids + content hashes, near-duplicate similarity check, one
  upload row per video (`UNIQUE(video_id)`), SHA-256 checksum check against previous uploads,
  one active job per comment.
- Cancellation is cooperative: the worker checks `cancel_requested` between stages and releases the
  comment back to the eligible pool.
- Graceful shutdown on `SIGINT`/`SIGTERM` finishes the current stage boundary, stops the scheduler,
  closes SQLite and exits (40 s systemd timeout recommended).

## Free-tier reality check

| Item | What is free | What is not |
|---|---|---|
| This application | MIT-licensed code, runs on any VPS/container | The VPS itself (~$4–6/month for 1–2 GB RAM) |
| OpenRouter | `:free` models at $0 | Strict rate limits, downtime, quality varies, no SLA |
| YouTube Data API | 10,000 units/day reads + 100 upload calls/day (current buckets) | Quota increases need a compliance audit; uploads from unverified apps may be locked private |
| GitHub Pages | Public repos, ~1 GB site, ~10 builds/hour, 100 GB/month | Private-repo Pages, custom domains need DNS setup |
| Netlify | 100 GB bandwidth, 300 build minutes/month | Beyond that is paid; free sites can be throttled |
| Piper TTS | Fully offline, unlimited | You host the binary/voice model (~60 MB per voice) |
| FFmpeg | Fully offline, unlimited | CPU time — rendering 1080×1920 takes real seconds |
| Chromium | Unlimited local runs | ~300 MB install, ~300–600 MB RAM while recording |
| Storage | Local disk | Generated sites/videos accumulate; prune old artifacts periodically |

**"24/7" means a persistent process.** Serverless/free web hosts that sleep after inactivity, cap
CPU-seconds, or use ephemeral disks will break the worker, the SQLite file, or recordings. Use a VPS,
a home server, or a container platform with persistent volumes. Keep the artifact directory on
persistent storage and monitor disk usage.

## Security model

- **Secrets** live only in environment variables (or the git-ignored `credentials/` dir). The API
  never returns them; the logger scrubs tokens, keys and `Bearer` headers before writing.
- **Dashboard**: single operator password → HMAC-signed HttpOnly `SameSite=Strict` cookie, login rate
  limiting, CSRF header requirement, same-origin check, strict CSP, `X-Frame-Options`, no inline
  scripts.
- **Untrusted comments**: length limits, control-character stripping, spam/injection pattern
  detection, explicit "data, not instructions" framing in every prompt, and no tool execution path
  from model output.
- **Generated code**: written through a path-safe writer (no traversal, no absolute paths, symlinks
  ignored, per-file and total size caps, file-count caps), HTML/CSS/JS structurally validated,
  JavaScript compiled with `vm.Script` but **never executed**, external assets/iframes/inline
  handlers/`eval` rejected. There is no `npm install` and no shell execution of generated content.
- **Recording isolation**: the browser may only load the deployment origin; private-network and
  third-party requests are aborted. The site never sees credentials (they are not injected).
- **Publishing gates**: deployment verification is required, videos are validated (codec, geometry,
  duration, audible audio) before upload, uploads are private by default, dry-run artifacts are
  blocked from upload, and the same file cannot be uploaded twice.
- **Data at rest**: generated sites are separate folders; the dashboard only serves a site folder,
  never arbitrary paths.

Report vulnerabilities privately rather than opening a public issue.

## Known limitations

- **Not for other people's channels.** Comments are fetched with `allThreadsRelatedToChannelId` for
  the authorized channel. Scraping or bypassing API restrictions is out of scope.
- **Quality depends on the model and the comment.** Free models occasionally produce a weak layout;
  the validator catches broken output, not mediocre design. Review before going public.
- **Website footage depends on the deployment.** If GitHub Pages has not published yet, verification
  fails and the job stops rather than recording an error page.
- **Subtitles** are aligned to measured per-segment audio durations. Within a long segment, cue
  boundaries are proportional to characters — the pipeline does not run forced alignment (that would
  need a model such as Whisper). Segment boundaries are exact, so drift stays inside one clip.
- **Piper speed control** changes `length_scale`; extreme values degrade quality.
- **No background music is bundled.** Add a licensed track via `BACKGROUND_MUSIC_PATH`.
- **Short length**: YouTube now treats vertical videos up to 3 minutes as Shorts; the default max here
  is 58 s to keep retention high. Raise `VIDEO_MAX_DURATION_SEC` up to 175 if you want longer.
- **YouTube policy** applies to everything you publish. Do not use this to mass-produce low-effort
  videos; the daily limits and private-first defaults exist for that reason.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Unable to launch Chromium … libnspr4.so` | `npx playwright install --with-deps chromium` (needs root) or install `libnss3 libnspr4 libasound2 libgbm1 libxkbcommon0` |
| `better-sqlite3` build fails / no module | Node ≥22.5 falls back to built-in `node:sqlite` automatically; or install build tools and `npm rebuild better-sqlite3` |
| `FFmpeg is not installed` | Install ffmpeg, or set `FFMPEG_PATH`; `node src/cli.js doctor` shows the resolved path |
| `No usable TTS engine` | Install Piper (`scripts/install-piper.sh`), or set `TTS_ENGINE=espeak` after `apt-get install espeak-ng` |
| `Piper produced no audio` | `PIPER_MODEL` must point at a `.onnx` voice file that exists |
| `YouTube channel is not connected` | Settings → Connect channel; check the redirect URI matches Google Cloud exactly |
| `quotaExceeded` | Quota resets at midnight Pacific; lower polling or request more quota |
| Upload skipped: *dry-run artifact* | The pipeline fell back to offline templates/screenshot video; fix the missing integration, or set `UPLOAD_REQUIRE_REAL_RECORDING=false` (not recommended) |
| GitHub Pages verification fails | First build takes 30–120 s; check the workflow/repo exists and Pages is enabled. The job retries with backoff |
| Dashboard logs "worker offline" | Worker process not running (`WORKER_ENABLED=false` in the web process) |
| Horizontal scroll in generated site | The tester warns on overflow; the fix prompt includes validator errors for the repair round |

## Project structure

```
src/
  server.js               HTTP entrypoint (dashboard + worker in one process by default)
  app.js                  Express assembly, security headers, routes
  bootstrap.js            object graph shared by server/CLI/tests
  cli.js                  operator CLI
  config.js               env parsing, dry-run derivation, redacted public view
  database.js             SQLite schema, migrations, repositories
  lib/                    sqlite adapter, http client, fs sandbox, auth, media probing,
                          browser launching, logger, prompts, static server, zip
  services/               openrouter, google-oauth, youtube-comments, comment-filter,
                          idea-generator, offline-ai, website-builder, website-tester,
                          deployer, recorder, narration, script-writer, subtitles,
                          video-renderer, youtube-uploader
  workers/                pipeline-worker, scheduler, upload limits
  routes/                 auth, api, dashboard
public/                   dashboard (HTML/CSS/JS) + login page
templates/prompts/        idea / site / repair / script prompt templates
tests/                    node:test suites (76 tests)
scripts/                  piper installer + dry-run demo script
docs/                     deployment, OAuth walkthrough, operations, security model, free-tier notes
legacy/telegram-bot/      unrelated old Python bot, kept out of the build root on purpose
data/ generated-sites/ generated-videos/ recordings/ credentials/   runtime (git-ignored)
```

## License

MIT. See [LICENSE](LICENSE). The generated websites and videos are yours; you are responsible for
the comments you build from and for complying with YouTube's Terms of Service and API policies.
