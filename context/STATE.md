# STATE — living project context

Update this file at the end of any session that changes project state. Newest entries first in the log.

## Where we are

- **Phase:** PLAN v2 (standalone product) adopted 2026-07-29 — see PLAN.md. Machine readiness half done. Coding not started; Phase A gated on spike S0.
- **Done:** tmux 3.7b + mosh 1.4.0 installed (tmux is now an internal component; mosh harmless extra); `~/.tmux.conf` written (history-limit 50000, window-size largest, mouse on); caffeinate LaunchAgent installed + verified (machine previously slept after 1 minute); launchd plists in `scripts/launchd/` + `~/Library/LaunchAgents/`.
- **Dropped from checklist (v2 pivot):** Tailscale install (stuck standalone app can just be trashed — no longer needed), Termius, Happy, Blink. Claude `/remote-control` stays available as Sahith's personal stopgap until Phase C.
- **Next actions:** (1) slice A7 — the React+Vite PWA (Pair, Sessions, Inbox, session detail, New Task, Devices) served by the daemon, with a reachability check separate from pairing and VPN detection; (2) Sahith's kickoff list below. **No API key or paid API account is needed anywhere** — agents run on the user's Claude subscription (S0 + A6 confirmed). S0 PASSED; **A1 DONE** (protocol, 14 tests); **A2 DONE** (event log, 18 tests + eyes-on demo `pnpm demo`); **A3 DONE** (pairing + device auth, 19 tests: QR one-time challenge w/ TTL + sweep, tokens hashed + timing-safe, no-plaintext-in-DB proven, revocation w/ crash-safe listeners, restart durability — VERIFIED ON DEVICE, see below); **A4 DONE** (WS server, 19 tests: token auth on upgrade, live revocation drops sockets mid-connection, subscribe→replay→live tail, per-session isolation, gap signals, hostile input survivable, reconnect storms, backpressure watermark with resync-gap instead of unbounded buffering, heartbeat reaping half-open sockets — VERIFIED ON DEVICE); **A5 DONE** (session manager + agent adapter contract + approval store, 22 tests: allowlisted-root enforcement incl. traversal/prefix/symlink attacks, pinned cwd, streaming→events, crash→session.errored keeping partial output, approvals block the agent until decided, deny carries steering reply, duplicate decisions idempotent, expiry auto-denies so agents never hang, auto-approved tools land in the activity feed per spike S0, single-writer claim, orphan cleanup after daemon crash); **A7 DONE** (React+Vite PWA served by the daemon; hello/roots picker, visible errors, origin labels, stop, reachability + VPN diagnostics; daemon binary `pnpm start <dir>`; /health, POST-only pairing, permission-posture warning; 28 app+http tests); **A6 DONE** (real Claude adapter + 6 contract tests passing against the live SDK — see `agents/2026-08-01-slice-a6-contract.md`). 97 unit/integration tests green workspace-wide, plus 6 contract tests run on demand. `docs/ARCHITECTURE.md` added. Repo live: https://github.com/Sahith59/LongLe-sh (public).

## Sahith's kickoff list (v3 — after the PWA pivot)

**Hard blockers: none.** The web-app decision removed every paid account and signup from the plan. Only item that matters for the build: have the iPhone handy at A7/A8.

Optional reliability config for his own always-on machine (advice, not product requirements — `docs/REQUIREMENTS.md` explains the tiers):
1. `sudo pmset -c sleep 0 && sudo pmset -a autorestart 1` (Mac stays awake on power; recovers after a power cut).
2. System Settings → General → Software Update → ⓘ → turn OFF "Install macOS updates".
3. Laptop-down alert: healthchecks.io free check `longleash-deadman` (5 min period, 10 min grace) → paste ping URL. Interim only; the daemon's own heartbeat replaces it.
4. FileVault: **recommended ON**, Sahith's call, no product impact either way.

## Superseded (do NOT do these)

- ~~Expo account, EAS builds~~ — PWA pivot 2026-08-01.
- ~~Apple Developer Program $99/yr~~ — not needed for any phase; only if native wrappers are ever added.
- ~~Tailscale / Termius / Happy installs~~ — dropped at the standalone-product pivot.

## Old kickoff list (v2, historical)

