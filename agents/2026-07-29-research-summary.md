# Research summary — six domains (2026-07-29)

Condensed from six parallel research agents; full structured findings with sources in `archive/research-recs.json`. Facts were verified against docs/repos as of July 2026 unless marked `[UNVERIFIED]`.

## 1. Terminal capture on macOS

**Recommendation:** tmux is the single capture layer for shells and TUI agents. A daemon speaks tmux control mode (`tmux -C attach`): list sessions, stream via `%output`, inject via `send-keys`, replay scrollback via `capture-pane -p -e -S -`, flow control via pause-mode (`refresh-client -f pause-after=...`). Render on the phone at laptop-side size (80–120 cols) with pan/zoom — never resize the PTY to phone width.

Key facts and pitfalls:
- A same-user daemon can attach to ANY session on the default tmux socket — including tmux the user started manually. What matters is the shell being inside tmux, not who launched it.
- **Cannot** attach to plain (non-tmux) terminals: VS Code's PTY masters belong to its ptyHost process; macOS has no cross-process PTY API; reptyr is Linux/FreeBSD only.
- Claude Code's ink TUI corrupts on resize (content loss upward, scrollback frame duplication, no reflow) — hard invariant: agent TUIs are never resized.
- `%output` payloads are octal-escaped and can split UTF-8/ANSI sequences across notifications — decode to raw bytes before feeding a terminal renderer.
- `pipe-pane` captures future output only, one pipe per pane; `history-limit` applies only to windows created after it's set.
- Flow control is mandatory, not polish: one `yarn build` can buffer megabytes to a phone on LTE.
- Daemon must be a LaunchAgent (user), not LaunchDaemon (root) — root lands on a different tmux socket and sees zero sessions.
- ttyd/GoTTY/tty-share/upterm solve public sharing, not private mirroring — copy their architecture (PTY bytes over one WebSocket, xterm.js, flow control), don't deploy them.

## 2. VS Code extension surface

**Recommendation:** the daemon owns everything that must survive VS Code closing; an extension could only ever be a thin sensor. In this plan the extension is not built at all — a tmux default-profile wrapper plus `code tunnel` replaces it.

Key facts:
- Shell-integration API (stable since ~1.93) gives command-scoped output (`execution.read()`), attach-at-start only — output before subscription is lost forever; no API reads an existing terminal buffer.
- `onDidWriteTerminalData` (raw stream) is forever-proposed and blocked for Marketplace extensions; Microsoft has said it won't stabilize.
- Another extension's webview (Claude/Copilot chat panel) is unreachable by design — at most invoke registered commands to focus it.
- Tasks API exposes start/end/exit-code only — no output streaming.
- `sendText` with default `shouldExecute` appends Enter; TUI steering needs explicit sequences (`\r`, `\x1b[A`, `\x03`).
- `code serve-web` on `0.0.0.0` or `--without-connection-token` is an unauthenticated remote IDE — tailnet-bind and keep the token if ever used.

## 3. Agent control protocols

**Recommendation:** three adapter tiers (this is what Happy already implements — adopt, don't rebuild): Tier 1 Claude via Agent SDK (`canUseTool` approvals, `includePartialMessages` streaming, shared `~/.claude/projects` store so phone-started sessions resume on the laptop with `claude --resume <id>`); Tier 2 ACP for Gemini CLI (`--experimental-acp`) and Codex (`@agentclientprotocol/codex-acp`) — `session/request_permission` maps to the same inbox; Tier 3 node-pty wrap, mirror-only, no structured approvals.

Key pitfalls:
- `canUseTool` never fires for auto-approved tools — allow-rules bypass the phone inbox silently; a PreToolUse hook is needed for an activity feed.
- Resume is keyed to the encoded cwd — resuming from the wrong directory silently creates a fresh empty session.
- Sessions are effectively single-writer JSONL files; concurrent CLI + daemon drivers risk corruption `[UNVERIFIED, assume dangerous]`.
- `codex exec` gives zero approval prompts — Codex needs app-server/ACP mode.
- Zed's adapter repos moved to the `@agentclientprotocol` npm org; old package names are archived.
- A pending `canUseTool` pins the Node process — daemon restarts must defer + resume, or the prompt is lost.

## 4. Phone client

**Recommendation (for a custom build — mooted by adopting Happy):** Expo + dev-client, not PWA (iOS web push has no action buttons and worse delivery); $99/yr Apple account non-negotiable for push; every stream cursor-addressed with reconnect-and-catch-up (iOS suspends sockets seconds after backgrounding); FlashList for agent output, xterm.js-in-WebView only for real terminals, with write coalescing and a custom Ctrl/Esc/arrows key row.

Facts that shaped the plan:
- Free Apple accounts: no push entitlement, builds die every 7 days. Store-distributed apps (Happy, Blink, Claude) delete this entire cost class — the decisive argument for compose-don't-build.
- Notification action taps from killed state are the least reliable path on both platforms — actions must be idempotent, with tap-to-open-inbox as the guaranteed fallback (spike S3).
- APNs payloads cap at 4 KB and transit Expo/Apple in plaintext — IDs only, fetch real state over the encrypted channel (spike S1).
- Android sideloading verification tightens from Sept 2026 — store installs sidestep it.

## 5. Networking + security

**Recommendation:** Tailscale-direct. Free Personal plan covers 1 user / laptop + phone. Bind services to the Tailscale interface only; `tailscale serve` for auto-renewed ts.net TLS (raw `tailscale cert` files expire in 90 days unrenewed; plain http to 100.x hits iOS ATS). VPN On Demand on `*.ts.net` (interface rule "Do Nothing") so the tunnel self-raises.

Threat model (mitigations in PLAN.md security invariants):
- Stolen unlocked phone = RCE on the laptop → biometric locks, two rehearsed revocation paths (tailnet admin + Happy unpair).
- Tailscale SSO account is the root of trust → passkey/hardware-key 2FA mandatory.
- Node key expiry (180 days) silently drops the laptop offline → disable on day one.
- Cloudflare Tunnel rejected: edge terminates TLS (reads the command channel); a service token in an app is a static bearer credential.
- Self-hosted relay lesson: E2E only covers what's actually encrypted client-side — Happy #680 stored API keys server-decryptably while marketing E2E. Avoided by never using `happy connect`.

## 6. Prior art

**Verdict: do not build the relay, E2E crypto, mobile app, or daemon — Happy (MIT, 22.9k stars, active) implements ~90% of the brief** (sessions list, approvals + push, steering, streaming, remote spawn, Claude/Codex/ACP, iOS+Android+web, self-hostable single-container server).

- **ADOPT** Happy as the core; self-host if the public relay (documented outages at api.cluster-fluster.com) flakes.
- **ADOPT** Claude Remote Control as the zero-infra Claude-only baseline. Limits: claude.ai OAuth only; silently disabled by DISABLE_TELEMETRY/DO_NOT_TRACK/custom base URL; transcripts on Anthropic servers un-E2E'd; each server bound to its launch directory.
- **IGNORE** Omnara — OSS wrapper deprecated (the treadmill warning), product closed.
- **BORROW ONLY** from Paseo (AGPL — contaminating for any future open-sourcing; Happy's MIT is the safe fork).
- Keep Blink/mosh/tmux (or VibeTunnel) as the terminal fallback layer rather than writing a terminal transport. Raw Claude TUI over SSH on a phone flickers with painful copy/paste — mosh+tmux is a fallback, not the agent daily driver.
- The one genuine gap vs the brief: unified plain-terminal control inside the same phone app → the Phase-5 fork option.
