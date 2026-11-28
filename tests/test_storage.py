"""Persistent storage: per-IP isolation, atomic writes, source parsing, installs."""
import importlib
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture()
def store(tmp_path, monkeypatch):
    """Fresh storage module bound to a throwaway DATA_DIR."""
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    if "storage" in sys.modules:
        del sys.modules["storage"]
    mod = importlib.import_module("storage")
    mod.ensure_layout()
    return mod


def test_layout_created_under_data_dir(store, tmp_path):
    for d in (store.CHATS, store.MODELS, store.UPLOADS):
        assert d.is_dir()
        assert str(d).startswith(str(tmp_path))
    assert (store.DATA_ROOT / "meta.json").exists()


def test_ip_key_is_stable_and_hashed(store):
    a = store.ip_key("203.0.113.9")
    assert a == store.ip_key("203.0.113.9")           # stable
    assert a != store.ip_key("203.0.113.10")          # distinct per IP
    assert "203.0.113.9" not in a                     # never stores the raw IP
    assert a.startswith("ip-")
    assert store.ip_key(None) == store.SHARED_IP_KEY


def test_chats_are_isolated_per_ip(store):
    m1 = [{"role": "user", "content": "my secret is 42"}]
    m2 = [{"role": "user", "content": "another visitor"}]
    store.save_chat("1.1.1.1", "chatA", m1)
    store.save_chat("2.2.2.2", "chatB", m2)

    assert [c["id"] for c in store.list_chats("1.1.1.1")] == ["chatA"]
    assert [c["id"] for c in store.list_chats("2.2.2.2")] == ["chatB"]
    assert store.list_chats("3.3.3.3") == []
    # IP 1 cannot open IP 2's transcript
    assert store.load_chat("1.1.1.1", "chatB") is None
    assert store.load_chat("1.1.1.1", "chatA")["messages"] == m1


def test_save_updates_index_and_title(store):
    store.save_chat("1.1.1.1", "c1", [{"role": "user", "content": "Explain quantum tunnelling"}])
    idx = store.list_chats("1.1.1.1")
    assert len(idx) == 1
    assert idx[0]["title"].startswith("Explain quantum")
    assert idx[0]["turns"] == 1

    # Same id saves again → still one entry, updated
    store.save_chat("1.1.1.1", "c1", [
        {"role": "user", "content": "Explain quantum tunnelling"},
        {"role": "assistant", "content": "Sure"},
        {"role": "user", "content": "more"},
    ])
    idx = store.list_chats("1.1.1.1")
    assert len(idx) == 1 and idx[0]["turns"] == 2


def test_delete_and_rename(store):
    store.save_chat("1.1.1.1", "c1", [{"role": "user", "content": "hi"}])
    assert store.rename_chat("1.1.1.1", "c1", "Renamed chat") is True
    assert store.load_chat("1.1.1.1", "c1")["title"] == "Renamed chat"
    assert store.delete_chat("1.1.1.1", "c1") is True
    assert store.list_chats("1.1.1.1") == []
    assert store.load_chat("1.1.1.1", "c1") is None
    # deleting a chat of another IP must not work
    store.save_chat("2.2.2.2", "c2", [{"role": "user", "content": "hi"}])
    assert store.delete_chat("1.1.1.1", "c2") is False
    assert store.load_chat("2.2.2.2", "c2") is not None


def test_corrupt_index_does_not_crash(store):
    d = store.CHATS / store.ip_key("9.9.9.9")
    d.mkdir(parents=True, exist_ok=True)
    (d / "index.json").write_text("{not json", encoding="utf-8")
    assert store.list_chats("9.9.9.9") == []       # falls back to empty
    store.save_chat("9.9.9.9", "c9", [{"role": "user", "content": "ok"}])
    assert len(store.list_chats("9.9.9.9")) == 1    # recovers


def test_chat_id_is_sanitised(store):
    store.save_chat("1.1.1.1", "../../etc/passwd", [{"role": "user", "content": "x"}])
    # nothing may be written outside the chats dir
    assert not (store.DATA_ROOT.parent / "etc").exists()
    files = list((store.CHATS / store.ip_key("1.1.1.1")).glob("*.json"))
    assert all(f.parent == store.CHATS / store.ip_key("1.1.1.1") for f in files)


def test_save_upload_keeps_file_per_ip(store):
    p = store.save_upload("1.1.1.1", "notes.txt", b"hello")
    assert p.read_bytes() == b"hello"
    assert str(p).startswith(str(store.UPLOADS))


@pytest.mark.parametrize("text,kind,repo", [
    ("Qwen/Qwen2.5-1.5B-Instruct", "model", "Qwen/Qwen2.5-1.5B-Instruct"),
    ("https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct", "model", "Qwen/Qwen2.5-Coder-7B-Instruct"),
    ("https://huggingface.co/datasets/allenai/c4/tree/main/en", "dataset", "allenai/c4"),
    ("datasets/open-r1/OpenR1-Math", "dataset", "open-r1/OpenR1-Math"),
    ("hf://datasets/mybucket/mydata", "dataset", "mybucket/mydata"),
])
def test_parse_source(store, text, kind, repo):
    p = store.parse_source(text)
    assert p["kind"] == kind
    assert p["repo_id"] == repo


def test_parse_source_rejects_junk(store):
    for bad in ("", "not a repo", "http://example.com/x/y", "justonetoken"):
        with pytest.raises(ValueError):
            store.parse_source(bad)


def test_parse_source_keyword(store):
    p = store.parse_source("https://huggingface.co/datasets/allenai/c4?keyword=small")
    assert p["keyword"] == "small"


def test_install_records_and_removal(store, tmp_path):
    # Simulate a finished install without touching the network.
    target = store.MODELS / "owner__demo"
    target.mkdir(parents=True)
    (target / "config.json").write_text("{}", encoding="utf-8")
    store.upsert_installed({
        "id": "local/demo", "kind": "model", "source": "owner/demo",
        "path": str(target), "status": "ready",
        "files": 1, "size_bytes": 2, "installed": 1.0,
    })
    assert store.get_installed("owner/demo")["id"] == "local/demo"
    assert len(store.installed_models("model")) == 1
    assert store.remove_installed("local/demo", delete_files=True) is True
    assert not target.exists()
    assert store.installed_models() == []


def test_install_async_rejects_bad_source(store):
    job = store.install_async("this is not a repo")
    assert job.status == "failed" and job.error


def test_disk_usage_and_summary(store):
    store.save_chat("1.1.1.1", "c1", [{"role": "user", "content": "x" * 500}])
    usage = store.disk_usage()
    assert usage["chats"] > 0
    assert "chats" in store.storage_summary()


def test_request_ip_from_headers(store):
    class Req:
        def __init__(self, headers, client=None):
            self.headers = headers
            self.client = client

    assert store.request_ip(Req({"x-forwarded-for": "9.9.9.9, 10.0.0.1"})) == "9.9.9.9"
    assert store.request_ip(Req({"x-real-ip": "8.8.8.8"})) == "8.8.8.8"
    assert store.request_ip(Req({}, client=("7.7.7.7", 1234))) == "7.7.7.7"
    assert store.request_ip(None) is None
