#!/usr/bin/env python3
"""
Tools for the AI Agent: internet search, page reading, maths, time, and
"install this model for me" — callable by the UI **and** by the model itself.

Two layers
----------
1. Plain Python functions (``web_search``, ``fetch_page``, ``calculator``, …)
   used directly by buttons and by the chat handler.
2. An OpenAI-style tool schema (``TOOL_SPECS``) plus ``run_tool()``. When the
   backend is the cloud API, the model can call these itself in a loop
   (``run_tool_loop``) — that is how "ask the AI to install a model" works.

Everything is dependency-light and fails soft: a tool returns a
``ToolResult`` with ``ok=False`` and a readable message instead of raising,
so a broken search engine never takes the chat down.
"""
from __future__ import annotations

import ast
import html
import json
import logging
import math
import operator
import os
import re
import time
import urllib.parse
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

import storage

log = logging.getLogger("ai-agent.tools")

UA = "Mozilla/5.0 (compatible; AI-Agent/1.0; +https://huggingface.co/spaces)"
HTTP_TIMEOUT = float(os.getenv("TOOL_HTTP_TIMEOUT", "20"))
MAX_PAGE_CHARS = int(os.getenv("TOOL_MAX_PAGE_CHARS", "6000"))


@dataclass
class ToolResult:
    ok: bool
    text: str
    data: Dict[str, Any] = field(default_factory=dict)
    citations: List[str] = field(default_factory=list)

    def __str__(self) -> str:  # convenience in f-strings
        return self.text


def _http_get(url: str, *, timeout: Optional[float] = None,
              headers: Optional[Dict[str, str]] = None) -> Tuple[bool, str, str]:
    """(ok, text, error). Uses requests when available, urllib otherwise."""
    hdrs = {"User-Agent": UA, "Accept": "text/html,application/json;q=0.9,*/*;q=0.8"}
    if headers:
        hdrs.update(headers)
    try:
        import requests  # type: ignore

        r = requests.get(url, headers=hdrs, timeout=timeout or HTTP_TIMEOUT)
        if r.status_code >= 400:
            return False, "", f"HTTP {r.status_code} for {url}"
        return True, r.text, ""
    except ImportError:
        pass
    except Exception as e:  # noqa: BLE001
        return False, "", f"{type(e).__name__}: {e}"
    try:
        import urllib.request

        req = urllib.request.Request(url, headers=hdrs)
        with urllib.request.urlopen(req, timeout=timeout or HTTP_TIMEOUT) as resp:
            charset = resp.headers.get_content_charset() or "utf-8"
            return True, resp.read().decode(charset, errors="replace"), ""
    except Exception as e:  # noqa: BLE001
        return False, "", f"{type(e).__name__}: {e}"


# --------------------------------------------------------------- html → md --
_TAG_RE = re.compile(r"<[^>]+>")
_SCRIPT_RE = re.compile(r"<(script|style|noscript|template)[^>]*>.*?</\1>", re.S | re.I)
_BLOCK_TAGS = re.compile(r"</?(p|div|br|li|tr|h[1-6]|section|article|header|footer)[^>]*>", re.I)


def html_to_text(raw: str, limit: int = MAX_PAGE_CHARS) -> str:
    """Very small HTML→text converter (no bs4 dependency)."""
    if not raw:
        return ""
    text = _SCRIPT_RE.sub(" ", raw)
    text = re.sub(r"<!--.*?-->", " ", text, flags=re.S)
    text = _BLOCK_TAGS.sub("\n", text)
    text = _TAG_RE.sub(" ", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t\x0b\f\r]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    text = "\n".join(line.strip() for line in text.splitlines())
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text[:limit]


def _title(raw: str) -> str:
    m = re.search(r"<title[^>]*>(.*?)</title>", raw, re.I | re.S)
    if not m:
        return ""
    flat = re.sub(r"\s+", " ", html.unescape(_TAG_RE.sub("", m.group(1)))).strip()
    return flat[:160]


# ------------------------------------------------------------------ search ---
@dataclass
class SearchHit:
    title: str
    url: str
    snippet: str


