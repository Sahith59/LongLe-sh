# LongLeash 🐕

> Your AI agents don't stop working when you leave the house. So why are *you* still chained to the desk like it's 2019?
>
> LongLeash is a **long-distance relationship with your terminal** — but, like, a healthy one. Your agents do the heavy lifting at home; you approve, deny, and occasionally yell "NO. BAD CLAUDE." from brunch, the gym, or your cousin's wedding. They miss you. Pet them remotely. 📱⛓️💻

## What this actually is

A standalone, end-to-end, open-source system to control everything running on your dev laptop from your phone — **anywhere in the world**:

- **AI agent sessions** (Claude Code first; Gemini CLI and Codex next) — a "waiting on you" approvals inbox with lock-screen Approve/Deny, steering messages, live streaming output, and remote start into any allowlisted project
- **Terminal sessions** — watch and type into real terminals (including VS Code's) from your phone, scrollback included
- **IDE awareness** — what project is open, what's running, what needs you
- **A laptop-down alarm** — because a home laptop is a home server, and servers lie about being fine

No third-party apps required, no app store, no fees. One daemon on your laptop, one installable web app on your phone, one self-hostable relay — all LongLeash, all open source, end-to-end encrypted, zero public endpoints on your machine.

## Why

AI moved the developer's job from *typing* to *prompting and approving*. The typing never needed you at a desk — but the approving still does, because the prompts land on a screen you're not in front of. LongLeash cuts that last chain.

## Status: pre-alpha, building in public 🚧

Nothing to install yet. The plan is real, the research is done, the architecture survived an adversarial review, and the code starts now. Watch/star if you want to follow along.

| Phase | What ships | State |
|---|---|---|
| A | Approve/steer/launch Claude from your phone (LAN) | in progress — daemon complete (event log, auth, live streaming, agent sessions + approvals), 92 tests |
| B | Our encrypted relay — works from anywhere | planned |
| C | Push notifications (Web Push, free) | planned |
| D | Terminals on your phone | planned |
| E | Gemini + Codex in the same inbox | planned |
| F | VS Code integration + hardening | planned |
| G | Public release: one command + one app + 5 minutes | planned |

## Architecture (one breath)

An installable web app (React + Vite: Inbox · Sessions · Activity) ⇄ E2E-encrypted channel (LAN direct, or the self-hostable `longleash-relay` that only ever sees ciphertext) ⇄ `longleashd` on the laptop (TypeScript daemon: typed API, SQLite event log with cursor replay, audit log) → structured adapters: Claude via the official Agent SDK, other agents via ACP, terminals via tmux control mode. Push notifications carry IDs only — never your content.

LongLeash never asks you to weaken your security to use it — see [what it requires and what it doesn't](docs/REQUIREMENTS.md).

Design rules we don't break: no TUI scraping, no generic exec endpoints, no credentials on the relay, no pretending macOS lets us capture things it doesn't. The full plan and the "why" behind every decision live in [PLAN.md](PLAN.md) and [context/DECISIONS.md](context/DECISIONS.md).

## Repo layout

- [PLAN.md](PLAN.md) — the build plan of record
- [context/](context/) — living project state, decisions, plain-language glossary
- [agents/](agents/) — research reports and the archived architecture evaluation that chose this design
- `scripts/` — machine-readiness pieces (launchd agents etc.)

## License

MIT — see [LICENSE](LICENSE).
