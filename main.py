import os
import json
import subprocess
import psutil
from flask import Flask, request
import telebot
from telebot.types import InlineKeyboardMarkup, InlineKeyboardButton

# ================= CONFIG ==================
BOT_TOKEN = "8492782828:AAHbPAvruc-j9_FLiksOM3QUBFuPVLH-waA"
ADMIN_ID = 7394704068 # your admin id
DATA_FILE = "users.json"
UPLOAD_DIR = "uploads"

bot = telebot.TeleBot(BOT_TOKEN, threaded=False)
app = Flask(__name__)

# ================ STORAGE ==================
if not os.path.exists(DATA_FILE):
    with open(DATA_FILE, "w") as f:
        json.dump({}, f)

if not os.path.exists(UPLOAD_DIR):
    os.makedirs(UPLOAD_DIR)

def load_data():
    with open(DATA_FILE) as f:
        return json.load(f)

def save_data(data):
    with open(DATA_FILE, "w") as f:
        json.dump(data, f)

def ensure_user(uid):
    data = load_data()
    if str(uid) not in data:
        data[str(uid)] = {"slots": 3, "running": {}}
        save_data(data)
    return data

# ================ FILE & PROCESS ==================
def run_command(uid, file, cmd):
    data = load_data()
    if len(data[str(uid)]["running"]) >= data[str(uid)]["slots"]:
        return "⚠️ Slot limit reached."

    logfile = f"{file}.log"
    proc = subprocess.Popen(
        cmd, shell=True, stdout=open(logfile, "w"), stderr=subprocess.STDOUT
    )
    data[str(uid)]["running"][file] = proc.pid
    save_data(data)
    return f"✅ Started {file}\nPID: {proc.pid}"

def stop_process(uid, file):
    data = load_data()
    if file in data[str(uid)]["running"]:
        pid = data[str(uid)]["running"][file]
        try:
            psutil.Process(pid).terminate()
        except Exception:
            pass
        del data[str(uid)]["running"][file]
        save_data(data)
        return f"⏹ Stopped {file}"
    return "⚠️ Not running."

def get_status(uid, file):
    data = load_data()
    if file in data[str(uid)]["running"]:
        pid = data[str(uid)]["running"][file]
        return "🟢 running" if psutil.pid_exists(pid) else "🔴 stopped"
    return "🔴 stopped"

# ================ BOT HANDLERS ==================
@bot.message_handler(commands=["start"])
def start(m):
    data = ensure_user(m.from_user.id)
    used = len(data[str(m.from_user.id)]["running"])
    slots = data[str(m.from_user.id)]["slots"]

    kb = InlineKeyboardMarkup()
    kb.add(InlineKeyboardButton("📂 Upload File", callback_data="upload"))
    kb.add(InlineKeyboardButton("📝 Check Files", callback_data="files"))
    kb.add(InlineKeyboardButton("⚙️ Custom Command", callback_data="custom"))

    bot.reply_to(m, f"""
👋 <b>Welcome to Hosting Bot</b> 🚀

This bot lets you host your Python/JS scripts online.  
You get <b>3 Free Slots</b> to run your codes.

👤 User ID: <code>{m.from_user.id}</code>  
🎯 Slots: {used}/{slots} used  

Upload your file and manage it easily ⬇️
""", reply_markup=kb)

# Handle uploaded files
@bot.message_handler(content_types=['document'])
def handle_file(m):
    ensure_user(m.from_user.id)
    file_info = bot.get_file(m.document.file_id)
    downloaded = bot.download_file(file_info.file_path)

    path = os.path.join(UPLOAD_DIR, m.document.file_name)
    with open(path, "wb") as f:
        f.write(downloaded)

    bot.reply_to(m, f"📂 File uploaded: {m.document.file_name}")

