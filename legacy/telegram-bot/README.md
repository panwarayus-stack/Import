# Legacy Telegram bot (not part of the factory)

These three files predate the AI Website & Shorts Factory and are kept only for reference:

| File | What it was |
|---|---|
| `main.py` | A tiny `pytelegrambotapi` echo bot with an `/admin` command |
| `Keep_alive.pt` | A Flask "keep alive" helper (the extension `.pt` is a typo for `.py`) |
| `requirements.txt` | `flask`, `pytelegrambotapi`, `psutil` |

They were moved out of the repository root because build platforms detect a Python project whenever
`requirements.txt` sits next to `package.json` — which is exactly what happened on the first deploy
attempt: the builder installed Flask and started a Python image instead of the Node application.

**Nothing in the factory imports these files.** If you still want the bot, treat this folder as its
own project: rename `Keep_alive.pt` to `keep_alive.py`, create the bot with BotFather, set
`BOT_TOKEN` and `ADMIN_ID`, and deploy it separately. Do not add it back to the repository root.
