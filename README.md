# hal-telegram

**Talk to Claude Code from Telegram.**

A single-binary Telegram bridge for [Claude Code](https://docs.claude.com/claude-code). Spawns `claude -p` per inbound message, streams the response back as chat messages, survives crashes, works on your phone.

```bash
git clone https://github.com/gmcdonald44/hal-telegram
cd hal-telegram
bun install
cp .env.example .env     # fill in TELEGRAM_BOT_TOKEN + TELEGRAM_OWNER_CHAT_ID
bun run bot
```

That's it. Message your bot. It replies with Claude Code.

---

## Why this exists

Claude Code is a power tool, but it's tethered to your terminal. If you're coming from a persistent-agent framework (OpenClaw, custom harnesses, Telegram bot duct tape) and you want Claude Code to be your everyday assistant — not just a coding sidekick — you need it reachable from your phone.

This repo is the glue: **Telegram → `claude -p` → Telegram**.

- Your messages become Claude Code prompts.
- Each chat gets a **persistent session** — resume-forever, so Claude remembers what you've been working on.
- Photos and documents are saved locally and handed to Claude with the file path.
- A per-channel queue serializes spawns so sessions don't collide.
- `/stop` kills the active spawn mid-flight.
- Single-owner mode by default — only your Telegram user ID can talk to it.

It is explicitly **not** a framework. Four TypeScript files, no database, no web UI.

---

## What it does

| Feature | Detail |
|---|---|
| Text messages | Forwarded as Claude Code prompts |
| Photos | Downloaded to a temp dir, Claude told the path + caption |
| Documents | Same — Claude gets the path, MIME type, size |
| Replies | Original message context prepended (`[Replying to X: "..."]`) |
| Long responses | Split at 4 KB, sent as multiple Telegram messages |
| Progress updates | Single editable message streams the response live (throttled ~1s); shows `🔧 <tool>` during tool calls and drops on completion |
| Abnormal exit | Sends `⚠️ Run exited with code <N>` if `claude -p` crashes so partial output isn't silently "done" |
| `/stop` | SIGTERMs the running `claude -p` spawn |
| `/stop all` | SIGTERM + clear the rest of the queue |
| `/queue` or `/status` | Show what's running and what's pending |
| `/rotate` | Reset the session — next message starts a fresh Claude Code conversation |

---

## What it does NOT do (yet)

- No group chats. It's a DM bridge. If you want to use a bot in a group, you'll need to add `@mention` gating yourself.
- No memory kit. Bring your own `CLAUDE.md` / hooks — we don't impose a memory layout.
- No multi-user billing / rate limits. Single-owner mode is the intended shape.
- No webhooks. It uses `getUpdates` long polling, which is fine for a personal bot and terrible for 1000s of users.

If you want a persistent-agent layer on top of this (memory files, CLAUDE.md conventions, hooks), build that separately or bring an existing one. This repo deliberately stays out of that opinion space.

---

## Architecture

```
Telegram  ──getUpdates──▶  bot/index.ts  ──enqueue──▶  bot/queue.ts
                               │                          │
                               │                          ▼
                               │                    bot/spawn.ts
                               │                          │
                               ▼                          ▼
                         stream progress     ┌──▶  claude -p --resume <session-id>
                         (throttled ~1s)     │              │
                               ▲             │              ▼
                               └── stream-json events ──────┘
                                         │
                                         ▼
                               sendReply → Telegram
```

- **`bot/index.ts`** — grammy handlers (text, photo, document, `/stop`, `/queue`, `/rotate`), progress tracker
- **`bot/spawn.ts`** — thin wrapper around `claude -p --output-format stream-json`, parses NDJSON
- **`bot/channels.ts`** — JSON registry of chat ID → session ID, persisted to disk
- **`bot/queue.ts`** — per-channel serial queue with SIGTERM-on-stop

Four files. ~800 lines total. Read them.

---

## Requirements

- **[Bun](https://bun.sh)** — runs the TypeScript directly. `curl -fsSL https://bun.sh/install | bash`
- **[Claude Code](https://docs.claude.com/claude-code) CLI** on your `PATH` — `claude --version` should work
- An Anthropic API key OR a Claude subscription that lets `claude -p` run
- A Telegram bot token (free, 2 minutes to get — see below)

---

## Getting a Telegram bot token (@BotFather)

Free, no phone verification beyond your existing Telegram account, ~2 minutes.

1. Open Telegram and message **[@BotFather](https://t.me/BotFather)**.
2. Send `/newbot` — follow the prompts:
   - **Display name:** whatever you want (shown as the bot's name in chats)
   - **Username:** must be unique across Telegram and must end in `bot` (e.g. `my_claude_code_bot`)
3. BotFather replies with an HTTP API token that looks like `1234567890:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`. **This is your `TELEGRAM_BOT_TOKEN`.** Treat it like a password — anyone with it can impersonate your bot.
4. Get your numeric user ID for single-owner mode: message **[@userinfobot](https://t.me/userinfobot)** → tap start → copy the ID it replies with. **This is your `TELEGRAM_OWNER_CHAT_ID`.**
5. (Optional polish) Back in @BotFather, register the slash commands so Telegram shows autocomplete when users type `/`:
   - Send `/setcommands` → pick your bot → paste:
     ```
     stop - Kill the active Claude Code spawn
     queue - Show what's running and what's pending
     rotate - Start a fresh Claude Code session
     ```
6. (Optional) `/setdescription` and `/setabouttext` let you set the text that appears on your bot's profile page.

If you later want to use the bot in a group chat, also send `/setprivacy` → pick your bot → **Disable**, so the bot can see all messages (not just ones addressed to it).

> **Losing the token:** `/token` in @BotFather will reveal it again. `/revoke` rotates it — the old token stops working immediately.

---

## Setup

See **[docs/SETUP.md](docs/SETUP.md)** for the full 5-minute walkthrough: filling in `.env`, first message, always-on runners (systemd / launchd), pointing Claude at a different codebase.

Hitting errors? See **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)**.

---

## Configuration

All via environment variables (see `.env.example`):

| Var | Required | Default | Purpose |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | — | From @BotFather |
| `TELEGRAM_OWNER_CHAT_ID` | recommended | — | Your Telegram user ID. Lock down single-owner mode. |
| `CLAUDE_MODEL` | no | `claude-opus-4-7` | Any model your subscription supports |
| `BOT_NAME` | no | `claude-tg-bot` | Prefix for log lines |
| `CLAUDE_SETTINGS_PATH` | no | `.claude/settings.json` | Optional Claude Code settings file |
| `TMP_DIR` | no | OS tmpdir | Where photos/documents land |
| `BOT_MODE` | no | `prod` | `prod` or `sandbox` — separate registries for a test bot |

---

## Security notes

- The bot runs `claude -p --dangerously-skip-permissions` because there's no interactive stdin. Claude Code can read, write, and execute in its working directory. **Treat the bot's working directory as untrusted territory** — don't run it against `~` or anywhere sensitive.
- `TELEGRAM_OWNER_CHAT_ID` is the **only** thing between a stranger who guesses your bot handle and a shell on your machine. Set it.
- `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` is passed to every spawn, which strips Anthropic credentials from the child env. You still need to be careful about other secrets in your env.
- `bot/channel-registry-*.json` contains your chat IDs. `.gitignore` covers them, but don't paste them elsewhere.

---

## License

MIT — see [LICENSE](LICENSE).

Contributions welcome. See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).
