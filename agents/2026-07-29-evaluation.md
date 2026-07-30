# Architecture evaluation — designs, judgment, critique (2026-07-29)

Full raw data: `archive/designs.json` (all three designs), `archive/judgment.json`, `archive/critique.json`, `archive/winner.json`.

## The three designs

| Design | Stance | Score |
|---|---|---|
| **Happy-on-Tailnet** | Glue-first: compose Happy + Tailscale + tmux + Blink; custom work = config + scripts | **79** |
| Tether | Integrated product: custom TS daemon + Expo app + VS Code extension | 74 |
| Switchboard | Protocol-first: universal adapter control plane (ACP-style), agents.toml config | 73 |

Weighting: pain solved 30 · solo-maintainable 25 · UX ceiling 20 · security 15 · extensibility 10, explicit over-engineering penalty (Tether −7, Switchboard −9).

**Judge's decisive reasoning:** all three solve the core pain; the differentiator is cost of ownership. Happy-on-Tailnet ships a working approvals inbox with push the same day, with essentially zero code to maintain. The custom designs concede in their own risk sections that they rebuild ~90% of a maintained 22.9k-star MIT project, and both require owning a daemon + mobile app + (for Tether) a VS Code extension forever, plus the $99/yr Apple program and TestFlight's 90-day re-upload treadmill for a one-user app. Omnara's deprecation is the evidence for how solo-maintained wrappers end.

## Grafts merged from the losing designs

1. Verification spikes pulled to week one (S1–S5) instead of deferred to dependent phases.
2. Self-hosting the relay moved to right after Phase 2 (weakest reliability/security link), gated on spike S4.
3. Dead-man's-switch heartbeat for laptop-down detection (the one custom glue worth writing early).
4. tmux no-resize invariant codified as configuration (`window-size largest`), not habit.
5. Single-writer session discipline with an explicit release-then-resume handoff.
6. Losing designs' terminal-adapter specs archived as the Phase-5 blueprint (see `2026-07-29-phase5-blueprint.md`).
7. Allowlisted project roots for remote spawn — if the fork or an upstream config hook ever exists.

## Hostile critique — verdict: sound-with-fixes

Five blocking issues, all fixed in PLAN.md:

1. **Dead-man's switch pointed the wrong way** — a dead laptop can't send its own alert. Fix: laptop pings healthchecks.io every 5 min; the alert fires when pings stop.
2. **Static VS Code tmux profile broken** — `tmux new -A -s vscode-N` as a fixed string attaches every terminal to the same session. Fix: 5-line wrapper picks the first unused `vscode-N`.
3. **No reboot story** — LaunchAgents start only after login; FileVault blocks unattended boot; clamshell sleep ignores pmset/caffeinate. Fix: `autorestart 1`, no auto-updates, lid open or `disablesleep 1`, FileVault stays ON with accepted detected downtime, sshd (runs at login window) as partial mitigation.
4. **Push privacy asserted, not established** — Expo has no payload E2E; if Happy embeds prompt text in pushes, plaintext transits Expo/APNs. Fix: spike S1 audits a real notification before trusting the story.
5. **Phase-1 false prerequisites** — Dispatch needs Claude Desktop (not installed); mosh-server wasn't in the install list; "Tailscale SSH" doesn't work with the macOS GUI app. Fix: dropped Dispatch, `brew install mosh`, plain Remote Login sshd over the tailnet.

Additional over-engineering cuts endorsed: VibeTunnel deferred (try a week on Blink first); no standing `code tunnel` LaunchAgent (break-glass, start via SSH); `/remote-control` demoted after Phase 2; realistic estimate ~6.5 days of evenings, not the design's optimistic 1.5.

Security findings carried into PLAN.md invariants: hosted-relay window accepted knowingly until Phase 3; stolen-phone revocation rehearsal; 2FA on the Tailscale SSO root of trust; bind-address audits; remote spawn is unbounded RCE once paired — contained, reviewed, consciously accepted.
