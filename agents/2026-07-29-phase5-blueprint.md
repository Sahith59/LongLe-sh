# Phase-5 blueprint — single-app terminals via a Happy fork (archived, deferred)

Build this ONLY if the Happy (agents) + Blink (terminals) two-app split demonstrably grates after weeks of real use. First re-verify Happy still lacks a terminal session type — its absence was `[UNVERIFIED]` at planning time. Estimated 6–8 solo days.

## Shape

Fork Happy (MIT — safe to fork; Paseo is AGPL, contaminating). Add a **terminal session type**, additive, riding the existing E2E channel and session list. Two sides:

## happy-cli side (laptop) — TmuxAdapter

- Attach via tmux control mode: `tmux -C attach` on the default per-user socket (daemon must run as a LaunchAgent, same user, or it sees zero sessions).
- Live stream: `%output` notifications. Payloads are octal-escaped and can split UTF-8/ANSI sequences across notifications — decode to raw bytes before forwarding, feed the renderer untouched.
- Input: `send-keys`. Explicit sequences for TUI keys (`\r`, `\x1b[A`, `\x03`).
- Connect-time replay: `capture-pane -p -e -S -` (full scrollback with colors). `pipe-pane` captures future output only, one pipe per pane.
- Flow control (mandatory): tmux pause-mode — `refresh-client -f pause-after=...` — or a ttyd-style ack/resume scheme, so a build log can't flood a phone on LTE.
- Optional: `@xterm/headless` + serialize addon per session for instant reconnect snapshots without querying tmux.
- Invariants: the control-mode client never issues `refresh-client -C` (never registers a size); `window-size largest` stays set; remote-started terminals are `tmux new-session -d -c <dir>` with dirs constrained to allowlisted project roots (graft 7).

## Expo app side (phone)

- xterm.js in a WebView (pattern: `@fressh/react-native-xtermjs-webview`).
- Render at the pane's laptop-side size (80–120 cols) with horizontal pan / pinch-zoom — never resize the PTY to phone width (Claude Code's ink UI corrupts on resize; this invariant is why the adapter never registers a client size).
- Coalesce writes across the RN↔WebView bridge or fast output freezes the UI.
- Custom accessory key row: Ctrl, Esc, Tab, arrows (mobile keyboards lack them; autocorrect off).
- Keep FlashList (plain virtualized text) for agent/chat streams — the xterm view is only for real PTY sessions.

## Warning (from the critique, endorsed)

Forking a fast-moving Expo monorepo is the one place the glue-first plan can quietly become the greenfield build it exists to avoid. Rebase burden is permanent. Before starting: check whether upstream Happy has grown terminal sessions or a config hook that makes the fork unnecessary.
