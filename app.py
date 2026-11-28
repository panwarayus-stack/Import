#!/usr/bin/env python3
"""
AI Agent — Multi-Model Chat & Code (ZeroGPU + RAM + Cloud API fallback)
=======================================================================
A single-file Gradio app for Hugging Face Spaces that also runs locally.

Highlights
----------
* 20+ top open models: Chat, Code, Reasoning, Tiny (4GB RAM) and huge
  API-served models (72B / 70B / 480B) that need no local GPU at all.
* Universal Auto-Route: one "model" that classifies every query
  (code / hard-code / math / reasoning / creative / translation /
  summary / general — English **and** Hinglish) in <1 ms and sends it
  to the best backend+model. Routing rationale is shown in the UI.
* Three execution backends, chosen automatically:
    1. ZeroGPU  — `@spaces.GPU` on free Hugging Face Spaces (no GPU cost)
    2. RAM/CPU  — quantised local inference, single-model cache
    3. HF Inference Providers — streaming cloud API when `HF_TOKEN` is set
  If local loading fails (OOM, gated, no GPU) the app transparently
  retries through the API — no more dead chats.
* Speed: streaming tokens, `sdpa`/flash-attn, `use_cache`, left padding,
  thread-tuned CPU, warm-model cache, no re-tokenising the system prompt.
* Bug fixes: load/generation locks, model freed *before* switching,
  pad/eos tokens, history truncation, gated detection, ZeroGPU preemption
  recovery, empty input, generator cleanup on cancel, streaming timeouts,
  and no deprecated Gradio kwargs.

Env vars
--------
HF_TOKEN / HUGGINGFACEHUB_API_TOKEN : token (gated models + cloud API)
MOCK_MODE=1        : force simulated replies (UI test, no downloads)
DEVICE             : auto | cuda | cpu
QUANTIZATION       : auto | 4bit | 8bit | none
PRELOAD_MODEL      : model id to warm into RAM/VRAM on startup
AUTO_PRELOAD=1     : warm the best model that fits available RAM
PREFER_API=1       : prefer cloud API over local weights when a token exists
ZEROGPU_DURATION   : seconds requested from ZeroGPU (default 120)
PORT / HOST        : server bind (default 7860 / 0.0.0.0)

Run locally
-----------
    pip install -r requirements.txt
    python app.py --host 0.0.0.0 --port 7860
    # UI + router only, no torch needed:
    pip install gradio && MOCK_MODE=1 python app.py
"""
from __future__ import annotations

import argparse
import gc
import json
import logging
import os
import re
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Generator, Iterable, List, Optional, Tuple

# Local modules (ship next to this file; also uploaded to the Space).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import storage  # noqa: E402  persistent storage: chats, models, uploads
import tools as agent_tools  # noqa: E402  web search, fetch, calc, install

# ---------------------------------------------------------------- logging ---
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("ai-agent")

# ------------------------------------------------------------------- env ----
os.environ.setdefault("GRADIO_ANALYTICS_ENABLED", "False")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

HF_TOKEN = os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACEHUB_API_TOKEN") or ""
MOCK_MODE = os.getenv("MOCK_MODE", "").strip().lower() in ("1", "true", "yes", "on")
DEVICE_PREF = os.getenv("DEVICE", "auto").strip().lower()
QUANT_PREF = os.getenv("QUANTIZATION", "auto").strip().lower()
PRELOAD_MODEL = os.getenv("PRELOAD_MODEL", "").strip()
AUTO_PRELOAD = os.getenv("AUTO_PRELOAD", "1").strip().lower() in ("1", "true", "yes", "on")
PREFER_API = os.getenv("PREFER_API", "").strip().lower() in ("1", "true", "yes", "on")
ZEROGPU_DURATION = int(os.getenv("ZEROGPU_DURATION", "120"))
WEB_TOOLS = os.getenv("WEB_TOOLS", "1").strip().lower() in ("1", "true", "yes", "on")
MAX_TOOL_ROUNDS = int(os.getenv("MAX_TOOL_ROUNDS", "3"))

# ------------------------------------------------------- optional imports ---
# ZeroGPU: `gradio.spaces` only exists on HF Spaces / recent Gradio.
# Locally we fall back to a no-op decorator so the same file runs everywhere.
try:
    from gradio import spaces as _spaces  # type: ignore

    HAS_SPACES = True
    gpu_decorator = _spaces.GPU(duration=ZEROGPU_DURATION)
    log.info("ZeroGPU (@spaces.GPU, duration=%ss) available", ZEROGPU_DURATION)
except Exception as e:  # pragma: no cover - local dev path
    HAS_SPACES = False
    log.info("ZeroGPU not available (%s) — local/CPU mode", e)

    def gpu_decorator(fn):  # type: ignore
        return fn


try:
    import torch  # type: ignore

    HAS_TORCH = True
    CUDA_AVAILABLE = torch.cuda.is_available()
    if not CUDA_AVAILABLE:
        # Faster CPU matmuls; never hurts.
        try:
            torch.set_num_threads(max(1, (os.cpu_count() or 2)))
        except Exception:
            pass
except Exception as e:  # pragma: no cover
    torch = None  # type: ignore
    HAS_TORCH = False
    CUDA_AVAILABLE = False
    log.warning("torch not installed (%s)", e)

try:
    from transformers import (  # type: ignore
        AutoModelForCausalLM,
        AutoTokenizer,
        BitsAndBytesConfig,
        TextIteratorStreamer,
    )

    HAS_TRANSFORMERS = True
except Exception as e:  # pragma: no cover
    AutoModelForCausalLM = AutoTokenizer = BitsAndBytesConfig = TextIteratorStreamer = None  # type: ignore
    HAS_TRANSFORMERS = False
    log.warning("transformers not installed (%s)", e)

try:
    from huggingface_hub import InferenceClient  # type: ignore

    HAS_HUB = True
except Exception as e:  # pragma: no cover
    InferenceClient = None  # type: ignore
    HAS_HUB = False
    log.warning("huggingface_hub not installed (%s) — cloud API fallback disabled", e)

HAS_LOCAL = HAS_TORCH and HAS_TRANSFORMERS
# Cloud API needs a token; free-tier HF Inference credits are enough for a demo.
CAN_API = HAS_HUB and bool(HF_TOKEN)
MOCK = MOCK_MODE or not (HAS_LOCAL or CAN_API)
if MOCK:
    log.warning("Running in MOCK mode — install torch+transformers or set HF_TOKEN for real answers")

try:
    import gradio as gr  # type: ignore
except Exception as e:  # pragma: no cover
    raise SystemExit(f"gradio is required: pip install gradio  ({e})")

GRADIO_MAJOR = int(str(gr.__version__).split(".")[0]) if getattr(gr, "__version__", None) else 5

# ------------------------------------------------------------- registry -----
# `ram_gb`  : rough RAM/VRAM for fp16 weights (CPU uses 4-bit for big ones)
# `api`     : served by HF Inference Providers (no local GPU needed)
# `zerogpu` : known-good with @spaces.GPU
# `gated`   : needs HF_TOKEN + accepted licence for *local* download
@dataclass(frozen=True)
class ModelInfo:
    id: str
    label: str
    category: str  # chat | code | reasoning | tiny | api
    params: str
    ram_gb: float
    zerogpu: bool
    gated: bool
    description: str
    best_for: str
    max_context: int = 8192
    system_prompt: str = "You are a helpful AI assistant."
    api: bool = False
    emoji: str = "🤖"


CODE_SYS = (
    "You are an expert software engineer. Write clean, correct, well-commented code. "
    "Explain briefly, then give code in fenced blocks with the language name. "
    "If the request contains a bug, state the root cause first."
)
CHAT_SYS = "You are a helpful, friendly AI assistant. Answer clearly and concisely."
REASON_SYS = (
    "You are a careful reasoning assistant. Think step by step, then give a clear "
    "final answer on its own line."
)

MODEL_REGISTRY: Dict[str, ModelInfo] = {}


def _add(info: ModelInfo) -> None:
    MODEL_REGISTRY[info.id] = info


# ---- Chat (top local picks) ----
_add(ModelInfo(
    id="Qwen/Qwen2.5-7B-Instruct", label="Qwen2.5-7B-Instruct — Best Chat ⭐",
    category="chat", params="7B", ram_gb=15, zerogpu=True, gated=False,
    description="Top open chat model: fast, strong instruction following, excellent multilingual (incl. Hindi).",
    best_for="General chat, Q&A, summarisation, translation, writing",
    max_context=32768, system_prompt=CHAT_SYS, emoji="💬",
))
_add(ModelInfo(
    id="Qwen/Qwen2.5-14B-Instruct", label="Qwen2.5-14B-Instruct — Chat (large)",
    category="chat", params="14B", ram_gb=28, zerogpu=True, gated=False,
    description="Larger Qwen2.5 — noticeably better reasoning and long-form answers.",
    best_for="Complex questions, long documents, detailed explanations",
    max_context=32768, system_prompt=CHAT_SYS, emoji="💬",
))
_add(ModelInfo(
    id="meta-llama/Llama-3.1-8B-Instruct", label="Llama-3.1-8B-Instruct — Meta (gated)",
    category="chat", params="8B", ram_gb=16, zerogpu=True, gated=True,
    description="Meta Llama 3.1 8B — very strong general assistant, 128k context.",
    best_for="Chat, reasoning, tool use, multilingual",
    max_context=131072, system_prompt=CHAT_SYS, emoji="🦙",
))
_add(ModelInfo(
    id="mistralai/Mistral-7B-Instruct-v0.3", label="Mistral-7B-Instruct-v0.3 — Fast Chat",
    category="chat", params="7B", ram_gb=15, zerogpu=True, gated=False,
    description="Mistral 7B — fast, efficient, great for everyday chat.",
    best_for="Fast chat, Q&A, summarisation",
    max_context=32768, system_prompt=CHAT_SYS, emoji="🌪️",
))
_add(ModelInfo(
    id="microsoft/Phi-3-mini-4k-instruct", label="Phi-3-mini-4k — Small & Fast (CPU)",
    category="chat", params="3.8B", ram_gb=8, zerogpu=True, gated=False,
    description="Microsoft Phi-3 mini — small enough for CPU RAM with 4-bit quantisation.",
    best_for="Low-RAM machines, quick answers",
    max_context=4096, system_prompt=CHAT_SYS, emoji="🍃",
))

