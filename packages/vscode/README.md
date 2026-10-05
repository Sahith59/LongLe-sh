# LongLeash for VS Code

This package is the Phase 2A companion extension. Version `0.0.3` connects its native session
tree and LongLeash-owned conversation editor to the local daemon over an authenticated loopback
endpoint. Click a session to read its exact transcript. A phone open request can target this VS Code
window; the extension confirms it only after the editor renders that conversation. In the editor,
you can send a message, answer or deny a pending request, stop or reopen a controllable session,
and ask to continue on the phone. The daemon enforces session scope and control. External sessions
require an explicit Take control action before writing, and observation-only sessions remain view
only. The editor does not read or control Claude Code's or Codex's private VS Code panels.

The V0 live matrix found that Claude Code extension `2.1.229` did not render the requested native
history through its documented URI. LongLeash therefore disables that route unless the exact build
has an independently passing compatibility record; the UI must offer the exact Terminal/`--ide`
resume command instead. Codex `thread/read` passed without loading or mutating the thread.

Run **LongLeash: Show Connection Diagnostics** from the Command Palette to inspect the
local compatibility surface. The report deliberately excludes workspace paths, conversation IDs,
prompts, credentials, query strings, and raw provider errors.

From the repository root, build and verify the installable artifact with `pnpm vscode:package` and
`pnpm vscode:verify-package`. Preview installation with `pnpm vscode:install -- --dry-run`; run
`pnpm vscode:install` only when you explicitly want to install or update the local VSIX. Public
signing, Marketplace distribution, staged rollout, and rollback are later release gates.

The Activity Bar Sessions view accepts typed, complete, monotonic inventory snapshots and groups
them into **Needs you**, **Active**, and **Earlier**. A dormant resumable conversation never appears
active. The view shows only sessions inside the current trusted local workspace; it clears the
tree and disables editor actions when the daemon becomes unavailable. Other repositories require
their own trusted VS Code window. Install the matching CLI candidate before the VSIX. This is a
GitHub prerelease VSIX, not a Marketplace listing. Phone handoff and real provider behavior still
require the physical acceptance matrix before a general release.

See [`../../docs/VSCODE-EXTENSION.md`](../../docs/VSCODE-EXTENSION.md) and
[`../../docs/VSCODE-V0-EVIDENCE.md`](../../docs/VSCODE-V0-EVIDENCE.md).
