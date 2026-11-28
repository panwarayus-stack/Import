#!/usr/bin/env python3
"""
Persistent storage for the AI Agent.

Everything lives under one root (default ``/data``, as on Hugging Face Spaces
persistent storage) and is scoped **per client IP**, not per user account:

    /data/
    ├── chats/
    │   └── <ip-key>/                 one directory per client IP
    │       ├── index.json            chat list (id, title, updated, turns)
    │       └── <chat-id>.json        full transcript
    ├── models/
    │   ├── index.json                installed model/dataset registry
    │   ├── <owner>__<name>/          snapshot_download() target
    │   └── ...
    ├── uploads/
    │   └── <ip-key>/<file>           attachments kept with the chat
    └── meta.json                     storage info (root, created, version)

Design notes
------------
* ``ip_key()`` is a **salted hash** of the IP, never the raw address: chats are
  stable per IP across restarts but the directory name is not reversible
  without the salt. Rotate ``DATA_IP_SALT`` to fork the namespace.
* Writes are atomic (temp file + ``os.replace``) so a crash or a Space restart
  cannot leave a half-written transcript.
* The root is auto-detected: ``$DATA_DIR`` → ``/data`` → ``/root/data`` →
  ``./data`` next to the app → temp dir. The first *writable* candidate wins,
  so the exact layout the Space uses is the layout you also get locally.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import threading
import time
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

log = logging.getLogger("ai-agent.storage")

# ------------------------------------------------------------------ paths ----
def _writable(p: Path) -> bool:
    try:
        p.mkdir(parents=True, exist_ok=True)
        probe = p / f".probe-{os.getpid()}"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return True
    except Exception:
        return False


def _pick_root() -> Tuple[Path, str]:
    candidates: List[Tuple[str, Path]] = []
    env = os.getenv("DATA_DIR", "").strip()
    if env:
        candidates.append(("DATA_DIR", Path(env).expanduser()))
    candidates += [
        ("/data (HF Space persistent storage)", Path("/data")),
        ("/root/data", Path("/root/data")),
        ("app data dir", Path(__file__).resolve().parent / "data"),
        ("temp dir", Path(os.getenv("TMPDIR", "/tmp")) / "ai-agent-data"),
    ]
    for label, path in candidates:
        if _writable(path):
            return path, label
    raise RuntimeError("no writable storage location found")


DATA_ROOT, DATA_ROOT_SOURCE = _pick_root()
CHATS = DATA_ROOT / "chats"
MODELS = DATA_ROOT / "models"
UPLOADS = DATA_ROOT / "uploads"
MODEL_INDEX = MODELS / "index.json"

_IP_SALT = os.getenv("DATA_IP_SALT", "ai-agent-v1")  # change to fork namespaces
_LOCK = threading.RLock()

SHARED_IP_KEY = "shared"  # used when the client IP cannot be determined


def ensure_layout() -> None:
    for d in (DATA_ROOT, CHATS, MODELS, UPLOADS):
        d.mkdir(parents=True, exist_ok=True)
    meta = DATA_ROOT / "meta.json"
    if not meta.exists():
        _atomic_write_json(meta, {
            "version": 1,
            "created": time.time(),
            "root_source": DATA_ROOT_SOURCE,
        })


# ---------------------------------------------------------------- helpers ----
def _atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp{os.getpid()}")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _read_json(path: Path, default: Any) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except Exception as e:  # corrupt file → don't crash the app
        log.warning("could not read %s: %s", path, e)
        return default


def ip_key(ip: Optional[str]) -> str:
    """Salted, stable pseudonym for a client IP (safe to use as a directory)."""
    raw = (ip or "").strip()
    if not raw:
        return SHARED_IP_KEY
    digest = hashlib.sha256(f"{_IP_SALT}:{raw}".encode("utf-8")).hexdigest()
    return f"ip-{digest[:20]}"


def request_ip(request: Any) -> Optional[str]:
    """Best-effort client IP from a Gradio ``gr.Request`` (proxy aware)."""
    if request is None:
        return None
    try:
        headers = getattr(request, "headers", None) or {}
        for h in ("x-forwarded-for", "x-real-ip", "cf-connecting-ip", "x-client-ip"):
            val = headers.get(h) or headers.get(h.title()) or ""
            if val:
                return str(val).split(",")[0].strip()
        client = getattr(request, "client", None)
        if client is not None:
            host = getattr(client, "host", None) or (client[0] if isinstance(client, tuple) else None)
            if host:
                return str(host)
    except Exception:
        pass
    return None


def _slug(text: str, limit: int = 60) -> str:
    text = re.sub(r"[^a-zA-Z0-9._-]+", "-", (text or "").strip()).strip("-.")
    return (text or "untitled")[:limit]


def _now() -> float:
    return time.time()


def human_bytes(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.1f}{unit}" if unit != "B" else f"{int(n)}B"
        n /= 1024
    return f"{n:.1f}TB"


def dir_size(path: Path) -> int:
    total = 0
    if not path.exists():
        return 0
    for p in path.rglob("*"):
        try:
            if p.is_file():
                total += p.stat().st_size
        except Exception:
            pass
    return total


# ------------------------------------------------------------------ chats ----
def _chat_dir(ip: Optional[str]) -> Path:
    return CHATS / ip_key(ip)


def _chat_index(ip: Optional[str]) -> Path:
    return _chat_dir(ip) / "index.json"


def list_chats(ip: Optional[str]) -> List[Dict[str, Any]]:
    """Chats belonging to this IP, newest first."""
    with _LOCK:
        items = _read_json(_chat_index(ip), [])
    return sorted(items, key=lambda c: c.get("updated", 0), reverse=True)


def new_chat_id() -> str:
    return f"{int(_now())}-{uuid.uuid4().hex[:8]}"


def save_chat(ip: Optional[str], chat_id: str, messages: List[Dict[str, str]],
              title: Optional[str] = None, model: str = "", extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Persist a transcript and update the IP's chat index."""
    chat_id = _slug(chat_id, 80) or new_chat_id()
    with _LOCK:
        d = _chat_dir(ip)
        d.mkdir(parents=True, exist_ok=True)
        if not title:
            first_user = next((m.get("content", "") for m in messages if m.get("role") == "user"), "")
            title = (first_user or "New chat").strip().replace("\n", " ")[:80] or "New chat"
        record = {
            "id": chat_id,
            "title": title,
            "model": model,
            "updated": _now(),
            "turns": sum(1 for m in messages if m.get("role") == "user"),
            "messages": messages,
        }
        if extra:
            record.update(extra)
        _atomic_write_json(d / f"{chat_id}.json", record)

        index = _read_json(_chat_index(ip), [])
        summary = {k: v for k, v in record.items() if k != "messages"}
        index = [c for c in index if c.get("id") != chat_id] + [summary]
        _atomic_write_json(_chat_index(ip), index)
        return summary