# ---- Code (top local picks) ----
_add(ModelInfo(
    id="Qwen/Qwen2.5-Coder-7B-Instruct", label="Qwen2.5-Coder-7B-Instruct — Best Code ⭐",
    category="code", params="7B", ram_gb=15, zerogpu=True, gated=False,
    description="State-of-the-art open coder — beats much larger models on code benchmarks.",
    best_for="Writing, debugging, refactoring code in 40+ languages",
    max_context=32768, system_prompt=CODE_SYS, emoji="💻",
))
_add(ModelInfo(
    id="Qwen/Qwen2.5-Coder-14B-Instruct", label="Qwen2.5-Coder-14B-Instruct — Code (large)",
    category="code", params="14B", ram_gb=28, zerogpu=True, gated=False,
    description="Larger coder — better for full apps, complex debugging and long files.",
    best_for="Full applications, complex algorithms, large refactors",
    max_context=32768, system_prompt=CODE_SYS, emoji="💻",
))
_add(ModelInfo(
    id="Qwen/Qwen2.5-Coder-32B-Instruct", label="Qwen2.5-Coder-32B-Instruct — Frontier (ZeroGPU)",
    category="code", params="32B", ram_gb=65, zerogpu=True, gated=False,
    description="Frontier open coder. Practical only on ZeroGPU or via the cloud API.",
    best_for="Hardest coding tasks, architecture, large codebases",
    max_context=32768, system_prompt=CODE_SYS, emoji="🧠",
))
_add(ModelInfo(
    id="deepseek-ai/deepseek-coder-6.7b-instruct", label="DeepSeek-Coder-6.7B — Code",
    category="code", params="6.7B", ram_gb=14, zerogpu=True, gated=False,
    description="DeepSeek coder — strong at completion and fill-in-the-middle tasks.",
    best_for="Code completion, debugging, Python/C++/Java",
    max_context=16384, system_prompt=CODE_SYS, emoji="🐋",
))
_add(ModelInfo(
    id="bigcode/starcoder2-7b", label="StarCoder2-7B — Code (BigCode)",
    category="code", params="7B", ram_gb=15, zerogpu=True, gated=False,
    description="Trained on The Stack v2 — 600+ programming languages.",
    best_for="Code generation across many languages, completion",
    max_context=16384, system_prompt=CODE_SYS, emoji="⭐",
))
_add(ModelInfo(
    id="meta-llama/CodeLlama-7b-Instruct-hf", label="CodeLlama-7B-Instruct — Meta (gated)",
    category="code", params="7B", ram_gb=15, zerogpu=True, gated=True,
    description="Meta CodeLlama 7B instruct.",
    best_for="Code chat, debugging, Python/Java/C++",
    max_context=4096, system_prompt=CODE_SYS, emoji="🦙",
))

# ---- Reasoning ----
_add(ModelInfo(
    id="deepseek-ai/DeepSeek-R1-Distill-Qwen-7B", label="DeepSeek-R1-Distill-Qwen-7B — Reasoning",
    category="reasoning", params="7B", ram_gb=15, zerogpu=True, gated=False,
    description="Distilled DeepSeek-R1 — strong at maths, logic and multi-step reasoning; shows its thinking.",
    best_for="Maths, logic puzzles, proofs, step-by-step reasoning",
    max_context=32768, system_prompt=REASON_SYS, emoji="🧮",
))

# ---- Tiny (fits ~4GB RAM) ----
_add(ModelInfo(
    id="Qwen/Qwen2.5-1.5B-Instruct", label="Qwen2.5-1.5B-Instruct — Small (fits 4GB RAM)",
    category="tiny", params="1.5B", ram_gb=2.5, zerogpu=True, gated=False,
    description="Best quality that still fits a 4GB machine with 4-bit quantisation.",
    best_for="Low-RAM machines, offline chat",
    max_context=32768, system_prompt=CHAT_SYS, emoji="🐣",
))
_add(ModelInfo(
    id="Qwen/Qwen2.5-0.5B-Instruct", label="Qwen2.5-0.5B-Instruct — Tiny (fits 1GB RAM)",
    category="tiny", params="0.5B", ram_gb=1.2, zerogpu=True, gated=False,
    description="Tiny Qwen — runs in ~1GB. Weak but instant; ideal for testing.",
    best_for="Testing, very low RAM, quick demos",
    max_context=32768, system_prompt=CHAT_SYS, emoji="🐜",
))

# ---- Cloud API (no GPU, no RAM — needs HF_TOKEN with inference credits) ----
_add(ModelInfo(
    id="Qwen/Qwen2.5-72B-Instruct", label="Qwen2.5-72B-Instruct — Cloud API (frontier chat)",
    category="chat", params="72B", ram_gb=0.0, zerogpu=False, gated=False,
    description="Frontier-quality chat served by HF Inference Providers — no GPU needed.",
    best_for="Best-quality chat, long context, multilingual",
    max_context=32768, system_prompt=CHAT_SYS, api=True, emoji="☁️",
))
_add(ModelInfo(
    id="meta-llama/Llama-3.3-70B-Instruct", label="Llama-3.3-70B-Instruct — Cloud API",
    category="chat", params="70B", ram_gb=0.0, zerogpu=False, gated=True,
    description="Meta's 70B flagship via HF Inference Providers (model licence required).",
    best_for="High-quality chat, reasoning, multilingual",
    max_context=131072, system_prompt=CHAT_SYS, api=True, emoji="☁️",
))
_add(ModelInfo(
    id="Qwen/Qwen3-Coder-480B-A35B-Instruct", label="Qwen3-Coder-480B (MoE) — Cloud API",
    category="code", params="480B MoE", ram_gb=0.0, zerogpu=False, gated=False,
    description="Huge MoE coding model served in the cloud — the strongest coder available here.",
    best_for="Hardest engineering tasks, agents, large refactors",
    max_context=131072, system_prompt=CODE_SYS, api=True, emoji="☁️",
))
_add(ModelInfo(
    id="deepseek-ai/DeepSeek-R1", label="DeepSeek-R1 — Cloud API (frontier reasoning)",
    category="reasoning", params="671B MoE", ram_gb=0.0, zerogpu=False, gated=False,
    description="Full R1 reasoning model via the cloud — best maths/logic quality.",
    best_for="Hard maths, proofs, deep reasoning",
    max_context=65536, system_prompt=REASON_SYS, api=True, emoji="☁️",
))

UNIVERSAL_ID = "universal"


# ------------------------------------------------- local (downloaded) models --
def refresh_local_models() -> int:
    """Expose /data/models snapshots in the model dropdown.

    Each installed model becomes ``local/<name>`` in MODEL_REGISTRY so it can be
    selected, loaded and routed like any built-in model. Idempotent.
    """
    added = 0
    try:
        items = storage.installed_models("model")
    except Exception as e:  # noqa: BLE001
        log.warning("could not read installed models: %s", e)
        return 0
    for it in items:
        if it.get("status") != "ready":
            continue
        mid, path = it.get("id", ""), it.get("path", "")
        if not mid or not path or not os.path.isdir(path):
            continue
        if mid in MODEL_REGISTRY:
            continue
        name = it.get("source", mid).split("/")[-1]
        MODEL_REGISTRY[mid] = ModelInfo(
            id=mid,
            label=f"{name} — local ({storage.human_bytes(it.get('size_bytes', 0))})",
            category="chat",
            params="?",
            ram_gb=round(max(0.5, it.get("size_bytes", 0) / 1e9), 1),
            zerogpu=True,
            gated=False,
            description=f"Downloaded from {it.get('source')} into {path}",
            best_for="Locally installed model",
            system_prompt=CHAT_SYS,
            emoji="📦",
        )
        added += 1
    if added:
        log.info("registered %s locally installed model(s)", added)
    return added


def local_model_choices() -> List[Tuple[str, str]]:
    return [(f"{m.emoji} {m.label}", m.id)
            for m in MODEL_REGISTRY.values() if m.id.startswith("local/")]


def all_model_choices() -> List[Tuple[str, str]]:
    base = [("🧭 Universal — Auto-Route to the best model (recommended)", UNIVERSAL_ID)]
    base += [(f"{m.emoji} {m.label}", m.id) for m in MODEL_REGISTRY.values()
             if not m.id.startswith("local/")]
    base += local_model_choices()
    return base


try:
    refresh_local_models()
except Exception as _e:  # noqa: BLE001
    log.warning("local model scan failed: %s", _e)

# Best model per category (local weights). Used by the router.
ROUTER_DEFAULTS: Dict[str, str] = {
    "code": "Qwen/Qwen2.5-Coder-7B-Instruct",
    "code_hard": "Qwen/Qwen2.5-Coder-14B-Instruct",
    "chat": "Qwen/Qwen2.5-7B-Instruct",
    "reasoning": "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B",
    "creative": "Qwen/Qwen2.5-7B-Instruct",
    "translation": "Qwen/Qwen2.5-7B-Instruct",
    "summarisation": "Qwen/Qwen2.5-7B-Instruct",
    "general": "Qwen/Qwen2.5-7B-Instruct",
}
# Upgrades used when the cloud API is available and the query is hard.
ROUTER_API_DEFAULTS: Dict[str, str] = {
    "code": "Qwen/Qwen3-Coder-480B-A35B-Instruct",
    "code_hard": "Qwen/Qwen3-Coder-480B-A35B-Instruct",
    "reasoning": "deepseek-ai/DeepSeek-R1",
    "chat": "Qwen/Qwen2.5-72B-Instruct",
    "general": "Qwen/Qwen2.5-72B-Instruct",
}

# --------------------------------------------------------------- router -----
@dataclass
class RoutingDecision:
    model_id: str
    category: str
    confidence: float
    reason: str
    scores: Dict[str, float] = field(default_factory=dict)
    backend: str = "local"


_CODE_PATTERNS = [
    (r"\b(function|def |class |import |from .+ import|return |async |await |lambda)\b", 2.0),
    (r"\b(python|javascript|typescript|java|c\+\+|rust|golang|sql|html|css|bash|shell|api|sdk|framework|library|docker|kubernetes|react|node|django|flask|fastapi)\b", 1.5),
    (r"\b(code|coding|program|script|bug|debug|error|traceback|exception|stack ?trace|compile|runtime|refactor|algorithm|regex|database|endpoint|deploy|unit test)\b", 1.5),
    (r"```", 3.0),
    (r"\b(write|create|build|implement|fix|explain).{0,40}\b(code|function|script|program|app|website|class|query|api)\b", 2.0),
    (r"\.(py|js|ts|jsx|tsx|java|cpp|rs|go|sql|html|css|json|yaml|sh)\b", 1.5),
    (r"\b(code likho|code likh|program likho|bug fix)\b", 2.0),  # Hinglish
]
_REASONING_PATTERNS = [
    (r"\b(solve|calculate|compute|equation|integral|derivative|probability|statistics|geometry|algebra|math|maths)\b", 2.0),
    (r"\b(prove|proof|logic|logical|reason|reasoning|step by step|chain of thought|puzzle|riddle|deduce)\b", 2.0),
    (r"\b(why|how does|explain).{0,30}\b(work|happen|cause)\b", 1.0),
    (r"[0-9]\s*[-+*/^]\s*[0-9]", 1.5),
]
_CREATIVE_PATTERNS = [
    (r"\b(story|poem|poetry|song|lyrics|essay|blog|article|email|letter|resume|cv|cover letter|speech|novel|fiction|shayari|kahani)\b", 2.0),
    (r"\b(write|draft|compose|create).{0,30}\b(story|poem|essay|blog|email|letter|post|content)\b", 2.0),
]
_TRANSLATION_PATTERNS = [
    (r"\b(translate|translation|in (hindi|spanish|french|german|chinese|japanese|arabic|english|urdu|tamil))\b", 2.5),
    (r"\b(anuvad|hindi mein|english mein)\b", 2.0),
]
_SUMMARY_PATTERNS = [
    (r"\b(summarise|summarize|summary|tl;dr|tldr|key points|main idea|overview of|shorten this)\b", 2.5),
]


