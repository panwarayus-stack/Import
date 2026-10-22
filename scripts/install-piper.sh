#!/usr/bin/env bash
# Install Piper TTS locally (offline narration) — no root required.
#
# Usage:
#   ./scripts/install-piper.sh                      # default voice: en_US-amy-medium
#   PIPER_VOICE=en_GB-alba-medium ./scripts/install-piper.sh
#   PIPER_DIR=/opt/piper ./scripts/install-piper.sh
#
# Then export (or put in .env):
#   PIPER_BIN=<PIPER_DIR>/piper
#   PIPER_MODEL=<PIPER_DIR>/voices/<voice>.onnx
#
# Requires: curl, tar, network access to github.com and huggingface.co.
set -euo pipefail

PIPER_DIR="${PIPER_DIR:-$PWD/vendor/piper}"
PIPER_VOICE="${PIPER_VOICE:-en_US-amy-medium}"
PIPER_VERSION="${PIPER_VERSION:-2023.11.14-2}"

case "$(uname -m)" in
  x86_64|amd64) ARCH="x86_64" ;;
  aarch64|arm64) ARCH="aarch64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

OS="linux"
if [[ "$(uname -s)" == "Darwin" ]]; then OS="macos"; fi

echo "Installing Piper ${PIPER_VERSION} (${OS}-${ARCH}) into ${PIPER_DIR}"
mkdir -p "${PIPER_DIR}/voices"

TARBALL="piper_${OS}_${ARCH}.tar.gz"
URL="https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/${TARBALL}"

if command -v curl >/dev/null 2>&1; then
  curl -fL --retry 3 -o "/tmp/${TARBALL}" "${URL}"
else
  wget -O "/tmp/${TARBALL}" "${URL}"
fi

tar -xzf "/tmp/${TARBALL}" -C "${PIPER_DIR}" --strip-components=1
rm -f "/tmp/${TARBALL}"

MODEL_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main"
LANG_PATH="${PIPER_VOICE%%-*}"          # en_US
SPEAKER_QUALITY="${PIPER_VOICE#*-}"     # amy-medium
SPEAKER="${SPEAKER_QUALITY%%-*}"        # amy
QUALITY="${SPEAKER_QUALITY##*-}"        # medium
LANG="${LANG_PATH%%_*}"                 # en
VOICE_PATH="${MODEL_BASE}/${LANG}/${LANG_PATH}/${SPEAKER}/${QUALITY}/${PIPER_VOICE}.onnx"
CONFIG_PATH="${VOICE_PATH}.json"

echo "Downloading voice ${PIPER_VOICE}"
if command -v curl >/dev/null 2>&1; then
  curl -fL --retry 3 -o "${PIPER_DIR}/voices/${PIPER_VOICE}.onnx" "${VOICE_PATH}"
  curl -fL --retry 3 -o "${PIPER_DIR}/voices/${PIPER_VOICE}.onnx.json" "${CONFIG_PATH}"
else
  wget -O "${PIPER_DIR}/voices/${PIPER_VOICE}.onnx" "${VOICE_PATH}"
  wget -O "${PIPER_DIR}/voices/${PIPER_VOICE}.onnx.json" "${CONFIG_PATH}"
fi

chmod +x "${PIPER_DIR}/piper" || true

cat <<EOF

Piper installed.

Add these to .env (adjust paths if you used a different PIPER_DIR):

  PIPER_BIN=${PIPER_DIR}/piper
  PIPER_MODEL=${PIPER_DIR}/voices/${PIPER_VOICE}.onnx
  PIPER_CONFIG=${PIPER_DIR}/voices/${PIPER_VOICE}.onnx.json
  TTS_ENGINE=piper

Smoke test:

  echo "The comment became a website." | ${PIPER_DIR}/piper \\
    --model ${PIPER_DIR}/voices/${PIPER_VOICE}.onnx --output_file /tmp/test.wav
EOF
