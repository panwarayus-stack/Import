# Security model

The factory executes content that strangers typed into YouTube comments, renders code produced by a
language model, and publishes to your channel. Those three facts drive every control below.

## 1. Trust boundaries

| Input | Trust | Controls |
|---|---|---|
| YouTube comment text | **Untrusted, hostile** | sanitising, length caps, spam/injection detection, prompt framing, storage-only |
| AI output (brief/site/script) | Untrusted | JSON schema validation, file allow-list, pattern blocklist, syntax checks, size caps |
| Deployed HTTP responses | Untrusted | verification required, recording restricted to the deployment origin |
| Dashboard operator | Trusted after auth | password + signed cookie + rate limit + CSRF header |
| Environment variables | Trusted | never sent to the browser, scrubbed from logs |

## 2. Prompt injection

Comments are wrapped in explicit delimiters and labelled as data in every prompt:

```
<<<COMMENT>>> … <<<END_COMMENT>>>
```

The system prompt states that quoted content is never an instruction. Known injection signatures
(`ignore previous instructions`, `system prompt`, `reveal your api key`, `<|im_start|>`, `developer
mode`, …) reject the comment before it reaches a model. Even a successful injection cannot reach
tooling: model output is only ever used as **text and static files**, never as a command.

## 3. Generated code execution

- Files are written with `writeFileWithin()`: relative paths only, no `..`, no absolute paths, no
  drive letters, no null bytes, symlinks skipped, per-file (512 KB) and total (3 MB) caps, ≤40 files.
- HTML: tag balance, single `<h1>`, required `<html>/<head>/<body>`, viewport meta.
- CSS: brace balance, minimum size sanity, no remote `@import`.
- JavaScript: compiled with `vm.Script` **to catch syntax errors only** — it is never executed by the
  server.
- Blocked patterns: external scripts/styles/images, iframes/objects, `on*=` handler attributes,
  `javascript:` URLs, `eval`, `new Function`, `document.write`, remote `fetch`/XHR/import,
  meta-refresh redirects, a literal `</script>` inside `app.js`.
- Local references must resolve to files that exist in the same site.
- No `npm install`, no bundler, no build command, no shell: there is no path from model output to
  process execution.
- Execution happens only in the operator's own Chromium, loading only the deployment origin; all
  other origins (including localhost/private ranges during recording) are aborted.

## 4. Credentials

- API keys, OAuth client secrets, tokens and music/licence files stay server side. Nothing secret is
  serialised into `publicConfig()` or any API response.
- OAuth tokens live in SQLite (`oauth_tokens`) and optionally `credentials/youtube-token.json`
  (git-ignored). Refresh tokens never leave the process.
- `.env*` (except the template), `credentials/`, `data/`, `logs/`, generated artifacts are git-ignored.
- The logger scrubs `AIza…`, `sk-or-v1-…`, `gh*_…`, `Bearer …`, `*_token`, `client_secret`, `api_key`
  and `?token=` patterns before writing to stdout or the database.
- Uploads run with the minimum useful scopes (`youtube.readonly`, `youtube.upload`).

## 5. Dashboard

- Password → HMAC-SHA256 signed, expiring, stateless cookie (`HttpOnly`, `SameSite=Strict`, `Secure`
  in production, `__Host-` prefix under HTTPS).
- Constant-time password comparison; sliding-window login rate limiting per IP.
- CSRF: state-changing requests require `X-Requested-With: dashboard`; cross-origin `Origin` headers
  are rejected.
- Responses carry `Content-Security-Policy` (no inline scripts), `X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, HSTS in production.
- Generated sites are served through an authenticated route with their own CSP, from their own
  sandbox directory; path traversal is rejected before the filesystem is touched.
- Media endpoints accept only `[a-zA-Z0-9_-]` ids and known file kinds.

## 6. Publishing gates

A website or video can only be published when all of these are true:

1. The site passed static validation (and browser validation when a browser is available).
2. Deployment succeeded **and** the live URL returned 200 with the expected content.
3. The video passed FFmpeg validation: H.264, AAC, 1080×1920, 9:16, expected duration, audible audio.
4. The upload is not a dry-run artifact (unless `UPLOAD_REQUIRE_REAL_RECORDING=false` is set
   deliberately).
5. The checksum has not been uploaded before and no upload row exists for the video.
6. `ALLOW_PUBLIC_UPLOAD=true` for anything other than private uploads.
7. Daily upload limits and the YouTube upload bucket have room.

## 7. Operational hardening

- Run as a non-root service user; keep `.env` mode `600`.
- Put TLS in front of the app; bind to `127.0.0.1` if a reverse proxy is local
  (`HOST=127.0.0.1`).
- Keep Chromium's sandbox enabled where the kernel allows it; the bundled `--no-sandbox` is there for
  containers, prefer `--cap-add=SYS_ADMIN` + removing the flag on a VPS if you can.
- Back up SQLite with `.backup`, not a live copy.
- Rotate `DASHBOARD_PASSWORD`/`SESSION_SECRET` if a laptop is lost: a new secret invalidates every
  session instantly.
- Review the dashboard's daily usage panel; unexplained AI calls mean a leaked key.

## 8. What this project intentionally does not do

- It does not scrape YouTube or use undocumented endpoints.
- It does not fetch comments from channels you do not own.
- It does not bypass quotas, rate limits or verification requirements.
- It does not run model-generated commands or install model-selected packages.
- It does not claim an integration succeeded without a verified response.
