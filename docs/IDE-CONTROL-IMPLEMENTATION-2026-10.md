# Universal session identity and exact IDE continuation

## Owner direction — 2026-10-05

The owner clarified that duplicate cards occur across repositories, not only Orbit. Correct session identity and control take priority over visual polish. Build and verify the installable VS Code extension before asking the owner to repeat the physical phone matrix. This supersedes earlier roadmap ordering that deferred extension work until that matrix. GPT-6 Sol research, identity, and independent review agents are authorized. Existing commit/push/release authorization remains in force.

## Implementation under verification

1. Canonical provider conversation identity at hook ingress, provider-scoped live/registry/managed resume lookup, and safe historical inventory reconciliation. Never join conversations by project name or title. See [identity audit](SESSION-IDENTITY-AUDIT-2026-10.md).
2. Direct daemon supervision and authenticated build readiness during service replacement, including narrowly verified legacy orphan retirement. See [service lifecycle](D-SERVICE-LIFECYCLE-2026-10.md).
3. Installable LongLeash VS Code extension 0.0.3: trusted workspace inventory, paginated exact-conversation editor, messages, approvals/questions, stop/reopen, explicit external takeover, and phone/editor navigation.
4. Separate authenticated loopback control transport. It rejects browser Origin headers, untrusted/remote workspaces, incompatible builds, out-of-workspace sessions, unrelated approval IDs, and unsupported commands. Commands reuse the daemon's provider and workspace ownership checks. The endpoint credential is not a phone pairing or hook credential.
5. Phone selects a live eligible window. The daemon only reports opened after that exact window acknowledges rendering the requested session. Reverse navigation requires a connected phone to acknowledge its visible exact-session screen. Neither navigation action starts another provider process.
6. Existing provider SDK/app-server remains the agent writer. External sessions require the existing verified takeover process before LongLeash can send. An observed-only native panel remains read-only when no verified process handle exists.

## Supported contract

The exact IDE destination is **the LongLeash conversation editor inside VS Code** for both providers. It continues the same provider conversation through the laptop daemon. This is distinct from clicking into the private Claude/Codex vendor panel. Claude's native URI can silently create a fresh conversation when an ID is wrong; it remains fail-closed until the specific build has passed exact-history testing. No supported Codex native-panel deep link was verified. See [official-source research](VSCODE-INTEGRATION-RESEARCH-2026-10.md).

This release does not promise control of every arbitrary IDE/provider. Support is explicitly Claude Code and Codex through the validated terminal, hook, SDK/app-server and LongLeash editor paths. VS Code remote/SSH/containers and browser-hosted VS Code remain unsupported by the local companion.

## Completion gates

- [x] Focused identity, control authorization, duplicate-command, reconnect, approvals and handoff tests.
- [ ] Full workspace tests, types, build and package verification.
- [x] Real isolated extension-host and provider contracts on the candidate (simulated companion in editor host; no claim of physical phone acceptance).
- [ ] Exact committed CI artifact and install/upgrade checks.
- [ ] Coordinated CLI/app/extension release and production build verification.
- [ ] Marketplace publisher ownership/publishing access and public install verification.
- [ ] Owner physical phone matrix after the extension is ready.

The earlier rc.13 production checkpoint remains the live baseline until a new release is actually verified. Do not describe this in-progress candidate as deployed. Workstream D cannot be marked completely closed while its physical, publishing or unsupported-provider-control gates remain unmet.

## Marketplace publication setup

The repository manifest requests publisher `longleash`; that string does not prove ownership of a Marketplace publisher. No `VSCE_PAT` environment credential or local `.vsce` credential file was present during this session. The owner has been asked to identify the publisher account. Do not invent a successful listing or ask for a token in chat.

After publisher ownership is verified, configure a narrowly scoped Marketplace publishing credential as GitHub environment secret `VSCE_PAT` in `vscode-marketplace`. Run **Publish VS Code extension** on main with the exact reviewed version. The workflow verifies the selected version, types, tests and package before invoking the installed `vsce` CLI with the environment credential. It publishes the packaged VSIX, not an independently rebuilt source version. After publication, verify `longleash.longleash` in a clean VS Code Extensions search and install it there. Until that verification, distribution is the signed-in user's local VSIX installation / matching GitHub prerelease artifact only; no Marketplace claim appears in the app.

## Local candidate evidence

- 1,103 workspace tests passed: protocol 80, relay 127, app 196, daemon 624, extension 30, CLI 46.
- Workspace typechecks passed. Workspace build and Worker deployment dry-run passed during candidate verification; exact committed CI remains required.
- Eleven real Claude/Codex provider contract tests passed, including tool denial and resumable transcripts.
- Real VS Code 1.131 editor-host test passed with a disposable authenticated companion fixture: exact webview render acknowledgment, send, approval, Stop, phone return, observation-only guard and negative command acknowledgment. Original V0 host matrix also passed.
- Verified extension artifact 0.0.3: 43,353 bytes, eight entries; SHA-256 `c030e1fa4a29f65ab63e189ee1805412ac059b4ba4fbf33f9a705f9787cdb51d`.
- Isolated macOS launchd accepted the packaged direct-daemon wrapper, verified matching lock/manager PID and build, and removed the process on repeated bootout. The owner's service was unchanged during these checks.
- Independent review additionally fixed old browser subscription replay resurrecting aliases, negative send acknowledgments clearing drafts, stale editor render acknowledgments, cursor rollback, approval snapshot loss, and legacy registry rollback compatibility.