def _ddg_html(query: str) -> List[SearchHit]:
    """DuckDuckGo HTML endpoint — no API key, no JS."""
    url = "https://html.duckduckgo.com/html/"
    ok, body, err = _http_get(url, headers={"Accept": "text/html"}, timeout=HTTP_TIMEOUT)
    if not ok:
        # The HTML endpoint accepts POST more reliably.
        try:
            import requests  # type: ignore

            r = requests.post(url, data={"q": query}, headers={"User-Agent": UA}, timeout=HTTP_TIMEOUT)
            body, ok = r.text, r.status_code < 400
        except Exception:  # noqa: BLE001
            return []
    if not ok and not body:
        return []
    hits: List[SearchHit] = []
    for m in re.finditer(
        r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>.*?'
        r'(?:<a[^>]+class="result__snippet"[^>]*>(.*?)</a>)?',
        body, re.S | re.I,
    ):
        href, title_html, snippet_html = m.group(1), m.group(2), m.group(3) or ""
        href = html.unescape(href)
        # DDG wraps links: //duckduckgo.com/l/?uddg=<encoded>
        if "uddg=" in href:
            href = urllib.parse.unquote(re.search(r"uddg=([^&]+)", href).group(1))
        hits.append(SearchHit(
            title=html_to_text(title_html, 200) or href,
            url=href,
            snippet=html_to_text(snippet_html, 300),
        ))
        if len(hits) >= 8:
            break
    return hits


def _ddg_lite(query: str) -> List[SearchHit]:
    ok, body, _ = _http_get(
        "https://lite.duckduckgo.com/lite/?q=" + urllib.parse.quote(query),
        headers={"Accept": "text/html"},
    )
    if not ok:
        return []
    hits: List[SearchHit] = []
    for m in re.finditer(r'<a[^>]+href="(https?://[^"]+)"[^>]*>(.*?)</a>', body, re.S | re.I):
        url, title = urllib.parse.unquote(m.group(1)), html_to_text(m.group(2), 200)
        if "duckduckgo.com" in url:
            continue
        hits.append(SearchHit(title=title or url, url=url, snippet=""))
        if len(hits) >= 8:
            break
    return hits


def _wikipedia(query: str, limit: int = 4) -> List[SearchHit]:
    ok, body, _ = _http_get(
        "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit="
        f"{limit}&srsearch=" + urllib.parse.quote(query)
    )
    if not ok:
        return []
    try:
        data = json.loads(body)
    except Exception:
        return []
    out: List[SearchHit] = []
    for item in data.get("query", {}).get("search", []):
        title = item.get("title", "")
        out.append(SearchHit(
            title=title,
            url="https://en.wikipedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_")),
            snippet=html_to_text(item.get("snippet", ""), 300),
        ))
    return out


def web_search(query: str, limit: int = 5) -> ToolResult:
    """Search the web. Tries DuckDuckGo (HTML + lite), falls back to Wikipedia."""
    query = (query or "").strip()
    if not query:
        return ToolResult(False, "⚠️ Empty search query.")
    for name, fn in (("duckduckgo-html", _ddg_html), ("duckduckgo-lite", _ddg_lite)):
        try:
            hits = fn(query)[:limit]
        except Exception as e:  # noqa: BLE001
            log.warning("%s search failed: %s", name, e)
            hits = []
        if hits:
            return _format_hits(query, hits, name)
    # Last resort: Wikipedia's API (reliable, no scraping).
    try:
        hits = _wikipedia(query, limit)[:limit]
    except Exception:
        hits = []
    if hits:
        return _format_hits(query, hits, "wikipedia")
    return ToolResult(
        False,
        f"🔍 No results for **{query}** — search backends are unreachable from this "
        f"host (common on sandboxes with a network allowlist).",
    )


def _format_hits(query: str, hits: List[SearchHit], backend: str) -> ToolResult:
    lines = [f"🔍 **Results for** _{query}_ (via {backend})\n"]
    for i, h in enumerate(hits, 1):
        lines.append(f"**{i}. [{h.title}]({h.url})**")
        if h.snippet:
            lines.append(f"   {h.snippet}")
    return ToolResult(
        True, "\n".join(lines),
        data={"query": query, "backend": backend,
              "hits": [h.__dict__ for h in hits]},
        citations=[h.url for h in hits],
    )


# ------------------------------------------------------------- page fetch ---
def fetch_page(url: str, limit: int = MAX_PAGE_CHARS) -> ToolResult:
    if not url:
        return ToolResult(False, "⚠️ No URL given.")
    if not re.match(r"^https?://", url):
        url = "https://" + url
    ok, body, err = _http_get(url)
    if not ok:
        return ToolResult(False, f"🌐 Could not read {url}: {err}")
    text = html_to_text(body, limit)
    if not text:
        return ToolResult(False, f"🌐 {url} returned no readable text.")
    title = _title(body)
    header = f"🌐 **{title or url}**\n<{url}>\n\n"
    return ToolResult(True, header + text,
                      data={"url": url, "title": title, "chars": len(text)},
                      citations=[url])


