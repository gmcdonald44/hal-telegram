# Troubleshooting

## The bot starts but doesn't reply

**Check the logs first.** Everything meaningful gets logged to stdout. Run it in the foreground (`bun run bot`) instead of a daemon while debugging.

### "User X is not the owner. Ignoring."

Your `TELEGRAM_OWNER_CHAT_ID` doesn't match the user ID Telegram reports for your account. Double-check with @userinfobot. The log prints the ID it saw — copy that into `.env` if it matches your account, restart.

### No logs at all after sending a message

The bot isn't receiving updates.

- Make sure you're messaging the **right handle** — `@BotFather` tells you the username when you created the bot.
- Make sure you actually ran `bun run bot` and didn't Ctrl-C it by accident.
- If you have **two** processes running with the same token, Telegram will randomly deliver updates to one or the other and `getUpdates` conflicts. Kill duplicates: `pkill -f 'bot/index.ts'`.

### "⏳ Working (5s)..." and then silence forever

The `claude -p` spawn is hanging. Common causes:

- **Claude Code isn't logged in.** Run `claude` in a normal terminal first and complete the auth flow.
- **Wrong model name.** `CLAUDE_MODEL` needs to be a model your subscription supports. Defaults to `claude-opus-4-7`; try `claude-sonnet-4-6` or `claude-haiku-4-5-20251001`.
- **First-run MCP init** is slow. Give it 60–90 seconds the first time.

Send `/stop` to kill the spawn. Then check the terminal — you'll usually see a stderr blob explaining what went wrong.

### "Hit an error. Check the logs."

The spawn exited non-zero. The terminal log has the `stderr` (first 200 chars). Typical culprits:

- `Error: ENOENT` — `claude` is not on the bot's PATH. If you launched it from a systemd unit or launchd plist, make sure it inherits your shell's PATH or hardcode the full path to `claude`.
- `Authentication error` — run `claude` once manually, complete login.
- `Model not found` — wrong model name (see above).

---

## Session won't persist

Every message should resume the same session ID. Verify:

```bash
cat bot/channel-registry-prod.json
```

You should see one entry with `"sessionExists": true`. If it stays `false` after multiple messages, the spawn is failing on first run — check the stderr.

Force a fresh session: send `/rotate` in the chat.

---

## "Stopped" command doesn't stop anything

SIGTERM is issued but `claude -p` may take up to a second to actually exit. If it keeps replying even after `/stop`, the output was already buffered in grammy's reply queue. Send `/stop all` to also clear the Telegram-side queue.

---

## Photos / documents don't land in the temp dir

- Temp dir defaults to `$TMPDIR/claude-tg-bot-files` (macOS) or `/tmp/claude-tg-bot-files` (Linux).
- Set `TMP_DIR` explicitly in `.env` if your OS cleans tmpdirs aggressively.
- Check permissions: the bot process needs write access to that dir.

---

## The bot can't write files

`--dangerously-skip-permissions` is already on. If `claude -p` reports "not allowed", the issue is somewhere else:

- The working directory is read-only (try `ls -la`).
- A `.claude/settings.json` hook is blocking it — inspect the file.
- You're pointing at a path inside a protected macOS dir (Desktop/Documents/Downloads trigger TCC prompts).

---

## High CPU / memory

The bot itself is nearly idle. High resource usage = `claude -p` is doing work. Check:

```bash
ps aux | grep 'claude '
```

If Claude is stuck in a loop (rare but happens), `/stop` is your friend.

---

## Two bots, one machine

Set `BOT_MODE=prod` on one install and `BOT_MODE=sandbox` on the other — they'll use different registry files and not clobber each other. Use different `BOT_NAME` values for log prefixes.

Separate `TELEGRAM_BOT_TOKEN` values obviously — Telegram conflicts if two processes poll the same token.

---

## Still stuck

Open an issue with:

1. Redacted `.env` (no tokens)
2. The terminal log from bot start through the failing message
3. Output of `claude --version` and `bun --version`
