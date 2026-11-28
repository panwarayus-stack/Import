"""Tools: calculator safety, HTML extraction, tool schema, intent detection."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import tools  # noqa: E402


# ------------------------------------------------------------- calculator ---
@pytest.mark.parametrize("expr,expected", [
    ("2+2", 4),
    ("sqrt(144)", 12),
    ("2^10", 1024),
    ("(3+4)*2", 14),
    ("max(1, 5, 3)", 5),
    ("log10(1000)", 3),
    ("round(pi, 3)", 3.142),
    ("10 % 3", 1),
    ("-5 + 2", -3),
])
def test_calculator_values(expr, expected):
    res = tools.calculator(expr)
    assert res.ok, res.text
    assert abs(res.data["value"] - expected) < 1e-9


@pytest.mark.parametrize("expr", [
    "__import__('os').system('ls')",
    "open('/etc/passwd').read()",
    "().__class__.__bases__",
    "exec('x=1')",
    "lambda: 1",
    "[x for x in range(10)]",
    "9**9**9",
])
def test_calculator_blocks_unsafe_input(expr):
    res = tools.calculator(expr)
    assert res.ok is False, f"should have been rejected: {expr}"


def test_calculator_empty_and_long():
    assert tools.calculator("").ok is False
    assert tools.calculator("1+" * 300).ok is False


# ------------------------------------------------------------------- html ---
def test_html_to_text_strips_scripts_and_keeps_content():
    html = """<html><head><title>My Page</title>
    <script>alert('x')</script><style>.a{}</style></head>
    <body><h1>Hello</h1><p>World &amp; friends</p>
    <div>Second<br>line</div></body></html>"""
    text = tools.html_to_text(html)
    assert "Hello" in text and "World & friends" in text
    assert "alert" not in text and ".a{}" not in text
    assert "<" not in text
    assert tools.html_to_text(html, limit=5) == text[:5]


def test_html_title():
    assert tools._title("<html><head><title> Foo \n bar </title></head></html>") == "Foo bar"
    assert tools._title("no title here") == ""


# ------------------------------------------------------------ tool schema ---
def test_tool_specs_and_impls_match():
    spec_names = {s["function"]["name"] for s in tools.TOOL_SPECS}
    assert spec_names == set(tools.TOOL_IMPLS)
    assert {"web_search", "fetch_page", "calculator", "install_model"} <= spec_names
    for spec in tools.TOOL_SPECS:
        assert spec["function"]["description"]
        assert spec["function"]["parameters"]["type"] == "object"


def test_run_tool_dispatch_and_errors():
    assert tools.run_tool("calculator", {"expression": "6*7"}).ok
    assert tools.run_tool("calculator", '{"expression": "6*7"}').ok        # JSON string args
    assert tools.run_tool("nope", {}).ok is False                          # unknown tool
    assert tools.run_tool("calculator", {"wrong": 1}).ok is False          # bad args
    assert "Unknown tool" in tools.run_tool("nope", {}).text


# --------------------------------------------------------------- intent ----
@pytest.mark.parametrize("text,expected", [
    ("install Qwen/Qwen2.5-1.5B-Instruct", "Qwen/Qwen2.5-1.5B-Instruct"),
    ("please download meta-llama/Llama-3.1-8B-Instruct for me", "meta-llama/Llama-3.1-8B-Instruct"),
    ("add https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct", "https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct"),
    ("install datasets/open-r1/OpenR1-Math", "datasets/open-r1/OpenR1-Math"),
    ("train on datasets/allenai/c4 please", "datasets/allenai/c4"),
])
def test_extract_hf_source(text, expected):
    assert tools.extract_hf_source(text) == expected


def test_extract_hf_source_ignores_prose():
    assert tools.extract_hf_source("I/O is slow and/or fine") is None
    assert tools.extract_hf_source("hello world") is None


@pytest.mark.parametrize("text", [
    "install this model", "download the dataset", "add model to storage", "pull model",
])
def test_wants_install(text):
    assert tools.wants_install(text)


def test_auto_tools_planning():
    assert "web" in tools.auto_tools_for("search the web for python 3.14 news", True)
    assert "calc" in tools.auto_tools_for("calculate 42*17", True)
    assert "fetch" in tools.auto_tools_for("read https://example.com/page", True)
    assert "install" in tools.auto_tools_for("install Qwen/Qwen2.5-1.5B", True)
    assert tools.auto_tools_for("search the web", False) == []       # disabled
    assert "time" in tools.auto_tools_for("what is the current time in delhi", True)


# ------------------------------------------------------------ tool calls ---
@pytest.mark.parametrize("reply,name,args", [
    ('{"tool": "calculator", "arguments": {"expression": "2+2"}}', "calculator", {"expression": "2+2"}),
    ('```json\n{"tool": "web_search", "arguments": {"query": "x"}}\n```', "web_search", {"query": "x"}),
    ('{"tool":"current_time","args":{}}', "current_time", {}),
])
def test_parse_tool_call(reply, name, args):
    parsed = tools.parse_tool_call(reply)
    assert parsed is not None
    assert parsed[0] == name
    assert parsed[1] == args


@pytest.mark.parametrize("reply", [
    "Just a normal answer.", "", "{}", '{"tool": "not_a_tool"}',
    '{"answer": 42}', "```python\nprint(1)\n```", '{"tool": "calculator"',
])
def test_parse_tool_call_rejects_non_calls(reply):
    assert tools.parse_tool_call(reply) is None


def test_tool_prompt_block_mentions_tools():
    block = tools.tool_prompt_block()
    for name in ("web_search", "install_model", "calculator"):
        assert name in block


# ------------------------------------------------------- offline behaviour ---
def test_web_search_empty_query_fails_soft():
    res = tools.web_search("")
    assert res.ok is False and "Empty" in res.text


def test_fetch_page_bad_input_fails_soft():
    assert tools.fetch_page("").ok is False
    # unreachable host must not raise
    res = tools.fetch_page("https://this-host-does-not-exist.invalid")
    assert res.ok is False and res.text.startswith("🌐")


def test_current_time():
    res = tools.current_time("Asia/Kolkata")
    assert res.ok and "IST" in res.text or "Asia/Kolkata" in res.text


def test_dataset_overview_rejects_bad_source():
    res = tools.dataset_overview("nonsense")
    assert res.ok is False


def test_install_model_bad_source():
    res = tools.install_model("nonsense")
    assert res.ok is False and "📦" in res.text
