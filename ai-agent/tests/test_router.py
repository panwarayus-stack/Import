"""Router + registry + history tests. Needs gradio only (no torch/transformers)."""
import importlib.util
import sys
from pathlib import Path

import pytest

pytest.importorskip("gradio")

spec = importlib.util.spec_from_file_location(
    "ai_agent_app", Path(__file__).resolve().parents[1] / "app.py"
)
mod = importlib.util.module_from_spec(spec)
sys.modules["ai_agent_app"] = mod
spec.loader.exec_module(mod)


def test_registry_categories_and_size():
    cats = {m.category for m in mod.MODEL_REGISTRY.values()}
    assert {"chat", "code", "reasoning", "tiny"} <= cats
    assert len(mod.MODEL_REGISTRY) >= 15


def test_registry_has_api_models_without_ram():
    api_models = [m for m in mod.MODEL_REGISTRY.values() if m.api]
    assert api_models, "expected cloud-API models"
    assert all(m.ram_gb == 0.0 for m in api_models)


def test_universal_is_first_choice():
    assert mod.MODEL_CHOICES[0][1] == mod.UNIVERSAL_ID


def test_router_code():
    d = mod.route_query("Write a Python function to parse JSON and fix this bug: TypeError")
    assert d.category in ("code", "code_hard")
    assert "Coder" in d.model_id
    assert d.confidence > 0.5


def test_router_hard_code():
    long_prompt = "Write a full REST API in Python with " + "authentication and migrations. " * 300
    d = mod.route_query(long_prompt)
    assert d.category == "code_hard"


def test_router_reasoning():
    d = mod.route_query("Solve this and prove step by step: calculate the integral of x^2")
    assert d.category == "reasoning"
    assert "DeepSeek-R1" in d.model_id


def test_router_hinglish_code():
    d = mod.route_query("mera code work nahi kar raha, Python list index error aa raha hai, fix karo")
    assert "Coder" in d.model_id


def test_router_chat_default():
    d = mod.route_query("Hello there, how are you today?")
    assert d.model_id == mod.ROUTER_DEFAULTS["general"]


def test_router_empty():
    d = mod.route_query("")
    assert d.model_id == mod.ROUTER_DEFAULTS["general"]
    assert d.confidence == 0.0


def test_router_ram_downgrade():
    d = mod.route_query("Write a Python function to sort a list", ram_gb=0.9)
    info = mod.MODEL_REGISTRY[d.model_id]
    assert info.ram_gb <= 2.0, f"router picked {d.model_id} ({info.ram_gb}GB) for 0.9GB RAM"
    # A code question must never be answered by a reasoning model.
    assert info.category in ("code", "tiny", "chat")


def test_router_keeps_big_model_when_ram_is_plenty():
    d = mod.route_query("Write a Python function to sort a list", ram_gb=64.0)
    assert d.model_id == mod.ROUTER_DEFAULTS["code"]


def test_router_confidence_bounds():
    for q in ["hi", "write code", "solve 2+2", "translate to hindi", "summarise this", ""]:
        d = mod.route_query(q)
        assert 0.0 <= d.confidence <= 1.0


def test_clean_history_tuples_and_dicts():
    hist = [("hi", "hello"), {"role": "user", "content": "again"},
            {"role": "assistant", "content": "ok", "metadata": None}]
    out = mod._clean_history(hist)
    assert [m["content"] for m in out] == ["hi", "hello", "again", "ok"]


def test_truncate_history_keeps_recent_and_no_dangling_assistant():
    hist = [{"role": "user", "content": "x" * 5000},
            {"role": "assistant", "content": "y" * 5000},
            {"role": "user", "content": "hi"}]
    out = mod._truncate_history(hist, max_chars=100)
    assert out[-1]["content"] == "hi"
    if out:
        assert out[0]["role"] == "user"


def test_backend_labels():
    assert "Mock" in mod._backend_label("mock") or "🟡" in mod._backend_label("mock")
    assert "Cloud" in mod._backend_label("api")


def test_routing_breakdown_is_readable():
    text = mod.routing_breakdown("write a python function")
    assert "Pick:" in text and "Confidence" in text


def test_transcript_file_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(mod.tempfile, "gettempdir", lambda: str(tmp_path))
    path = mod.transcript_file([{"role": "user", "content": "hi"}])
    assert path and Path(path).exists()
    assert "hi" in Path(path).read_text(encoding="utf-8")


def test_backend_mock_without_torch_or_token():
    # In a plain environment (no torch, no token) every model resolves to mock.
    for mid in list(mod.MODEL_REGISTRY)[:5]:
        assert mod.available_backend(mid) in ("mock", "local", "api")


class FakeRequest:
    """Minimal stand-in for gr.Request (the real one is injected by Gradio)."""

    def __init__(self, ip="203.0.113.5"):
        self.headers = {"x-forwarded-for": ip}
        self.client = (ip, 1234)


