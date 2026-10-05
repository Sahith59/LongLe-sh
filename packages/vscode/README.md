# LongLeash for VS Code

This package is the Phase 2A companion extension. Version `0.0.2` connects its native session
tree to the local daemon's read-only, workspace-scoped inventory over an authenticated loopback
endpoint. V0 also contains the typed security contract, fail-closed provider preflights, safe
diagnostics, and real extension-host tests. Bidirectional handoff and provider control are not in
this preview.

The V0 live matrix found that Claude Code extension `2.1.229` did not render the requested native
history through its documented URI. LongLeash therefore disables that route unless the exact build
has an independently passing compatibility record; the UI must offer the exact Terminal/`--ide`
resume command instead. Codex `thread/read` passed without loading or mutating the thread.

During V0, run **LongLeash: Show Phase 2A Diagnostics** from the Command Palette to inspect the
local compatibility surface. The report deliberately excludes workspace paths, conversation IDs,
prompts, credentials, query strings, and raw provider errors.

From the repository root, build and verify the installable artifact with `pnpm vscode:package` and
`pnpm vscode:verify-package`. Preview installation with `pnpm vscode:install -- --dry-run`; run
`pnpm vscode:install` only when you explicitly want to install or update the local VSIX. Public
signing, Marketplace distribution, staged rollout, and rollback are later release gates.

The Activity Bar Sessions view accepts typed, complete, monotonic inventory snapshots and groups
them into **Needs you**, **Active**, and **Earlier**. A dormant resumable conversation never appears
active. The preview shows only sessions inside the current trusted local workspace; it clears the
tree when the daemon becomes unavailable. Install the matching CLI candidate before the VSIX.

See [`../../docs/VSCODE-EXTENSION.md`](../../docs/VSCODE-EXTENSION.md) and
[`../../docs/VSCODE-V0-EVIDENCE.md`](../../docs/VSCODE-V0-EVIDENCE.md).
