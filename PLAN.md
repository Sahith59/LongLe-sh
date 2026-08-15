# LongLeash — Build Plan v2 (standalone product)

**Decided 2026-07-29 (supersedes the compose-tools plan; that version is archived in git history and the artifact).** Sahith's final scope: LongLeash is a standalone, end-to-end, open-source product. One daemon, one phone app, our own sync layer. No Happy, no Termius, no Tailscale as user-facing dependencies. Base design: the archived "Tether" architecture (`agents/archive/tether.json`) plus our own relay replacing Tailscale.

**Vision:** AI now does the heavy lifting; the human's job is prompting and approving. LongLeash frees that job from the desk — control agent sessions, terminal sessions, and IDE sessions on your laptop from anywhere in the world.

> [!NOTE]
> The public-preview, pricing, account boundary, competition, and `$5,000 MRR` validation plan is
> frozen in [`docs/MONETIZATION-PLAN.md`](docs/MONETIZATION-PLAN.md). It does not advance Phase 2A;
> resume Phase 2A from [`docs/PHASE2A-CHECKPOINT.md`](docs/PHASE2A-CHECKPOINT.md).

> [!NOTE]
> The phase forecast below is preserved as project history. The shipped architecture has evolved:
> Claude managed sessions use the official Agent SDK, Codex uses `codex app-server`, supported
> Terminal/VS Code sessions are observed through provider lifecycle hooks, and safe concurrency
> uses Git worktrees. LongLeash does **not** currently mirror arbitrary terminal screens through
> tmux, use ACP for Codex, or inject conversations into vendor VS Code chat panels. Read
> [Current architecture](docs/ARCHITECTURE.md), [Session portability](docs/SESSION-PORTABILITY.md),
> and the current-status section below before treating an original phase item as implemented.

## What "everything ours" means (boundary, agreed)

We own every product surface: daemon, phone app, relay, protocol, installer, extension. We stand on standard open-source libraries and system binaries underneath (Node, React Native/Expo, xterm.js, tmux, libsodium, SQLite) — like every real product. Forked/adapted code becomes ours (with proper license attribution). Platform fees (Apple $99/yr) are fees, not dependencies.

## Components (all ours, TypeScript throughout)

1. **`longleashd`** — laptop daemon (Node, launchd LaunchAgent, runs as logged-in user). Fastify HTTP+WS; SQLite (better-sqlite3) cursor-addressed event log, approvals with expiry, hashed per-device tokens, audit log; adapter tiers: (T1) Claude via `@anthropic-ai/claude-agent-sdk` — `query()` + `canUseTool` + `includePartialMessages` + PermissionRequest hook, cwd pinned per session; (T2) ACP via `@agentclientprotocol/sdk` — Gemini CLI (`--experimental-acp`), Codex (`codex-acp`), never `codex exec`; (T3) terminals via one long-lived `tmux -C` control-mode client — %output octal-decode, `capture-pane -p -e -S -` replay, send-keys, pause-mode flow control. Typed API only (approveDecision, sendMessage, sendKeys, startSession in allowlisted roots, attachTerminal) — never generic exec. Built-in self-health heartbeat (absorbs the dead-man script).
2. **LongLeash web app (PWA)** — React + TypeScript + Vite, installable to the home screen, served by the daemon (LAN) or the relay (remote). Decided 2026-08-01: a PWA costs $0 forever (no Apple $99/yr, no Play fee, no TestFlight 90-day re-install treadmill), needs no store review, updates instantly, works on desktop browsers too, and — decisive for an open-source product — anyone can use it without sideloading or invites. Views: Inbox (approvals), Sessions (agents/terminals/IDE with capture-fidelity labels), Session detail (virtualized stream + approve/deny/steer), New Task, Devices. Terminals use xterm.js directly (no WebView bridge) at laptop-side size with pan/zoom — the phone NEVER resizes a PTY. Keys/tokens in IndexedDB, non-extractable WebCrypto keys where possible. Reconnect-and-catch-up: socket dropped on background, every stream cursor-resumed.
   **Accepted trade-off:** iOS web push (16.4+, home-screen install required) has no lock-screen action buttons, so iPhone approvals are tap-notification → approve in app (~2s slower than native). Android web push does support actions. If users demand lock-screen actions later, the same web app gets a thin native wrapper — daemon, protocol, and relay are unaffected.