# ------------------------------------------------------------- calculator ---
_BIN_OPS: Dict[type, Callable[[Any, Any], Any]] = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
    ast.Div: operator.truediv, ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod, ast.Pow: operator.pow,
}
_UNARY_OPS: Dict[type, Callable[[Any], Any]] = {
    ast.UAdd: operator.pos, ast.USub: operator.neg,
}
_FUNCS = {
    "abs": abs, "round": round, "min": min, "max": max,
    "sqrt": math.sqrt, "log": math.log, "log10": math.log10, "log2": math.log2,
    "exp": math.exp, "sin": math.sin, "cos": math.cos, "tan": math.tan,
    "asin": math.asin, "acos": math.acos, "atan": math.atan,
    "floor": math.floor, "ceil": math.ceil, "factorial": math.factorial,
    "degrees": math.degrees, "radians": math.radians, "hypot": math.hypot,
}
_CONSTS = {"pi": math.pi, "e": math.e, "tau": math.tau, "inf": math.inf}


def _safe_eval(node: ast.AST) -> Any:
    """Evaluate a tiny arithmetic AST — no names, no attributes, no imports."""
    if isinstance(node, ast.Expression):
        return _safe_eval(node.body)
    if isinstance(node, ast.Constant):
        if isinstance(node.value, (int, float)):
            return node.value
        raise ValueError("only numbers are allowed")
    if isinstance(node, ast.BinOp) and type(node.op) in _BIN_OPS:
        left, right = _safe_eval(node.left), _safe_eval(node.right)
        if isinstance(node.op, ast.Pow) and (abs(right) > 1000 or abs(left) > 1e6):
            raise ValueError("exponent too large")
        return _BIN_OPS[type(node.op)](left, right)
    if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY_OPS:
        return _UNARY_OPS[type(node.op)](_safe_eval(node.operand))
    if isinstance(node, ast.Name) and node.id in _CONSTS:
        return _CONSTS[node.id]
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
        fn = _FUNCS.get(node.func.id)
        if fn is None:
            raise ValueError(f"function not allowed: {node.func.id}")
        return fn(*[_safe_eval(a) for a in node.args])
    if isinstance(node, (ast.Tuple, ast.List)):
        return [_safe_eval(e) for e in node.elts]
    raise ValueError(f"expression not allowed: {type(node).__name__}")


def calculator(expression: str) -> ToolResult:
    """Evaluate arithmetic safely (no eval())."""
    expr = (expression or "").strip().replace("^", "**").replace("×", "*").replace("÷", "/")
    if not expr:
        return ToolResult(False, "⚠️ Empty expression.")
    if len(expr) > 400:
        return ToolResult(False, "⚠️ Expression too long.")
    try:
        value = _safe_eval(ast.parse(expr, mode="eval"))
    except Exception as e:  # noqa: BLE001
        return ToolResult(False, f"🧮 Could not evaluate `{expr}`: {e}")
    if isinstance(value, float):
        pretty = f"{value:.10g}"
    else:
        pretty = str(value)
    return ToolResult(True, f"🧮 `{expr}` = **{pretty}**", data={"expression": expr, "value": value})


# ------------------------------------------------------------------ time ----
def current_time(timezone: str = "UTC") -> ToolResult:
    tz = (timezone or "UTC").strip()
    try:
        from zoneinfo import ZoneInfo

        now = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
        try:
            from datetime import datetime

            now = datetime.now(ZoneInfo(tz)).strftime("%Y-%m-%d %H:%M:%S %Z")
        except Exception:
            pass
        return ToolResult(True, f"🕒 **{tz}**: {now}", data={"timezone": tz, "time": now})
    except Exception as e:  # noqa: BLE001
        return ToolResult(False, f"🕒 time failed: {e}")


# ---------------------------------------------------------------- install ---
def install_model(source: str) -> ToolResult:
    """Install a model or dataset from a HF id/URL into /data/models (async)."""
    try:
        job = storage.install_async(source)
    except Exception as e:  # noqa: BLE001
        return ToolResult(False, f"📦 Could not start install: {e}")
    if job.status == "ready":
        return ToolResult(True, f"📦 **Already installed** — {job.progress}")
    if job.status == "failed":
        return ToolResult(False, f"📦 Install failed: {job.error}")
    return ToolResult(
        True,
        f"📦 **Downloading** `{job.source}` ({job.kind}) → "
        f"`{storage.MODELS}` (job `{job.job_id}`). Check the **Models** tab for progress.",
        data={"job_id": job.job_id, "source": job.source, "kind": job.kind},
    )


