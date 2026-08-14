# LongLeash for VS Code

This package is the Phase 2A companion extension. V0 contains the typed security contract,
fail-closed provider preflights, safe diagnostics, and real extension-host tests. The first V1
distribution slice adds a verified local VSIX and dry-run-capable install/update command. It does
not yet connect to a production daemon or claim the V1 session tree.

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

The Activity Bar now contains an honest Sessions view foundation. It accepts only typed, complete,
monotonic inventory snapshots and groups them into **Needs you**, **Active**, and **Earlier**. A
dormant resumable conversation never appears active. Until authenticated daemon transport lands,
the installed view deliberately stays offline and empty instead of showing fixtures or stale cache.

See [`../../docs/VSCODE-EXTENSION.md`](../../docs/VSCODE-EXTENSION.md) and
[`../../docs/VSCODE-V0-EVIDENCE.md`](../../docs/VSCODE-V0-EVIDENCE.md).
