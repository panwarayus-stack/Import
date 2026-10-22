# AI Website & Shorts Factory — production image
#
# Includes: Node 22, FFmpeg (x264/aac/libass), Chromium + runtime libraries, DejaVu fonts.
# Not included: Piper TTS (add it in a derived image via scripts/install-piper.sh).

FROM node:22-bookworm-slim AS base

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      fonts-dejavu-core \
      ca-certificates \
      curl \
      tini \
      python3 \
      make \
      g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# Chromium for Playwright (tests + real website recording).
RUN npx playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*

COPY . .

# Runtime state lives in volumes; make sure the paths exist and stay writable.
RUN mkdir -p data generated-sites generated-videos recordings recordings logs credentials \
    && chown -R node:node /app

USER node

# Fail the image build (not the deploy) if the runtime cannot work: wrong Node, missing
# dependencies, or stray Python project files that would make a builder pick Python.
RUN node scripts/preflight.js

EXPOSE 3000
VOLUME ["/app/data", "/app/generated-sites", "/app/generated-videos", "/app/recordings", "/app/credentials"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
