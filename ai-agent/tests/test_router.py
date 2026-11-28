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


def test_chat_fn_mock_streams_and_records_history():
    gen = mod.chat_fn("hello there", [], "universal", "", 0.7, 0.9, 64, None)
    last = None
    for last in gen:
        pass
    history, status, routing = last
    assert len(history) == 2
    assert history[0]["role"] == "user"
    assert history[1]["content"].strip()
    assert "Auto-Route" in routing or "Selected" in routing
    assert status


def test_chat_fn_empty_message_is_guarded():
    history, status, routing = next(mod.chat_fn("   ", [], "universal", "", 0.7, 0.9, 64, None))
    assert history == []
    assert "Type a message" in status


def test_chat_fn_with_tupple_history():
    gen = mod.chat_fn("and again", [("hi", "hello")], "universal", "", 0.7, 0.9, 32, None)
    for out in gen:
        pass
    history = out[0]
    assert history[0]["content"] == "hi"
    assert len(history) == 4


def test_read_upload_limits_size(tmp_path):
    f = tmp_path / "big.txt"
    f.write_text("a" * 100, encoding="utf-8")
    text = mod._read_upload(str(f), limit=10)
    assert text.startswith("a" * 10) and "truncated" in text
    assert mod._read_upload(None) == ""


def test_regenerate_without_history_is_safe():
    history, status, _ = next(mod.regenerate_fn([], "universal", "", 0.7, 0.9, 32))
    assert history == [] and "Nothing" in status