def list_installed_tool(kind: str = "") -> ToolResult:
    items = storage.installed_models(kind or None)
    if not items:
        return ToolResult(True, "📦 No models installed yet.")
    lines = ["📦 **Installed**\n"]
    for it in items[:40]:
        lines.append(f"- `{it['id']}` — {it['kind']} · {storage.human_bytes(it.get('size_bytes', 0))}"
                     f" · {it.get('files', 0)} files")
    return ToolResult(True, "\n".join(lines), data={"items": items})


def dataset_overview(source: str, keyword: str = "") -> ToolResult:
    """Inspect a dataset repo (files + sizes) without downloading everything."""
    try:
        parsed = storage.parse_source(source)
    except Exception as e:  # noqa: BLE001
        return ToolResult(False, f"📚 {e}")
    try:
        from huggingface_hub import HfApi

        api = HfApi(token=os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACEHUB_API_TOKEN") or None)
        files = api.list_repo_files(parsed["repo_id"], repo_type=parsed["kind"])
    except Exception as e:  # noqa: BLE001
        return ToolResult(False, f"📚 Could not list {parsed['repo_id']}: {e}")
    if keyword:
        files = [f for f in files if keyword.lower() in f.lower()]
    lines = [f"📚 **{parsed['repo_id']}** ({parsed['kind']}) — {len(files)} files\n"]
    for f in files[:60]:
        lines.append(f"- `{f}`")
    if len(files) > 60:
        lines.append(f"- … and {len(files) - 60} more")
    return ToolResult(True, "\n".join(lines), data={"repo_id": parsed["repo_id"], "files": files})


# ------------------------------------------------------- tool schema/dispatch -
TOOL_SPECS: List[Dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the public web for current information. Use for news, "
                           "prices, releases, anything after your training cutoff.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"},
                    "limit": {"type": "integer", "description": "Max results (1-8)", "default": 5},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_page",
            "description": "Read a web page and return its visible text. Use after web_search "
                           "to read a promising result in full.",
            "parameters": {
                "type": "object",
                "properties": {"url": {"type": "string", "description": "Absolute http(s) URL"}},
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "calculator",
            "description": "Evaluate an arithmetic expression exactly (supports sqrt, log, "
                           "sin, factorial, pi, e).",
            "parameters": {
                "type": "object",
                "properties": {"expression": {"type": "string"}},
                "required": ["expression"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "current_time",
            "description": "Current date and time in a timezone.",
            "parameters": {
                "type": "object",
                "properties": {"timezone": {"type": "string", "default": "UTC"}},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "install_model",
            "description": "Download a Hugging Face model or dataset into local storage so it "
                           "can be used later. Accepts an id like 'Qwen/Qwen2.5-1.5B-Instruct' "
                           "or 'datasets/open-r1/OpenR1-Math', or a huggingface.co URL.",
            "parameters": {
                "type": "object",
                "properties": {
                    "source": {"type": "string", "description": "HF repo id or URL"},
                },
                "required": ["source"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_installed",
            "description": "List models and datasets already downloaded to local storage.",
            "parameters": {"type": "object", "properties": {"kind": {"type": "string"}}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "dataset_overview",
            "description": "List the files inside a Hugging Face dataset or model repo "
                           "without downloading it.",
            "parameters": {
                "type": "object",
                "properties": {
                    "source": {"type": "string"},
                    "keyword": {"type": "string", "description": "Optional filename filter"},
                },
                "required": ["source"],
            },
        },
    },
]

TOOL_IMPLS: Dict[str, Callable[..., ToolResult]] = {
    "web_search": web_search,
    "fetch_page": fetch_page,
    "calculator": calculator,
    "current_time": current_time,
    "install_model": install_model,
    "list_installed": list_installed_tool,
    "dataset_overview": dataset_overview,
}


def run_tool(name: str, arguments: Dict[str, Any] | str) -> ToolResult:
    """Execute a tool by name with JSON-ish arguments."""
    fn = TOOL_IMPLS.get(name)
    if fn is None:
        return ToolResult(False, f"⚠️ Unknown tool: {name}")
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments or "{}")
        except Exception:
            arguments = {}
    try:
        return fn(**arguments) if isinstance(arguments, dict) else fn()
    except TypeError as e:
        return ToolResult(False, f"⚠️ Bad arguments for {name}: {e}")
    except Exception as e:  # noqa: BLE001
        log.exception("tool %s failed", name)
        return ToolResult(False, f"⚠️ {name} failed: {e}")


# --------------------------------------------------- detect intent in text ---
_URL_RE = re.compile(r"https?://huggingface\.co/(?:datasets/)?[\w.\-]+/[\w.\-]+", re.I)
_HF_ID_RE = re.compile(r"\b(?:datasets/)?[A-Za-z0-9][\w.\-]*/[\w.\-]+\b")
_INSTALL_WORDS = ("install", "download", "add model", "add this model", "fetch model",
                  "pull model", "install this", "store this", "save this model",
                  "install model", "model add", "add dataset", "install dataset")


def wants_install(text: str) -> bool:
    t = (text or "").lower()
    return any(w in t for w in _INSTALL_WORDS)


def looks_like_database(text: str) -> bool:
    return "dataset" in (text or "").lower()


def extract_hf_source(text: str) -> Optional[str]:
    """Find a HF repo reference in free text, e.g. 'install Qwen/Qwen2.5-1.5B'."""
    t = (text or "").strip()
    m = _URL_RE.search(t)
    if m:
        return m.group(0)
    # Prefer a token that was explicitly marked as a dataset.
    m = re.search(r"datasets?/([\w.\-]+/[\w.\-]+)", t, re.I)
    if m:
        return "datasets/" + m.group(1)
    for cand in _HF_ID_RE.findall(t):
        if "/" not in cand or cand.lower().startswith(("http", "www")):
            continue
        owner, name = cand.split("/", 1)
        if "." in owner:  # looks like a domain, not a repo
            continue
        # Require a model-ish name so "I/O" or "and/or" never matches.
        if re.search(r"(model|instruct|chat|coder|llama|qwen|mistral|phi|gemma|starcoder|deepseek|whisper|bert|gpt|t5|dataset)",
                     name, re.I):
            return cand
    return None


# ------------------------------------------------------- model tool loop -----
def tool_prompt_block() -> str:
    """Text injected into the system prompt telling the model what it can call."""
    return (
        "\n\nYou have tools. To use one, reply with a single line of JSON and nothing else:\n"
        '{"tool": "<name>", "arguments": {<args>}}\n'
        "Available tools: web_search(query, limit), fetch_page(url), calculator(expression), "
        "current_time(timezone), install_model(source), list_installed(kind), "
        "dataset_overview(source, keyword).\n"
        "If you need a tool, call it and wait for the observation before answering. "
        "When you are ready to answer the user, just write the answer (no JSON). "
        "Cite URLs you used."
    )


_JSON_LINE = re.compile(r"^\s*\{.*\"tool\"\s*:.*\}\s*$", re.S)


def parse_tool_call(text: str) -> Optional[Tuple[str, Dict[str, Any]]]:
    """Extract (name, args) from a model reply, if it is a tool call."""
    if not text:
        return None
    candidate = text.strip()
    # Strip markdown fences if the model wrapped its JSON.
    candidate = re.sub(r"^```(?:json)?\s*|\s*```$", "", candidate).strip()
    if not (candidate.startswith("{") and candidate.endswith("}")):
        return None
    try:
        obj = json.loads(candidate)
    except Exception:
        return None
    if not isinstance(obj, dict) or "tool" not in obj:
        return None
    name = str(obj.get("tool", "")).strip()
    args = obj.get("arguments") or obj.get("args") or {}
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except Exception:
            args = {"query": args}
    if not isinstance(args, dict):
        args = {}
    return (name, args) if name in TOOL_IMPLS else None


def auto_tools_for(message: str, enabled: bool) -> List[str]:
    """Which tools the UI should run before answering."""
    if not enabled:
        return []
    t = (message or "").lower()
    tools: List[str] = []
    if wants_install(t):
        tools.append("install")
    if re.search(r"\b(search|google|look ?up|latest|news|today|current|weather|price|release)\b", t):
        tools.append("web")
    if re.search(r"https?://", t):
        tools.append("fetch")
    if re.search(r"\b(calculate|compute|what is)\b.*[0-9].*[+\-*/^%]|\d+\s*[+\-*/^%]\s*\d+", t):
        tools.append("calc")
    if re.search(r"\b(time|date|today|day)\b.*\b(now|current|today|is it|in)\b", t):
        tools.append("time")
    return tools
