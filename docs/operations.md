# Operations guide

Everything you need to keep the factory alive for weeks without babysitting it.

## Processes

Two supported topologies:

| Topology | Processes | When |
|---|---|---|
| Single process | `node src/server.js` (dashboard + worker + scheduler) | 1–2 GB VPS, one operator, simplest |
| Split | `node src/server.js` with `WORKER_ENABLED=false` **plus** `npm run worker` | You want the dashboard to stay fast while rendering, or you restart the web tier independently |

Both processes must share the same `DATABASE_PATH`, `SITES_DIR`, `VIDEOS_DIR` and `RECORDINGS_DIR`.
SQLite runs in WAL mode with a 5 s busy timeout, which is enough for this write pattern
(one writer, occasional dashboard reads).

## Rotation / maintenance

- **Logs**: the scheduler prunes the `logs` table to the newest 5,000 rows every day at 03:15.
- **Artifacts**: generated sites/videos are never deleted automatically. Add a cron job when disk
  usage matters:

  ```bash
  find /opt/shorts-factory/generated-videos -type f -name '*.mp4' -mtime +30 -delete
  find /opt/shorts-factory/recordings -type f -name '*.mp4' -mtime +7 -delete
  ```

  (Do not delete `data/factory.sqlite*` — the dashboard links to artifacts by id.)
- **AI cache**: `data/ai-cache/` is safe to delete; it only saves tokens.
- **Credentials**: `chmod 600 credentials/*`, and keep them out of backups you share.

## Backups

```bash
# consistent SQLite snapshot (never plain-cp a live database)
sqlite3 data/factory.sqlite ".backup 'backups/factory-$(date +%F).sqlite'"
tar czf "backups/credentials-$(date +%F).tgz" credentials
```

Restore: stop the worker, replace the files, start again. Jobs that were `running` are recovered on
start (retried from their last completed stage, or canceled if a cancel was pending).

## Monitoring

| Signal | Where | Action |
|---|---|---|
| `GET /healthz` | HTTP, no auth | 200 with worker state; use for uptime checks |
| `node src/cli.js healthcheck` | cron/CI | exits 1 if the heartbeat is older than 10 minutes |
| Worker paused | dashboard chip | Settings → Resume, or check `worker_state.last_error` |
| Quota warning | dashboard integrations card | lower polling, wait for Pacific midnight |
| Failed jobs | Jobs tab filter `failed` | open the job, read the log, retry when fixed |
| `no video (no browser)` badge | Job drawer | install Chromium, or accept the site-only outcome |
| Disk usage | host | prune artifacts (above) |

Example cron entry:

```cron
*/10 * * * * cd /opt/shorts-factory && /usr/bin/node src/cli.js healthcheck --json >> logs/health.log 2>&1
```

## Failure playbook

**Worker keeps retrying the same job**
Open the job drawer. Retryable errors back off exponentially up to `JOB_BACKOFF_MAX_MS` and stop
after `JOB_MAX_ATTEMPTS`. Cancel the job if the cause is external (e.g. the hosting account is
suspended); it will release the comment back to the pool.

**Renders are slow or the host OOMs**
- `FFMPEG_THREADS=1`, `VIDEO_PRESET=veryfast`, `RECORD_CAPTURE_FPS=8`, `RECORD_MAX_SECTIONS=3`.
- 1080×1920 H.264 encoding is CPU bound; 1 vCPU is enough but jobs queue up.
- Chromium needs ~300–600 MB while recording.

**Chromium cannot launch**
`npx playwright install --with-deps chromium` as root. In containers, add `--cap-add=SYS_ADMIN`
only if you disable `--no-sandbox`; the bundled args already include `--no-sandbox` for unprivileged
containers. If the host simply cannot run a browser, the job fails at `record_site` with
`browser_unavailable` (and does not consume a retry). Setting `ALLOW_SKIP_VIDEO_WITHOUT_BROWSER=true`
makes the job finish with the website, script and narration plus a warning that no video exists —
useful for CI or an API-only host, never a substitute for a real Short. In that mode the job is
recorded as `succeeded` with `state.videoSkipped = true`, the comment is still marked used (so it is
never turned into two different videos) and the dashboard shows a red *no video (no browser)* badge.

**GitHub Pages deploys but verification fails**
First build can take up to two minutes. The pipeline retries with backoff for ~90 s
(`DEPLOY_VERIFY_TIMEOUT_MS`). If the repo exists but Pages is disabled, enable it once in the repo
settings; subsequent deploys reuse the setting.

**Publishing too much**
Set `DAILY_JOB_LIMIT=1`, `DAILY_UPLOAD_LIMIT=1`, `UPLOAD_PRIVACY=private`, and leave
`ALLOW_PUBLIC_UPLOAD=false`. Pause from the dashboard without stopping the process.

## Upgrades

```bash
cd /opt/shorts-factory
git pull
npm ci --omit=dev
node src/cli.js init     # applies new migrations (idempotent)
sudo systemctl restart shorts-factory
```

Migrations are numbered and transactional; the schema version lives in `schema_migrations`.

## Security checklist for a public deployment

- [ ] `DASHBOARD_PASSWORD` is long and random; `SESSION_SECRET` set.
- [ ] TLS terminated by nginx/Caddy; `BASE_URL` uses `https://`.
- [ ] `.env` and `credentials/` are `600` and owned by the service user.
- [ ] Firewall allows 80/443 only; the dashboard is not exposed on a bare IP over HTTP.
- [ ] `ALLOW_PUBLIC_UPLOAD` reflects what you actually want.
- [ ] Generated-site folder is on the same disk but not served by nginx directly (the app serves it
      with a CSP and auth).
