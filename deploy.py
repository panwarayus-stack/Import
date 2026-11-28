#!/usr/bin/env python3
"""
Deploy the AI Agent to a Hugging Face Space (ZeroGPU).

    export HF_TOKEN=hf_your_new_token      # shell only — never commit it
    python deploy.py --space nezuhub/ai-agent.txt

    # optional
    python deploy.py --space nezuhub/ai-agent.txt --restart
    python deploy.py --space nezuhub/ai-agent.txt --secret HF_TOKEN=hf_...

Notes
-----
* `--secret` stores the token as a *Space secret* (Settings → Variables and
  secrets) instead of baking it into the repo. Preferred.
* Requires: pip install huggingface_hub
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
FILES = ["app.py", "storage.py", "tools.py", "requirements.txt", "README.md"]
# NOTE: deploy.py itself is not uploaded — the Space never runs it.


REQUIRED = ("app.py", "requirements.txt", "README.md")


def _check_space_config(readme: str) -> list[str]:
    """Validate the Space card + requirements the way Spaces will read them."""
    problems: list[str] = []
    if not readme.startswith("---"):
        problems.append("README.md has no YAML front-matter — Spaces will not detect the app")
        return problems

    try:
        front = readme.split("---", 2)[1]
    except IndexError:
        problems.append("README.md front-matter is not closed with '---'")
        return problems

    if "app_file:" not in front:
        problems.append("README.md front-matter is missing 'app_file:'")
    if "sdk: gradio" not in front:
        problems.append("README.md front-matter is missing 'sdk: gradio'")
    if "sdk_version:" in front:
        problems.append(
            "README.md pins 'sdk_version' — this fights the runtime's own Gradio and "
            "can fail the build; remove it"
        )
    return problems


def _check_requirements(path: Path) -> list[str]:
    """A 'gradio' pin here collides with the runtime's gradio[oauth,mcp]==X."""
    problems: list[str] = []
    if not path.exists():
        return ["requirements.txt is missing"]
    import re

    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if re.match(r"(?i)gradio(\[[^\]]*\])?\s*[<>=!~]", line):
            problems.append(
                f"requirements.txt pins gradio ({line!r}) — the Space installs its own "
                "Gradio in the same pip run and the build fails with ResolutionImpossible"
            )
    return problems


def _dry_run(args) -> int:
    """Validate everything we can locally, then report what would be uploaded."""
    print(f"DRY RUN — nothing will be uploaded (space: {args.space})\n")
    problems: list[str] = []

    for name in REQUIRED:
        if not (HERE / name).exists():
            problems.append(f"required file missing: {name}")

    readme_path = HERE / "README.md"
    if readme_path.exists():
        problems += _check_space_config(readme_path.read_text(encoding="utf-8"))
    problems += _check_requirements(HERE / "requirements.txt")

    total = 0
    print("Would upload:")
    for name in FILES:
        path = HERE / name
        if not path.exists():
            print(f"  - {name:20s} MISSING")
            continue
        size = path.stat().st_size
        total += size
        print(f"  - {name:20s} {size / 1024:8.1f} KB")
    print(f"  total {total / 1024:.1f} KB → repo {args.space}")

    if problems:
        print("\n❌ Problems that would break the Space build:")
        for p in problems:
            print(f"   - {p}")
        return 4

    print("\n✅ Config looks valid for a Spaces build "
          "(no gradio pin, no sdk_version, app_file present).")
    print("   Re-run without --dry-run on a machine that can reach huggingface.co.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Deploy AI Agent to a HF Space")
    ap.add_argument("--space", default="nezuhub/ai-agent.txt", help="Space repo id (owner/name)")
    ap.add_argument("--token", default=os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACEHUB_API_TOKEN"),
                    help="HF token (default: $HF_TOKEN). Never commit it.")
    ap.add_argument("--private", action="store_true", help="Create the Space as private")
    ap.add_argument("--hardware", default="zero-a10g",
                    help="zero-a10g (ZeroGPU, free) | cpu-basic | t4-small …")
    ap.add_argument("--secret", action="append", default=[], metavar="KEY=VALUE",
                    help="Add/update a Space secret (e.g. --secret HF_TOKEN=hf_...)")
    ap.add_argument("--restart", action="store_true", help="Restart the Space after upload")
    ap.add_argument("--dry-run", action="store_true",
                    help="Validate the files and the Space config without uploading")
    args = ap.parse_args()

    if args.dry_run:
        return _dry_run(args)

    token = (args.token or "").strip()
    if not token:
        print("ERROR: no token. Create one at https://huggingface.co/settings/tokens")
        print("       then:  export HF_TOKEN=hf_...    (shell only, never in git)")
        return 1
    if not token.startswith("hf_"):
        print("WARNING: token does not start with 'hf_' — continuing anyway.")

    try:
        from huggingface_hub import HfApi
    except ImportError:
        print("ERROR: huggingface_hub missing.  pip install huggingface_hub")
        return 1

    api = HfApi(token=token)
    try:
        who = api.whoami()
        print(f"Authenticated as: {who.get('name', '?')}")
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        network_markers = ("MaxRetryError", "SSLError", "ConnectionError", "timed out",
                           "Name or service not known", "Temporary failure in name resolution",
                           "SSLZeroReturnError", "EOF occurred")
        if any(m in msg for m in network_markers):
            print("ERROR: cannot reach huggingface.co from this machine/network.")
            print(f"       {msg.splitlines()[0][:180]}")
            print("       This is a network block, not a token problem — the token was")
            print("       NOT checked. Run this script where huggingface.co is reachable")
            print("       (your laptop, a Space, or a GitHub Actions runner).")
            return 3
        print(f"ERROR: token rejected by Hugging Face: {msg}")
        print("       Revoke it, create a fresh **write** token, then retry.")
        return 2

    space = args.space
    try:
        info = api.space_info(space)
        print(f"Space exists: {space} (sdk={info.sdk}, hardware={getattr(info, 'runtime', None) and info.runtime.hardware})")
    except Exception:
        print(f"Creating Space {space} (sdk=gradio, hardware={args.hardware})…")
        api.create_repo(repo_id=space, repo_type="space", space_sdk="gradio",
                        private=args.private, exist_ok=True)
        try:
            api.request_space_hardware(space, hardware=args.hardware)
        except Exception as e:  # noqa: BLE001
            print(f"  (could not set hardware automatically: {e})")

    for name in FILES:
        path = HERE / name
        if not path.exists():
            print(f"  skip (missing): {name}")
            continue
        print(f"  uploading {name} ({path.stat().st_size // 1024} KB)…")
        api.upload_file(
            path_or_fileobj=str(path),
            path_in_repo=name,
            repo_id=space,
            repo_type="space",
            commit_message=f"Update {name} — AI Agent (multi-model, auto-router, ZeroGPU)",
        )

    for item in args.secret:
        if "=" not in item:
            print(f"  skip secret (need KEY=VALUE): {item}")
            continue
        key, value = item.split("=", 1)
        api.add_space_secret(repo_id=space, key=key, value=value)
        print(f"  secret set: {key}")

    if args.restart:
        try:
            api.restart_space(repo_id=space)
            print("  restart requested")
        except Exception as e:  # noqa: BLE001
            print(f"  restart failed: {e}")

    print(f"\n✅ Done → https://huggingface.co/spaces/{space}")
    print("   Add HF_TOKEN under Settings → Variables and secrets for gated models + cloud API.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
