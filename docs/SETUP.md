# Setup

Five minutes end-to-end, assuming you already have bun and Claude Code installed.

---

## 1. Install prerequisites

```bash
# Bun (if you don't have it)
curl -fsSL https://bun.sh/install | bash

# Claude Code CLI — https://docs.claude.com/claude-code
# Verify:
claude --version
```

Log in to Claude Code at least once (`claude` in a regular terminal) so your auth is cached. The bot inherits that session.

---

## 2. Create a Telegram bot

1. Open Telegram, search for **[@BotFather](https://t.me/BotFather)**.
2. Send `/newbot`. Follow the prompts:
   - Bot name: whatever you want (shows as the display name)
   - Bot username: must end in `bot` (e.g. `my_claude_code_bot`)
3. BotFather replies with an HTTP API token that looks like `1234567890:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`. **Save it.** This is `TELEGRAM_BOT_TOKEN`.
4. (Optional but recommended) Send `/setprivacy` to @BotFather → pick your bot → **Disable**. This lets the bot see all messages in groups, which you'll want later. For DM-only use it doesn't matter.

---

## 3. Find your Telegram user ID

The bot locks itself to a single owner by default. You need your numeric user ID.

1. In Telegram, search for **[@userinfobot](https://t.me/userinfobot)**.
2. Tap start. It replies with your user ID — a number like `123456789`.
3. Save it. This is `TELEGRAM_OWNER_CHAT_ID`.

> **Heads up:** Your user ID and the chat ID for your DM with the bot are the same number. If you later use the bot in a group, groups have negative chat IDs (e.g. `-100123456789`) — that's a different registration path we haven't wired up.

---

## 4. Clone and configure

```bash
git clone https://github.com/<you>/hal-telegram
cd hal-telegram
bun install
cp .env.example .env
```

Edit `.env`:

```env
TELEGRAM_BOT_TOKEN=1234567890:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TELEGRAM_OWNER_CHAT_ID=123456789
```

Everything else is optional. If you have a Claude subscription that supports Opus 4.7 you're done. If you're on Sonnet only, set `CLAUDE_MODEL=claude-sonnet-4-6`.

---

## 5. Run it

```bash
bun run bot
```

You should see:

```
[claude-tg-bot] Bot starting...
[claude-tg-bot] Project root: /path/to/hal-telegram/
[claude-tg-bot] Online as @my_claude_code_bot (8...)
[claude-tg-bot] Waiting for messages...
```

Open Telegram → search for your bot handle → send a message like:

> Hello, are you there? What's the current working directory?

After 5–30 seconds you should see a progress message ("⏳ Working (Xs)..."), then the actual reply. If the first reply never comes, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

---

## 6. Keep it running

For casual use, just leave `bun run bot` running in a terminal. When you close the terminal, the bot stops.

For always-on, pick one of:

**tmux / screen** — cheap and cheerful:

```bash
tmux new -d -s claudebot 'cd ~/hal-telegram && bun run bot'
tmux attach -t claudebot   # to check on it
```

**systemd** (Linux):

```ini
# /etc/systemd/system/hal-telegram.service
[Unit]
Description=hal-telegram — Telegram bridge for Claude Code
After=network.target

[Service]
Type=simple
User=yourusername
WorkingDirectory=/home/yourusername/hal-telegram
ExecStart=/home/yourusername/.bun/bin/bun run bot
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now hal-telegram
journalctl -u hal-telegram -f
```

**launchd** (macOS):

```xml
<!-- ~/Library/LaunchAgents/com.example.hal-telegram.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>          <string>com.example.hal-telegram</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/yourusername/.bun/bin/bun</string>
    <string>run</string>
    <string>bot</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/yourusername/hal-telegram</string>
  <key>RunAtLoad</key>      <true/>
  <key>KeepAlive</key>      <true/>
  <key>StandardOutPath</key><string>/tmp/hal-telegram.log</string>
  <key>StandardErrorPath</key><string>/tmp/hal-telegram.err</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.example.hal-telegram.plist
```

---

## 7. Pointing Claude at a different codebase

By default `claude -p` runs with the bot repo as its working directory, so Claude sees `hal-telegram/` itself.

To point it at another project, set `cwd` per channel. Edit `bot/channel-registry-prod.json` after the first message registers your chat:

```json
{
  "channels": {
    "123456789": {
      "name": "DM",
      "sessionId": "...",
      "sessionExists": true,
      "settingsPath": "/path/to/hal-telegram/.claude/settings.json",
      "cwd": "/path/to/your/actual/project",
      "allowedUsers": [123456789],
      "description": "..."
    }
  }
}
```

Restart the bot. Now every spawn uses that `cwd`.

---

## 8. What's next

- **Hooks:** drop a `.claude/settings.json` into the repo (or point `CLAUDE_SETTINGS_PATH` elsewhere) to add hooks like `SessionStart`, `PreToolUse`, etc. Docs: <https://docs.claude.com/claude-code>.
- **Multiple projects:** run two copies of the bot with different `BOT_NAME`, different tokens, different `cwd`. The channel registry is per-install.
- **Memory:** bring your own `CLAUDE.md`. This repo is deliberately layout-agnostic.
