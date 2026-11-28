"""Gradio 5/6 compatibility guards.

The Space installs its own Gradio (6.x) into the same pip run as
requirements.txt, so:
  * app.py must build its UI from whichever kwargs the installed Gradio accepts
  * requirements.txt must not pin gradio (that is what broke the 2026-11-28 build)
"""
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
pytest.importorskip("gradio")
import gradio as gr  # noqa: E402


# ----------------------------------------------------------- requirements ----
def test_requirements_does_not_pin_gradio():
    body = (ROOT / "requirements.txt").read_text(encoding="utf-8")
    active = [ln.strip() for ln in body.splitlines()
              if ln.strip() and not ln.strip().startswith("#")]
    offenders = [ln for ln in active if re.match(r"(?i)gradio(\[.*\])?\s*[<>=!~]", ln)]
    assert not offenders, (
        "requirements.txt must not pin gradio — Spaces installs its own version in "
        f"the same pip invocation and the build fails with ResolutionImpossible: {offenders}"
    )


def test_space_card_does_not_pin_sdk_version():
    head = (ROOT / "README.md").read_text(encoding="utf-8").split("---")[1]
    assert "sdk: gradio" in head
    assert "sdk_version" not in head.replace("# sdk_version intentionally omitted", ""), (
        "sdk_version pins the runtime's Gradio; leaving it out lets the Space use its own"
    )


# --------------------------------------------------------------- app.py ------
def test_chatbot_kwargs_are_valid_for_this_gradio():
    sys.path.insert(0, str(ROOT))
    import importlib

    mod = importlib.import_module("app")
    import inspect

    params = set(inspect.signature(gr.Chatbot.__init__).parameters)
    for key in mod._CHATBOT_KW:
        assert key in params, f"_CHATBOT_KW['{key}'] is not accepted by Chatbot {gr.__version__}"


def test_launch_kwargs_are_valid_for_this_gradio():
    import importlib
    import inspect

    sys.path.insert(0, str(ROOT))
    mod = importlib.import_module("app")
    params = set(inspect.signature(gr.Blocks.launch).parameters)
    for key in mod._LAUNCH_KW:
        assert key in params, f"_LAUNCH_KW['{key}'] is not accepted by launch() {gr.__version__}"


def test_theme_is_passed_exactly_once():
    """Gradio 5 keeps theme/css on Blocks, 6 on launch() — never both, never neither."""
    import importlib
    import inspect

    sys.path.insert(0, str(ROOT))
    mod = importlib.import_module("app")
    on_blocks = "theme" in mod._BLOCKS_KW
    on_launch = "theme" in mod._LAUNCH_KW
    assert on_blocks != on_launch, f"theme configured twice/missing (blocks={on_blocks}, launch={on_launch})"
    # And the selected place must really accept it.
    target = gr.Blocks.__init__ if on_blocks else gr.Blocks.launch
    assert "theme" in set(inspect.signature(target).parameters)


def test_app_builds_a_ui_object():
    import importlib

    sys.path.insert(0, str(ROOT))
    mod = importlib.import_module("app")
    assert mod.demo is not None
    assert len(mod.demo.blocks) > 10          # real UI, not an empty shell
    assert mod.MODEL_CHOICES and mod.MODEL_CHOICES[0][1] == mod.UNIVERSAL_ID


def test_chat_message_content_normalisation_for_gradio6():
    """Gradio 6 history carries list-of-block content; chat_fn must read it."""
    import importlib

    sys.path.insert(0, str(ROOT))
    mod = importlib.import_module("app")

    g6_history = [
        {"role": "user", "content": [{"type": "text", "text": "hello there"}]},
        {"role": "assistant", "content": [{"type": "text", "text": "hi!"}]},
    ]
    cleaned = mod._clean_history(g6_history)
    assert [m["content"] for m in cleaned] == ["hello there", "hi!"]
    assert all(isinstance(m["content"], str) for m in cleaned)


# ------------------------------------------------------- deploy dry-run -------
def _deploy_module():
    import importlib

    sys.path.insert(0, str(ROOT))
    return importlib.import_module("deploy")


def test_deploy_dry_run_passes_on_the_real_repo(capsys):
    mod = _deploy_module()
    rc = mod.main.__wrapped__ if hasattr(mod.main, "__wrapped__") else None  # not wrapped
    # Call the internal helpers directly so we never touch the network.
    problems = mod._check_space_config((ROOT / "README.md").read_text(encoding="utf-8"))
    problems += mod._check_requirements(ROOT / "requirements.txt")
    assert problems == [], f"repo config would break the Space build: {problems}"


def test_dry_run_detects_a_gradio_pin(tmp_path):
    mod = _deploy_module()
    req = tmp_path / "requirements.txt"
    req.write_text("gradio>=5.0,<6\n", encoding="utf-8")
    problems = mod._check_requirements(req)
    assert problems and "ResolutionImpossible" in problems[0]


def test_dry_run_ignores_gradio_in_comments(tmp_path):
    mod = _deploy_module()
    req = tmp_path / "requirements.txt"
    req.write_text("# do not pin gradio<6 here\nrequests>=2.31\n", encoding="utf-8")
    assert mod._check_requirements(req) == []


def test_dry_run_detects_sdk_version_pin():
    mod = _deploy_module()
    readme = "---\nsdk: gradio\nsdk_version: 5.50.0\napp_file: app.py\n---\n# x\n"
    problems = mod._check_space_config(readme)
    assert any("sdk_version" in p for p in problems)


def test_dry_run_requires_front_matter():
    mod = _deploy_module()
    problems = mod._check_space_config("# no front matter\n")
    assert problems and "front-matter" in problems[0]


def test_dry_run_reports_missing_app_file():
    mod = _deploy_module()
    readme = "---\nsdk: gradio\n---\n"
    assert any("app_file" in p for p in mod._check_space_config(readme))


def test_dry_run_does_not_upload_itself():
    mod = _deploy_module()
    assert "deploy.py" not in mod.FILES
    assert set(mod.FILES) == {"app.py", "storage.py", "tools.py",
                              "requirements.txt", "README.md"}
