# Phase A — "Claude in your pocket" (LAN) · TDD working plan

**Goal:** on home Wi-Fi, watch, approve, steer, and launch Claude Code sessions from the phone. ~6 dev-days. Gated S0: **passed** (see `agents/2026-07-29-spike-s0.md`).

## Project-wide TDD rules (apply to every phase)

1. **Red → green → refactor.** No production code without a failing test first.
2. **Pyramid:** unit (pure logic, in-memory SQLite) → integration (real WS server, real DB file, FakeAgent) → contract (real Agent SDK — costs ~$0.10–0.25/run, so budgeted: run on demand and at phase close, not on every push).
3. **Failure modes are first-class.** Every slice lists its failure tests up front; a slice without failure tests doesn't merge. No happy-path-only suites.
4. **S0 rules, binding:** assert on observable side effects (DB rows, files, tool_results) — never on agent text or callback firing; per-session cwd pinned AND tested; PreToolUse hook feeds the activity feed (canUseTool misses auto-approved tools).
5. **Tooling:** pnpm workspaces, vitest, TypeScript strict, zod at every boundary. GitHub Actions: unit+integration on every push; contract suite manual.
6. **Slice done =** tests green (incl. failure modes) + typecheck clean + STATE.md updated.

## Monorepo layout

```
packages/
  protocol/   shared types, zod schemas, event codecs   (everything depends on this)
  daemon/     longleashd
  app/        Expo phone app
  relay/      (Phase B)
  cli/        installer (grows through Phase G)
```

## Slices, in build order

### A1 · protocol package
Event + message schemas (session lifecycle, stream delta, approval, decision, activity), cursor addressing, protocol version field.
- Tests: schema round-trips; malformed payloads rejected with useful errors; unknown extra fields tolerated (forward compat).

### A2 · daemon event log
Append-only per-session event streams in SQLite (better-sqlite3, WAL), cursor replay, delta batching before write.
- Failure tests: replay from stale/invalid cursor → explicit gap signal, not silent skip; interleaved appends keep per-session order; reopen after simulated crash mid-transaction loses nothing committed; 10k-event replay under a latency bound.

### A3 · pairing + device auth
QR one-time-challenge pairing, device keypair registration, per-device tokens stored hashed, revocation list, device inventory.
- Failure tests: QR challenge single-use (replay rejected); revoked token → socket refused AND live sockets dropped; malformed pairing payloads; token comparison timing-safe.

### A4 · WS server
Fastify + WS bound to LAN interface: authenticated connect, per-session subscribe, replay-from-cursor then live tail.
- Failure tests: unauthenticated/revoked socket rejected; reconnect storm (20 rapid reconnects) yields consistent replay, no duplicate delivery; slow reader hits bounded buffer → oldest-dropped-with-gap-signal policy, daemon memory stays bounded; two devices subscribed → identical event order.

### A5 · Claude adapter (against FakeAgent)
FakeAgent implements the SDK surface (query stream, canUseTool, hooks) for fast deterministic tests. Session start with pinned cwd; stream → protocol events; canUseTool → approval row + event + (later) push; decision resolves the pending promise; PreToolUse → activity events; single-writer session lock.
- Failure tests: decision on expired approval → idempotent reject; duplicate decision → no-op; daemon restart with approval pending → defer path, prompt survives; agent process dies mid-stream → session marked errored, subscribers notified; second writer on same session refused.

### A6 · contract tests (real Agent SDK, budgeted ~5 runs)
Start/stream/approve/deny/steer on the real SDK; cwd pinning verified by actual file location (the S0 gotcha); session JSONL exists in `~/.claude/projects`; `claude --resume <id>` sees the session.

### A7 · Expo app (LAN)
Carries two requirements proven in the field on 2026-07-31 (see STATE.md field findings): a **reachability check separate from pairing** (so "network blocked" and "pairing failed" are never confused), and **active-VPN/tunnel detection with a plain-language warning**.
Screens: Pair (QR scan), Sessions, Inbox, Session detail (FlashList stream + approve/deny/steer), New Task (allowlisted roots from daemon). Target Expo Go if all deps allow, else free-signed dev build (7-day re-sign accepted until Phase C).
- Tests: client store unit tests — cursor resume after reconnect, optimistic decision reconciliation; component tests with a mocked daemon client; manual device checklist: background → foreground catch-up, app killed → reopen catch-up, airplane-mode flap.

### A8 · dogfood gate (phase exit)
One real workday driving a real Claude session from the phone on home Wi-Fi. Every friction logged to STATE.md. Phase A closes only when this day happens.

## Sahith's inputs for Phase A

- Free Expo account (expo.dev) — needed at A7.
- iPhone available for device testing at A7/A8.
- Machine-readiness leftovers (pmset, auto-updates, FileVault decision, healthchecks URL) — independent of coding, still open.