def load_chat(ip: Optional[str], chat_id: str) -> Optional[Dict[str, Any]]:
    with _LOCK:
        rec = _read_json(_chat_dir(ip) / f"{_slug(chat_id, 80)}.json", None)
    return rec


def delete_chat(ip: Optional[str], chat_id: str) -> bool:
    with _LOCK:
        d = _chat_dir(ip)
        path = d / f"{_slug(chat_id, 80)}.json"
        removed = False
        if path.exists():
            try:
                path.unlink()
                removed = True
            except Exception:
                pass
        index = [c for c in _read_json(_chat_index(ip), []) if c.get("id") != chat_id]
        _atomic_write_json(_chat_index(ip), index)
        return removed


def rename_chat(ip: Optional[str], chat_id: str, title: str) -> bool:
    rec = load_chat(ip, chat_id)
    if not rec:
        return False
    save_chat(ip, chat_id, rec.get("messages", []), title=title,
              model=rec.get("model", ""))
    return True


def chat_count(ip: Optional[str]) -> int:
    return len(list_chats(ip))


def save_upload(ip: Optional[str], filename: str, content: bytes) -> Path:
    d = UPLOADS / ip_key(ip)
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{int(_now())}-{_slug(filename, 80)}"
    path.write_bytes(content)
    return path


