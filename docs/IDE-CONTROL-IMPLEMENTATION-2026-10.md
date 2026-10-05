# Universal session identity and exact IDE continuation

## Owner direction — 2026-10-05

The owner clarified that duplicate cards occur across repositories, not only Orbit. Correct session identity and control take priority over visual polish. Build and verify the installable VS Code extension before asking the owner to repeat the physical phone matrix. This supersedes earlier roadmap ordering that deferred extension work until that matrix. GPT-6 Sol research, identity, and independent review agents are authorized. Existing commit/push/release authorization remains in force.

## Released implementation — rc.15 / extension 0.0.3

1. Canonical provider conversation identity at hook ingress, provider-scoped live/registry/managed resume lookup, and safe historical inventory reconciliation. Never join conversations by project name or title. See [identity audit](SESSION-IDENTITY-AUDIT-2026-10.md).
2. Direct daemon supervision and authenticated build readiness during service replacement, including narrowly verified legacy orphan retirement. See [service lifecycle](D-SERVICE-LIFECYCLE-2026-10.md).
3. Installable LongLeash VS Code extension 0.0.3: trusted workspace inventory, paginated exact-conversation editor, messages, approvals/questions, stop/reopen, explicit external takeover, and phone/editor navigation.
4. Separate authenticated loopback control transport. It rejects browser Origin headers, untrusted/remote workspaces, incompatible builds, out-of-workspace sessions, unrelated approval IDs, and unsupported commands. Commands reuse the daemon's provider and workspace ownership checks. The endpoint credential is not a phone pairing or hook credential.
5. Phone selects a live eligible window. The daemon only reports opened after that exact window acknowledges rendering the requested session. Reverse navigation requires a connected phone to acknowledge its visible exact-session screen. Neither navigation action starts another provider process.
6. Existing provider SDK/app-server remains the agent writer. External sessions require the existing verified takeover process before LongLeash can send. An observed-only native panel remains read-only when no verified process handle exists.

## Supported contract

The exact IDE destination is **the LongLeash conversation editor inside VS Code** for both providers. It continues the same provider conversation through the laptop daemon. This is distinct from clicking into the private Claude/Codex vendor panel. Claude's native URI can silently create a fresh conversation when an ID is wrong; it remains fail-closed until the specific build has passed exact-history testing. No supported Codex native-panel deep link was verified. See [official-source research](VSCODE-INTEGRATION-RESEARCH-2026-10.md).

This release does not promise control of every arbitrary IDE/provider. Support is explicitly Claude Code and Codex through the validated terminal, hook, SDK/app-server and LongLeash editor paths. VS Code remote/SSH/containers and browser-hosted VS Code remain unsupported by the local companion.

## Final coordinated release — rc.15

PR #34 merged the reproduced macOS asynchronous bootout correction. Release commit **`ed7d72d`**, tag **`cli-v0.1.0-rc.15`**. Main CI `37352216047` test/image passed; tag CI `37352220081` passed Linux/macOS tarballs, Linux systemd and trusted npm publication. Production was deployed from that exact commit and the HTTP matrix passed. Cloudflare version `cef4d2bd-3d74-4a62-8c09-a9e3ec7d7d4c`. Automatic GitHub deploy still lacks D1 permission7403; no broad OAuth credential was copied to CI.

The owner's rc.14 → rc.15 setup completed first try; service healthy and doctor CLI/daemon/relay all match `ed7d72d`, pairingv2 and both hook configurations. The exact published CI tarball was installed while npm processed registry availability; SHA-1 `abfeb766f249556a75671a5ce63b423baf183fc6`. [GitHub release and artifacts](https://github.com/Sahith59/LongLe-sh/releases/tag/cli-v0.1.0-rc.15).

Final tests: **1,107** (CLI48; other packages unchanged), typechecks/builds and package checks. Disposable real macOS legacy-parent → direct-daemon transition passed in 2.36 s, with new manager/lock/endpoint PID agreement, both old processes exited, disposable job unloaded, owner process untouched. ESRCH signal race is covered. The existing orphan fallback still relies on same-user, same-installation lock-backed runtime evidence; a manually detached daemon from that same installation is not independently distinguishable by launchd provenance.

Extension remains **0.0.3**; exact final CI VSIX SHA-256 `f545e60e7aac235cee6ef0137d897d2de850136341f4815a3ba299fbe6902ac6` (43,532 bytes). Every archive member is identical to the rc.14 VSIX already installed; ZIP timestamps differ. Reload the owner VS Code window before physical acceptance.

## Completion gates

- [x] Focused identity, control authorization, duplicate-command, reconnect, approvals and handoff tests.
- [x] Full workspace tests, types, build and package verification.
- [x] Real isolated extension-host and provider contracts on the candidate (simulated companion in editor host; no claim of physical phone acceptance).
- [x] Exact committed CI artifact and isolated Linux/macOS install/upgrade checks.
- [x] Coordinated CLI/app/extension artifacts and production build verification (installed CI tarball checksum matches the now-visible npm release).
- [ ] Marketplace publisher ownership/publishing access and public install verification.
- [ ] Owner physical phone matrix after the extension is ready.

