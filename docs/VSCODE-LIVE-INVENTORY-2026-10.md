# VS Code field correction and companion rollout — 2026-10-05

## Release outcome

`cli-v0.1.0-rc.13` at commit `37de078` was published through npm trusted publishing and deployed to the public app/relay. The matching VSIX `0.0.2` was attached to that GitHub prerelease and installed locally. Main CI test/image and PR Linux/macOS/VS Code/package gates passed; automatic production deployment still fails with Cloudflare D1 permission 7403, so the exact commit was deployed manually through the owner's OAuth account and the production matrix passed. The owner laptop needed recovery from an orphan rc.12 daemon after upgrade; rc.13 doctor then reported matching CLI/daemon/relay builds and a responsive service. An authenticated live IDE snapshot for Orbit contained one Claude VS Code conversation. The physical phone and repeated-turn matrix remain unverified.

## Field evidence

The owner's iPhone showed many finished `Orbit — VS Code` Claude cards. Read-only inspection of the local event database found **37** Orbit VS Code cards; **36** contained only start/status/end events and no transcript, tool, or approval event. One card contained the continuing transcript. These are distinct native IDs reported by Claude's hooks, not 36 copies of the same LongLeash ID. The absence of a LongLeash extension is not evidence that the native Claude panel creates a new conversation for every message.

The daemon was eagerly making every `SessionStart`/passive observation into a durable card. The new gate waits for a nonempty provider transcript **whose filename matches the native session ID** before registering passive Claude VS Code IDs, while a real permission request still registers immediately. On startup, finished generic Claude VS Code entries with lifecycle-only history are omitted from fresh inventories; their database records are preserved. This targets the observed empty-card pattern and must be checked against fresh real-provider turns on the owner's phone.

During release review, the owner's rc.12 daemon was alive but stopped answering health requests while consuming high CPU. The machine has multi-GB Claude transcripts; the existing synchronous tailer could allocate and scan an entire resumed transcript when first adopted. The rc.13 candidate now starts at a bounded recent tail and reads bounded chunks per poll. An integration regression uses a sparse 128 MB transcript to prove it does not replay ancient history. The exact cause of the observed rc.12 stall still needs confirmation by healthy rc.13 service operation over the physical test window.

## Companion slice built

The existing VS Code extension foundation is now a **read-only live inventory preview** (`0.0.2`). The daemon runs a second, loopback-only HTTP listener and writes a separate 0600 `ide-endpoint.json` credential. The extension validates that local file, stores its token in VS Code SecretStorage, and polls a complete typed snapshot every two seconds. The daemon restricts each response to canonical trusted local workspace roots inside the LongLeash allowlist. Restricted Mode, remote workspaces, protocol/build mismatch, missing capability and invalid credentials receive no inventory. Removing/replacing the endpoint file revokes access to all companion windows until the daemon restarts. A new daemon stream ID resets the client's cursor; unchanged snapshots do not duplicate tree entries.

This preview **does not** read another extension's private chat state, send prompts, approve, Stop, take over, or open a provider panel. It does not yet provide per-window principal registration/revocation or event-level cursor replay. It is not Phase V1/V2 complete or a Marketplace release.

## Next gates in order

1. **Candidate rollout:** package CLI and VSIX from one reviewed commit; pass unit, actual extension-host, tarball/upgrade, dependency, and production gates. Install the VSIX in the owner's VS Code and update the managed daemon. Verify the local tree and phone show the same stable native session after multiple turns and reconnects. Record the current Claude extension and Codex versions.
2. **Physical provider matrix:** one fresh Claude and Codex session each in an ordinary terminal, VS Code integrated terminal, and their vendor panel. Confirm one card per actual native conversation, transcript freshness, source label, approval routing, reload, and restart. A distinct provider-native ID with real transcript is a separate conversation and must not be merged by matching titles.
3. **Exact handoff foundation:** add a daemon-owned session editor in the extension. Use an authenticated per-window principal, explicit release/reservation, and a verified native resume ID. The editor can display and drive the daemon's Claude SDK or Codex app-server session without a second writer. A phone command targets a specific VS Code window/workspace and receives an exact-open acknowledgement. Returning to phone reverses that reservation. Unsupported native-panel deep links keep a clearly labeled fallback.
4. **Release acceptance:** exercise phone → laptop → phone for both agents and origins with history intact, no duplicate writer, safe cancellation, provider permission prompts, network loss, VS Code reload, daemon restart, multiple windows, Workspace Trust, and rollback. Only then call IDE handoff and Workstream D closed.

Do not polish the visual design or claim Marketplace support ahead of these correctness gates. See [the full extension plan](VSCODE-EXTENSION.md) and [phone walkthrough](PHONE-LAPTOP-WALKTHROUGH.md).
