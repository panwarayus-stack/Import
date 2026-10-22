import os
import telebot
from keep_alive import keep_alive

# 🔑 Load from environment
BOT_TOKEN = os.getenv("BOT_TOKEN")
ADMIN_ID = int(os.getenv("ADMIN_ID", "0"))

# Initialize bot
bot = telebot.TeleBot(BOT_TOKEN)

# Example start command
@bot.message_handler(commands=["start"])
def start_handler(message):
    bot.reply_to(message, "✅ Bot is running on Render with Flask keep_alive!")

# Example admin command
@bot.message_handler(commands=["admin"])
def admin_handler(message):
    if str(message.from_user.id) == str(ADMIN_ID):
        bot.reply_to(message, "Hello Admin 👑")
    else:
        bot.reply_to(message, "🚫 You are not admin!")

if __name__ == "__main__":
    # Keep alive with Flask
    keep_alive()
    # Start polling
    bot.infinity_polling()
