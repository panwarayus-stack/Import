# Free-tier strategy (and where the real costs are)

The factory is designed so that **software** is free and **services** are borrowed carefully. Nothing
here promises unlimited capacity; every external limit is configurable and enforced in code.

## Cost map

| Component | Cost model | Enforced by |
|---|---|---|
| Node.js, Express, Playwright, FFmpeg, SQLite, node-cron | Free, open source | — |
| Piper TTS / espeak-ng | Free, runs locally | `TTS_ENGINE` |
| OpenRouter `:free` models | $0 per call, hard rate limits | `MAX_AI_CALLS_PER_DAY`, per-job call budget, disk cache |
| YouTube Data API reads | 10,000 units/day/project | `YOUTUBE_DAILY_QUOTA_UNITS`, quota pre-checks |
| YouTube uploads | 100 calls/day bucket (post-June-2026), 1 unit each | `YOUTUBE_UPLOAD_DAILY_LIMIT`, `DAILY_UPLOAD_LIMIT` |
| GitHub Pages | Free for public repos, ~1 GB site, ~10 builds/hour | one repo per site, size caps |
| Netlify | 100 GB bandwidth, 300 build minutes/month | `DEPLOY_PROVIDER`, size caps |
| Server / VPS | **Paid** (~$4–6/month for 1–2 GB RAM) | your choice of host |
| Domain (optional) | Paid | — |

## Recommended configuration for a zero-budget start

```env
OPENROUTER_MODELS=meta-llama/llama-3.3-70b-instruct:free,google/gemma-3-27b-it:free
MAX_AI_CALLS_PER_DAY=20
DAILY_JOB_LIMIT=2
DAILY_UPLOAD_LIMIT=1
COMMENT_POLL_INTERVAL_MINUTES=60
VIDEO_MAX_DURATION_SEC=45
TTS_ENGINE=piper
DEPLOY_PROVIDER=github-pages
UPLOAD_PRIVACY=private
ALLOW_PUBLIC_UPLOAD=false
```

That produces at most two websites and one Short per day for $0 in API spend.

## Why AI calls are budgeted twice

1. **Per job** (`OPENROUTER_MAX_CALLS_PER_JOB`): idea + site + up to two repairs + script = 5–6 calls.
2. **Per day** (`MAX_AI_CALLS_PER_DAY`): a hard stop for the whole process.

Responses are cached by prompt hash in `data/ai-cache` for `AI_CACHE_TTL_HOURS`. Identical
comment→brief prompts (common when you re-run a job) cost nothing. The script prompt is deliberately
not cached, because it depends on the deployed URL.

## Why the comment filter matters for cost

Every AI call costs a rate-limit slot. The filter removes noise before it ever reaches the model:

- too short / no real words / only emoji
- all-caps shouting, repeated characters
- links, self-promotion, banned words
- near-duplicate comments (token Jaccard ≥ 0.82)
- prompt-injection patterns (`ignore previous instructions`, `system prompt`, `<|im_start|>`, …)
- comments already processed (id + SHA-256 content hash)

Only comments with real substance reach `OPENROUTER_MODELS`.

## What happens when a free service is exhausted

| Service | Behaviour |
|---|---|
| OpenRouter rate limited / down | Tries the next model, then the offline template; job continues and every artifact is flagged `offline-template` |
| YouTube read quota exhausted | Poll aborts immediately, warning stored, polling waits for the next day |
| YouTube upload bucket exhausted | Upload stage is skipped with the reason recorded; job still succeeds locally |
| GitHub Pages slow to publish | URL verification retries with backoff; job fails cleanly instead of recording an error page |
| Netlify build minutes exhausted | Deploy API returns an error; job retries with backoff, then fails |

## Things that are **not** free (be honest with yourself)

- A machine that stays awake 24/7.
- Bandwidth for viewers of generated sites (GitHub Pages/Netlify free tiers cover modest traffic).
- Your time reviewing output before publishing publicly.
- YouTube API compliance work if you need more than the default quotas.

## Quality over volume

The pipeline is intentionally rate-limited. Posting a handful of genuinely useful Shorts per week,
each backed by a real working website, will outperform automated volume — and keeps you inside
YouTube's spam and reuse-content policies. Use the daily limits as a feature, not an obstacle.
