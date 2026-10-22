# Legacy Telegram bot (not part of the factory) — archived as `.example`

These files predate the AI Website & Shorts Factory. They are kept for reference only, and every
filename ends in `.example` **on purpose**:

| File | What it was |
|---|---|
| `main.py.example` | A tiny `pytelegrambotapi` echo bot with an `/admin` command |
| `keep_alive.py.example` | A Flask "keep alive" helper (originally misnamed `Keep_alive.pt`) |
| `requirements.txt.example` | `flask`, `pytelegrambotapi`, `psutil` |

## Why `.example`

Two deploys of this repository built a **Python** image instead of the Node app:

1. `requirements.txt` and `main.py` sat in the repository root next to `package.json`, so the
   buildpack detected a Python project and ran `pip install -r requirements.txt`.
2. Even after moving them to `legacy/`, some builders scan **recursively** for `main.py`/`*.py`.
   The deployed container then ran `/app/main.py` and crashed with
   `ModuleNotFoundError: No module named 'keep_alive'` (the helper file was called
   `Keep_alive.pt`, so it was never importable).

There is now **no file in this repository** that ends in `.py`, is named `requirements.txt`,
`Pipfile` or `pyproject.toml`. The Node application is the only thing a builder can detect.

## If you actually want the bot

Treat it as a separate project — do not revive it inside this repository:

```bash
mkdir ~/telegram-bot && cd ~/telegram-bot
cp /path/to/Import/legacy/telegram-bot/main.py.example        main.py
cp /path/to/Import/legacy/telegram-bot/keep_alive.py.example  keep_alive.py
cp /path/to/Import/legacy/telegram-bot/requirements.txt.example requirements.txt
python -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
export BOT_TOKEN=... ADMIN_ID=...
python main.py
```

The original crash came from the helper's extension (`.pt` instead of `.py`); copying it to
`keep_alive.py` fixes the import. `keep_alive.py` starts Flask on port 8080, which is useful only on
a platform that expects an HTTP port — on a VPS you can delete that import entirely.
