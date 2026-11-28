"""Real (non-mock) local inference path: load → stream → cleanup.

Builds a tiny random-weight Llama model + word-level tokenizer in a temp dir,
so no Hugging Face download is needed. Skipped when torch/transformers are
not installed.
"""
import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

torch = pytest.importorskip("torch")
transformers = pytest.importorskip("transformers")
pytest.importorskip("gradio")

spec = importlib.util.spec_from_file_location(
    "ai_agent_app_local", Path(__file__).resolve().parents[1] / "app.py"
)
mod = importlib.util.module_from_spec(spec)
sys.modules["ai_agent_app_local"] = mod
spec.loader.exec_module(mod)

pytestmark = pytest.mark.skipif(not mod.HAS_LOCAL, reason="torch/transformers unavailable")


@pytest.fixture(scope="module")
def tiny_model_dir(tmp_path_factory):
    """Create a ~1MB random Llama model with a word-level tokenizer."""
    from tokenizers import Tokenizer, models, pre_tokenizers
    from transformers import LlamaConfig, LlamaForCausalLM, PreTrainedTokenizerFast

    vocab_tokens = ["<pad>", "<unk>", "<s>", "</s>", "<|im_start|>", "<|im_end|>",
                    "<|user|>", "<|assistant|>", "<|system|>"]
    words = ("hello hi there how are you write python function code solve math "
             "step answer the is a of to and in for with list string sort reverse "
             "linked node explain briefly final text reply assistant user").split()
    for w in words:
        if w not in vocab_tokens:
            vocab_tokens.append(w)
    vocab = {tok: i for i, tok in enumerate(vocab_tokens)}
    vocab["<unk>"] = vocab.get("<unk>", 1)

    d = tmp_path_factory.mktemp("tiny-llama")
    tok = Tokenizer(models.WordLevel(vocab=vocab, unk_token="<unk>"))
    tok.pre_tokenizer = pre_tokenizers.Whitespace()
    fast = PreTrainedTokenizerFast(
        tokenizer_object=tok, pad_token="<pad>", unk_token="<unk>",
        bos_token="<s>", eos_token="</s>",
    )
    fast.chat_template = (
        "{% for m in messages %}<|im_start|>{{ m['role'] }}\n{{ m['content'] }}<|im_end|>\n"
        "{% endfor %}{% if add_generation_prompt %}<|im_start|>assistant\n{% endif %}"
    )
    fast.save_pretrained(d)

    cfg = LlamaConfig(
        vocab_size=len(vocab), hidden_size=32, num_hidden_layers=2,
        num_attention_heads=4, num_key_value_heads=2, intermediate_size=64,
        max_position_embeddings=256,
    )
    torch.manual_seed(0)
    model = LlamaForCausalLM(cfg)
    model.save_pretrained(d)
    return str(d)


def _register(path: str):
    mod.MODEL_REGISTRY[path] = mod.ModelInfo(
        id=path, label="tiny-local", category="chat", params="tiny", ram_gb=0.1,
        zerogpu=False, gated=False, description="test", best_for="tests",
    )


def test_load_and_stream_real_model(tiny_model_dir):
    _register(tiny_model_dir)
    ok, msg = mod.MANAGER.load(tiny_model_dir, want_gpu=False)
    assert ok, msg
    assert mod.MANAGER.is_loaded(tiny_model_dir)
    assert mod.MANAGER.tokenizer.pad_token is not None
    assert mod.MANAGER.tokenizer.padding_side == "left"

    messages = [{"role": "user", "content": "hello there write python"}]
    chunks = list(mod.MANAGER.generate_stream(messages, max_new_tokens=8, temperature=0.7))
    assert chunks, "streamer produced nothing"
    assert isinstance(chunks[-1], str)
    # Progressive output must be a prefix-chain (streaming, not one blob).
    assert all(chunks[i + 1].startswith(chunks[i]) for i in range(len(chunks) - 1))


def test_greedy_generation_is_deterministic(tiny_model_dir):
    _register(tiny_model_dir)
    mod.MANAGER.load(tiny_model_dir, want_gpu=False)
    msgs = [{"role": "user", "content": "hello"}]
    a = list(mod.MANAGER.generate_stream(msgs, max_new_tokens=4, temperature=0.0))
    b = list(mod.MANAGER.generate_stream(msgs, max_new_tokens=4, temperature=0.0))
    assert a[-1] == b[-1]


def test_switching_models_frees_previous(tiny_model_dir):
    _register(tiny_model_dir)
    other = mod.MODEL_REGISTRY[tiny_model_dir].__class__(
        **{**mod.MODEL_REGISTRY[tiny_model_dir].__dict__, "label": "tiny-local-2"}
    )
    mod.MODEL_REGISTRY["/nonexistent-model"] = other.__class__(
        **{**other.__dict__, "id": "/nonexistent-model"}
    )
    mod.MANAGER.load(tiny_model_dir, want_gpu=False)
    ok, msg = mod.MANAGER.load("/nonexistent-model", want_gpu=False)
    assert not ok  # bad path must fail cleanly …
    assert mod.MANAGER.model is None  # … and must not leave a half-loaded model
    assert "Failed to load" in msg


def test_unload_releases_everything(tiny_model_dir):
    _register(tiny_model_dir)
    mod.MANAGER.load(tiny_model_dir, want_gpu=False)
    mod.MANAGER.unload()
    assert mod.MANAGER.model is None and mod.MANAGER.tokenizer is None
    assert mod.MANAGER.model_id is None


def test_chat_fn_real_backend_streams(tiny_model_dir, monkeypatch):
    _register(tiny_model_dir)
    monkeypatch.setattr(mod, "MOCK", False)
    monkeypatch.setattr(mod, "HAS_LOCAL", True)
    monkeypatch.setattr(mod, "MODEL_CHOICES", mod.MODEL_CHOICES)
    outs = list(mod.chat_fn("hello", [], tiny_model_dir, "", 0.7, 0.9, 6, None))
    history, status, routing = outs[-1]
    assert len(history) == 2
    assert history[1]["content"].strip()
    assert "Selected" in routing
    assert "Done" in status or "Mock" in status


def test_gpu_generate_falls_back_to_cpu_without_cuda(tiny_model_dir):
    _register(tiny_model_dir)
    if mod.CUDA_AVAILABLE:
        pytest.skip("CUDA present — fallback path not exercised")
    mod.MANAGER.load(tiny_model_dir, want_gpu=False)
    moved, note = mod.MANAGER.ensure_device(want_gpu=True)
    assert moved is False
    assert "No CUDA" in note or "GPU" in note


def test_generation_crash_is_reported_not_hung(tiny_model_dir):
    """Regression: a failing generate() used to block the streamer for 180s."""
    import time as _time

    _register(tiny_model_dir)
    mod.MANAGER.load(tiny_model_dir, want_gpu=False)

    def boom(**kwargs):
        raise RuntimeError("token_type_ids not used by the model")

    orig = mod.MANAGER.model.generate
    mod.MANAGER.model.generate = boom
    try:
        t0 = _time.time()
        out = list(mod.MANAGER.generate_stream([{"role": "user", "content": "hi"}], max_new_tokens=4))
        took = _time.time() - t0
    finally:
        mod.MANAGER.model.generate = orig
    assert took < 15, f"stream hung for {took:.1f}s"
    assert out and "⚠️" in out[-1]