# ----------------------------------------------------------------- models ----
@dataclass
class InstalledModel:
    id: str                       # local id used by the app ("local/<name>")
    kind: str                     # model | dataset
    source: str                   # original repo id / URL
    path: str                     # on-disk directory
    params: str = ""
    category: str = "chat"
    note: str = ""
    files: int = 0
    size_bytes: int = 0
    installed: float = field(default_factory=time.time)
    status: str = "ready"         # ready | downloading | failed
    error: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def _load_model_index() -> List[Dict[str, Any]]:
    return _read_json(MODEL_INDEX, [])


def _save_model_index(items: List[Dict[str, Any]]) -> None:
    _atomic_write_json(MODEL_INDEX, items)


def installed_models(kind: Optional[str] = None) -> List[Dict[str, Any]]:
    items = _load_model_index()
    if kind:
        items = [i for i in items if i.get("kind") == kind]
    return sorted(items, key=lambda i: i.get("installed", 0), reverse=True)


def get_installed(model_id: str) -> Optional[Dict[str, Any]]:
    for item in _load_model_index():
        if item.get("id") == model_id or item.get("source") == model_id:
            return item
    return None


def upsert_installed(record: Dict[str, Any]) -> None:
    with _LOCK:
        items = [i for i in _load_model_index() if i.get("id") != record.get("id")]
        items.append(record)
        _save_model_index(items)


def remove_installed(model_id: str, delete_files: bool = True) -> bool:
    with _LOCK:
        items = _load_model_index()
        target = next((i for i in items if i.get("id") == model_id), None)
        if not target:
            return False
        if delete_files:
            path = Path(target.get("path", ""))
            if str(path).startswith(str(MODELS)) and path.exists():
                shutil.rmtree(path, ignore_errors=True)
        _save_model_index([i for i in items if i.get("id") != model_id])
        return True


# ------------------------------------------------------- source parsing -----
_HF_URL = re.compile(
    r"^(?:https?://)?(?:www\.)?huggingface\.co/(?:(datasets)/)?([\w.\-]+)/([\w.\-]+)"
    # trailing /tree/main/<sub/dirs>, /blob/main/file, /resolve/main/file — any depth
    r"(?:/(?:tree|blob|resolve|discussions)/[\w.\-/]+)?/?(?:\?.*)?$"
)
_SHORT = re.compile(r"^(?:(datasets)/)?([\w.\-]+)/([\w.\-]+)$")


def parse_source(text: str) -> Dict[str, Any]:
    """Parse a model/dataset reference.

    Accepts:
        Qwen/Qwen2.5-1.5B-Instruct
        datasets/open-r1/OpenR1-Math
        https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct
        https://huggingface.co/datasets/allenai/c4?keyword=small
        hf://datasets/mybucket/mydata
        https://huggingface.co/datasets/owner/name/tree/main/subdir
    """
    raw = (text or "").strip()
    if not raw:
        raise ValueError("empty reference")
    kind = "model"
    keyword = ""
    if "?" in raw:
        raw, _, query = raw.partition("?")
        m = re.search(r"(?:^|&)keyword=([^&]+)", query)
        if m:
            keyword = m.group(1)

    cleaned = raw.replace("hf://", "").rstrip("/")
    m = _HF_URL.match(cleaned) or _SHORT.match(cleaned)
    if not m:
        raise ValueError(
            f"not a Hugging Face repo id or URL: {raw!r} "
            "(expected 'owner/name' or 'https://huggingface.co/owner/name')"
        )
    if m.group(1):
        kind = "dataset"
    owner, name = m.group(2), m.group(3)
    return {"kind": kind, "repo_id": f"{owner}/{name}", "keyword": keyword, "raw": text.strip()}


# ---------------------------------------------------- install (downloads) ---
@dataclass
class InstallJob:
    job_id: str
    source: str
    kind: str
    status: str = "pending"      # pending | downloading | ready | failed
    progress: str = ""
    files: int = 0
    size_bytes: int = 0
    error: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


_JOBS: Dict[str, InstallJob] = {}
_JOBS_LOCK = threading.Lock()


def _job_update(job: InstallJob, **kw: Any) -> None:
    with _JOBS_LOCK:
        for k, v in kw.items():
            setattr(job, k, v)


def get_job(job_id: str) -> Optional[InstallJob]:
    with _JOBS_LOCK:
        return _JOBS.get(job_id)


