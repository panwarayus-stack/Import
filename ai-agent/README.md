---
title: AI Agent — Multi-Model Chat & Code (ZeroGPU)
emoji: 🤖
colorFrom: indigo
colorTo: purple
sdk: gradio
sdk_version: 5.50.0
app_file: app.py
pinned: false
short_description: Auto-routing multi-model chat & coding agent
license: apache-2.0
---

# 🤖 AI Agent — Multi-Model Chat & Code

One Gradio app that picks **the right model for every question**: 18 models across
chat, coding, reasoning, tiny-RAM and frontier cloud tiers, plus a **Universal
auto-router** that decides per message. Runs on a **free ZeroGPU Space**, on a
plain CPU box, or purely through the **HF Inference Providers cloud API**.

## What it does

| Feature | Detail |
|---|---|
| 🧭 **Universal Auto-Route** | Heuristic classifier (code / hard-code / maths / reasoning / creative / translation / summary / general, **English + Hinglish**) scores the prompt in <1 ms — no extra model call. The pick, confidence and reason are shown in the UI. |
| 💬 **Top chat models** | Qwen2.5-7B / 14B / 72B, Llama-3.1-8B, Llama-3.3-70B, Mistral-7B, Phi-3-mini |
| 💻 **Top code models** | Qwen2.5-Coder-7B / 14B / 32B, Qwen3-Coder-480B (MoE), DeepSeek-Coder-6.7B, StarCoder2-7B, CodeLlama-7B |
| 🧮 **Reasoning** | DeepSeek-R1-Distill-Qwen-7B (local) and DeepSeek-R1 (cloud) |
| 🐣 **Low RAM** | Qwen2.5-1.5B / 0.5B fit a 4GB machine with 4-bit quantisation |
| ☁️ **Cloud tier** | 70B–480B models via HF Inference Providers — need only `HF_TOKEN`, no GPU, no download |
| ⚡ **ZeroGPU** | `@spaces.GPU(duration=120)` — free GPU on Spaces, allocated **per generation**, not per session |
| 💾 **RAM-first loading** | Weights are loaded **once into CPU RAM** (outside the GPU window), then moved to the GPU only while tokens stream, and moved back afterwards. Switching models frees the old one first — one model resident at a time. |
| 🗂️ **Persistent chats** | Every conversation is saved to the bucket under `/data/chats/<hashed-ip>/`, **per client IP** (salted hash — the raw address is never stored). Survives Space restarts and rebuilds; reopen, rename, delete from the *Chats* tab. |
| 📦 **Install models from chat** | A *Models* tab, a tool, and plain language (`"install Qwen/Qwen2.5-1.5B-Instruct"`) all download a model **or dataset** into `/data/models/`. Installed models appear in the dropdown as 📦 and load like built-ins. |
| 🌐 **Internet tools** | Web search (DuckDuckGo HTML/lite → Wikipedia fallback), page reading, safe calculator (no `eval`), clock, dataset inspection. The model can call them itself and its answers cite URLs. |
| ⏩ **Fast** | Token streaming, SDPA attention, `use_cache`, left-padded inputs, thread-tuned CPU, warm-model reuse, no re-tokenising the system prompt |
| 🛟 **Resilient** | If a local load fails (OOM, gated repo, no GPU) the request transparently falls back to the cloud API; a crashed generation reports the error instead of hanging the chat |

## Persistent storage (per IP)

Everything lives in one bucket (default `/data`, as on HF Spaces persistent
storage; override with `DATA_DIR`):

```
/data/
├── chats/<ip-key>/index.json          chat list for that IP
├── chats/<ip-key>/<chat-id>.json      full transcript (atomic writes)
├── models/index.json                  installed models + datasets
├── models/<owner>__<name>/            snapshot_download() output
├── uploads/<ip-key>/<file>            attachments kept with the chat
└── meta.json
```

* `ip-key` is `sha256($DATA_IP_SALT + ip)[:20]` — stable per IP across restarts,
  not reversible, and rotating the salt forks the namespace.
* IP comes from `X-Forwarded-For` / `X-Real-IP` / `CF-Connecting-IP`, falling
  back to the socket peer — so it works behind the Spaces proxy.
* Isolation is enforced in code: IP A cannot open, rename or delete IP B's chat.
* Writes are temp-file + `os.replace`, so an interrupted save can't corrupt a
  transcript, and a corrupt index degrades to "empty" instead of crashing.
* No `/data`? It falls back to `/root/data` → `./data` → temp dir. Check the
  status line or the startup log for which root is in use.

## Tools

| Tool | What it does |
|---|---|
| `web_search` | DuckDuckGo HTML → lite → Wikipedia API fallback; returns titles, URLs, snippets |
| `fetch_page` | Downloads a page and converts it to readable text (scripts/styles stripped) |
| `calculator` | AST-based arithmetic — `sqrt`, `log`, `sin`, factorial, `pi`; `eval` is never used |
| `current_time` | Time in any IANA timezone |
| `install_model` | Downloads a HF model/dataset snapshot into the bucket |
| `list_installed` | What is already downloaded |
| `dataset_overview` | Lists a repo's files without downloading it |

