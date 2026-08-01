# LongLeash

Standalone, end-to-end, open-source product: control the AI-agent sessions, terminal sessions, and IDE sessions on your laptop from your phone, anywhere in the world. AI does the heavy lifting; LongLeash frees the human's remaining job — prompting and approving — from the desk.

**Scope (decided 2026-07-29; client form revised 2026-08-01):** one daemon (`longleashd`), one **web app (PWA, React+Vite)** served by the daemon or relay — not a native app, because $0 cost and zero-friction install matter more for an open-source product than lock-screen action buttons — plus our own E2E relay, installer CLI, and VS Code extension. No Happy/Termius/Tailscale as dependencies — every product surface is ours. Standard libraries underneath (Node, RN, xterm.js, tmux, libsodium) are fine. Base architecture: `agents/archive/tether.json` + our relay. Personal-first dogfooding, then public release.

## Status

Plan v2 written (2026-07-29). Machine readiness half done. Coding not started — Phase A gated on spike S0 (Agent SDK under subscription OAuth). Read `context/STATE.md` first; update it at the end of any session that changes project state.

## Architecture in one breath

Phone (Expo app: Inbox / Sessions / Activity) ⇄ E2E encrypted channel (LAN direct or `longleash-relay`, ciphertext-only) ⇄ `longleashd` on the laptop (Fastify+WS, SQLite event log with cursor replay, typed API only) → adapters: Claude via Agent SDK (canUseTool approvals, streaming), other agents via ACP, terminals via tmux control mode → push via Expo→APNs/FCM, IDs only. Full plan: `PLAN.md`.

## Invariants — never violate these

- Never scrape a TUI to detect prompts — structured channels only (Agent SDK / ACP). This is why Omnara died; it must not be why we die.
- Never resize an agent TUI/PTY to phone width — Claude Code's ink UI corrupts on resize. Phone renders at laptop-side size with pan/zoom; `window-size largest` in tmux.
- The relay never stores credentials or plaintext — ciphertext routing only (the Happy #680 lesson as a design rule).
- Push payloads carry IDs only, never content. The in-app inbox is the source of truth, not the notification.
- Typed API operations only — never a generic exec endpoint. Remote start only into allowlisted project roots. Audit-log every mutating call.
- One writer per Claude session: exclusive attach, defer-based release before `claude --resume` handoff.
- Nothing binds `0.0.0.0`. Daemon binds localhost/LAN/relay outbound only.
- **Never require a user to weaken their security.** Disk encryption, firewalls, OS updates are the user's call; LongLeash requires only that the machine is awake, the daemon runs, and the phone can reach it. See `docs/REQUIREMENTS.md` for the three tiers — keep that file honest.
- Non-tmux terminals are uncapturable on macOS; VS Code chat panels are sealed webviews. Say so in the UI and docs; never pretend.

## Conventions

- Sahith is new to much of this stack — explain in plain language first, command second. `context/GLOSSARY.md` has the vocabulary.
- TypeScript everywhere; no over-engineering; env vars for all secrets.
- Agents/subagents write reports to `agents/` as `YYYY-MM-DD-topic.md` (see `agents/README.md`); raw data in `agents/archive/`.
- `context/STATE.md` is the single source of truth for project state. Spikes (S0 gate for Phase A; S1–S5) must pass/fail explicitly before building on what they verify.
- Commit only when Sahith asks. The repo will be public one day — write code and docs as if strangers are reading.