def jobs_snapshot() -> List[Dict[str, Any]]:
    with _JOBS_LOCK:
        return [j.to_dict() for j in _JOBS.values()]


def _download(source: str, token: Optional[str], job: InstallJob) -> Dict[str, Any]:
    """Download a model or dataset snapshot into /data/models/<owner>__<name>."""
    parsed = parse_source(source)
    kind, repo_id, keyword = parsed["kind"], parsed["repo_id"], parsed["keyword"]
    if not keyword:
        # datasets/allenai/c4/tree/main/en → subfolder 'en' works as a keyword too
        m = re.search(r"/(?:tree|blob)/(?:[\w.\-]+)/([\w.\-/]+)$", source.strip())
        if m and kind == "dataset":
            keyword = m.group(1).strip("/").split("/")[-1]

    from huggingface_hub import snapshot_download  # local import: optional dep

    dest = MODELS / f"{_slug(repo_id.replace('/', '__'))}"
    dest.mkdir(parents=True, exist_ok=True)
    _job_update(job, status="downloading", progress=f"resolving {repo_id}…")

    allow = None
    if keyword:
        kw = keyword.lower()
        allow = [f"*{kw}*.json", f"*{kw}*.jsonl", f"*{kw}*.txt", f"*{kw}*.csv",
                 f"*{kw}*.parquet", f"*{kw}*/*"]
        _job_update(job, progress=f"selecting files matching keyword={keyword}")

    snapshot_download(
        repo_id=repo_id,
        repo_type="dataset" if kind == "dataset" else "model",
        local_dir=str(dest),
        token=token or None,
        allow_patterns=allow,
        ignore_patterns=None if kind == "dataset" else ["*.safetensors.index.json.orig", "*.gguf", "original/*"],
    )

    size = dir_size(dest)
    files = sum(1 for p in dest.rglob("*") if p.is_file())
    record = {
        "id": f"local/{_slug(repo_id.replace('/', '-'), 60)}",
        "kind": kind,
        "source": repo_id,
        "path": str(dest),
        "category": "dataset" if kind == "dataset" else "chat",
        "note": f"{files} files, {human_bytes(size)}" + (f", keyword={keyword}" if keyword else ""),
        "files": files,
        "size_bytes": size,
        "installed": _now(),
        "status": "ready",
        "error": "",
    }
    upsert_installed(record)
    _job_update(job, status="ready", progress="done", files=files, size_bytes=size)
    return record


def install_async(source: str, token: Optional[str] = None) -> InstallJob:
    """Start a background download; returns immediately with a job handle."""
    job = InstallJob(job_id=uuid.uuid4().hex[:10], source=source, kind="")
    try:
        parsed = parse_source(source)
        job.kind = parsed["kind"]
    except Exception as e:
        job.status = "failed"
        job.error = str(e)
    with _JOBS_LOCK:
        _JOBS[job.job_id] = job
    if job.status == "failed":
        return job

    # Refuse duplicate work.
    existing = get_installed(parsed["repo_id"])
    if existing and existing.get("status") == "ready":
        job.status = "ready"
        job.progress = f"already installed at {existing['path']}"
        job.files = existing.get("files", 0)
        job.size_bytes = existing.get("size_bytes", 0)
        return job

    def _run() -> None:
        try:
            _download(source, token, job)
        except Exception as e:  # noqa: BLE001
            log.exception("install failed: %s", source)
            _job_update(job, status="failed", error=str(e)[:500], progress="failed")

    threading.Thread(target=_run, daemon=True, name=f"install-{job.job_id}").start()
    return job


def disk_usage() -> Dict[str, int]:
    return {
        "chats": dir_size(CHATS),
        "models": dir_size(MODELS),
        "uploads": dir_size(UPLOADS),
        "total": dir_size(DATA_ROOT),
    }


def storage_summary() -> str:
    u = disk_usage()
    free = shutil.disk_usage(DATA_ROOT).free if DATA_ROOT.exists() else 0
    return (
        f"`{DATA_ROOT}` ({DATA_ROOT_SOURCE}) · chats {human_bytes(u['chats'])} · "
        f"models {human_bytes(u['models'])} · free {human_bytes(free)}"
    )


ensure_layout()