Release commit `614d44d` (PR #33) is merged and the app/relay is deployed. The production HTTP matrix passed for that exact build. The matching CI-tested VSIX is attached to the [rc.14 prerelease](https://github.com/Sahith59/LongLe-sh/releases/tag/cli-v0.1.0-rc.14) and installed locally. npm trusted publication succeeded; rc.14 is now visible and the `rc` tag points to it, with provenance metadata. The owner installed the exact matching CI tarball (SHA-1 `a457e3554c55aac18747600f67410a58c4d0c1d0`), with matching CLI/daemon/relay build `614d44d`. Workstream D cannot be marked completely closed while its physical, publishing or unsupported-provider-control gates remain unmet.

## Marketplace publication setup

The repository manifest requests publisher `longleash`; that string does not prove ownership of a Marketplace publisher. No `VSCE_PAT` environment credential or local `.vsce` credential file was present during this session. The owner has been asked to identify the publisher account. Do not invent a successful listing or ask for a token in chat.

After publisher ownership is verified, configure a narrowly scoped Marketplace publishing credential as GitHub environment secret `VSCE_PAT` in `vscode-marketplace`. Run **Publish VS Code extension** on main with the exact reviewed version. The workflow verifies the selected version, types, tests and package before invoking the installed `vsce` CLI with the environment credential. It publishes the packaged VSIX, not an independently rebuilt source version. After publication, verify `longleash.longleash` in a clean VS Code Extensions search and install it there. Until that verification, distribution is the signed-in user's local VSIX installation / matching GitHub prerelease artifact only; no Marketplace claim appears in the app.

## Local candidate evidence

- 1,105 workspace tests passed: protocol 80, relay 127, app 196, daemon 626, extension 30, CLI 46.
- Workspace typechecks passed. Workspace build and Worker deployment dry-run passed during candidate verification; exact committed CI test/image jobs subsequently passed.
- Eleven real Claude/Codex provider contract tests passed, including tool denial and resumable transcripts.
- Real VS Code 1.131 editor-host test passed with a disposable authenticated companion fixture: exact webview render acknowledgment, send, approval, Stop, phone return, observation-only guard and negative command acknowledgment. Original V0 host matrix also passed.
- Released CI extension artifact 0.0.3: 43,532 bytes, eight entries; SHA-256 `57b9e56f7b1ead8e88483dadd9e32a821b441ca5dda47eacb3131c547c9a68f0`. This exact artifact was installed on the owner laptop.
- Isolated macOS launchd accepted the packaged direct-daemon wrapper, verified matching lock/manager PID and build, and removed the process on repeated bootout. The owner's service was unchanged during these checks.
- Independent review additionally fixed old browser subscription replay resurrecting aliases, negative send acknowledgments clearing drafts, stale editor render acknowledgments, cursor rollback, approval snapshot loss, and legacy registry rollback compatibility.

Final approval review added explicit VS Code confirmation for an Allow request outside the permitted project folder, showing the target path and tool summary before sending the decision. Extension typecheck, 30 unit tests, actual editor-host test and repack verification passed afterward.

The composed roundtrip regression additionally passed with real daemon, session manager, event log, companion and control hub over loopback HTTP and an authenticated phone WebSocket (only the agent factory is fake). It proves send routing into one session and confirmed handoff in both directions. PR CI passed Linux/macOS clean tarballs, Linux systemd crash/update/restart lifecycle, the Docker image, workspace checks and the actual editor host. Final correction passed all those gates before merge. Main CI run `37349375314` passed test/image; tag run `37349423372` passed both tarball platforms, real systemd and npm provenance publication. Automatic deployment failed at D1 scope (7403); local authenticated deployment of the exact tested commit succeeded. Cloudflare version `53148f75-6456-4eea-982a-2116e8ad95f4`; no D1 migrations pending.

## Live rc.13 stall discovered before rollout

The owner rc.13 daemon had elevated CPU and both its LAN health check and separate loopback IDE endpoint timed out. A bounded native sample showed the main timer thread repeatedly doing string searches and regular-expression construction, with no corresponding SQLite/I/O hot path. The Codex fallback title scan used an inclusive `lastIndexOf` cursor and reused that same position after rejecting IDE-only text: it could loop indefinitely and block every daemon request.

The candidate now advances to `roleAt - 1`. The title pass also skips JSON lines over 1 MB before parsing them, leaving the bounded string fallback for compaction history. A subprocess regression has a hard timeout, so a recurrence fails instead of hanging the test worker; it covers both only-context history and an earlier real message followed by context. Fixed inspector checks on three recent real VS Code transcripts (86 MB, 18 MB and 3 MB) returned in 246/154/112 ms with bounded blocks and no transcript content logged. After upgrade, service health and doctor build checks passed; the live IDE snapshot returned HTTP 200 in 69 ms with 8 unique cards in the LongLeash workspace, and daemon CPU was 1.1% at 36 seconds. This is operational recovery evidence, not a physical phone acceptance pass.


## Owner service rollout

Initial rc.13 → rc.14 setup activated the verified runtime/hooks but did not become healthy; the old stalled PID remained. A subsequent installed `longleash service start` automatically retired that verified orphan and started the new direct-supervision daemon. No manual kill was used. Doctor then reported matching CLI/daemon/relay `614d44d`, pairing v2 and configured Claude/Codex hooks. The initial activation race is reproduced, with an rc.15 correction under verification and is not erased by successful recovery. Reload VS Code to activate the installed extension and restart old native provider sessions to load their hooks.

The second owner health check after 1m54s returned HTTP 200 in 30 ms, CPU 0.1%, and matching launchd/lock PID. npm registry visibility subsequently passed: `rc` → `0.1.0-rc.14`, matching published SHA-1, SLSA provenance metadata present.


**Final rc.15 registry and operational check:** npm `rc` points to rc.15; checksum matches the installed CI tarball and SLSA provenance metadata is present. At1m46s the owner IDE endpoint returned HTTP200 in74ms with8 unique LongLeash workspace session IDs, CPU0.0% and matching manager/lock PID. Native extension reload and physical phone matrix remain unclaimed.
