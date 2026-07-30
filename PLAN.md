# LongLeash — Build Plan v2 (standalone product)

**Decided 2026-07-29 (supersedes the compose-tools plan; that version is archived in git history and the artifact).** Sahith's final scope: LongLeash is a standalone, end-to-end, open-source product. One daemon, one phone app, our own sync layer. No Happy, no Termius, no Tailscale as user-facing dependencies. Base design: the archived "Tether" architecture (`agents/archive/tether.json`) plus our own relay replacing Tailscale.

**Vision:** AI now does the heavy lifting; the human's job is prompting and approving. LongLeash frees that job from the desk — control agent sessions, terminal sessions, and IDE sessions on your laptop from anywhere in the world.

## What "everything ours" means (boundary, agreed)

We own every product surface: daemon, phone app, relay, protocol, installer, extension. We stand on standard open-source libraries and system binaries underneath (Node, React Native/Expo, xterm.js, tmux, libsodium, SQLite) — like every real product. Forked/adapted code becomes ours (with proper license attribution). Platform fees (Apple $99/yr) are fees, not dependencies.

## Components (all ours, TypeScript throughout)

1. **`longleashd`** — laptop daemon (Node, launchd LaunchAgent, runs as logged-in user). Fastify HTTP+WS; SQLite (better-sqlite3) cursor-addressed event log, approvals with expiry, hashed per-device tokens, audit log; adapter tiers: (T1) Claude via `@anthropic-ai/claude-agent-sdk` — `query()` + `canUseTool` + `includePartialMessages` + PermissionRequest hook, cwd pinned per session; (T2) ACP via `@agentclientprotocol/sdk` — Gemini CLI (`--experimental-acp`), Codex (`codex-acp`), never `codex exec`; (T3) terminals via one long-lived `tmux -C` control-mode client — %output octal-decode, `capture-pane -p -e -S -` replay, send-keys, pause-mode flow control. Typed API only (approveDecision, sendMessage, sendKeys, startSession in allowlisted roots, attachTerminal) — never generic exec. Built-in self-health heartbeat (absorbs the dead-man script).
2. **LongLeash app** — Expo/React Native + expo-dev-client (Expo Go can't receive push; PWA disqualified — iOS web push has no action buttons). Tabs: Inbox (approvals, badge), Sessions (agents/terminals/IDE, capture-fidelity labels), Activity (audit feed). Agent streams as FlashList message blocks; xterm.js-in-WebView (write coalescing, custom Esc/Ctrl/arrows key row) for real PTYs, rendered at laptop-side size with pan/zoom — the phone NEVER resizes a PTY. Keys/tokens in expo-secure-store behind Face ID. Reconnect-and-catch-up networking: socket torn down on background, every stream cursor-resumed.
3. **`longleash-relay`** — small Node WSS relay: routes ciphertext between paired devices, zero-knowledge (E2E payloads it cannot read), stores nothing durable but queued ciphertext, NEVER credentials (the Happy #680 lesson is a design rule). Docker image, self-hostable free; hosted public instance later if the project earns it.
4. **`longleash` CLI** — installer/orchestrator: audits the machine, silently installs internal deps (tmux etc.), writes launchd agents + tmux config + VS Code terminal profile, applies invariants, prints pairing QR.
5. **VS Code companion extension** (later phase) — thin sensor/actuator: IDE state (workspace, editors, tabs, terminal inventory), best-effort shell-integration mirroring of non-tmux terminals, sendText input with terminal-identity verification. Never onDidWriteTerminalData (dead API), never the Claude chat webview (sealed).

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
| **C — Push** ~3d | Expo Push + APNs (needs Apple Developer $99/yr): "approval" category with lock-screen Approve/Deny (Deny carries text reply), time-sensitive level, idempotent decisions + expiry + escalating re-notify; killed-state testing on real devices. TestFlight distribution. | Phone buzzes when an agent needs you; approve from the lock screen. |
| **D — Terminals** ~4d | tmux control-mode tier in daemon; CLI switches VS Code default terminal profile to the `vscode-N` wrapper; xterm.js WebView screen; per-session attach confirmation. | Every tmux-wrapped terminal (all new VS Code terminals) watchable/typeable from the phone, scrollback replay included. |
| **E — Multi-agent** ~3d | ACP client tier: Gemini + Codex adapters, capability feature-detection, daemon-side transcript mirror, agent picker in New Task. | One inbox for Claude + Gemini + Codex. |
| **F — IDE eyes + hardening** ~4d | VS Code companion extension; device management/revocation screen; Activity feed from PreToolUse hooks; desk-handoff (defer + release → `claude --resume`). | Phone shows what the IDE is doing; clean handoff to the desk; security surfaces complete. |
| **G — Open-source release** ~5d | `longleash` CLI installer end-to-end; docs (incl. honest limits); license (MIT) + attribution; security self-review vs invariants; repo, CI, README, demo video. | Anyone: one command + one app (TestFlight/APK) + 5 minutes. |

~29 solo dev-days total. Verification spikes before building on them: **S0** Agent SDK under subscription OAuth (auth + ToS + cost) — gate for Phase A; S1–S5 from v1 (push payload audit → now ours by construction; killed-state actions; concurrent-resume assumption; Gemini ACP quality; relay push viability → moot, we own the relay).

## Costs (honest)

| Item | Cost |
|---|---|
| All software/libraries | Free (open source) |
| Apple Developer Program (push + TestFlight/App Store) | $99/yr — unavoidable, needed at Phase C |
| Relay VPS (his instance; users self-host free) | ~$0–5/mo |
| Google Play (only if Play Store later; sideload/APK is free) | $25 once |

## Known hard walls (stated honestly, in docs too)

- VS Code chat-panel sessions (Claude/Copilot webviews) are sealed by the platform — invisible to every tool. LongLeash steers users to daemon-hosted sessions and mirrors tmux ones.
- Non-tmux terminals opened before setup can never be retro-captured on macOS.
- Killed-state lock-screen actions occasionally degrade to "open the app" (both platforms) — inbox is the guaranteed path.
- A home laptop is a home server: sleep/power/net failures happen; daemon self-health push + machine-readiness config reduce, never eliminate.
- Maintenance treadmill vs SDK/ACP churn is structural — mitigated by building only on official structured channels (the Omnara lesson), never TUI scraping.

## What we deliberately do NOT build

Hosted multi-tenant SaaS (v1 is self-hosted relay + BYO devices); web client; voice; TUI scraping of any agent; generic shell-exec endpoint; Claude chat-panel integration; custom terminal emulator (xterm.js) or multiplexer (tmux) — those are internal components we configure, not products we rebuild.
