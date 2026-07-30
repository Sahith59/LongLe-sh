# Glossary — plain language

- **Happy** — free, open-source remote control for AI coding agents. Two parts: a background program on the laptop (happy-cli) that runs the agents, and a normal App Store app on the phone showing sessions, approvals, and live output. End-to-end encrypted; the relay only ever sees ciphertext.
- **Tailscale** — a private network between your own devices. Once installed on laptop + phone, they talk securely from anywhere, like an invisible cable — without exposing the laptop to the public internet. Built on **WireGuard** (the fast, modern VPN protocol).
- **tmux** — keeps terminal sessions alive independently of any window. Closing the window (or VS Code crashing) doesn't kill the session, and you can "attach" to the same live session from another device and see the same screen.
- **sshd** — the SSH server built into macOS (System Settings → "Remote Login"). Lets another device securely log into the laptop's terminal.
- **mosh** — SSH that survives switching between WiFi and mobile data without disconnecting. Comfort upgrade, not a requirement.
- **Blink Shell / Termius** — iPhone terminal apps used to SSH into the laptop and attach to tmux. Blink (~$20/yr) has the nicest mosh support; Termius has a free tier.
- **healthchecks.io** — free service that expects a "ping" from the laptop every few minutes and alerts your phone when pings stop. That's the dead-man's switch.
- **launchd / LaunchAgent** — macOS's built-in way to keep a program running in the background and restart it automatically. A LaunchAgent runs as your user (needed here so it sees your tmux sessions).
- **`tailscale serve`** — publishes a local service to your private Tailscale network only, with automatic HTTPS certificates. Its dangerous sibling `tailscale funnel` publishes to the whole internet — never used here.
- **OrbStack / Docker** — a way to run a packaged server (happy-server) in an isolated box on the laptop. Used only in Phase 3 to self-host the relay.
- **Claude Agent SDK** — the official library for driving Claude Code programmatically. Its `canUseTool` callback is how permission prompts get routed to a phone instead of the terminal.
- **ACP (Agent Client Protocol)** — a standard protocol some agents (Gemini CLI, Codex adapters) speak, so one client can control any of them. How Happy supports non-Claude agents.
- **PTY / TUI** — a PTY is the "virtual terminal" a program runs in; a TUI is a full-screen text interface drawn inside it (like Claude Code's chat UI). Key limits: macOS can't read another program's PTY, and Claude Code's TUI corrupts if resized to phone width.
- **E2E (end-to-end encryption)** — only the laptop and the phone can read the messages; the relay in the middle sees ciphertext only.
- **Dead-man's switch** — an alarm that fires when a regular "I'm alive" signal stops, rather than when a problem is reported. The only way to detect a laptop that lost power.
