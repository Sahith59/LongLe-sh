# LongLeash

Standalone, end-to-end, open-source product: control the AI-agent sessions, terminal sessions, and IDE sessions on your laptop from your phone, anywhere in the world. AI does the heavy lifting; LongLeash frees the human's remaining job — prompting and approving — from the desk.

**Scope (decided 2026-07-29; client form revised 2026-08-01):** one daemon (`longleashd`), one **web app (PWA, React+Vite)** served by the daemon or relay — not a native app, because $0 cost and zero-friction install matter more for an open-source product than lock-screen action buttons — plus our own E2E relay, installer CLI, and VS Code extension. No Happy/Termius/Tailscale as dependencies — every product surface is ours. Standard libraries underneath (Node, RN, xterm.js, tmux, libsodium) are fine. Base architecture: `agents/archive/tether.json` + our relay. Personal-first dogfooding, then public release.

## Status

Updated 2026-10-04: the product has six implemented packages and a deployed preview. Workstream D remains open: D2 is locally tested; D3 hardening includes session discovery, packaged diagnostics and dependency updates, with physical-device/platform/production acceptance still pending. Remote migration listing now succeeds with none pending; historical 7403 is not the current result. No new release was deployed. Read `context/STATE.md`, `docs/D3-RELEASE-READINESS.md` and `docs/WORKSTREAM-D-VERIFIED-PAIRING.md` first. The owner requested a stop before production push/deploy. Update durable context after each phase; older dated entries are historical evidence.

## Architecture in one breath

Phone (React/Vite PWA) ⇄ LAN or E2E relay ⇄ laptop daemon (Fastify/WS, SQLite, typed operations) → Claude Agent SDK / Codex app-server and structured external hooks/transcript sources. Web Push carries IDs only. CLI manages per-user installation/service; VS Code companion still needs authenticated live snapshot sync. Hosted Clerk identity and D1 support/measurement are a separate data plane from encrypted session routing. See `docs/MONETIZATION-PLAN.md` for current commercial policy; retired Expo/fork/tmux plans are not the implementation source.

## Invariants — never violate these

- Never scrape a TUI to detect prompts — use structured provider SDK/app-server/hooks. Historical competitor failure claims are not current evidence; see the dated competitive research.
- Never resize an agent TUI/PTY to phone width — Claude Code's ink UI corrupts on resize. Phone renders at laptop-side size with pan/zoom; `window-size largest` in tmux.
- Session relay rooms route ciphertext only. Hosted account identity and explicitly submitted support/measurement data belong to a separate documented data plane; never put session content or pairing secrets there.
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
- `context/BUSINESS.md` is the commercial plan in plain language — pricing, free/paid split, trust, go-to-market, honest odds. Read it before any money or launch conversation. `context/PRICING.md` is the evidence and sources behind it. **Do not implement billing until 100 people use LongLeash for free** (BUSINESS.md §7).
- `context/ROADMAP.md` is the running work plan — open bugs, the next features, and the order. Read it at the start of a build session; update it as things land.
- `context/DECISIONS.md` is the running decision log — every choice with its REASON. Read it before proposing architecture, design, or commercial changes; append when a decision is made or reversed, and never delete an entry.
- `context/STATE.md` is the single source of truth for project state. Spikes (S0 gate for Phase A; S1–S5) must pass/fail explicitly before building on what they verify.
- Commit only when Sahith asks. The repo will be public one day — write code and docs as if strangers are reading.