Enabled by the **🔧 Use tools** checkbox in chat, or run any of them directly in
the *Tools* tab. Tool output is appended to the reply in a collapsible
*Tools used* block, so you can see exactly what the model was told.

## UI features

- Model picker (Universal + 18 models) with per-model memory / ZeroGPU / access metadata
- System-prompt presets + free-form system prompt
- Temperature, top-p, max-new-tokens controls
- **Send / Stop / Regenerate / Clear**, streaming output
- 📎 Attach a text or code file as extra context
- 🔍 “Why this model?” panel showing the router's score breakdown
- 📚 Model Explorer table, example prompts (incl. Hinglish), ⬇️ download the conversation
- Live status line: backend, loaded model, free RAM, token presence, model count

## Run locally

```bash
cd ai-agent
pip install -r requirements.txt
python app.py --host 0.0.0.0 --port 7860
```

Low-RAM machine? Use **Qwen2.5-1.5B** / **0.5B**, or just test the UI:

```bash
pip install gradio
MOCK_MODE=1 python app.py
```

With a token but no local weights, the ☁️ cloud models answer directly:

```bash
HF_TOKEN=hf_... python app.py
```

## Deploy to your Space

```bash
# 1) Revoke any token that has ever been pasted in a chat:
#    https://huggingface.co/settings/tokens  →  create a new **write** token
export HF_TOKEN=hf_your_new_token          # shell only — never commit it

# 2) Upload app.py, requirements.txt and README.md, and store the token as a
#    Space secret (so gated models + the cloud API work):
python ai-agent/deploy.py --space nezuhub/ai-agent.txt --restart \
    --secret HF_TOKEN="$HF_TOKEN"
```

The script creates the Space with **ZeroGPU** hardware if it does not exist,
uploads the files, sets the secret and restarts it. It needs outbound access to
`huggingface.co` — if the machine/network cannot reach HF it says so explicitly
instead of blaming the token.

### Deploy from GitHub instead (no local setup)

`.github/workflows/deploy-space.yml` uploads `ai-agent/` to the Space from a
GitHub runner, which can always reach `huggingface.co`:

1. Repo → **Settings → Secrets and variables → Actions** → new secret
   `HF_TOKEN` = your write token.
2. **Actions → “Deploy AI Agent to Hugging Face Space” → Run workflow.**

It also auto-deploys on pushes to `main` that touch `ai-agent/`, and refuses to
run if a token is ever found committed in the repo.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `HF_TOKEN` / `HUGGINGFACEHUB_API_TOKEN` | — | Gated models (Llama, CodeLlama) **and** the cloud API tier |
| `PRELOAD_MODEL` | — | Model id to warm into RAM on startup |
| `AUTO_PRELOAD` | `1` | On start, warm the best chat model that fits available RAM |
| `MOCK_MODE=1` | — | Simulated replies, no downloads (UI testing) |
| `DEVICE` | `auto` | `auto` \| `cuda` \| `cpu` |
| `QUANTIZATION` | `auto` | `auto` \| `4bit` \| `8bit` \| `none` |
| `PREFER_API` | `0` | Prefer cloud models over local weights (fastest cold start) |
| `ZEROGPU_DURATION` | `120` | Seconds requested per ZeroGPU allocation |
| `GENERATION_IDLE_TIMEOUT` | `180` | Abort a generation that stops producing tokens |
| `DATA_DIR` | auto | Storage root. First writable of `$DATA_DIR`, `/data`, `/root/data`, `./data`, temp |
| `DATA_IP_SALT` | `ai-agent-v1` | Salt for the IP→directory hash. Change it to start a fresh namespace |
| `WEB_TOOLS` | `1` | `0` disables search/fetch entirely |
| `MAX_TOOL_ROUNDS` | `3` | Max model-initiated tool calls per turn |
| `TOOL_HTTP_TIMEOUT` | `20` | Per-request timeout for tool HTTP calls |
| `PORT` / `HOST` | `7860` / `0.0.0.0` | Server bind |

## Tests

```bash
python -m pytest ai-agent/tests -v
```

- `test_storage.py` — per-IP isolation, atomic writes, chat id sanitisation, source parsing, install records
- `test_tools.py` — calculator safety (blocks `eval`, attribute access, huge exponents), HTML→text, tool schema, intent detection
- `test_router.py` — routing, RAM downgrades, history handling, mock streaming, tools in chat, persistence, file attachment
- `test_local_inference.py` — **real** load/stream/unload using a tiny randomly-initialised Llama, plus a regression test that a failing `generate()` cannot hang the UI

## Notes

- Never commit a token. If one leaked into a chat or a repo, revoke it and issue a new one.
- Gated repos (Llama-3.x, CodeLlama) need the licence accepted on Hugging Face **and** `HF_TOKEN` set.