# =============== INLINE CALLBACKS ===============
@bot.callback_query_handler(func=lambda call: True)
def callback(call):
    uid = call.from_user.id
    data = ensure_user(uid)

    if call.data == "files":
        files = os.listdir(UPLOAD_DIR)
        if not files:
            bot.edit_message_text("❌ No files uploaded.", call.message.chat.id, call.message.message_id)
            return
        msg = "📝 Your Files:\n\n"
        kb = InlineKeyboardMarkup()
        for f in files:
            status = get_status(uid, f)
            kb.add(InlineKeyboardButton(f"{f} ({status})", callback_data=f"file:{f}"))
        kb.add(InlineKeyboardButton("🔙 Back to Menu", callback_data="menu"))
        bot.edit_message_text(msg, call.message.chat.id, call.message.message_id, reply_markup=kb)

    elif call.data.startswith("file:"):
        fname = call.data.split(":", 1)[1]
        status = get_status(uid, fname)
        kb = InlineKeyboardMarkup()
        kb.add(InlineKeyboardButton("▶ Start", callback_data=f"start:{fname}"),
               InlineKeyboardButton("🔄 Restart", callback_data=f"restart:{fname}"))
        kb.add(InlineKeyboardButton("⏹ Stop", callback_data=f"stop:{fname}"),
               InlineKeyboardButton("❌ Delete", callback_data=f"delete:{fname}"))
        kb.add(InlineKeyboardButton("📜 Logs", callback_data=f"logs:{fname}"),
               InlineKeyboardButton("⚙️ Custom Command", callback_data=f"cmd:{fname}"))
        kb.add(InlineKeyboardButton("🔙 Back to Files", callback_data="files"))
        bot.edit_message_text(f"⚙️ Actions for {fname} ({status})", call.message.chat.id, call.message.message_id, reply_markup=kb)

    elif call.data.startswith("start:"):
        fname = call.data.split(":", 1)[1]
        ext = os.path.splitext(fname)[1]
        cmd = "python " + os.path.join(UPLOAD_DIR, fname) if ext == ".py" else "node " + os.path.join(UPLOAD_DIR, fname)
        msg = run_command(uid, fname, cmd)
        bot.answer_callback_query(call.id, msg, show_alert=True)

    elif call.data.startswith("restart:"):
        fname = call.data.split(":", 1)[1]
        stop_process(uid, fname)
        ext = os.path.splitext(fname)[1]
        cmd = "python " + os.path.join(UPLOAD_DIR, fname) if ext == ".py" else "node " + os.path.join(UPLOAD_DIR, fname)
        msg = run_command(uid, fname, cmd)
        bot.answer_callback_query(call.id, msg, show_alert=True)

    elif call.data.startswith("stop:"):
        fname = call.data.split(":", 1)[1]
        msg = stop_process(uid, fname)
        bot.answer_callback_query(call.id, msg, show_alert=True)

    elif call.data.startswith("delete:"):
        fname = call.data.split(":", 1)[1]
        try:
            os.remove(os.path.join(UPLOAD_DIR, fname))
        except: pass
        stop_process(uid, fname)
        bot.answer_callback_query(call.id, f"🗑 Deleted {fname}", show_alert=True)

    elif call.data.startswith("logs:"):
        fname = call.data.split(":", 1)[1]
        logfile = f"{fname}.log"
        if os.path.exists(logfile):
            with open(logfile) as f:
                logs = f.readlines()[-500:]
            bot.send_message(call.message.chat.id, "📜 Logs (last 500 lines):\n\n<pre>" + "".join(logs) + "</pre>")
        else:
            bot.answer_callback_query(call.id, "⚠️ No logs found.", show_alert=True)

    elif call.data.startswith("cmd:"):
        bot.send_message(call.message.chat.id, "⚙️ Enter custom command (e.g. `pip install requests`):")
        bot.register_next_step_handler(call.message, lambda m: os.system(m.text))

    elif call.data == "custom":
        kb = InlineKeyboardMarkup()
        kb.add(InlineKeyboardButton("⚙️ Run Custom Command", callback_data="run_cmd"))
        kb.add(InlineKeyboardButton("📦 Install Module", callback_data="install_module"))
        kb.add(InlineKeyboardButton("📄 Install from requirements.txt", callback_data="install_req"))
        kb.add(InlineKeyboardButton("🔙 Back to Menu", callback_data="menu"))
        bot.edit_message_text("💻 Custom Command Options:", call.message.chat.id, call.message.message_id, reply_markup=kb)

    elif call.data == "menu":
        start(call.message)

# =============== ADMIN COMMANDS ===============
@bot.message_handler(commands=["admin"])
def admin_panel(m):
    if m.from_user.id != ADMIN_ID:
        return
    kb = InlineKeyboardMarkup()
    kb.add(InlineKeyboardButton("📢 Broadcast", callback_data="admin_broadcast"))
    kb.add(InlineKeyboardButton("➕ Add Slot", callback_data="admin_addslot"))
    kb.add(InlineKeyboardButton("➖ Remove Slot", callback_data="admin_removeslot"))
    bot.reply_to(m, "⚙️ Admin Panel:", reply_markup=kb)

@bot.message_handler(commands=["broadcast"])
def broadcast(m):
    if m.from_user.id != ADMIN_ID:
        return
    text = m.text.split(" ", 1)[1] if " " in m.text else None
    if not text:
        bot.reply_to(m, "⚠️ Usage: /broadcast message")
        return
    data = load_data()
    for uid in data:
        try: bot.send_message(int(uid), f"📢 Admin Broadcast:\n\n{text}")
        except: pass
    bot.reply_to(m, "✅ Broadcast sent!")

@bot.message_handler(commands=["addslot"])
def addslot(m):
    if m.from_user.id != ADMIN_ID: return
    try:
        _, uid, n = m.text.split()
        uid, n = int(uid), int(n)
        data = load_data()
        data[str(uid)]["slots"] += n
        save_data(data)
        bot.reply_to(m, f"✅ Added {n} slots to {uid}")
    except:
        bot.reply_to(m, "⚠️ Usage: /addslot user_id number")

@bot.message_handler(commands=["removeslot"])
def removeslot(m):
    if m.from_user.id != ADMIN_ID: return
    try:
        _, uid, n = m.text.split()
        uid, n = int(uid), int(n)
        data = load_data()
        data[str(uid)]["slots"] = max(0, data[str(uid)]["slots"] - n)
        save_data(data)
        bot.reply_to(m, f"✅ Removed {n} slots from {uid}")
    except:
        bot.reply_to(m, "⚠️ Usage: /removeslot user_id number")

# =================== WEBHOOK =====================
@app.route(f"/{BOT_TOKEN}", methods=["POST"])
def webhook():
    update = request.stream.read().decode("utf-8")
    bot.process_new_updates([telebot.types.Update.de_json(update)])
    return "OK", 200

@app.route("/", methods=["GET"])
def index():
    return "✅ Hosting Bot Webhook Active"

# ================== RUN LOCAL ====================
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