1. Power config (still pending): `sudo pmset -c sleep 0 && sudo pmset -a autorestart 1`. Lid stays open when away.
2. System Settings → General → Software Update → ⓘ → turn OFF "Install macOS updates".
3. FileVault decision: recommend ON (Privacy & Security → FileVault; recovery key NOT stored on this laptop). Say the decision explicitly so it's recorded.
4. healthchecks.io free account → check `longleash-deadman` (period 5 min, grace 10 min) → paste ping URL to Claude. (Interim; Phase A daemon absorbs this.)
5. Apple Developer Program ($99/yr) — needed by Phase C for push/TestFlight; enrollment can take days, so start it when Phase A is underway.
6. Free Expo account (expo.dev) — needed when the phone app scaffold lands (Phase A).
7. GitHub repo for the monorepo (or Claude runs `git init` locally now and wires the remote later).
8. Trash /Applications/Tailscale.app whenever — it's dead weight now.

## Open questions

- **FileVault decision pending** (status audited 2026-07-29; current state deliberately kept off-repo). Recommendation: ON (System Settings → Privacy & Security → FileVault; recovery key stored somewhere safe, NOT on this laptop). Trade-off if ON: unattended reboot = down until home (dead-man alert detects it). Whatever Sahith decides gets recorded here as "decided", without publishing device security posture.
- Blink vs free Termius — decide after a week of Phase 1 use.
- VibeTunnel: deliberately skipped unless Blink/mosh UX grates after a week.
- Phase 5 (Happy fork for single-app terminals): deferred until two-app UX demonstrably fails in real use.

## Spike checklist (verify BEFORE building on these)

| # | Spike | Status | Outcome |
|---|-------|--------|---------|
| S0 | Agent SDK under subscription OAuth (gates Phase A) | **PASS** 2026-07-29 | Auth/streaming/canUseTool all work. 3 binding findings: PreToolUse hook needed for activity feed; cwd must be pinned AND tested; assert on side effects, never agent text. `agents/2026-07-29-spike-s0.md` |
| S1 | Push payload audit — approval push must carry IDs only, no prompt text on lock screen | not run | — |
| S2 | Credential audit — nothing in `~/.happy` / outbound traffic leaks OAuth or API keys | not run | — |
| S3 | Killed-state notification actions work on the real iPhone | not run | — |
| S4 | Self-hosted happy-server can deliver push through the store apps (gates Phase 3) | not run | — |
| S5 | Gemini CLI via `--experimental-acp` works under Happy (listed deprecated upstream) | not run | — |

## Open questions

- Blink vs free Termius — decide after a week of Phase 1 use.
- VibeTunnel: deliberately skipped unless Blink/mosh UX grates after a week.
- Phase 5 (Happy fork for single-app terminals): deferred until two-app UX demonstrably fails in real use.

## Public-product shape (decided 2026-07-29, refines the goal change)

Bar for public v1: **one command on the laptop, one app on the phone, working in <5 min.**
- `npx longleash init` style CLI installs/configures ALL laptop-side deps silently (tmux, happy-cli, launchd agents, invariants) — users never see them.
- The Happy phone app is the single required phone install (QR pairing).
- Tailscale = optional "advanced mode" only (raw SSH lane, self-hosted relay) — Sahith's own onboarding friction with it proved it can't be required. Termius/healthchecks.io also optional.
- Public v2 (only if v1 traction demands it): fork Happy (MIT) into a branded LongLeash app, adding the terminal session type from `agents/2026-07-29-phase5-blueprint.md`. Never rebuild E2E/relay/push from scratch.

## Verified on real hardware

- **A3 pairing + auth — VERIFIED BY SAHITH 2026-07-31**, iPhone → MacBook over Wi-Fi (phone 192.168.1.207 → laptop 192.168.1.71), running the real `DeviceRegistry`: QR scan paired a real device, token auth succeeded repeatedly with lastSeen updates, and pressing `r` revoked it — revocation listener fired and the phone's token was rejected on the next request. Single-use-challenge replay rejection was not eyeballed in that run but is covered by automated tests and was verified via simulated requests.

## Audit of A1-A6 (2026-08-01)

Full report: `agents/2026-08-01-audit-a1-a6.md`. Seven flaws found; all critical/high ones fixed the same day (stop button, orphan reconciliation actually wired, expiry sweeper actually running, real audit log replacing a doc overclaim, concurrent-session cap, WS frame cap, session origin). Deferred with named phases: external agents are mirror-only (Phase D, platform limit), sessions not persisted across restart (F), token in query string (B, TLS), event-log retention (F), `sendMessage` steering (E).

## Roadmap change (2026-08-01)

