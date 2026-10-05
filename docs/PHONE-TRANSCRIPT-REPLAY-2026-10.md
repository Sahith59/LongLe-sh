# Phone transcript replay correction — 2026-10-05

## Field evidence

Owner native Codex VS Code session in LongLeash-Test-A appeared in the extension and phone inventory, but phone conversation showed “Nothing yet.” This is a transcript delivery defect; observed-only control does not justify missing messages.

Read-only local audit found the matching durable conversation already had one transcript reset with a user block and seven stream deltas (assistant text and tools), plus status events. Native provider record shapes parsed correctly. Replaying those20events chronologically through the current phone store yields8blocks. Applying the latest status(seq20) before the historical events yields0blocks: the store cursor considers all lower sequences already seen. No private transcript bodies or credentials are recorded here.

## Repair under verification

The client must order initial/reconnect replay before committing newer live events to its cursor. A persistent relay connection can already be subscribed when a new phone browser joins; status events can arrive while historical replay is pending. Replay buffering must stay bounded, survive a slow replay beyond the animation timeout, and fail/retry coherently rather than silently advance past missing messages. A valid authoritative hello must still remove suppressed aliases. Exact IDE-return acknowledgement must wait for ordered history too.

CLI rc.16 is assigned because the packaged local app must match the hosted client. Extension remains0.0.3. At this checkpoint rc.15/ed7d72d is still live. Release and owner physical result are not yet claimed.
