# Deployment guide

The factory is a **long-running Node.js process with a background worker**, not a static site. That
single fact decides most hosting questions: it needs Node 22.5+, a persistent disk, and an instance
that does not sleep.

## 0. First: why a build can go to the wrong runtime

If `requirements.txt` (or any Python entrypoint) sits in the repository root next to `package.json`,
buildpack-based platforms detect **two** projects and may pick Python. That is exactly what happened
on the first attempt: the builder installed Flask and produced a Python image.

The stray Telegram bot now lives in `legacy/telegram-bot/` **with an `.example` suffix on every
file** (`main.py.example`, `keep_alive.py.example`, `requirements.txt.example`) and is not part of this
app. There is no `*.py`, `requirements.txt`, `Pipfile` or `pyproject.toml` anywhere in the repository,
so no builder can detect Python.

If you ever see `/app/main.py` in a log — for example:

```
Traceback (most recent call last):
  File "/app/main.py", line 3, in <module>
    from keep_alive import keep_alive
ModuleNotFoundError: No module named 'keep_alive'
```

then the running container is **not** this repository's current code. `main.py` has not existed in
this repo since commit `81448e0`. Typical causes: the platform is still serving a previously built
image, the service was created against an old commit, or the cache was not cleared. See
[§4 Redeploying after this fix](#4-redeploying-after-this-fix).

### The guard: `scripts/preflight.js`

`npm start` now runs a preflight check first (`prestart`), and the image build runs it explicitly:

```bash
node scripts/preflight.js            # human-readable
node scripts/preflight.js --json     # machine-readable
node scripts/preflight.js --strict   # warnings become failures (used by CI / Docker build)
```

It fails (exit 1) when:

- Node is older than 22.5,
- no SQLite driver is available,
- `express` / `dotenv` / `node-cron` / `playwright-core` are not installed,
- a Python marker (`*.py`, `requirements.txt`, `Pipfile`, `pyproject.toml`, `setup.py`,
  `poetry.lock`) exists outside `node_modules`, `.git` and `legacy/`,
- `package.json` has no `start` script, `main` is missing, or `src/server.js` is absent.

It warns about a missing `Dockerfile`/`.node-version` and about runtime directories that are not
writable. In the container image the same script runs at build time, so a broken image cannot be
published; on Render/Nixpacks it runs as part of the build command.

Second cause: the platform defaulted to **Node 20**. This app needs **Node 22.5+** because it uses
`node:sqlite` when the native `better-sqlite3` module is unavailable. The repo pins it three ways:

| File | Read by |
|---|---|
| `package.json` → `"engines": { "node": ">=22.5.0" }` | Render, Railway, Nixpacks, Heroku |
| `.node-version` / `.nvmrc` (`22`) | Nixpacks, asdf, fnm, nvm |
| `Dockerfile` (`node:22-bookworm-slim`) | Any container platform |

If a platform ignores all three, set `NODE_VERSION=22.22.3` in its environment settings or use the
Dockerfile.

## 1. Required settings on any platform

| Setting | Value |
|---|---|
| Build command | `npm ci --include=optional --no-audit --no-fund` |
| Start command | `npm start` |
| Health check path | `/healthz` |
| Port | platform-provided `PORT` (the app reads it; binds `HOST=0.0.0.0`) |
| Persistent disk | mount at `/var/data`, then point the paths at it (below) |
| Instance type | always-on. Free tiers that sleep will stall the worker mid-job |

Environment variables (minimum for a working dashboard):

```env
NODE_ENV=production
PORT=<platform>
BASE_URL=https://your-app.example.com
DASHBOARD_PASSWORD=<long random string>
SESSION_SECRET=<long random string>
ALLOW_PUBLIC_UPLOAD=false
UPLOAD_PRIVACY=private
DEPLOY_PROVIDER=local

# persistent disk
DATABASE_PATH=/var/data/factory.sqlite
DATA_DIR=/var/data
SITES_DIR=/var/data/generated-sites
VIDEOS_DIR=/var/data/generated-videos
RECORDINGS_DIR=/var/data/recordings
LOGS_DIR=/var/data/logs
CREDENTIALS_DIR=/var/data/credentials
```

Then add `OPENROUTER_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` when you want real AI and
YouTube access. Without them the app boots in a clearly-flagged dry-run mode.

> Without a persistent disk, SQLite and generated artifacts are lost on every deploy/restart. The app
> still works, but job history disappears — the boot log warns if the database directory is not
> writable.

## 2. Platform recipes

### Render (blueprint included: `render.yaml`)

1. **New → Blueprint**, pick this repo, branch `main`.
2. Render reads `render.yaml`: Node runtime, `npm start`, `/healthz`, 10 GB disk at `/var/data`.
3. Fill the `sync:false` secrets in the dashboard.
4. Note: the Starter plan is the cheapest always-on option; free web services spin down.

### Railway / Coolify / Northflank (Nixpacks — `nixpacks.toml` included)

The file pins `nodejs_22` + `ffmpeg`, installs with `npm ci`, and starts `npm start`. Add a volume at
`/var/data` and the env vars above.

### Fly.io

```bash
fly launch --no-deploy          # uses the Dockerfile
fly volumes create factory_data --size 20
# fly.toml: [mounts] source="factory_data" destination="/var/data"
fly secrets set DASHBOARD_PASSWORD=... SESSION_SECRET=... BASE_URL=https://<app>.fly.dev
fly deploy
```

### Docker / VPS

```bash
docker build -t shorts-factory .
docker run -d --name shorts-factory -p 3000:3000 \
  -v /srv/factory:/var/data \
  -e DASHBOARD_PASSWORD=... -e SESSION_SECRET=... -e BASE_URL=https://shorts.example.com \
  -e DATABASE_PATH=/var/data/factory.sqlite -e DATA_DIR=/var/data \
  -e SITES_DIR=/var/data/generated-sites -e VIDEOS_DIR=/var/data/generated-videos \
  -e RECORDINGS_DIR=/var/data/recordings -e LOGS_DIR=/var/data/logs \
  -e CREDENTIALS_DIR=/var/data/credentials \
  shorts-factory
```

The image includes Node 22, FFmpeg (x264/aac/libass), Chromium with its runtime libs, and DejaVu
fonts — the four things video work actually needs. For systemd, see `docs/operations.md`.

### Heroku-style (`Procfile` included)

`web: npm start` and `worker: npm run worker`. Add the Postgres-free SQLite caveat: Heroku's disk is
ephemeral, so run the worker on a box with a volume instead.

## 3. What breaks on managed platforms (and the fix)

| Symptom | Cause | Fix |
|---|---|---|
| Builder installs pip packages | Python files in root | they are in `legacy/` now; keep it that way |
| `Cannot find module 'node:sqlite'` / "SQLite unavailable" | Node 20 | pin Node 22.5+ (`.node-version`, `engines`, `NODE_VERSION`) |
| "Database directory … is not writable" | no persistent disk | attach a volume, set `DATABASE_PATH` |
| Jobs stall at `record_site` | Chromium missing or `/dev/shm` too small | use the Dockerfile, or `ALLOW_SKIP_VIDEO_WITHOUT_BROWSER=true` |
| Renders killed by the platform | CPU/time limits, OOM | `VIDEO_PRESET=veryfast`, `FFMPEG_THREADS=1`, smaller instance expectations |
| OAuth redirect mismatch | `BASE_URL` still localhost | set `BASE_URL` and add `https://…/auth/google/callback` in Google Cloud |
| Session lost on every deploy | `SESSION_SECRET` unset | set it once and keep it stable |
| Worker sleeping between requests | free tier scale-to-zero | always-on instance; the pipeline needs minutes of uninterrupted CPU |

## 4. Redeploying after this fix

Because the container in the traceback was running `/app/main.py`, the deploy pipeline is still on an
old commit/image. Do all of the following, in order:

1. **Confirm the branch and commit.** Deploy `main`; the newest commit must be `81448e0` or later.
   `git ls-tree --name-only main` must **not** list `main.py` or `requirements.txt`.
2. **Clear the build cache** (Render: *Manual Deploy → Clear build cache & deploy*; Railway:
   *Redeploy → Clear build cache*; Coolify: *Rebuild without cache*).
3. **Check the service type.** If the service was created as a Python/Flask app, its start command is
   often a fixed `python main.py` and its environment has a `PYTHON_VERSION`. Delete the service and
   create a new **Web Service / Node** one pointing at this repo — editing the start command is not
   always enough, because the build command may still be `pip install -r requirements.txt`.
4. **Set the start command explicitly:** `npm start`. Build command:
   `npm ci --include=optional --no-audit --no-fund`.
5. **Set `NODE_VERSION=22.22.3`** (or confirm the builder reads `.node-version`, which contains `22`).
6. Watch the build log for one of these two lines — they mean the new code is in use:
   - `Preflight OK` / `· SQLite driver: node:sqlite`
   - `SQLite driver: Node's built-in node:sqlite`
   If you instead see `pip install` or `Successfully installed flask`, the platform is still running
   the old detection: go back to step 3.
7. After the deploy, `curl https://<your-app>/healthz` should return JSON with `"ok":true`.

## 5. Post-deploy checklist

```bash
curl -fsS https://your-app.example.com/healthz          # {"ok":true,...}
node src/cli.js doctor                                  # run inside the container/host
```

Then in the browser:

1. Log in with `DASHBOARD_PASSWORD`; the warning strip should only list what you have not configured.
2. **Settings** — set the model, daily limits, poll interval, privacy.
3. **Connect channel** (if OAuth is configured) and confirm the chip shows your channel name.
4. Queue one manual job and watch it to `done` (or to an explicit, explained failure).
5. Only then enable the scheduler and auto-enqueue.

## 6. Things this project will not pretend to be

- A serverless deployment. Recording + encoding exceed typical function timeouts.
- A free 24/7 host. Sleeping instances break the loop; the docs and dashboard say so.
- A place to store your Google client secret in the frontend. All secrets stay server-side.
