# Show HN drafts — hal-telegram

Three variants. Pick one, adjust the "I" voice, paste into Hacker News / Twitter / r/ClaudeAI as appropriate. All three assume the GitHub repo is public and linkable.

---

## Variant A — Show HN, tight (recommended)

**Title:** Show HN: hal-telegram — Talk to Claude Code from Telegram

**Body:**

Four TypeScript files. `bun install`, set two env vars, `bun run bot`. Message your bot, it replies with Claude Code.

Each chat gets a persistent `claude -p --resume <session-id>` so context carries across messages. Photos and documents get saved to a tempdir and handed to Claude with the path. `/stop` SIGTERMs the spawn. Single-owner mode by default — only your Telegram user ID can talk to it.

Not a framework. No database, no web UI, no plugin system. If you want memory / personas on top, bring your own CLAUDE.md.

I built it because my "Claude Code as everyday assistant" workflow only works when I can reach it from my phone. Six weeks of dogfooding, now open-sourcing the bridge.

GitHub: https://github.com/gmcdonald44/hal-telegram

Happy to answer questions on the architecture, trade-offs, or how it compares to Claude Code Routines (TL;DR: Routines are stateless and server-managed; this is stateful and runs on your box).

---

## Variant B — r/ClaudeAI / r/LocalLLaMA flavor

**Title:** I open-sourced the Telegram bridge I've been using with Claude Code for 6 weeks

**Body:**

Quick context: I wanted Claude Code reachable from my phone. Not a chat app that calls the API, but the actual CLI with my project's file system, hooks, and settings. After a bunch of duct tape, this is the version that's been running in production for me.

Four files:
- `index.ts` — grammy handlers (text, photo, document)
- `spawn.ts` — wraps `claude -p --output-format stream-json --resume <session-id>`
- `channels.ts` — JSON registry of chat_id → session_id
- `queue.ts` — per-channel serial queue so spawns don't collide

The magic is `--resume` — every message to a given chat re-enters the same Claude Code session, so it remembers what you've been working on.

A single Telegram message streams the response live (throttled ~1s), with a `🔧 <tool>` line during tool calls so you see it doing work during long runs. `/stop` kills the spawn.

Single-owner mode by default. MIT licensed. PRs welcome but the scope stays narrow.

https://github.com/gmcdonald44/hal-telegram

---

## Variant C — Twitter / X thread

1/ Shipped the Telegram bridge I've been using with Claude Code for 6 weeks as open-source.

`bun install && bun run bot` — message your bot, it replies with Claude Code. Each chat = persistent `claude -p --resume` session.

https://github.com/gmcdonald44/hal-telegram

2/ Four TypeScript files, no database, no framework. The whole repo is ~800 lines.

`--resume <session-id>` is the magic. Same chat → same session → Claude remembers what you were working on yesterday.

3/ Photos and docs get saved to a tempdir and handed to Claude with the path. `/stop` SIGTERMs the spawn mid-thought. Single-owner mode locks it to your Telegram user ID.

4/ Not trying to be a framework. If you want memory / personas on top, bring your own CLAUDE.md.

MIT. PRs welcome but the scope stays narrow.

https://github.com/gmcdonald44/hal-telegram

---

## Launch checklist

- [x] Pick GitHub account → `gmcdonald44` (personal primary)
- [x] Create the repo, push the `main` branch → https://github.com/gmcdonald44/hal-telegram
- [ ] Pick a variant (A / B / C) and adjust the "I" voice to yours
- [ ] Add repo topics on GitHub (`telegram-bot`, `claude-code`, `grammy`, `bun`, `typescript`)
- [ ] First pin on HN is the Show HN post; aim for 9–11am ET for best visibility
- [ ] Have a follow-up answer ready for "why not just use [grammy/telegram-bot-api/other wrapper]?" → you're not wrapping Telegram, you're bridging Telegram → Claude Code CLI with session persistence
- [ ] Have a follow-up ready for "this is unsafe, `--dangerously-skip-permissions`" → the whole bot runs in one working directory you chose, and the README is explicit about that

## Metrics to watch

- Stars: 50 in 48h = signal of resonance. 200+ = genuinely viral for a small repo.
- Issues / PRs: the first 3–5 real issues will tell you what's actually broken for other people.
- Twitter replies: who picked it up matters more than how many.

## If it flops

That's fine. This is infra you needed anyway, and the next project can link to it. No sunk cost.
