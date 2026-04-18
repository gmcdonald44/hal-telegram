# Contributing

Thanks for your interest. Before opening a PR, read this.

## Scope

This repo is deliberately narrow: **Telegram ↔ `claude -p`**. Four files, one job, done.

Stuff that fits:

- Bug fixes
- Better docs
- Lightweight platform adapters (e.g. systemd unit, Docker image)
- Small UX improvements (command aliases, better progress display)
- Security hardening

Stuff that doesn't:

- Web UIs
- Plugin systems
- Memory layouts / agent personas (bring your own `CLAUDE.md`)
- Multi-tenant auth, billing, rate limits
- Vendor lock-in to any particular agent framework

If you're not sure, open an issue first.

---

## Dev loop

```bash
bun install
cp .env.example .env.dev  # use a separate bot token for dev
BOT_MODE=sandbox bun --watch run bot/index.ts
```

`BOT_MODE=sandbox` gives you a separate channel registry so you won't stomp on someone's production data.

---

## Coding style

- TypeScript strict mode is on. Don't turn it off.
- No new runtime deps unless they earn their weight. `grammy` and `dotenv` are all we use.
- Prefer small, readable functions over clever abstractions.
- Don't add comments that describe *what* the code does. Add them only when the *why* is non-obvious.

---

## Tests

There are none yet. If you add a feature that warrants them, `bun test` is the expected harness.

---

## PR checklist

- [ ] Code compiles (`bun run bot` doesn't crash on boot)
- [ ] `.env.example` updated if you added an env var
- [ ] README or docs updated if user-facing behavior changed
- [ ] No secrets, chat IDs, or personal paths in the diff
- [ ] `git grep -i '<your name>'` returns nothing

---

## Security

If you find a vulnerability (credential exposure, RCE path, etc.) please open a private issue or email the maintainer instead of a public PR. We'd rather patch quietly than race a drive-by exploit.