def _score(text: str, patterns: List[Tuple[str, float]]) -> float:
    t = text.lower()
    return sum(w for pat, w in patterns if re.search(pat, t))


def route_query(text: str, ram_gb: Optional[float] = None, prefer_api: bool = False) -> RoutingDecision:
    """Pick the best model for a query. Pure heuristic — <1 ms, no model needed.

    Safety rules (bug fixes over naive routers):
      * never routes a huge task to a tiny model
      * skips gated models when no token is configured
      * downgrades to a model that fits the available RAM
      * only uses cloud-API upgrades when a token exists
    """
    text = (text or "").strip()
    if not text:
        return RoutingDecision(ROUTER_DEFAULTS["general"], "general", 0.0, "Empty query — default chat model.")

    scores = {
        "code": _score(text, _CODE_PATTERNS),
        "reasoning": _score(text, _REASONING_PATTERNS),
        "creative": _score(text, _CREATIVE_PATTERNS),
        "translation": _score(text, _TRANSLATION_PATTERNS),
        "summarisation": _score(text, _SUMMARY_PATTERNS),
    }
    is_long = len(text) > 1500
    is_very_long = len(text) > 4000
    if is_long:
        scores["code"] += 0.5

    best_cat = max(scores, key=lambda k: scores[k])
    best_score = scores[best_cat]

    if best_score <= 0:
        category, model_id = "general", ROUTER_DEFAULTS["general"]
        confidence, reason = 0.55, "No strong signal — general chat model."
    elif best_cat == "code":
        category = "code_hard" if (is_very_long or len(text) > 2500) else "code"
        model_id = ROUTER_DEFAULTS[category]
        confidence = min(0.97, 0.6 + best_score * 0.08)
        reason = f"Code signals detected (score {best_score:.1f})."
    elif best_cat == "reasoning":
        category, model_id = "reasoning", ROUTER_DEFAULTS["reasoning"]
        confidence = min(0.95, 0.6 + best_score * 0.08)
        reason = f"Reasoning/maths signals (score {best_score:.1f})."
    else:
        category = best_cat
        model_id = ROUTER_DEFAULTS.get(best_cat, ROUTER_DEFAULTS["general"])
        confidence = min(0.95, 0.6 + best_score * 0.08)
        reason = f"{best_cat.capitalize()} signals (score {best_score:.1f})."

    # --- Cloud upgrade for genuinely hard work ---
    if prefer_api and CAN_API and (category in ("code_hard", "reasoning") or is_very_long):
        api_model = ROUTER_API_DEFAULTS.get(category)
        if api_model in MODEL_REGISTRY:
            model_id = api_model
            reason += f" Upgraded to the cloud API ({MODEL_REGISTRY[api_model].params}) for a harder task."

    # --- Safety downgrades ---
    info = MODEL_REGISTRY.get(model_id)
    if info and info.gated and not HF_TOKEN:
        model_id = ROUTER_DEFAULTS["general"]
        info = MODEL_REGISTRY[model_id]
        reason += " (gated model skipped — no HF_TOKEN set)"
    # Fit rule: 4-bit loading needs roughly ram_gb/4 of RAM, and we keep ~45%
    # of the box free — so a model fits when ram_gb <= available * ~1.6.
    if (ram_gb is not None and info and not info.api and info.ram_gb > ram_gb * 1.6
            and CAN_API and not prefer_api and category in ROUTER_API_DEFAULTS
            and not MOCK):
        # Too big for this machine, but the cloud can serve it — no downgrade.
        model_id = ROUTER_API_DEFAULTS[category]
        info = MODEL_REGISTRY[model_id]
        reason += f" Too large for {ram_gb:.1f}GB RAM — routed to the cloud API ({info.params})."
    elif ram_gb is not None and info and not info.api and info.ram_gb > ram_gb * 1.6:
        fitting = [
            m for m in MODEL_REGISTRY.values()
            if m.ram_gb <= ram_gb * 1.6 and not m.gated and not m.api
        ]
        if fitting:
            # Same-category candidates only when they are in the same quality
            # class (never a reasoning model for a coding job, etc.).
            same_cat = [m for m in fitting if m.category == info.category]
            top_ram = max(m.ram_gb for m in fitting)
            good_enough = [m for m in same_cat if m.ram_gb >= top_ram * 0.5]
            pick = max(good_enough or same_cat or fitting, key=lambda m: m.ram_gb)
            model_id = pick.id
            info = pick
            reason += f" Downgraded to {pick.label.split(' — ')[0]} to fit {ram_gb:.1f}GB RAM."

    backend = "api" if MODEL_REGISTRY.get(model_id, info) and MODEL_REGISTRY[model_id].api else "local"
    return RoutingDecision(
        model_id=model_id, category=category, confidence=round(confidence, 2),
        reason=reason, scores={k: round(v, 1) for k, v in scores.items()}, backend=backend,
    )


# ---------------------------------------------------------- model manager ---
def get_ram_gb() -> float:
    """Available RAM in GB (psutil if present, else /proc/meminfo)."""
    try:
        import psutil  # type: ignore

        return psutil.virtual_memory().available / (1024**3)
    except Exception:
        try:
            with open("/proc/meminfo") as f:
                for line in f:
                    if line.startswith("MemAvailable:"):
                        return int(line.split()[1]) / (1024**2)
        except Exception:
            pass
    return 4.0


def _human_gb(x: float) -> str:
    return f"{x:.1f}GB"


