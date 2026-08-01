# LongLeash Architecture

One sentence: **a TypeScript daemon on your laptop is the single source of truth for every dev session; your phone is a thin, always-assumed-disconnected client; everything between them is end-to-end encrypted.**

```
┌─────────────────────────────┐
│  LongLeash web app (PWA)    │  React + Vite + TypeScript
│  Inbox · Sessions · Activity│  installable, $0, any device
└──────────────┬──────────────┘
               │  E2E-encrypted, cursor-addressed event streams
               │  (LAN direct, or via relay from anywhere)
┌──────────────┴──────────────┐
│   longleash-relay (optional)│  Node WSS · routes ciphertext only ·
│   self-hostable, Docker     │  zero knowledge, stores no credentials
└──────────────┬──────────────┘
               │
┌──────────────┴──────────────┐
│   longleashd (laptop)       │  Node / TypeScript daemon (launchd)
│  ┌───────────────────────┐  │
│  │ typed API (no exec)   │  │  Fastify + WebSocket
│  │ event log             │  │  SQLite (better-sqlite3, WAL)
│  │ device auth + pairing │  │  QR challenge · hashed tokens
│  │ audit log             │  │
│  └───────────┬───────────┘  │
│      adapters│               │
│  ┌───────────┴───────────┐  │
│  │ Claude   → Agent SDK  │  │  canUseTool approvals, streaming
│  │ Gemini/Codex → ACP    │  │  one protocol, many agents
│  │ Terminals → tmux -C   │  │  control mode, screen-exact mirror
│  │ VS Code  → extension  │  │  thin sensor/actuator
│  └───────────────────────┘  │
└─────────────────────────────┘
```

## Components and technology choices

| Component | Technology | Why this choice |
|---|---|---|
| `longleashd` daemon | Node.js + TypeScript, Fastify, WebSocket | Single source of truth on the laptop; survives the IDE closing; TS end-to-end keeps one language across the whole product |
| Event storage | SQLite via better-sqlite3, WAL mode | Crash-safe, zero-ops, synchronous single-writer matches the daemon design; every session is an append-only, cursor-replayable event stream |
| Agent control (Claude) | official Claude Agent SDK | Structured approvals (`canUseTool`), streaming, session resume — never screen-scraping (screen-scrapers die on every agent UI update; that killed prior projects) |
| Agent control (others) | ACP — Agent Client Protocol | One client implementation covers Gemini CLI, Codex, and every future ACP agent |
| Terminal capture | tmux control mode (`tmux -C`) | The only honest way to mirror and drive terminals on macOS; screen-exact, resize-safe |
| Phone app | React + Vite PWA (installable web app) | Free forever, no store review or sideloading, instant updates, works on desktop browsers too — adoption matters more for an open-source tool than iOS lock-screen action buttons. Native wrappers stay an option later; nothing else changes if we add them |
| Sync protocol | zod-validated event schemas, cursor-addressed streams | The phone assumes it is always disconnected and catches up from its last cursor — mobile networks are treated as hostile, not exceptional |
| Relay | small Node WSS service, Docker, self-hostable | NAT traversal without a third party in the trust path: it routes ciphertext it cannot read and stores no credentials |
| Pairing & auth | QR one-time challenge, per-device random tokens (stored hashed, timing-safe compare), instant revocation | A stolen database leaks no tokens; a lost phone is one tap to revoke |
| Notifications | Web Push with self-generated VAPID keys, payloads carry IDs only | No vendor account or fee; nothing sensitive transits push infrastructure — the app fetches real state over the encrypted channel |
| Testing | vitest, TDD, failure-mode tests mandatory | Every guarantee is a test that existed before the code; CI on every push |

## The approval flow (the product in one trace)

1. An agent on the laptop wants to run a gated tool → the Agent SDK parks it in our `canUseTool` callback.
2. The daemon writes an approval event to the session's stream and fires a push (IDs only).
3. Your phone shows it on the lock screen. You tap Approve/Deny (or open the inbox for the full diff).
4. The decision travels back encrypted, resolves the pending callback, and the agent continues.
5. Every mutating action lands in the audit log; both desk and phone render the same event stream.

## How an agent session actually runs

`SessionManager` owns every session. Starting one resolves the requested directory through
symlinks and refuses anything outside your allowlisted roots — so remote start cannot reach
`/etc`, cannot climb out with `..`, and cannot be tricked by a sibling path that merely shares
a prefix. The directory is then **pinned** for the session's life, because resuming an agent
from a different working directory silently forks a fresh, empty session.

While it runs, the adapter contract (`AgentFactory`) is all `SessionManager` knows about the
agent, so Claude via the official SDK, ACP agents, and the deterministic test double are
interchangeable. Output becomes `stream.delta` events; tools that ask permission become
approvals that **block the agent until a human answers**; tools that were auto-approved still
surface in the activity feed, because a permission callback alone would leave them invisible.

Failure is designed for, not hoped against: an agent that dies mid-stream marks the session
errored while keeping its partial output, any approval it left pending is closed out rather
than hanging forever, unanswered approvals expire into a safe deny, repeated decisions are
idempotent, and approvals left pending by a crashed daemon are reconciled at startup instead
of appearing as a phantom inbox.

## Security model, in five rules

1. Typed operations only — there is no generic "run this command" endpoint; the API's shape is the security boundary.
2. The relay never sees plaintext and never stores credentials.
3. Push payloads carry IDs, never content.
4. Tokens are random 256-bit values stored only as hashes, compared timing-safe, revocable instantly (revocation also drops live connections).
5. Remote session start is restricted to allowlisted project roots — and so is what tools may touch: a tool declaring a path has it resolved and checked, with anything reaching outside the project flagged to you or refused outright. Shell commands are not parsed, because guessing at shell syntax would be security theatre; you see the whole command and decide.

## What we deliberately do not build

Terminal emulators (xterm.js), multiplexers (tmux), crypto primitives (libsodium), or agent runtimes — we integrate the proven ones. And we never scrape TUIs: structured protocols only.
