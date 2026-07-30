# LongLeash Architecture

One sentence: **a TypeScript daemon on your laptop is the single source of truth for every dev session; your phone is a thin, always-assumed-disconnected client; everything between them is end-to-end encrypted.**

```
┌─────────────────────────────┐
│   LongLeash app (phone)     │  Expo / React Native + TypeScript
│   Inbox · Sessions · Activity│  approvals on the lock screen
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
| Phone app | Expo / React Native + TypeScript | Real native push with lock-screen actions (a PWA can't do this on iOS); one codebase for iOS + Android |
| Sync protocol | zod-validated event schemas, cursor-addressed streams | The phone assumes it is always disconnected and catches up from its last cursor — mobile networks are treated as hostile, not exceptional |
| Relay | small Node WSS service, Docker, self-hostable | NAT traversal without a third party in the trust path: it routes ciphertext it cannot read and stores no credentials |
| Pairing & auth | QR one-time challenge, per-device random tokens (stored hashed, timing-safe compare), instant revocation | A stolen database leaks no tokens; a lost phone is one tap to revoke |
| Notifications | Expo Push → APNs / FCM, payloads carry IDs only | Nothing sensitive ever transits push infrastructure; the app fetches real state over the encrypted channel |
| Testing | vitest, TDD, failure-mode tests mandatory | Every guarantee is a test that existed before the code; CI on every push |

## The approval flow (the product in one trace)

1. An agent on the laptop wants to run a gated tool → the Agent SDK parks it in our `canUseTool` callback.
2. The daemon writes an approval event to the session's stream and fires a push (IDs only).
3. Your phone shows it on the lock screen. You tap Approve/Deny (or open the inbox for the full diff).
4. The decision travels back encrypted, resolves the pending callback, and the agent continues.
5. Every mutating action lands in the audit log; both desk and phone render the same event stream.

## Security model, in five rules

1. Typed operations only — there is no generic "run this command" endpoint; the API's shape is the security boundary.
2. The relay never sees plaintext and never stores credentials.
3. Push payloads carry IDs, never content.
4. Tokens are random 256-bit values stored only as hashes, compared timing-safe, revocable instantly (revocation also drops live connections).
5. Remote session start is restricted to allowlisted project roots.

## What we deliberately do not build

Terminal emulators (xterm.js), multiplexers (tmux), crypto primitives (libsodium), or agent runtimes — we integrate the proven ones. And we never scrape TUIs: structured protocols only.
