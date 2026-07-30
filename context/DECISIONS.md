# Decisions — what was chosen and why

## 2026-07-29 PIVOT: standalone product (overrides "compose, don't build" for the product itself)

Sahith's explicit call after the goal changed from personal tool to public open-source product: no third-party apps as dependencies (Happy, Termius, Tailscale all out); every product surface built/owned by us. The original evaluation scored the custom build (Tether, 74) below composition (79) **for a personal tool** — the public-product goal flips that weighting, so Tether + our own E2E relay is now the architecture of record (PLAN.md v2). Accepted costs, stated once: $99/yr Apple, solo maintenance of daemon + app + relay + extension against SDK/ACP churn, ~29 dev-days to public v1. Risk mitigation carried over: structured protocols only (never TUI scraping — the Omnara failure mode), relay never stores credentials (#680 lesson), typed API as the security boundary. The composed stack (Remote Control etc.) remains Sahith's personal stopgap while v1 is built — dogfooding both informs the product.

## How the architecture was chosen (2026-07-29)

Eleven agents in four stages: six parallel researchers (terminal capture, VS Code extension APIs, agent protocols, phone stack, networking/security, prior art), three independently designed architectures, a weighted judge, and a hostile critique. Raw data in `../agents/archive/`.

| Design | Score | In one line |
|---|---|---|
| **Happy-on-Tailnet** (winner) | 79 | Compose maintained tools; custom work is config + three scripts |
| Tether | 74 | Custom TS daemon + Expo app: highest polish ceiling, forever-maintenance for one user (−7 over-engineering) |
| Switchboard | 73 | Protocol-first control plane: best extensibility on paper, "the product is the protocol" (−9 over-engineering) |

Weighting: solves the pain 30 · solo-maintainable 25 · UX ceiling 20 · security 15 · extensibility 10, explicit over-engineering penalty. Decisive fact: the custom builds concede in their own risk sections that they rebuild ~90% of Happy (maintained, 22.9k-star, MIT) — and Omnara's deprecation shows how solo-maintained agent wrappers end. Critique verdict: **sound-with-fixes**; all five blocking fixes are folded into PLAN.md.

## The five architectural decisions

1. **Compose, don't build.** Happy = ~90% of the brief. Trade-off: upstream fix latency and UX ceiling; Phase-5 fork is the exit.
2. **Tailscale-only networking, zero public endpoints.** Cloudflare Tunnel rejected (edge reads plaintext of an RCE channel). Trade-off: VPN on both devices; occasional first-request retry.
3. **tmux as sole terminal capture layer.** macOS cannot retro-attach PTYs (reptyr is Linux-only). Trade-off: non-tmux terminals invisible — stated honestly in the UI.
4. **Structured agent channels; terminal view is mirror-only.** SDK/ACP for approvals, never TUI scraping; never resize agent TUIs to phone width (ink corruption). Trade-off: hand-launched bare `claude` gets mirror-only.
5. **Single-writer sessions, enforced by a wrapper.** Dual-writer `--resume` risks transcript corruption (unverified, assumed dangerous). Trade-off: one extra hop on laptop handback.

## Notable smaller calls

- Dead-man's switch direction inverted (critique fix): laptop pings healthchecks.io; alert fires when pings STOP. A dead laptop can't send its own alert.
- FileVault stays ON; accept down-until-home on unattended reboot, with detection. Never auto-login on an RCE machine.
- Plain sshd over the tailnet instead of "Tailscale SSH" (GUI app can't accept incoming SSH) — and sshd runs at the login window, softening the reboot gap.
- VibeTunnel and a standing `code tunnel` LaunchAgent cut as over-engineering: break-glass tools get started on demand, not run 24/7.
- Self-hosting the relay moved earlier (after Phase 2), gated on spike S4, because the hosted relay is the weakest reliability/security link.
- Start free (Termius) — Blink ~$20/yr only if reconnect UX grates.