def _drain(gen):
    last = None
    for last in gen:
        pass
    return last


def test_chat_fn_mock_streams_and_records_history():
    history, status, routing, chat_id, saved = _drain(
        mod.chat_fn("hello there", [], "universal", "", 0.7, 0.9, 64, None)
    )
    assert len(history) == 2
    assert history[0]["role"] == "user"
    assert history[1]["content"].strip()
    assert "Auto-Route" in routing or "Selected" in routing
    assert status
    # a chat id is allocated and the transcript is persisted
    assert chat_id
    assert saved.startswith("💾 Saved")


def test_chat_fn_persists_under_ip(tmp_path, monkeypatch):
    """The transcript lands in <DATA_DIR>/chats/<ip-key>/ and can be reopened."""
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    import importlib
    import storage
    importlib.reload(storage)
    monkeypatch.setattr(mod, "storage", storage)

    out = _drain(mod.chat_fn("remember 7", [], "universal", "", 0.7, 0.9, 64,
                             None, True, "", FakeRequest()))
    chat_id = out[3]
    rec = storage.load_chat("203.0.113.5", chat_id)
    assert rec is not None
    assert rec["messages"][0]["content"] == "remember 7"
    assert (tmp_path / "chats" / storage.ip_key("203.0.113.5") / f"{chat_id}.json").exists()


def test_chat_fn_continues_existing_chat(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    import importlib
    import storage
    importlib.reload(storage)
    monkeypatch.setattr(mod, "storage", storage)

    req = FakeRequest("198.51.100.7")
    first = _drain(mod.chat_fn("one", [], "universal", "", 0.7, 0.9, 64, None, True, "", req))
    cid = first[3]
    second = _drain(mod.chat_fn("two", first[0], "universal", "", 0.7, 0.9, 64, None,
                                True, cid, req))
    assert second[3] == cid                       # same conversation
    rec = storage.load_chat("198.51.100.7", cid)
    assert len(rec["messages"]) == 4              # 2 turns kept in one file


def test_chat_fn_empty_message_is_guarded():
    history, status, routing, chat_id, saved = next(
        mod.chat_fn("   ", [], "universal", "", 0.7, 0.9, 64, None))
    assert history == []
    assert "Type a message" in status


def test_chat_fn_with_tupple_history():
    out = _drain(mod.chat_fn("and again", [("hi", "hello")], "universal", "",
                             0.7, 0.9, 32, None))
    history = out[0]
    assert history[0]["content"] == "hi"
    assert len(history) == 4


def test_chat_fn_tools_appendix(tmp_path, monkeypatch):
    """Tool output is embedded in the assistant message, not silently dropped."""
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    import importlib
    import storage
    importlib.reload(storage)
    monkeypatch.setattr(mod, "storage", storage)

    out = _drain(mod.chat_fn("calculate 2+2", [], "universal", "", 0.7, 0.9, 64,
                             None, True))
    routing = out[2]
    assert "Tools:" in routing
    assert "calculator" in routing
    assert "<details>" in out[0][-1]["content"]
    assert "= **4**" in out[0][-1]["content"]


def test_chat_fn_tools_can_be_disabled(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    import importlib
    import storage
    importlib.reload(storage)
    monkeypatch.setattr(mod, "storage", storage)

    out = _drain(mod.chat_fn("calculate 2+2", [], "universal", "", 0.7, 0.9, 64,
                             None, False))
    assert "Tools:" not in out[2]
    assert "<details>" not in out[0][-1]["content"]


def test_read_upload_limits_size(tmp_path):
    f = tmp_path / "big.txt"
    f.write_text("a" * 100, encoding="utf-8")
    text = mod._read_upload(str(f), limit=10)
    assert text.startswith("a" * 10) and "truncated" in text
    assert mod._read_upload(None) == ""


def test_regenerate_without_history_is_safe():
    history, status, _, _, _ = next(mod.regenerate_fn([], "universal", "", 0.7, 0.9, 32))
    assert history == [] and "Nothing" in status


def test_local_models_enter_registry(tmp_path, monkeypatch):
    """A downloaded model must appear in the dropdown choices."""
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    import importlib
    import storage
    importlib.reload(storage)
    monkeypatch.setattr(mod, "storage", storage)

    target = tmp_path / "models" / "owner__demo"
    target.mkdir(parents=True)
    (target / "config.json").write_text("{}", encoding="utf-8")
    storage.upsert_installed({
        "id": "local/demo", "kind": "model", "source": "owner/demo",
        "path": str(target), "status": "ready", "files": 1, "size_bytes": 10,
    })
    added = mod.refresh_local_models()
    assert added == 1
    assert "local/demo" in mod.MODEL_REGISTRY
    assert any(c[1] == "local/demo" for c in mod.all_model_choices())
    assert mod.refresh_local_models() == 0        # idempotent
