# Deployment guide

The factory is a **long-running Node.js process with a background worker**, not a static site. That
single fact decides most hosting questions: it needs Node 22.5+, a persistent disk, and an instance
that does not sleep.

## 0. First: why a build can go to the wrong runtime

If `requirements.txt` (or any Python entrypoint) sits in the repository root next to `package.json`,
buildpack-based platforms detect **two** projects and may pick Python. That is exactly what happened
on the first attempt: the builder installed Flask and produced a Python image.

The stray Telegram bot now lives in `legacy/telegram-bot/` and is not part of this app. Keep the
repository root free of `requirements.txt`, `Pipfile`, `pyproject.toml` and `.python-version`.

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

## 4. Post-deploy checklist

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

## 5. Things this project will not pretend to be

- A serverless deployment. Recording + encoding exceed typical function timeouts.
- A free 24/7 host. Sleeping instances break the loop; the docs and dashboard say so.
- A place to store your Google client secret in the frontend. All secrets stay server-side.
