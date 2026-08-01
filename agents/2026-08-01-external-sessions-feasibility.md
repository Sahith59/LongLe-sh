# Can LongLeash control sessions it did not start? (2026-08-01)

**Short answer: mostly YES — far more than assumed.** This changes the roadmap. Verified against
official Claude Code docs (August 2026); the one risky item is flagged as needing a spike.

## What is now confirmed possible

| Capability | Verdict | Mechanism |
|---|---|---|
| **Gate tool use in sessions we did NOT start** (your terminal, VS Code chat panel) | **CONFIRMED** | A `PreToolUse` hook in `~/.claude/settings.json` fires for *every* Claude Code session on the machine — CLI, VS Code extension, desktop — and can return `permissionDecision: "deny" \| "allow" \| "ask"`. Settings are watched and reload dynamically. |
| **See every session on the machine, live** | **CONFIRMED** | All sessions (CLI and VS Code) append to `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` in real time. Any process may tail them. |
| **Observe VS Code chat-panel sessions** | **CONFIRMED** | The extension shares the same `~/.claude/projects` store *and* the same `settings.json` hooks as the CLI. |
| **Route approvals through an external service** | **CONFIRMED** | Hooks can call MCP tools, so a hook can consult the LongLeash daemon. |
| **Inject a new prompt into a running foreign session** | **NOT POSSIBLE** | No supported channel. Input arrives only via that session's own stdin / UI / Anthropic's Remote Control. |
| **List active sessions via an API** | **NOT AVAILABLE** | No documented command. Must be inferred from transcript-file activity. |

Docs: [hooks](https://code.claude.com/docs/en/hooks.md) ·
[sessions](https://code.claude.com/docs/en/sessions.md) ·
[settings](https://code.claude.com/docs/en/settings.md) ·
[vs-code](https://code.claude.com/docs/en/vs-code.md)

## The one real constraint

Hooks are **synchronous with a timeout** — command hooks default to 600 s (configurable), and there
is no documented way to hold one open indefinitely. Our own sessions can park an approval forever
(`canUseTool` has no deadline); a hooked foreign session cannot. So an approval raised from a
foreign session must resolve within the hook's timeout, after which Claude Code falls back to its
normal behaviour.

Practically that is a ten-minute answer window, which covers most real "I'm away from the desk"
moments but is not the indefinite park we get for sessions we own. **The product must state this
difference plainly rather than implying identical control.**

## What this means for the roadmap

A new capability, provisionally **Phase D1 — Attach Mode**, sitting before terminal mirroring:

1. **Session watcher** — tail `~/.claude/projects/**/*.jsonl`, reconstruct a live list of every
   Claude Code session on the machine with its project, recent output, and activity. Sessions get
   `origin: 'terminal' | 'vscode' | 'external'` (the field already exists in the protocol).
2. **Approval bridge** — a `PreToolUse` hook, installed by our CLI, that POSTs the pending tool
   call to the daemon, waits for a phone decision within the timeout, and returns the decision.
   Foreign sessions then raise approvals in the same inbox as our own.
3. **Honest capability labels** — each session shows what LongLeash can actually do with it:
   *full control* (we started it), *approve + watch* (hook-attached, timeout-bounded), or
   *watch only* (transcript tail, no hook installed).

**Spike D0 before building:** confirm on this machine that a `PreToolUse` hook fires for a session
started independently in a terminal, that it can hold long enough to be answered from a phone, and
what exactly happens when the timeout expires. The hook-hold behaviour is the load-bearing
assumption, and it is documented as timeout-bounded but not documented as safe to stall.

## What remains genuinely impossible

- Injecting prompts into a foreign running session (no channel exists).
- Driving the VS Code chat panel's UI from another extension (webview isolation).

Terminal mirroring via tmux (Phase D) still covers "type into a session I started in a terminal",
because that operates on the terminal rather than on Claude.
