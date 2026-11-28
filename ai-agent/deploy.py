#!/usr/bin/env python3
"""
Deploy the AI Agent to a Hugging Face Space (ZeroGPU).

    export HF_TOKEN=hf_your_new_token      # shell only — never commit it
    python ai-agent/deploy.py --space nezuhub/ai-agent.txt

    # optional
    python ai-agent/deploy.py --space nezuhub/ai-agent.txt --restart
    python ai-agent/deploy.py --space nezuhub/ai-agent.txt --secret HF_TOKEN=hf_...

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
    args = ap.parse_args()

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