**Externally-started sessions are addressable after all.** Verified: a `PreToolUse` hook in `~/.claude/settings.json` fires for EVERY Claude Code session on the machine (CLI and VS Code extension) and can return allow/deny; all sessions write live transcripts to `~/.claude/projects/**/*.jsonl` that any process may tail. So LongLeash can list and gate sessions it did not start. Constraint: hooks are timeout-bounded (~600 s default), so foreign-session approvals cannot park indefinitely the way our own do — the UI must say so. New **Phase D1 (Attach Mode)** added to PLAN.md, gated on spike **D0**. Still impossible: injecting a prompt into a foreign running session; driving the VS Code chat webview. Full analysis: `agents/2026-08-01-external-sessions-feasibility.md`.

## Dogfood round 3 (2026-08-01) — reload wiped the screen

Refreshing the app lost every session. Two causes, both fixed:
- The daemon only tracked **live** sessions in memory, so nothing survived its own restart either
  (this was deferred audit item #9; it became urgent). Sessions are now persisted in SQLite with
  agent, cwd, origin, title, status and start time. Anything left `running`/`waiting` when the
  daemon died is marked `ended` on startup — showing "working" for an agent that no longer exists
  would be a lie the user cannot act on.
- The app had no way to **discover** existing sessions; it only learned of ones it started. `hello`
  now carries the session list, and the client rebuilds the list and resubscribes to every session
  from its cursor.

Verified end to end: two real Claude sessions, full client reload, both reappear with titles and
honest statuses, both transcripts replay, and a restored session still answers follow-up questions
about its own earlier context. Added `LONGLEASH_DATA` so instances (and test runs) can hold
separate storage.

## Dogfood round 2 (2026-08-01) — the interaction model was wrong

Sahith: "why is each message a new session?" Correct and fundamental. The composer only ever
called `startSession`, so every message spawned a one-shot agent — not a conversation. Fixed as
slice **A9**:
- **Multi-turn sessions.** The Claude adapter now drives the SDK in streaming-input mode: an
  async generator feeds user messages, so a session stays open between turns. A finished turn
  emits `session.status: waiting` instead of ending the session. `sendMessage` delivers
  follow-ups to the same agent and the same transcript. Verified against real Claude: it
  remembered a value across turns and used it three turns later.
- **Session focus.** Tapping a session opens a detail view with its own conversation, its own
  approvals, a reply box, and a stop button; the list shows status, origin, pending-approval
  count and a preview.
- **Directory choice restored.** A picker when several roots exist, plus an optional subfolder
  field, so a single-root daemon no longer traps the user.
- **Approvals appear per session** as well as in the global inbox.

## Dogfood findings (2026-08-01, Sahith on his iPhone)

First real use of the app found four defects, all fixed the same session:
1. **Send did nothing and lost the typed task.** He entered `Desktop` as the directory, which was not an allowed root. The daemon refused correctly, but the client did `if (type === 'error') return` — swallowing it — and cleared the input optimistically. Fixed: errors surface in a dismissible bar, and the prompt is retained until the message is actually on the wire.
2. **Asking for a typed path at all was the deeper bug.** The daemon knows its allowed roots; the client should never guess. Added a `hello` greeting carrying roots + capabilities; the app now preselects the single root or offers a picker.
3. **The terminal printed nothing after startup.** Server had a log hook but `startDaemon` never passed one. Now the daemon prints device connections, session starts, approvals, decisions, auto-approved tools, and completions with timestamps.
4. **The app implied it could see every session.** It now states plainly that sessions started in a terminal or the VS Code chat panel are not visible yet (Phase D1).

## Field findings

- **2026-08-01 — a user's own allow-rules bypass our approval gate.** Verified on this machine: with `allowedTools` set and `isolateFromUserSettings: true`, a `Bash` command still executed without `canUseTool` firing, because `~/.claude/settings.json` `permissions.allow` matched it (the SDK emits a CAN_USE_TOOL_SHADOWED warning saying settings allow-rules shadow the callback). We cannot override this. Response: `readPermissionPosture()` reports the count and examples at daemon startup, the activity feed still shows such actions so nothing is invisible, and `docs/REQUIREMENTS.md` states the caveat plainly. Never claim total approval coverage.

- **2026-08-01 — SECURITY HOLE FOUND BY HAND-TESTING, now fixed.** Live demo with real Claude: asked to create a file, it wrote to `/tmp/phone_test.txt`, OUTSIDE the sandbox, and the approval layer allowed it. The allowlist only governed where a session *started*, never where its tools *wrote*. Fixed: tools declaring a path have it resolved against the session cwd and checked against allowlisted roots; approvals carry `targetPath` + `outsideRoot` so the human sees the reach; `denyOutsideRoot` refuses outright for sandboxed use. Shell commands are deliberately not parsed (that would be security theatre) — they still go to a human who sees the full command. Verified against real Claude: escape attempt refused, no file created. Lesson: automated tests all passed while the product was insecure; only driving a real agent by hand exposed it.

- **2026-08-01 — agents can target paths outside the session directory.** A contract run attempted `Write: /tmp/approved.txt` before self-correcting. cwd pinning governs the agent's process, not every absolute path a tool is handed. The approval card must always show the full target path (it does), and Phase F should flag or block writes landing outside the session's allowlisted root.
- **2026-08-01 — approval behaviour is machine-dependent unless pinned.** Inheriting the developer's Claude Code settings made the same prompt sometimes raise an approval and sometimes not. The adapter now takes `allowedTools` + `isolateFromUserSettings`; the product must choose its permission posture explicitly rather than inherit one.

- **2026-07-31 — A full-tunnel VPN silently kills LAN-direct mode; corrected root cause.** First hypothesis was university client isolation. WRONG: once Cisco AnyConnect (full-tunnel, utun default route) was disconnected, the phone reached the laptop fine on the same university Wi-Fi (phone 192.168.1.207 → laptop 192.168.1.71). Verified by Sahith on-device. Two real bugs found: (1) picking the first non-internal IPv4 handed the phone 192.0.0.2, iOS's RFC 7335 service-continuity range, which Safari refuses to route — address selection must exclude 169.254/16 and 192.0.0.0/29 and prefer 172.20.10/24 (hotspot) then RFC1918; (2) no connectivity check existed, so network failure and pairing failure were indistinguishable. Product consequences: the app MUST detect an active VPN/tunnel and say so, MUST ship a reachability check separate from pairing, and MUST NOT assume LAN-direct works — corporate/university VPNs are the norm for the target user. Phase B relay remains required, but for VPN interference at least as much as for remote access.

## Log

- **2026-08-01 (PIVOT: client is a web app)** — Sahith: no budget for Apple/Google fees, and wants maximum reach for an open-source tool. Client changes from Expo/React Native to an installable **React+Vite PWA** served by the daemon/relay. Rationale: $0 forever, no store review or sideloading, instant updates, desktop browsers get a free client, and adoption friction drops to "open a URL". Accepted trade-off: iOS web push has no lock-screen action buttons (tap → approve in app, ~2s slower); Android does. Native wrappers remain a later option that changes nothing below the client. **A1–A4 unaffected** — the architecture's client-swappability paid off. Also corrected a policy error: "FileVault stays ON" was wrongly recorded as a project invariant; disk encryption is the user's call and LongLeash must never require weakened security. New `docs/REQUIREMENTS.md` codifies required vs recommended vs never-required.

- **2026-07-29 (PIVOT)** — Sahith set final scope: LongLeash is a STANDALONE end-to-end product — no Happy/Termius/Tailscale dependencies, every product surface ours. Adopted the archived Tether architecture + our own E2E relay as PLAN v2 (7 phases A–G, ~29 dev-days, $99/yr Apple at Phase C). Public-product bar unchanged: one command + one app + 5 minutes. Old compose-tools plan superseded; published artifact now outdated (refresh once v2 stabilizes). Checklist pruned: Tailscale/Termius/Happy dropped.

- **2026-07-29 (later still)** — GOAL CHANGE: Sahith wants LongLeash open-sourced and publicly usable, not just personal. Direction agreed: dogfood personal build first, then ship as a setup-orchestrator CLI + docs (not a rebuild of Happy). Tailscale standalone (brew cask) failed on his machine — login hangs, CLI reports service not started; fix in motion: swap to App Store version (or ZeroTier fallback). Phases reordered: agent lanes (Remote Control, Happy) proceed without VPN; terminal lane resumes when the network layer works.
- **2026-07-29 (later)** — Phase 1 build started. Installed tmux 3.7b, mosh 1.4.0; wrote ~/.tmux.conf; caffeinate LaunchAgent running (verified assertion). Tailscale cask install blocked on sudo password → moved to manual checklist. FileVault status audited → flagged as open decision (posture details off-repo). Dead-man plist templated in scripts/launchd/, waiting on healthchecks.io URL.
- **2026-07-29** — Planning finished. 11-agent evaluation (6 researchers, 3 designs, judge, hostile critique) chose Happy-on-Tailnet (79/100) over custom builds Tether (74) and Switchboard (73). Critique found 5 blocking flaws; all fixed in PLAN.md (dead-man direction inverted to healthchecks.io, vscode-N wrapper script, reboot/FileVault story, push-payload spike, Phase-1 prerequisite corrections). Project folder created; plan published as artifact.
