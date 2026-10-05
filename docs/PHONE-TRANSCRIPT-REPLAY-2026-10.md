# Phone transcript replay correction — 2026-10-05

## Field evidence

Owner native Codex VS Code session in LongLeash-Test-A appeared in the extension and phone inventory, but phone conversation showed “Nothing yet.” This is a transcript delivery defect; observed-only control does not justify missing messages.

Read-only local audit found the matching durable conversation already had one transcript reset with a user block and seven stream deltas (assistant text and tools), plus status events. Native provider record shapes parsed correctly. Replaying those 20 events chronologically through the current phone store yields 8 blocks. Applying the latest status (seq 20) before the historical events yields 0 blocks: the store cursor considers all lower sequences already seen. No private transcript bodies or credentials are recorded here.

## Released repair

The client must order initial/reconnect replay before committing newer live events to its cursor. A persistent relay connection can already be subscribed when a new phone browser joins; status events can arrive while historical replay is pending. Replay buffering must stay bounded, survive a slow replay beyond the animation timeout, and fail/retry coherently rather than silently advance past missing messages. A valid authoritative hello must still remove suppressed aliases. Exact IDE-return acknowledgement must wait for ordered history too.

Released via PR #35, commit `d3267b7`, tag `cli-v0.1.0-rc.16`. The extension stays 0.0.3. Main CI `37380133962` test/image and tag CI `37380138610` Linux/macOS tarball, real systemd and trusted npm publication all passed. The hosted app/relay was deployed from the exact tested commit (Cloudflare version `cb653ead-3a62-46ae-b264-e024f580aaa2`); production HTTP matrix passes. CI auto-deploy still fails the known D1 scope 7403; local authenticated deployment succeeded.

Verification: **1,117 workspace tests** (protocol 80, relay 127, app 205, daemon 627, extension 30, CLI 48), types/build/package gates. Client regressions include live-before-history, slow replay after 1.5s paint timeout, pre-hello events, omitted aliases, pruning, IDE-return order, events above a sync marker, existing damaged cards, connection-wide buffer bounds and disposal. Real-WebSocket regression proves old subscriptions are cleared on authoritative hello.

An isolated run of the corrected actual client/store against the owner's 20 saved Test-A events, delivering the latest status before history, recovers **8 blocks and 0 errors**. The old store sequence produced 0 blocks. This preserves private history locally; no private bodies were copied into fixtures or documentation.

Release CLI tarball SHA-1 `5a4c2b73ebf8c39957eca9e285ffc3176d91389c`. Matching VSIX 0.0.3 SHA-256 `0616bd23ade1f1963169a94ba0e3f725682e0fbae2fd258bb08703c771a181f9`; extension source is unchanged. [Release](https://github.com/Sahith59/LongLe-sh/releases/tag/cli-v0.1.0-rc.16).

## Owner retest

Refresh the phone app and accept Update if offered. Open the same Test-A “sample test files” conversation; its existing messages should render. Then send one more prompt in the same native Codex VS Code chat and verify it appends on the phone without a new card. Do not clear storage, delete conversations or pair again for this test. Observation-only still means no send/stop authority; it never means an intentionally empty transcript. Physical owner confirmation remains pending.

## Restart restoration correction — rc.17 candidate

The rc.16 owner upgrade exposed a second defect: initial Codex discovery only considers recently modified transcripts, while read-only observations are intentionally absent from the process-control registry. An idle known Test-A conversation disappeared from current inventory after restart despite its durable messages remaining intact.

Restore a bounded set of known native Codex identities from event-log metadata, validate the on-disk provider identity, VS Code origin and allowed workspace, and preserve the existing transcript on restoration. The filename is only a candidate selector. This does not grant process control or a workspace lease. Both recent and older known conversations must avoid a fresh truncated transcript reset.

### Remaining offline recovery work

The existing transcript tailer starts at EOF when adopting an existing history. Messages written while the daemon is stopped can therefore be missing; this hotfix preserves already ingested history and does not claim offline catch-up. Track a follow-up to persist observer file identity, byte offset and partial-line remainder atomically with ingested events, then resume from that checkpoint. Legacy files need bounded, non-destructive reconciliation. Do not replace a complete saved conversation with a smaller tail snapshot to conceal the gap.