3. **`longleash-relay`** — small Node WSS relay: routes ciphertext between paired devices, zero-knowledge (E2E payloads it cannot read), stores nothing durable but queued ciphertext, NEVER credentials (the Happy #680 lesson is a design rule). Docker image, self-hostable free; hosted public instance later if the project earns it.
4. **`longleash` CLI** — installer/orchestrator: audits the machine, silently installs internal deps (tmux etc.), writes launchd agents + tmux config + VS Code terminal profile, applies invariants, prints pairing QR.
5. **VS Code companion extension** (Phase 2A) — an authenticated IDE client for session navigation,
   exact handoff, provider controls, native diffs, and delegation review. Claude's official
   exact-session URI remains disabled until an exact extension build passes LongLeash's live-history
   matrix; Codex uses a LongLeash-owned editor backed by the documented app-server because no public
   exact-thread entry point into Codex's own panel is currently part of its contract. The extension
   never scrapes or mutates another extension's webview. See
   [the durable extension plan](docs/VSCODE-EXTENSION.md).

## Protocol & security

- QR pairing on the laptop → device keypairs (libsodium), per-device revocable, stored hashed daemon-side; device list + one-tap revoke in app.
- E2E encryption phone↔laptop; the relay sees ciphertext + metadata only.
- Transport modes: (a) **LAN direct** (same Wi-Fi — dev mode, day one, no relay), (b) **relay** (anywhere), (c) user's own VPN as optional layer, never required.
- Push: daemon → Expo Push → APNs/FCM, payloads carry IDs only, never content; app fetches real state over the encrypted channel. In-app inbox is source of truth; unanswered approvals re-notify escalating.
- Invariants (inherited from research, non-negotiable): no TUI scraping; no PTY resize to phone width; typed API shape as the security boundary; single-writer Claude sessions with defer-based handoff; nothing binds 0.0.0.0; audit-log every mutating call.

## Build phases (each ends usable; solo evenings pace)

| Phase | Scope | Usable deliverable |
|---|---|---|
| **A — Claude in your pocket (LAN)** ~6d | Daemon skeleton: Fastify+WS, SQLite event log + cursor replay, QR pairing, audit log. Claude adapter (SDK): sessions, canUseTool approvals, streaming, remote start in allowlisted roots. Expo dev-build app: Sessions, Inbox, session detail stream, New Task. | On home Wi-Fi: watch, approve, steer, and launch Claude sessions from the phone. |
| **B — Anywhere** ~4d | longleash-relay (WSS, E2E ciphertext routing, Docker); daemon + app speak relay with LAN fallback; deploy to a small VPS/Fly. | Everything in A works from anywhere in the world. |
| **C — Push** ~3d | Web Push with self-generated VAPID keys (free, no vendor account): service worker, subscription management, idempotent decisions + expiry + escalating re-notify; payloads carry IDs only. Tested on real iOS (home-screen install) and Android. | Phone buzzes when an agent needs you; tap to approve. |
| **D1 — Attach mode** ~5d | Session watcher tailing `~/.claude/projects/**/*.jsonl` to list EVERY Claude Code session on the machine (terminal + VS Code) with live output; a `PreToolUse` hook installed by our CLI that routes those sessions' approvals to the phone inbox within the hook timeout; honest per-session capability labels (full control / approve+watch / watch only). Gated on spike **D0** (hook fires for foreign sessions and can hold long enough to answer). See `agents/2026-08-01-external-sessions-feasibility.md`. | Sessions you started yourself — in your terminal or the VS Code chat panel — appear on your phone and ask you for approval. |
| **D — Terminals** ~4d | tmux control-mode tier in daemon; CLI switches VS Code default terminal profile to the `vscode-N` wrapper; xterm.js WebView screen; per-session attach confirmation. | Every tmux-wrapped terminal (all new VS Code terminals) watchable/typeable from the phone, scrollback replay included. |
| **E — Multi-agent** ~3d | ACP client tier: Gemini + Codex adapters, capability feature-detection, daemon-side transcript mirror, agent picker in New Task. | One inbox for Claude + Gemini + Codex. |
| **F — IDE eyes + hardening** ~4d | VS Code companion extension; device management/revocation screen; Activity feed from PreToolUse hooks; desk-handoff (defer + release → `claude --resume`). | Phone shows what the IDE is doing; clean handoff to the desk; security surfaces complete. |
| **G — Open-source release** ~5d | `longleash` CLI installer end-to-end; docs (incl. honest limits); license (MIT) + attribution; security self-review vs invariants; repo, CI, README, demo video. | Anyone: one command + one app (TestFlight/APK) + 5 minutes. |

~29 solo dev-days total. **No API key or paid API account is needed anywhere:** the Agent SDK inherits the Claude Code CLI's subscription OAuth (spike S0 confirmed `apiKeySource: "none"`), so agent runs draw on the user's existing Claude plan allowance, not a billed API account. The SDK's reported `total_cost_usd` is the token-equivalent value, not a charge. Keep contract-test runs few to respect plan rate limits.

## Agent-to-agent delegation roadmap

The original Phase E delivered multiple agent adapters. The next product layer—controlled
Claude↔Claude, Claude↔Codex, Codex↔Claude, and Codex↔Codex delegation—is specified in
[`docs/DELEGATION.md`](docs/DELEGATION.md). That document is the source of truth for the approved
Delegate → isolated parallel specialists → Crew rollout, its safety invariants, and release gates.

**Current status (2026-08-12):** Delegate Phases 0–1D are implementation-complete. The first
Phase 2 foundation is also implemented for ordinary phone launches: a second writer in one Git
project receives an isolated worktree/branch, while the physical checkout keeps its one-writer
lease. Universal Terminal/VS Code workspace handoff commands and provider model/reasoning launch
settings are wired end to end. The pre-Phase-2 control pass also adds child settings and a Tune
surface for live/dormant conversations; externally controlled sessions require an explicit,
verified transfer. Delegated children still use the reviewed sequential transfer until their
merge/return UX exists. Physical-phone UX review, all four live Claude/Codex handoffs, and
the 20-delegation dogfood gate remain required before release.

Phase 2 begins with the companion-extension contract and the remaining isolated-specialist work.
The product, security boundary, provider capability split, delivery phases, and release matrix are
preserved in [the VS Code companion plan](docs/VSCODE-EXTENSION.md). Use the
[Phase 1 phone test](docs/PHASE1-PHONE-TEST.md) before moving the release label forward.

**Phase 2A progress (2026-08-12):** V0 and the first V1 distribution gate are complete. The separate
companion protocol, fail-closed capability negotiation, workspace-trust policy, diagnostics,
installed-capability probe, and real VS Code host matrix are implemented. Codex's exact read path
returned the disposable transcript without loading or mutating its thread. Claude extension
`2.1.229` failed exact-history rendering through its documented URI, so dispatch is disabled behind
an exact-build compatibility ledger and the product must show the Terminal/`--ide` fallback. The
companion now also produces a strictly verified, hash-reported VSIX; exposes safe compatibility
evidence; provides a dry-run-capable non-shelling install/update command; and packages the artifact
in CI. It is not yet signed or publicly released. See [the V0 evidence
record](docs/VSCODE-V0-EVIDENCE.md). The next V1 slice has also started: a native Activity Bar
session tree now validates complete typed snapshots, rejects stale cursors, separates attention,
live processes, and dormant history, and stays honestly empty until authenticated daemon sync is
implemented. The exact post-public-launch resume point and gates are frozen in the
[Phase 2A checkpoint](docs/PHASE2A-CHECKPOINT.md).

Verification spikes before building on them: **S0** Agent SDK under subscription OAuth — PASSED, gate for Phase A; S1–S5 from v1 (push payload audit → now ours by construction; killed-state actions; concurrent-resume assumption; Gemini ACP quality; relay push viability → moot, we own the relay).

## Costs (honest)

| Item | Cost |
|---|---|
| All software/libraries | Free (open source) |
| Running agents (Claude) | **The user's existing Claude subscription** — no API key, no billed API account (spike S0) |
| Push notifications (Web Push + self-generated VAPID keys) | **Free** — no Apple or Google account required |
| App distribution (PWA: open a URL, add to home screen) | **Free** — no store review, no TestFlight |
| Relay hosting (Sahith's instance; users self-host free) | $0–5/mo (free tiers cover single-user) |
| Native iOS/Android wrappers | **Deferred** — only if users demand lock-screen action buttons ($99/yr + $25 at that point) |

## Known hard walls (stated honestly, in docs too)

- LongLeash never injects into another extension's private webview. Claude now documents an
  exact-session VS Code URI that the companion can use. Codex documents app-server for custom rich
  clients but not an external exact-thread URI for its own panel, so the companion will render that
  exact thread in a LongLeash-owned editor. See [the extension plan](docs/VSCODE-EXTENSION.md).
- Non-tmux terminals opened before setup can never be retro-captured on macOS.
- Killed-state lock-screen actions occasionally degrade to "open the app" (both platforms) — inbox is the guaranteed path.
- A home laptop is a home server: sleep/power/net failures happen; daemon self-health push + machine-readiness config reduce, never eliminate.
- Maintenance treadmill vs SDK/ACP churn is structural — mitigated by building only on official structured channels (the Omnara lesson), never TUI scraping.

## What we deliberately do NOT build

Hosted multi-tenant SaaS (v1 is self-hosted relay + BYO devices); web client; voice; TUI scraping of
any agent; generic shell-exec endpoint; mutation of vendor-owned chat webviews; custom terminal
emulator (xterm.js) or multiplexer (tmux) — those are internal components we configure, not products
we rebuild.