class ModelManager:
    """Single-model cache: exactly one model in RAM at a time.

    Design notes
    ------------
    * `_load_lock`   : serialises (un)loading — no two requests racing to load
    * `_gen_lock`    : serialises generation on the shared model/tokenizer
    * old weights are freed *before* the new ones are read (no OOM spike)
    * pad/eos tokens are set correctly (no garbled output / infinite loops)
    * on ZeroGPU the model lives in RAM and is moved to the GPU per request;
      if the GPU was preempted the move is retried / reverted safely
    """

    def __init__(self) -> None:
        self._load_lock = threading.Lock()
        self._gen_lock = threading.Lock()
        self.model = None
        self.tokenizer = None
        self.model_id: Optional[str] = None
        self.device: str = "cpu"
        self.load_seconds: float = 0.0
        self.on_gpu: bool = False
        self.tokens: int = 0
        self.last_tok_s: float = 0.0

    # -- lifecycle ---------------------------------------------------------
    def unload(self) -> None:
        with self._load_lock:
            self._unload_locked()

    def _unload_locked(self) -> None:
        if self.model is None:
            self.model_id = None
            return
        try:
            del self.model
        except Exception:
            pass
        self.model = None
        self.tokenizer = None
        self.model_id = None
        self.on_gpu = False
        gc.collect()
        if HAS_TORCH and torch is not None and torch.cuda.is_available():
            try:
                torch.cuda.empty_cache()
            except Exception:
                pass
        log.info("Model unloaded, memory freed")

    def is_loaded(self, model_id: str) -> bool:
        return self.model_id == model_id and self.model is not None

    # -- loading -----------------------------------------------------------
    def load(self, model_id: str, want_gpu: bool = False) -> Tuple[bool, str]:
        if MOCK:
            return False, "MOCK mode — no real model loaded."
        if not HAS_LOCAL:
            return False, "Local inference needs torch + transformers (or use a ☁️ cloud API model)."
        info = MODEL_REGISTRY.get(model_id)
        if info is None:
            return False, f"Unknown model: {model_id}"
        if info.api:
            return False, f"{model_id} is served by the cloud API — no local loading needed."
        if info.gated and not HF_TOKEN:
            return False, (
                f"⚠️ {model_id} is gated. Accept the licence on Hugging Face and set "
                "HF_TOKEN (Space → Settings → Variables and secrets)."
            )

        with self._load_lock:
            if self.is_loaded(model_id):
                if want_gpu and not self.on_gpu:
                    ok, msg = self._to_gpu_locked()
                    if not ok:
                        return False, msg
                return True, f"Already loaded: {model_id} ({self.device})"

            # Free the old model *first*.
            self._unload_locked()
            t0 = time.time()
            try:
                self._load_locked(model_id, info, want_gpu=want_gpu)
                self.load_seconds = time.time() - t0
                return True, (
                    f"✅ Loaded {model_id} on {self.device} in {self.load_seconds:.1f}s "
                    f"(~{_human_gb(info.ram_gb)}, {info.params})"
                )
            except Exception as e:  # noqa: BLE001
                self._unload_locked()
                log.exception("Load failed for %s", model_id)
                err = str(e)
                hint = ""
                if "out of memory" in err.lower() or "memory" in err.lower():
                    hint = " — out of memory. Try Qwen2.5-1.5B or a ☁️ cloud API model."
                elif any(k in err.lower() for k in ("gated", "401", "403", "unauthorized")):
                    hint = " — gated/unauthorised. Check HF_TOKEN and licence acceptance."
                return False, f"❌ Failed to load {model_id}: {err}{hint}"

    def _pick_quant(self, info: ModelInfo) -> str:
        quant = QUANT_PREF
        if quant != "auto":
            return quant
        if CUDA_AVAILABLE and DEVICE_PREF != "cpu":
            return "none"  # fp16 on GPU is fastest
        if HAS_SPACES:
            # ZeroGPU: weights wait in RAM as fp16 and are moved onto the GPU
            # inside @spaces.GPU. Quantised weights cannot be moved, so skip it.
            return "none"
        # Plain CPU: quantise when the model would not comfortably fit in RAM.
        return "4bit" if info.ram_gb > max(2.0, get_ram_gb() * 0.4) else "none"

    def _load_locked(self, model_id: str, info: ModelInfo, want_gpu: bool = False) -> None:
        if not HAS_LOCAL:
            raise RuntimeError("torch/transformers not installed")
        token = HF_TOKEN or None

        self.tokenizer = AutoTokenizer.from_pretrained(model_id, token=token)
        # Left padding + pad==eos: required for correct batched/streamed decoding.
        if self.tokenizer.pad_token is None:
            self.tokenizer.pad_token = self.tokenizer.eos_token
        try:
            self.tokenizer.padding_side = "left"
        except Exception:
            pass

        use_cuda = DEVICE_PREF != "cpu" and (CUDA_AVAILABLE or want_gpu) and HAS_TORCH
        quant = "none" if use_cuda else self._pick_quant(info)

        kwargs: Dict[str, Any] = dict(token=token, low_cpu_mem_usage=True)
        if use_cuda:
            kwargs["device_map"] = "auto"
            kwargs["dtype"] = torch.float16
            # sdpa is universally available; flash-attn only if installed.
            attn_order = ["sdpa", "eager"]
            if os.getenv("USE_FLASH_ATTN", "").lower() in ("1", "true"):
                attn_order.insert(0, "flash_attention_2")
        else:
            attn_order = ["sdpa", "eager"]
            if HAS_SPACES and quant == "none" and HAS_TORCH:
                # fp16 halves RAM and can be moved to the GPU without a cast;
                # plain CPU stays fp32 (fp16 matmul is slow there).
                kwargs["dtype"] = torch.float16

        if quant in ("4bit", "8bit") and BitsAndBytesConfig is not None:
            bnb = dict(
                load_in_4bit=(quant == "4bit"),
                load_in_8bit=(quant == "8bit"),
                bnb_4bit_quant_type="nf4",
                bnb_4bit_use_double_quant=True,
            )
            if HAS_TORCH:
                bnb["bnb_4bit_compute_dtype"] = torch.float16
            kwargs["quantization_config"] = BitsAndBytesConfig(**bnb)

        last_err: Optional[Exception] = None
        for attn in attn_order:
            try:
                self.model = AutoModelForCausalLM.from_pretrained(
                    model_id, attn_implementation=attn, **kwargs
                )
                break
            except Exception as e:  # noqa: BLE001
                last_err = e
                log.warning("Load with attn=%s failed: %s", attn, e)
                # A quantisation failure will not be fixed by another attn backend.
                if "quantiz" in str(e).lower() or "bitsandbytes" in str(e).lower():
                    kwargs.pop("quantization_config", None)
                    if not use_cuda:
                        kwargs["dtype"] = torch.float32
        if self.model is None:
            raise RuntimeError(str(last_err))

        self.model.eval()
        try:
            self.model.generation_config.pad_token_id = self.tokenizer.pad_token_id
            self.model.generation_config.eos_token_id = self.tokenizer.eos_token_id
        except Exception:
            pass
        self.model_id = model_id
        self.device = "cuda" if use_cuda else "cpu"
        self.on_gpu = use_cuda and CUDA_AVAILABLE

    def _to_gpu_locked(self) -> Tuple[bool, str]:
        """Move an already-RAM-resident model onto the GPU (ZeroGPU per request)."""
        if not HAS_TORCH or torch is None:
            return False, "torch unavailable"
        if self.model is None:
            return False, "No model loaded."
        if getattr(self.model, "is_quantized", False):
            return False, (
                "Weights are CPU-quantised and cannot be moved to the GPU — "
                "generating on CPU. Set QUANTIZATION=none to use the GPU."
            )
        try:
            if not torch.cuda.is_available():
                return False, "No CUDA device available."
            self.model.to("cuda")
            self.device = "cuda"
            self.on_gpu = True
            return True, "Moved model to GPU."
        except Exception as e:  # noqa: BLE001
            log.warning("Could not move model to GPU: %s", e)
            try:
                self.model.to("cpu")
            except Exception:
                pass
            self.device = "cpu"
            self.on_gpu = False
            return False, f"GPU unavailable ({e}) — running on CPU."

    def _back_to_cpu(self) -> None:
        """Hand the GPU back at the end of a ZeroGPU window (weights stay in RAM)."""
        if not (HAS_TORCH and torch is not None) or self.model is None or not self.on_gpu:
            return
        try:
            self.model.to("cpu")
            self.device = "cpu"
            self.on_gpu = False
            log.info("Model moved back to RAM, VRAM released")
        except Exception:
            pass
        try:
            torch.cuda.empty_cache()
        except Exception:
            pass

    def ensure_device(self, want_gpu: bool) -> Tuple[bool, str]:
        """Verify the cached weights are on a usable device (ZeroGPU can preempt)."""
        with self._load_lock:
            if self.model is None:
                return False, "No model loaded."
            if not want_gpu:
                return True, "CPU"
            if not self.on_gpu:
                return self._to_gpu_locked()
            if not (HAS_TORCH and torch is not None and torch.cuda.is_available()):
                # GPU vanished mid-session (ZeroGPU preemption) — fall back to RAM.
                return self._to_gpu_locked()
            try:  # cheap sanity check that CUDA still works
                torch.zeros(1, device="cuda")
                return True, "cuda"
            except Exception:  # noqa: BLE001
                self.on_gpu = False
                self.device = "cpu"
                try:
                    self.model.to("cpu")
                except Exception:
                    pass
                return False, "GPU preempted — continuing on CPU."

    # -- generation --------------------------------------------------------
    def generate_stream(
        self,
        messages: List[Dict[str, str]],
        max_new_tokens: int = 512,
        temperature: float = 0.7,
        top_p: float = 0.9,
        repetition_penalty: float = 1.05,
    ) -> Generator[str, None, None]:
        """Yield the whole reply progressively (token streaming)."""
        if self.model is None or self.tokenizer is None:
            yield "⚠️ No model loaded."
            return
        tokenizer, model = self.tokenizer, self.model  # snapshot: unload-safe

        try:
            prompt = tokenizer.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True
            )
        except Exception:
            prompt = "\n".join(f"{m['role']}: {m['content']}" for m in messages) + "\nassistant:"

        try:
            inputs = tokenizer(prompt, return_tensors="pt", truncation=True,
                               max_length=max(512, int(getattr(model.config, "max_position_embeddings", 8192)) - max_new_tokens))
        except Exception:
            inputs = tokenizer(prompt, return_tensors="pt")
        try:
            device = next(model.parameters()).device
        except Exception:
            device = "cpu"
        # Keep only tensors the model actually accepts. `token_type_ids` from
        # some tokenizers makes generate() raise, which used to hang the UI.
        accepted = set(getattr(model, "forward", lambda **kw: None).__code__.co_varnames)
        inputs = {
            k: (v.to(device) if hasattr(v, "to") else v)
            for k, v in inputs.items()
            if k in ("input_ids", "attention_mask", "position_ids") or k in accepted
        }
        if "input_ids" not in inputs:
            yield "⚠️ Could not tokenise the prompt."
            return

        # Short per-read timeout: we poll instead of blocking for minutes, so a
        # crashed generation surfaces immediately instead of hanging the chat.
        streamer = TextIteratorStreamer(
            tokenizer, skip_prompt=True, skip_special_tokens=True, timeout=2.0
        )
        do_sample = temperature > 0.01
        gen_kwargs: Dict[str, Any] = dict(
            **inputs,
            streamer=streamer,
            max_new_tokens=max(16, min(int(max_new_tokens), 4096)),
            do_sample=do_sample,
            repetition_penalty=float(repetition_penalty),
            use_cache=True,
            pad_token_id=tokenizer.pad_token_id or tokenizer.eos_token_id,
        )
        if do_sample:  # greedy decoding ignores sampling params — don't pass them
            gen_kwargs["temperature"] = max(0.01, float(temperature))
            gen_kwargs["top_p"] = float(min(max(top_p, 0.05), 1.0))

        err: List[BaseException] = []

        def _run() -> None:
            try:
                model.generate(**gen_kwargs)
            except BaseException as e:  # noqa: BLE001
                err.append(e)

        with self._gen_lock:  # one generation at a time on the shared model
            t0 = time.time()
            thread = threading.Thread(target=_run, daemon=True)
            thread.start()
            buf = ""
            last_token_at = time.time()
            idle_limit = float(os.getenv("GENERATION_IDLE_TIMEOUT", "180"))
            while True:
                try:
                    chunk = next(streamer)
                except StopIteration:
                    break
                except Exception:  # noqa: BLE001  (queue.Empty → still generating?)
                    if err:  # generation crashed — report instead of hanging
                        break
                    if not thread.is_alive():  # finished without a sentinel
                        break
                    if time.time() - last_token_at > idle_limit:
                        err.append(TimeoutError(f"no tokens for {idle_limit:.0f}s"))
                        break
                    continue
                last_token_at = time.time()
                buf += chunk
                yield buf
            thread.join(timeout=10)
            elapsed = max(1e-6, time.time() - t0)
            out_tokens = max(1, len(buf) // 4)
            self.tokens += out_tokens
            self.last_tok_s = out_tokens / elapsed
        if err:
            log.warning("Generation error: %s", err[0])
            if buf:
                yield buf
            else:
                yield f"⚠️ Generation error: {err[0]}"


MANAGER = ModelManager()

# ------------------------------------------------------- cloud API backend --
_API_LOCK = threading.Lock()


def api_stream(
    model_id: str,
    messages: List[Dict[str, str]],
    max_tokens: int = 512,
    temperature: float = 0.7,
    top_p: float = 0.9,
) -> Generator[str, None, None]:
    """Stream a reply from HF Inference Providers (works with zero GPU)."""
    if not CAN_API:
        yield "⚠️ Cloud API needs an HF_TOKEN with inference access."
        return
    client = InferenceClient(model=model_id, token=HF_TOKEN)
    try:
        stream = client.chat_completion(
            messages=messages,
            max_tokens=max(16, min(int(max_tokens), 4096)),
            temperature=max(0.01, float(temperature)),
            top_p=float(min(max(top_p, 0.05), 1.0)),
            stream=True,
        )
    except Exception as e:  # noqa: BLE001
        yield f"⚠️ Cloud API error for {model_id}: {e}\n\nTry another model, or set HF_TOKEN with inference credits."
        return
    buf = ""
    try:
        for chunk in stream:
            try:
                delta = chunk.choices[0].delta.content or ""
            except Exception:
                delta = ""
            if delta:
                buf += delta
                yield buf
    except Exception as e:  # noqa: BLE001
        yield (buf + f"\n\n⚠️ Streaming interrupted: {e}") if buf else f"⚠️ Cloud API error: {e}"
        return
    if not buf:
        yield "⚠️ The API returned an empty reply. Try another model."


def available_backend(model_id: str, allow_local: bool = True) -> str:
    """'local' | 'api' | 'mock' — what will actually run this model."""
    info = MODEL_REGISTRY.get(model_id)
    if info is not None and info.api:
        return "api" if CAN_API else ("mock" if MOCK else "mock")
    if MOCK:
        return "mock"
    if allow_local and HAS_LOCAL and info is not None:
        return "local"
    if CAN_API:
        return "api"  # graceful fallback for CPU-only Spaces with a token
    return "mock"


# ------------------------------------------------------------- mock mode ----
def mock_reply(prompt: str, category: str, model_id: str) -> Generator[str, None, None]:
    """Simulated streaming reply so the UI/router can be tested without torch."""
    if category in ("code", "code_hard"):
        body = (
            f"**[MOCK — {model_id}]**\n\n"
            "Here is a clean starter implementation:\n\n"
            "```python\n"
            "def solve(data):\n"
            '    """TODO: implement your logic here."""\n'
            "    return [item for item in data if item is not None]\n\n\n"
            'if __name__ == "__main__":\n'
            "    print(solve([1, None, 3]))\n"
            "```\n\n"
            "Install `torch` + `transformers` (see `requirements.txt`) or add a "
            "`HF_TOKEN` to get real answers."
        )
    elif category == "reasoning":
        body = (
            f"**[MOCK — {model_id}]**\n\n"
            "Step 1 — Restate the problem.\nStep 2 — List the knowns.\n"
            "Step 3 — Work through the logic.\nStep 4 — Give the final answer.\n\n"
            "_Mock reply. Load DeepSeek-R1-Distill-Qwen-7B for real reasoning._"
        )
    else:
        body = (
            f"**[MOCK — {model_id}]**\n\n"
            f"You asked: *{prompt[:300]}*\n\n"
            "This is a **mock response** — routing, streaming and the UI all work, "
            "but no model ran. To get real answers:\n\n"
            "1. `pip install -r requirements.txt`, **or** set `HF_TOKEN` to use the "
            "☁️ cloud API models (no GPU needed).\n"
            "2. Pick a model on the left, or leave **Universal** on.\n"
            "3. On Hugging Face Spaces, ZeroGPU loads the model automatically."
        )
    for word in body.split(" "):
        yield word + " "
        time.sleep(0.006)


# ----------------------------------------------------------------- chat -----
def _clean_history(history: Any) -> List[Dict[str, str]]:
    """Normalise Gradio history (dicts, tuples, extra keys) to role/content."""
    out: List[Dict[str, str]] = []
    for item in history or []:
        if isinstance(item, dict):
            role = str(item.get("role", "user"))
            content = item.get("content", "")
            if isinstance(content, list):  # multimodal → keep text parts
                content = " ".join(
                    part.get("text", "") if isinstance(part, dict) else str(part)
                    for part in content
                )
            out.append({"role": role if role in ("user", "assistant", "system") else "user",
                        "content": str(content)})
        elif isinstance(item, (list, tuple)) and len(item) == 2:
            out.append({"role": "user", "content": str(item[0] or "")})
            out.append({"role": "assistant", "content": str(item[1] or "")})
    return [m for m in out if m["content"].strip()]


def _truncate_history(history: List[Dict[str, str]], max_chars: int = 12000) -> List[Dict[str, str]]:
    """Keep the most recent turns that fit — fixes context-overflow crashes."""
    if not history:
        return []
    kept, total = [], 0
    for msg in reversed(history):
        total += len(msg.get("content", ""))
        if total > max_chars:
            break
        kept.append(msg)
    kept.reverse()
    # Drop a dangling assistant message at the start (invalid role order).
    while kept and kept[0].get("role") == "assistant":
        kept.pop(0)
    return kept


def _read_upload(file_path: Optional[str], limit: int = 20000) -> str:
    """Read a text/code attachment as extra context (safe, size-limited)."""
    if not file_path:
        return ""
    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            text = f.read(limit + 1)
    except Exception as e:  # noqa: BLE001
        return f"[Could not read attachment: {e}]"
    if len(text) > limit:
        text = text[:limit] + "\n…[truncated]"
    return text


def _gpu_generate(model_id: str, messages: List[Dict[str, str]], max_tokens: int,
                  temperature: float, top_p: float) -> Generator[str, None, None]:
    """Move the (already RAM-resident) weights onto the GPU and generate.

    Runs **inside** the @spaces.GPU window, so the GPU is only held while
    tokens are being produced — the expensive download/load happens outside it.
    """
    ok = MANAGER.is_loaded(model_id)
    if ok:
        moved, note = MANAGER.ensure_device(want_gpu=True)
        if not moved:
            log.warning("GPU move failed (%s) — running on CPU", note)
    else:
        ok, note = MANAGER.load(model_id, want_gpu=True)
        if not ok:
            raise RuntimeError(note)
    try:
        yield from MANAGER.generate_stream(
            messages, max_new_tokens=max_tokens, temperature=temperature, top_p=top_p
        )
    finally:
        # Leave the allocation clean: weights back in RAM, VRAM released.
        MANAGER._back_to_cpu()  # noqa: SLF001


# ZeroGPU: GPU allocated only for the duration of this generator.
_gpu_generate = gpu_decorator(_gpu_generate)


def _local_stream(model_id: str, messages: List[Dict[str, str]], max_tokens: int,
                  temperature: float, top_p: float, want_gpu: bool) -> Generator[str, None, None]:
    """Load (CPU/RAM or GPU) then generate — with lazy weight loading."""
    if want_gpu:
        with MANAGER._load_lock:  # noqa: SLF001 - weights live in RAM already?
            loaded = MANAGER.is_loaded(model_id)
        if not loaded:
            # Load weights into CPU RAM first: no GPU time wasted on downloads.
            ok, status = MANAGER.load(model_id, want_gpu=False)
            if not ok:
                raise RuntimeError(status)
        yield from _gpu_generate(model_id, messages, max_tokens, temperature, top_p)
        return

    ok, status = MANAGER.load(model_id, want_gpu=False)
    if not ok:
        raise RuntimeError(status)
    yield from MANAGER.generate_stream(
        messages, max_new_tokens=max_tokens, temperature=temperature, top_p=top_p
    )


def _resolve(model_choice: str, message: str) -> Tuple[str, str, str, str]:
    """Return (model_id, category, backend, routing_markdown)."""
    if model_choice == UNIVERSAL_ID:
        ram = None if (HAS_SPACES or CUDA_AVAILABLE or MOCK) else get_ram_gb()
        decision = route_query(message, ram_gb=ram, prefer_api=PREFER_API or MOCK)
        backend = available_backend(decision.model_id)
        md = (
            f"**🧭 Auto-Route →** `{decision.model_id}`  \n"
            f"**Task:** {decision.category} &nbsp;·&nbsp; **Confidence:** {decision.confidence:.0%} "
            f"&nbsp;·&nbsp; **Backend:** {_backend_label(backend)}  \n"
            f"_{decision.reason}_"
        )
        return decision.model_id, decision.category, backend, md

    info = MODEL_REGISTRY.get(model_choice)
    category = info.category if info else "chat"
    backend = available_backend(model_choice)
    if info is None:  # unknown/removed model → fall back to the router
        chosen, category, backend, routing_md = _resolve(UNIVERSAL_ID, message)
        return chosen, category, backend, routing_md + f"\n\n_(selected model `{model_choice}` is gone; auto-routed)_"
    md = (
        f"**Selected →** `{model_choice}`  \n"
        f"**Task:** {category} &nbsp;·&nbsp; **Backend:** {_backend_label(backend)}"
    )
    return model_choice, category, backend, md


def _backend_label(backend: str) -> str:
    return {
        "local": "⚡ ZeroGPU" if HAS_SPACES else ("🖥️ GPU" if CUDA_AVAILABLE else "💾 CPU/RAM"),
        "api": "☁️ Cloud API",
        "mock": "🟡 Mock",
    }.get(backend, backend)


def _compose_messages(history: List[Dict[str, str]], message: str, system_prompt: str,
                      info: Optional[ModelInfo], attachment: str) -> List[Dict[str, str]]:
    sys_text = (system_prompt or "").strip() or (info.system_prompt if info else CHAT_SYS)
    messages: List[Dict[str, str]] = [{"role": "system", "content": sys_text}]
    messages += _truncate_history(history)
    user_text = message
    if attachment:
        instruction = message or "Summarise this file and point out anything important."
        user_text = f"{instruction}\n\n--- Attached file ---\n```\n{attachment}\n```"
    messages.append({"role": "user", "content": user_text})
    return messages


# ----------------------------------------------------------- tool helpers ---
def _tool_block(results: List[Tuple[str, agent_tools.ToolResult]]) -> str:
    """Render tool output as a collapsible markdown appendix."""
    if not results:
        return ""
    parts = ["\n\n<details><summary>🔧 Tools used</summary>\n"]
    for name, res in results:
        icon = "✅" if res.ok else "⚠️"
        body = res.text if len(res.text) <= 4000 else res.text[:4000] + "\n…"
        parts.append(f"\n**{icon} {name}**\n\n{body}\n")
    parts.append("\n</details>\n")
    return "".join(parts)


def _run_ui_tools(message: str, enabled: bool) -> List[Tuple[str, agent_tools.ToolResult]]:
    """Run the tools the UI decides are relevant for this message."""
    results: List[Tuple[str, agent_tools.ToolResult]] = []
    if not enabled or not WEB_TOOLS:
        return results
    try:
        planned = agent_tools.auto_tools_for(message, True)
    except Exception:
        planned = []
    # "install x/y" is handled deterministically, not by guessing with a model.
    if "install" in planned:
        source = agent_tools.extract_hf_source(message)
        if source:
            results.append(("install_model", agent_tools.install_model(source)))
        else:
            results.append(("install_model", agent_tools.ToolResult(
                False, "📦 Tell me the model id, e.g. `Qwen/Qwen2.5-1.5B-Instruct` "
                       "or `datasets/open-r1/OpenR1-Math`.")))
    if "web" in planned:
        results.append(("web_search", agent_tools.web_search(message[:200])))
    if "fetch" in planned:
        m = re.search(r"https?://[^\s)>\"]+", message)
        if m:
            results.append(("fetch_page", agent_tools.fetch_page(m.group(0))))
    if "calc" in planned:
        m = re.search(r"[-+*/^%().\d\s]{3,}", message)
        if m:
            results.append(("calculator", agent_tools.calculator(m.group(0))))
    if "time" in planned:
        results.append(("current_time", agent_tools.current_time()))
    return results


def _messages_with_tools(messages: List[Dict[str, str]],
                         results: List[Tuple[str, agent_tools.ToolResult]]) -> List[Dict[str, str]]:
    """Add tool observations + instructions to the last user turn."""
    if not results:
        return messages
    out = [dict(m) for m in messages]
    observations = "\n\n".join(
        f"### {name} result\n{res.text}" for name, res in results
    )
    last = out[-1]
    last["content"] = (
        f"{last['content']}\n\n---\nLive tool output (use it, cite URLs):\n{observations}\n---\n"
        "Answer the user using the tool output above where relevant. "
        "Do not mention JSON or the tool protocol."
    )
    return out


def _save_turn(ip: Optional[str], chat_id: Optional[str], messages: List[Dict[str, str]],
               model: str, tag: str = "") -> Optional[str]:
    """Persist the transcript for this IP; returns the chat id."""
    try:
        cid = chat_id or storage.new_chat_id()
        storage.save_chat(ip, cid, messages, model=model,
                          extra={"tag": tag} if tag else None)
        return cid
    except Exception as e:  # noqa: BLE001
        log.warning("could not save chat: %s", e)
        return chat_id


def _saved_line(ip: Optional[str], chat_id: str) -> str:
    """'saved' indicator shown under the chat."""
    if not chat_id:
        return ""
    where = storage.CHATS / storage.ip_key(ip) / f"{chat_id}.json"
    return f"💾 Saved automatically → `{where}`"


def chat_fn(
    message: str,
    history: List[Dict[str, str]],
    model_choice: str,
    system_prompt: str,
    temperature: float,
    top_p: float,
    max_tokens: int,
    attachment: Optional[str] = None,
    use_tools: bool = True,
    chat_id: str = "",
    request: gr.Request = None,
):
    """Streaming chat handler → (history, status, routing_md, chat_id, info_md)."""
    message = (message or "").strip()
    history = _clean_history(history)
    ip = storage.request_ip(request) if request is not None else None
    if not message and not attachment:
        yield history, "Type a message first.", "", chat_id, ""
        return
    # One id per conversation, created before the first token so every streamed
    # frame can show where the transcript is being persisted.
    chat_id = (chat_id or "").strip() or storage.new_chat_id()
    saved = _saved_line(ip, chat_id)

    chosen, category, backend, routing_md = _resolve(model_choice, message or "summarise this file")
    info = MODEL_REGISTRY.get(chosen)
    attach_text = ""
    if attachment:
        attach_text = _read_upload(attachment)
        if ip:
            try:  # keep the file alongside the chat for later turns
                with open(attachment, "rb") as f:
                    storage.save_upload(ip, os.path.basename(attachment), f.read())
            except Exception:
                pass
    messages = _compose_messages(history, message, system_prompt, info, attach_text)

    user_msg = {"role": "user", "content": message or "(attachment)"}
    yield history, f"🧭 Using {chosen} ({_backend_label(backend)})…", routing_md, chat_id, saved

    # ---------------- tools (before the model speaks) ----------------
    tool_results: List[Tuple[str, agent_tools.ToolResult]] = []
    if use_tools:
        yield (history + [user_msg, {"role": "assistant", "content": "🔧 Running tools…"}],
               "🔧 Running tools…", routing_md, chat_id, saved)
        tool_results = _run_ui_tools(message, use_tools)
        messages = _messages_with_tools(messages, tool_results)
        if tool_results:
            names = ", ".join(n for n, _ in tool_results)
            routing_md += f"\n\n🔧 **Tools:** {names}"
    tool_md = _tool_block(tool_results)
    model_messages = messages + [{"role": "user",
                                 "content": "Write your final answer to the user now in plain markdown. "
                                            "Do not emit JSON or tool calls."}] if tool_results else messages

    def _emit(full: str) -> List[Dict[str, str]]:
        return history + [user_msg, {"role": "assistant", "content": full + tool_md}]

    # ---------------- mock ----------------
    if backend == "mock":
        full = ""
        for chunk in mock_reply(message, category, chosen):
            full += chunk
            yield _emit(full), "🟡 MOCK streaming…", routing_md, chat_id, saved
        _save_turn(ip, chat_id, history + [user_msg,
                   {"role": "assistant", "content": full + tool_md}], chosen)
        yield (_emit(full),
               "🟡 MOCK reply — set HF_TOKEN or install torch for real models.",
               routing_md, chat_id, saved)
        return

    # ---------------- cloud API ----------------
    if backend == "api":
        full, err_text = "", ""
        try:
            for chunk in api_stream(chosen, model_messages, max_tokens, temperature, top_p):
                if chunk.startswith("⚠️"):
                    err_text = chunk
                    break
                full = chunk
                yield _emit(full), f"☁️ Streaming from {chosen}…", routing_md, chat_id, saved
        except Exception as e:  # noqa: BLE001
            err_text = f"⚠️ Cloud API error: {e}"
        if err_text and not full:
            yield history, err_text, routing_md, chat_id, saved
            return
        if err_text:
            full += "\n\n" + err_text
        _save_turn(ip, chat_id, history + [user_msg,
                   {"role": "assistant", "content": full + tool_md}], chosen)
        yield (_emit(full), "✅ Done (cloud API).", routing_md, chat_id, saved)
        return

    # ---------------- local (ZeroGPU or RAM) ----------------
    want_gpu = HAS_SPACES or (CUDA_AVAILABLE and DEVICE_PREF != "cpu")
    full = ""
    started = time.time()
    try:
        for chunk in _local_stream(chosen, model_messages, max_tokens, temperature, top_p, want_gpu):
            full = chunk
            yield _emit(full), "✍️ Generating…", routing_md, chat_id, saved
    except Exception as e:  # noqa: BLE001
        err = str(e)
        log.warning("Local generation failed (%s) — trying cloud fallback", err)
        if CAN_API:
            fallback = ROUTER_API_DEFAULTS.get(category, "Qwen/Qwen2.5-72B-Instruct")
            routing_md += (f"\n\n⚠️ Local model failed ({err.splitlines()[0][:160]}). "
                           f"Falling back to ☁️ `{fallback}`.")
            try:
                for chunk in api_stream(fallback, model_messages, max_tokens, temperature, top_p):
                    if chunk.startswith("⚠️"):
                        full = (full + "\n\n" + chunk).strip()
                        break
                    full = chunk
                    yield _emit(full), f"☁️ Cloud fallback: {fallback}", routing_md, chat_id, saved
                _save_turn(ip, chat_id, history + [user_msg,
                           {"role": "assistant", "content": (full or "⚠️ No reply.") + tool_md}], fallback)
                yield (_emit(full or "⚠️ No reply."), "✅ Done (cloud fallback).",
                       routing_md, chat_id, saved)
                return
            except Exception as e2:  # noqa: BLE001
                full = full or f"⚠️ {err}"
                err = f"{err} | fallback failed: {e2}"
        final = full or f"⚠️ {err}"
        _save_turn(ip, chat_id, history + [user_msg,
                   {"role": "assistant", "content": final + tool_md}], chosen)
        yield (_emit(final), f"❌ {err.splitlines()[0][:200]}", routing_md, chat_id, saved)
        return

    elapsed = max(1e-6, time.time() - started)
    tok_s = MANAGER.last_tok_s or (len(full) / 4) / elapsed
    status = f"✅ Done in {elapsed:.1f}s · ~{tok_s:.0f} tok/s · {_backend_label('local')}"
    _save_turn(ip, chat_id, history + [user_msg,
               {"role": "assistant", "content": full + tool_md}], chosen)
    yield (_emit(full), status, routing_md, chat_id, saved)


def regenerate_fn(history, model_choice, system_prompt, temperature, top_p, max_tokens,
                  use_tools=True):
    """Re-run the last user turn (drops the previous assistant reply)."""
    clean = _clean_history(history)
    idx = len(clean) - 1
    while idx >= 0 and clean[idx]["role"] != "user":
        idx -= 1
    if idx < 0:
        yield clean, "Nothing to regenerate.", "", "", ""
        return
    last_user = clean[idx]["content"]
    prior = clean[:idx]
    yield from chat_fn(last_user, prior, model_choice, system_prompt,
                       temperature, top_p, max_tokens, None, use_tools, "", None)


def load_model_btn(model_choice: str):
    if model_choice == UNIVERSAL_ID:
        return "Universal routes per-query — no single model to preload. Send a message!", "🧭 Universal"
    if MODEL_REGISTRY.get(model_choice) and MODEL_REGISTRY[model_choice].api:
        if CAN_API:
            return f"☁️ {model_choice} runs on the cloud API — nothing to load.", "☁️ Cloud API"
        return "⚠️ Cloud API models need HF_TOKEN (Space → Settings → Variables).", "⚠️ No token"
    if MOCK:
        return "🟡 MOCK mode — install torch+transformers to load real models.", "🟡 MOCK"
    # On ZeroGPU the GPU is only available inside the decorated call, so warm
    # the weights into CPU RAM here and move them on first generation.
    ok, status = MANAGER.load(model_choice, want_gpu=CUDA_AVAILABLE and not HAS_SPACES)
    return status, f"Loaded: `{MANAGER.model_id or '—'}` · {MANAGER.device} · RAM free {_human_gb(get_ram_gb())}"


def unload_btn():
    MANAGER.unload()
    return "🗑️ Model unloaded — memory freed."


def status_text() -> str:
    if MOCK:
        mode = "🟡 MOCK"
    elif HAS_SPACES:
        mode = "⚡ ZeroGPU"
    elif CUDA_AVAILABLE:
        mode = "🖥️ CUDA"
    else:
        mode = "💾 CPU/RAM"
    loaded = MANAGER.model_id or "none"
    api = "✅ token set" if HF_TOKEN else "— no token"
    return (
        f"**Backend:** {mode} &nbsp;·&nbsp; **Model:** `{loaded}`  \n"
        f"**RAM free:** {_human_gb(get_ram_gb())} &nbsp;·&nbsp; **Cloud API:** {api} "
        f"&nbsp;·&nbsp; **Models:** {len(MODEL_REGISTRY)}"
    )


def transcript_file(history) -> Optional[str]:
    """Write the conversation to a markdown file for download."""
    clean = _clean_history(history)
    if not clean:
        return None
    lines = ["# AI Agent — conversation\n"]
    for msg in clean:
        who = "🧑 You" if msg["role"] == "user" else "🤖 Assistant"
        lines.append(f"### {who}\n\n{msg['content']}\n")
    path = os.path.join(tempfile.gettempdir(), f"ai-agent-chat-{int(time.time())}.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return path


def routing_breakdown(message: str) -> str:
    """Human-readable router scores (used by the 'Why this model?' panel)."""
    d = route_query(message or "", ram_gb=None if (HAS_SPACES or CUDA_AVAILABLE or MOCK) else get_ram_gb(),
                    prefer_api=PREFER_API or MOCK)
    scores = d.scores or {}
    bars = "\n".join(
        f"- **{k}**: {'█' * int(v)} {v}" for k, v in sorted(scores.items(), key=lambda kv: -kv[1])
    ) or "- no signals"
    return (
        f"**Pick:** `{d.model_id}` ({_backend_label(available_backend(d.model_id))})  \n"
        f"**Category:** {d.category} · **Confidence:** {d.confidence:.0%}\n\n{bars}\n\n_{d.reason}_"
    )


# ------------------------------------------------------ chat history (IP) ---
def _ip_of(request: Optional[gr.Request]) -> Optional[str]:
    return storage.request_ip(request) if request is not None else None


def chats_table(request: gr.Request = None) -> List[List[str]]:
    """Rows for the 'Saved chats' dataframe (this IP only)."""
    ip = _ip_of(request)
    rows: List[List[str]] = []
    for c in storage.list_chats(ip):
        rows.append([
            str(c.get("id", "")),
            str(c.get("title", ""))[:70],
            time.strftime("%Y-%m-%d %H:%M", time.localtime(c.get("updated", 0))),
            str(c.get("turns", 0)),
            str(c.get("model", ""))[:40],
        ])
    return rows


def open_chat(chat_id: str, request: gr.Request = None):
    """Load a saved transcript into the chatbot."""
    ip = _ip_of(request)
    rec = storage.load_chat(ip, (chat_id or "").strip())
    if not rec:
        return [], "", chat_id or "", f"⚠️ No chat `{chat_id}` for this IP."
    msgs = rec.get("messages", [])
    return msgs, "", rec["id"], f"📂 Loaded **{rec.get('title', '')}** ({len(msgs)} messages)"


def new_chat() -> Tuple[list, str, str, str]:
    cid = storage.new_chat_id()
    return [], "", cid, f"🆕 New chat `{cid}` — it saves automatically as you talk."


def delete_saved_chat(chat_id: str, request: gr.Request = None):
    ip = _ip_of(request)
    ok = storage.delete_chat(ip, (chat_id or "").strip())
    return chats_table(request), (f"🗑️ Deleted `{chat_id}`" if ok else f"⚠️ Not found: `{chat_id}`")


def rename_saved_chat(chat_id: str, title: str, request: gr.Request = None):
    ip = _ip_of(request)
    ok = storage.rename_chat(ip, (chat_id or "").strip(), (title or "").strip() or "Untitled")
    return chats_table(request), ("✏️ Renamed." if ok else "⚠️ Chat not found.")


def storage_status(request: gr.Request = None) -> str:
    ip = _ip_of(request)
    n = storage.chat_count(ip)
    return (
        f"💾 **Storage:** {storage.storage_summary()}\n\n"
        f"👤 **This IP** (`{storage.ip_key(ip)}`): {n} saved chat(s)"
    )


# ------------------------------------------------------- models manager -----
def models_table() -> List[List[str]]:
    rows = []
    for it in storage.installed_models():
        rows.append([
            str(it.get("id", "")),
            str(it.get("kind", "")),
            str(it.get("source", "")),
            storage.human_bytes(it.get("size_bytes", 0)),
            str(it.get("files", 0)),
            time.strftime("%Y-%m-%d %H:%M", time.localtime(it.get("installed", 0))),
            str(it.get("status", "")),
        ])
    return rows


def install_model_ui(source: str) -> Tuple[List[List[str]], str]:
    source = (source or "").strip()
    if not source:
        return models_table(), "⚠️ Paste a model id or URL first."
    try:
        parsed = storage.parse_source(source)
    except Exception as e:  # noqa: BLE001
        return models_table(), f"❌ {e}"
    job = storage.install_async(source)
    if job.status == "ready":
        refresh_local_models()
        return models_table(), f"📦 **Already installed** — {job.progress}\n\nUpdated dropdown list."
    if job.status == "failed":
        return models_table(), f"❌ Could not start: {job.error}"
    return (
        models_table(),
        f"📦 **Started** downloading `{parsed['repo_id']}` ({parsed['kind']}) in the background.\n\n"
        f"Job `{job.job_id}` → target `{storage.MODELS}`. Press **Refresh** to watch progress; "
        f"the model appears in the dropdown once ready.",
    )


def refresh_models_ui() -> Tuple[List[List[str]], str, Any]:
    """Update the table, the status line and the model dropdown choices."""
    added = refresh_local_models()
    jobs = storage.jobs_snapshot()
    active = [j for j in jobs if j.get("status") in ("pending", "downloading")]
    lines = []
    if active:
        lines.append("⏳ **Downloading now:**")
        for j in active[:5]:
            lines.append(f"- `{j.get('source')}` — {j.get('progress') or j.get('status')}")
    failed = [j for j in jobs if j.get("status") == "failed"]
    if failed:
        lines.append("\n❌ **Failed:**")
        for j in failed[-3:]:
            lines.append(f"- `{j.get('source')}` — {str(j.get('error'))[:160]}")
    if added:
        lines.append(f"\n✅ {added} new local model(s) registered.")
    lines.append(f"\n{storage.storage_summary()}")
    return models_table(), "\n".join(lines), gr.update(choices=all_model_choices())


def delete_model_ui(model_id: str) -> Tuple[List[List[str]], str, Any]:
    model_id = (model_id or "").strip()
    if not model_id:
        return models_table(), "⚠️ Select a model id.", gr.update()
    rec = storage.get_installed(model_id)
    if not rec:
        return models_table(), f"⚠️ Not installed: `{model_id}`", gr.update()
    MANAGER.unload()
    MODEL_REGISTRY.pop(rec["id"], None)
    ok = storage.remove_installed(model_id, delete_files=True)
    return (models_table(),
            (f"🗑️ Removed `{model_id}` and its files." if ok else f"⚠️ Could not remove `{model_id}`."),
            gr.update(choices=all_model_choices()))


def tool_button(tool: str, arg: str) -> str:
    """Direct tool invocation from the Tools tab."""
    arg = (arg or "").strip()
    if tool == "web_search":
        return agent_tools.web_search(arg or "today's technology news").text
    if tool == "fetch_page":
        return agent_tools.fetch_page(arg).text if arg else "⚠️ Give a URL."
    if tool == "calculator":
        return agent_tools.calculator(arg).text if arg else "⚠️ Give an expression."
    if tool == "current_time":
        return agent_tools.current_time(arg or "UTC").text
    if tool == "dataset_overview":
        return agent_tools.dataset_overview(arg).text if arg else "⚠️ Give a repo id."
    if tool == "list_installed":
        return agent_tools.list_installed_tool().text
    if tool == "install_model":
        return agent_tools.install_model(arg).text if arg else "⚠️ Give a repo id."
    return f"⚠️ Unknown tool: {tool}"


# -------------------------------------------------------------------- UI ----
MODEL_CHOICES: List[Tuple[str, str]] = all_model_choices()

SYSTEM_PRESETS = {
    "Default (model's own)": "",
    "Expert Coder": CODE_SYS,
    "Friendly Chat": CHAT_SYS,
    "Reasoning Coach": REASON_SYS,
    "Creative Writer": "You are a creative writer. Be vivid, original and engaging.",
    "Teacher (simple words)": "You are a patient teacher. Explain in simple words with a short example.",
    "Concise / bullet points": "Answer in concise bullet points. No filler.",
}

EXAMPLES = [
    ["Write a Python function to check if a string is a palindrome, with tests.", UNIVERSAL_ID],
    ["Debug this error: TypeError: 'NoneType' object is not subscriptable in Python.", UNIVERSAL_ID],
    ["Solve: a train travels 60 km/h for 2.5 hours — how far? Show the steps.", UNIVERSAL_ID],
    ["Search the web for the latest Qwen model release and summarise it.", UNIVERSAL_ID],
    ["Install Qwen/Qwen2.5-1.5B-Instruct for me so I can chat with it offline.", UNIVERSAL_ID],
    ["Mera code work nahi kar raha, Python list index error aa raha hai. Fix karo.", UNIVERSAL_ID],
]

CSS = """
.footer {text-align:center; opacity:.65; font-size:.82em; margin-top:1.2em}
.badge {display:inline-block; padding:.18em .6em; border-radius:999px;
        background:linear-gradient(90deg,#eef2ff,#f5e8ff); font-size:.8em; margin:.12em}
#chatbox {border-radius:14px}
"""
try:
    import inspect as _inspect

    _blocks_params = set(_inspect.signature(gr.Blocks.__init__).parameters)
except Exception:  # pragma: no cover
    _blocks_params = {"theme", "css"}


# Gradio 5 takes theme/css in the constructor; Gradio 6 moved them to launch().
_BLOCKS_KW: Dict[str, Any] = {"title": "AI Agent — Multi-Model (ZeroGPU)", "analytics_enabled": False}
if "theme" in _blocks_params:
    _BLOCKS_KW["theme"] = gr.themes.Soft()
    _BLOCKS_KW["css"] = CSS

_try_import_inspect = _inspect  # already imported above


def _supports(obj: Any, *names: str) -> bool:
    """True when every kwarg is accepted by this Gradio version."""
    try:
        params = set(_inspect.signature(obj).parameters)
    except Exception:  # pragma: no cover
        return True
    return all(n in params for n in names)


# Chatbot: `type="messages"` (5.x) is the default/only mode in 6.x, and
# `show_copy_button` was replaced by `buttons=["copy"]`.
_CHATBOT_KW: Dict[str, Any] = {"height": 520, "label": "Chat", "elem_id": "chatbox",
                               "allow_tags": False}
if _supports(gr.Chatbot.__init__, "type"):
    _CHATBOT_KW["type"] = "messages"
if _supports(gr.Chatbot.__init__, "show_copy_button"):
    _CHATBOT_KW["show_copy_button"] = True
elif _supports(gr.Chatbot.__init__, "buttons"):
    _CHATBOT_KW["buttons"] = ["copy"]

# launch(): Gradio 6 wants theme/css there instead of on Blocks.
_LAUNCH_KW: Dict[str, Any] = {}
if not _supports(gr.Blocks.__init__, "theme"):
    _LAUNCH_KW["theme"] = gr.themes.Soft()
    _LAUNCH_KW["css"] = CSS

with gr.Blocks(**_BLOCKS_KW) as demo:
    gr.Markdown(
        "# 🤖 AI Agent — Multi-Model Chat & Code\n"
        '<span class="badge">🧭 Universal Auto-Route</span> '
        '<span class="badge">⚡ ZeroGPU</span> '
        '<span class="badge">💾 RAM / CPU</span> '
        '<span class="badge">☁️ Cloud API</span> '
        '<span class="badge">🌐 Web search</span> '
        '<span class="badge">🧮 Calculator</span> '
        '<span class="badge">📦 Install models</span> '
        '<span class="badge">🗂️ Chats saved per IP</span>\n\n'
        "Chats are stored in the persistent bucket and survive restarts. "
        "Models and datasets are downloaded into the same bucket and appear in the model list. "
        f"Storage: `{storage.DATA_ROOT}`"
    )

    # hidden state: which saved chat we are continuing
    chat_id_state = gr.State("")

    with gr.Tabs():
        # ================================================ CHAT ================
        with gr.Tab("💬 Chat"):
            with gr.Row():
                with gr.Column(scale=1, min_width=290):
                    model_dd = gr.Dropdown(
                        choices=MODEL_CHOICES, value=UNIVERSAL_ID, label="Model",
                        info="Universal auto-routes every query. 📦 = installed locally.",
                    )
                    preset_dd = gr.Dropdown(list(SYSTEM_PRESETS), value="Default (model's own)",
                                            label="System prompt preset")
                    system_tb = gr.Textbox(label="System prompt", lines=3,
                                           placeholder="Leave blank for the model's default…")
                    temperature = gr.Slider(0.0, 1.5, value=0.7, step=0.05, label="Temperature")
                    top_p = gr.Slider(0.1, 1.0, value=0.9, step=0.05, label="Top-p")
                    max_tokens = gr.Slider(64, 2048, value=512, step=64, label="Max new tokens")
                    use_tools = gr.Checkbox(
                        value=True, label="🔧 Use tools",
                        info="Web search · page fetch · calculator · time · install models",
                    )
                    with gr.Row():
                        load_btn = gr.Button("⬇️ Load", variant="secondary")
                        unload_b = gr.Button("🗑️ Unload", variant="secondary")
                    status_md = gr.Markdown(status_text())
                    with gr.Accordion("🔍 Why this model? (router scores)", open=False):
                        probe_tb = gr.Textbox(label="Preview routing for…", lines=2,
                                              placeholder="Paste a query to see how it would be routed")
                        probe_btn = gr.Button("Explain routing")
                        probe_md = gr.Markdown("")
                    routing_md = gr.Markdown("")
                    gr.Markdown(
                        "**Memory rules**\n"
                        "- Only **one** model is resident at a time.\n"
                        "- **ZeroGPU:** GPU allocated per request by `@spaces.GPU`.\n"
                        "- **Local CPU:** auto 4-bit quantisation; 0.5B/1.5B fit a 4GB box.\n"
                        "- **Cloud API:** 72B/70B/480B models need only `HF_TOKEN`."
                    )

                with gr.Column(scale=3):
                    chatbot = gr.Chatbot(**_CHATBOT_KW)
                    msg_tb = gr.Textbox(label="Message", show_label=False, lines=2,
                                        placeholder="Ask anything — or say \"search the web for…\" / "
                                                    "\"install Qwen/Qwen2.5-1.5B-Instruct\"")
                    with gr.Row():
                        send_btn = gr.Button("Send ➤", variant="primary", scale=2)
                        stop_btn = gr.Button("⏹ Stop", variant="stop", scale=1)
                        regen_btn = gr.Button("🔄 Regenerate", scale=1)
                        clear_btn = gr.Button("🧹 New chat", scale=1)
                    saved_md = gr.Markdown("")
                    with gr.Accordion("📎 Attach a file (optional context)", open=False):
                        file_in = gr.File(label="Text / code file", file_count="single",
                                          file_types=[".txt", ".md", ".py", ".js", ".ts", ".json",
                                                      ".csv", ".html", ".css", ".sql", ".yaml", ".log"])
                    with gr.Row():
                        download_btn = gr.DownloadButton("⬇️ Download chat", variant="secondary")
                    gr.Examples(examples=EXAMPLES, inputs=[msg_tb, model_dd], label="Try an example")

        # ============================================ SAVED CHATS =============
        with gr.Tab("🗂️ Chats"):
            gr.Markdown(
                "Conversations are saved to the persistent bucket **per client IP** "
                "(`/data/chats/<hashed-ip>/`) and survive Space restarts and rebuilds. "
                "Other visitors' chats are never listed here."
            )
            chats_status_md = gr.Markdown("")
            with gr.Row():
                refresh_chats_btn = gr.Button("🔄 Refresh list", variant="secondary")
                new_chat_btn = gr.Button("🆕 New chat", variant="primary")
            chats_df = gr.Dataframe(
                headers=["id", "title", "updated", "turns", "model"],
                value=[], interactive=False, wrap=True, label="Your saved chats",
            )
            with gr.Row():
                open_id_tb = gr.Textbox(label="Chat id", placeholder="paste an id from the table")
                open_btn = gr.Button("📂 Open")
                del_btn = gr.Button("🗑️ Delete", variant="stop")
            with gr.Row():
                rename_id_tb = gr.Textbox(label="Chat id to rename")
                rename_title_tb = gr.Textbox(label="New title")
                rename_btn = gr.Button("✏️ Rename")

        # ================================================ MODELS ==============
        with gr.Tab("📦 Models"):
            gr.Markdown(
                f"Download any Hugging Face **model** or **dataset** into the persistent bucket "
                f"(`{storage.MODELS}`). Installed models show up in the Chat model list as 📦 and "
                f"can be loaded like built-ins. You can also just ask the assistant: "
                f"*\"install Qwen/Qwen2.5-1.5B-Instruct\"*."
            )
            with gr.Row():
                install_tb = gr.Textbox(
                    label="Model / dataset id or URL", scale=4,
                    placeholder="Qwen/Qwen2.5-Coder-7B-Instruct · datasets/open-r1/OpenR1-Math · "
                                "https://huggingface.co/owner/name",
                )
                install_btn = gr.Button("⬇️ Install", variant="primary", scale=1)
            with gr.Row():
                refresh_models_btn = gr.Button("🔄 Refresh / progress")
                delete_model_tb = gr.Textbox(label="Model id to delete", scale=3,
                                             placeholder="local/qwen-qwen2.5-1.5b-instruct")
                delete_model_btn = gr.Button("🗑️ Delete", variant="stop", scale=1)
            models_md = gr.Markdown(storage.storage_summary())
            models_df = gr.Dataframe(
                headers=["id", "kind", "source", "size", "files", "installed", "status"],
                value=models_table(), interactive=False, wrap=True, label="Installed",
            )

        # ================================================= TOOLS ==============
        with gr.Tab("🌐 Tools"):
            gr.Markdown(
                "Every tool below is also available to the model during chat when "
                "**🔧 Use tools** is on. The AI can call them itself — including installing models."
            )
            with gr.Row():
                tool_pick = gr.Dropdown(
                    ["web_search", "fetch_page", "calculator", "current_time",
                     "dataset_overview", "list_installed", "install_model"],
                    value="web_search", label="Tool",
                )
                tool_arg = gr.Textbox(label="Argument", scale=2,
                                      placeholder="query · URL · expression · repo id")
                tool_run = gr.Button("▶️ Run", variant="primary")
            tool_out = gr.Markdown("")

            with gr.Accordion("📚 Model Explorer — every built-in model", open=False):
                rows = [
                    [f"{m.emoji} {m.id}", m.category, m.params,
                     "☁️ API" if m.api else _human_gb(m.ram_gb),
                     "✅" if m.api else ("☁️ API" if not m.zerogpu else "✅"),
                     "🔒 gated" if m.gated else "open", m.best_for]
                    for m in MODEL_REGISTRY.values()
                ]
                gr.Dataframe(
                    headers=["Model", "Category", "Params", "RAM/VRAM", "ZeroGPU", "Access", "Best for"],
                    value=rows, interactive=False, wrap=True,
                )
                gr.Markdown(
                    "**Routing** scores your query for code / reasoning / creative / translation / "
                    "summary signals — English **and** Hinglish — in under a millisecond. Hard tasks "
                    "are upgraded to the cloud API when a token is available, and downgraded to a "
                    "RAM-safe model when memory is low."
                )

    gr.Markdown(
        '<p class="footer">ZeroGPU + local CPU/RAM + HF Inference Providers. '
        "Chats and downloaded models live in the persistent bucket, keyed by a salted hash of "
        "your IP. Never commit an HF token — set it as a Space secret.</p>"
    )

    # ------------------------------------------------ wiring: chat ----------
    preset_dd.change(lambda p: SYSTEM_PRESETS.get(p, ""), inputs=[preset_dd], outputs=[system_tb])

    chat_inputs = [msg_tb, chatbot, model_dd, system_tb, temperature, top_p, max_tokens,
                   file_in, use_tools, chat_id_state]
    chat_outputs = [chatbot, status_md, routing_md, chat_id_state, saved_md]

    send_event = send_btn.click(chat_fn, inputs=chat_inputs, outputs=chat_outputs)
    submit_event = msg_tb.submit(chat_fn, inputs=chat_inputs, outputs=chat_outputs)
    regen_btn.click(
        regenerate_fn,
        inputs=[chatbot, model_dd, system_tb, temperature, top_p, max_tokens, use_tools],
        outputs=[chatbot, status_md, routing_md],
    )
    for ev in (send_event, submit_event):
        ev.then(lambda: "", outputs=[msg_tb])
        ev.then(lambda: None, outputs=[file_in])

    stop_btn.click(lambda: None, None, None, cancels=[send_event, submit_event])
    clear_btn.click(new_chat, outputs=[chatbot, saved_md, chat_id_state, status_md])
    load_btn.click(load_model_btn, inputs=[model_dd], outputs=[status_md, routing_md])
    unload_b.click(unload_btn, outputs=[status_md])
    probe_btn.click(routing_breakdown, inputs=[probe_tb], outputs=[probe_md])
    download_btn.click(transcript_file, inputs=[chatbot], outputs=[download_btn])

    # ------------------------------------------- wiring: saved chats --------
    def _refresh_chats(request: gr.Request = None):
        return chats_table(request)

    refresh_chats_btn.click(_refresh_chats, outputs=[chats_df])
    new_chat_btn.click(new_chat, outputs=[chatbot, saved_md, chat_id_state, status_md])
    open_btn.click(open_chat, inputs=[open_id_tb],
                   outputs=[chatbot, saved_md, chat_id_state, status_md])
    del_btn.click(delete_saved_chat, inputs=[open_id_tb], outputs=[chats_df, saved_md])
    rename_btn.click(rename_saved_chat, inputs=[rename_id_tb, rename_title_tb],
                     outputs=[chats_df, saved_md])

    # ---------------------------------------------- wiring: models ---------
    install_btn.click(install_model_ui, inputs=[install_tb], outputs=[models_df, models_md])
    refresh_models_btn.click(refresh_models_ui, outputs=[models_df, models_md, model_dd])
    delete_model_btn.click(delete_model_ui, inputs=[delete_model_tb],
                           outputs=[models_df, models_md, model_dd])

    # ----------------------------------------------- wiring: tools ---------
    tool_run.click(tool_button, inputs=[tool_pick, tool_arg], outputs=[tool_out])

    # ---------------------------------------------------- initial load -----
    def _on_load(request: gr.Request = None):
        ip = storage.request_ip(request)
        return (
            status_text(),
            chats_table(request),
            models_table(),
            storage.storage_summary(),
            f"👤 Session storage: `{storage.ip_key(ip)}` · "
            f"{storage.chat_count(ip)} saved chat(s) · {len(storage.installed_models())} installed model(s)",
        )

    demo.load(_on_load, outputs=[status_md, chats_df, models_df, models_md, chats_status_md])

    # ---------------- warm start ----------------
    def _auto_preload() -> None:
        if MOCK or not HAS_LOCAL:
            return
        target = PRELOAD_MODEL
        if not target and AUTO_PRELOAD:
            free = get_ram_gb()
            candidates = [
                m for m in MODEL_REGISTRY.values()
                if not m.api and not m.gated and m.category in ("chat", "tiny")
                and m.ram_gb <= max(1.0, free * 0.55)
            ]
            if candidates:
                target = max(candidates, key=lambda m: m.ram_gb).id
        if not target:
            log.info("Auto-preload: no model fits available RAM (%.1fGB)", get_ram_gb())
            return
        log.info("Preloading %s in the background…", target)
        ok, msg = MANAGER.load(target, want_gpu=CUDA_AVAILABLE and not HAS_SPACES)
        log.info("Preload: %s", msg)

    # Only warm up when the app is actually served — never on import/test.
    if __name__ == "__main__":
        threading.Thread(target=_auto_preload, daemon=True).start()


# ------------------------------------------------------------------- main ---
def main() -> None:
    ap = argparse.ArgumentParser(description="AI Agent — Multi-Model (ZeroGPU/RAM/API)")
    ap.add_argument("--host", default=os.getenv("HOST", "0.0.0.0"))
    ap.add_argument("--port", type=int, default=int(os.getenv("PORT", "7860")))
    ap.add_argument("--share", action="store_true", help="Create a public Gradio share link")
    ap.add_argument("--preload", default=PRELOAD_MODEL, help="Model id to warm into memory")
    ap.add_argument("--mock", action="store_true", help="Force mock replies")
    args = ap.parse_args()

    if args.mock:
        globals()["MOCK"] = True

    if args.preload and not MOCK:
        def _preload() -> None:
            log.info("Preloading %s…", args.preload)
            ok, msg = MANAGER.load(args.preload, want_gpu=CUDA_AVAILABLE and not HAS_SPACES)
            log.info("Preload: %s", msg)

        threading.Thread(target=_preload, daemon=True).start()

    log.info(
        "Starting AI Agent on %s:%s (MOCK=%s, ZeroGPU=%s, CUDA=%s, API=%s)",
        args.host, args.port, MOCK, HAS_SPACES, CUDA_AVAILABLE, CAN_API,
    )
    demo.queue(max_size=32, default_concurrency_limit=4)
    nonblock = os.getenv("AI_AGENT_NONBLOCK", "0") == "1"
    demo.launch(
        server_name=args.host,
        server_port=args.port,
        share=args.share,
        show_error=True,
        prevent_thread_lock=nonblock,
        **_LAUNCH_KW,
    )


if __name__ == "__main__":
    main()
