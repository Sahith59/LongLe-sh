# Phase 2A checkpoint — resume after public-site release

**Checkpoint reaffirmed:** 2026-08-15

**Functional-development baseline:** `2b49028` (`Build Phase 2A VS Code companion foundation`)

**Public-launch work after the baseline:** tracked independently by [`ACCOUNT-LAUNCH.md`](ACCOUNT-LAUNCH.md)
and the commits after `2b49028`; it does not move the Phase 2A implementation cursor.

Public-site, documentation, domain, and launch-readiness work after `2b49028` does **not** advance
the Phase 2A implementation state. Resume from the exact next slice below after the public preview
has passed its release checklist.

## What is complete

- A separate, typed companion protocol and fail-closed capability negotiation.
- Workspace Trust and remote-host policy; untrusted workspaces receive diagnostics only.
- A safe compatibility report and installed-capability probe.
- Claude exact-history live evidence: extension `2.1.229` did not render the requested history, so
  native dispatch is disabled and the exact Terminal/`--ide` fallback remains the product truth.
- Codex read-only live evidence: `thread/read(includeTurns: true)` returned the exact disposable
  transcript without resuming or mutating the thread.
- A verified, hash-reported VSIX; dry-run local install/update flow; packaged CI artifact.
- A native Activity Bar session tree with complete typed snapshots, attention/live/history
  sections, new-stream handling, and stale-cursor rejection.

The extension is not signed or publicly released. Its tree is deliberately empty unless a tested
snapshot is injected because authenticated live daemon sync is not implemented yet.

## Exact next engineering slice

Implement **authenticated daemon-to-extension snapshot sync** and feed it into the existing native
session tree.

The slice is complete only when all of these are true:

1. The extension registers and authenticates through the user-owned local companion transport.
2. The daemon sends only the capability-reduced, workspace-authorized inventory schema.
3. A reconnect resumes from a durable cursor without duplicating or losing sessions.
4. A new daemon stream identifier safely resets the cursor; a stale cursor on the same stream is rejected.
5. Revocation closes every live window for the companion principal.
6. Restricted Mode, build skew, protocol mismatch, and unsupported remote hosts expose no session data.
7. Unit, integration, real extension-host, packaged-VSIX, and manual multi-window gates pass.

Do not add Stop, Approve, Reply, Delegate, Return, provider dispatch, or other mutations to the
extension before this read-only sync and its authentication gates pass.

## Resume commands

```sh
git status --short
pnpm --dir packages/vscode typecheck
pnpm --dir packages/vscode test
pnpm --dir packages/vscode test:host:v0
pnpm --dir packages/vscode package:vsix
pnpm --dir packages/vscode package:verify
```

Then read, in order:

1. [`VSCODE-EXTENSION.md`](VSCODE-EXTENSION.md)
2. [`VSCODE-V0-EVIDENCE.md`](VSCODE-V0-EVIDENCE.md)
3. `packages/vscode/src/contracts.ts`
4. `packages/vscode/src/inventory.ts`
5. `packages/vscode/src/session-tree.ts`
6. `packages/vscode/src/extension.ts`

## Release boundary

“Phase 2A complete” remains false until authenticated live sync, reconnection, revocation,
workspace trust, packaging/install, physical VS Code, and rollback gates pass. The public website
may describe the companion as **in development** and may describe only the foundation above as built.
