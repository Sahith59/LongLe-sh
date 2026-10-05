# Session identity audit — October 2026

## Canonical key

The provider's durable conversation ID is the identity of an external session. Claude's native JSONL filename supplies that ID when it is a UUID. Codex's `session_meta.payload.id` (or `session_id`) supplies it from the first JSONL record. A hook's `session_id` is a fallback when no durable ID can be verified. The provider is part of the internal key, because Claude and Codex can independently use the same native ID.

## Duplicate paths found

1. The `/hook` route previously sent the raw hook `session_id` to `ExternalSessions`, while Codex transcript discovery sent the durable ID. A provider that generated a fresh hook ID per turn produced a new `ext_*` session for every message, even though every hook pointed to the same transcript. This applied independently of repository path. The route now resolves the transcript ID before session start and permission handling.
2. A per-turn `SessionEnd` could end the shared durable card while the provider conversation continued. A mismatched hook ID's end event is now ignored. A matching durable ID can end the conversation.
3. `ExternalSessions` and `SessionRegistry` keyed only on native ID. Claude and Codex using the same ID could overwrite each other's live state and restart record. Live keys and a new `live_sessions_v2` table now include provider. The original `live_sessions` table and its primary key remain intact for rollback to the previous release; ordinary rows are written to both tables. A simultaneous cross-provider collision cannot be fully represented in the old single-key table, so only the new release can read both. A public `ext_<id>` collision uses `ext_<provider>_<id>` for the second provider; existing single-provider card IDs remain stable.
4. Managed-session handoff searched for a native resume ID without a provider predicate. That could join a Codex external session to a Claude managed card, or the reverse. Lookup now includes provider.

## Verification

Focused regression tests exercise changing Claude and Codex hook IDs, Codex watcher convergence, transient end events, simultaneous provider ID collisions, restart readoption, old registry migration, and provider-scoped managed resume lookup. These tests use synthetic metadata and do not read user prompts.

## Historical rows

Old events do not store a verified transcript path or durable provider ID for each provisional hook card. Their titles and repository paths are insufficient proof of identity. This change preserves those rows rather than merging conversation content based on a title or path. Phone inventory now hides parked external cards with no conversation activity, regardless of provider or surface. When a persisted `(provider, native resume ID)` is shared by a phone and external row, it hydrates the phone card as canonical; the alias's raw events remain in SQLite for audit. A live external registry alias is rekeyed to that phone card on readoption.

A read-only inspection of the local owner database on October 5 found 93 session rows across 11 working directories. Fifty-three ended Claude VS Code rows had no non-lifecycle events; one parked row was also empty. Four other VS Code rows with activity had distinct native UUIDs and matching transcript filenames, so they remain separate. Three Claude phone/terminal pairs shared a persisted native resume ID and working directory, with activity in both rows. Their native transcript files were no longer present, so their event content was not merged. No title or working-directory match was used as identity evidence.

The phone store now removes cards and replay cursors omitted from an authoritative `hello`, so a card suppressed by the daemon does not linger in Earlier after reconnect. Its raw history stays in the laptop event database. If the provider conversation later appears in a new daemon inventory, that card is seeded and replayed again.

## Remaining boundary

If a hook provides no readable transcript, the route must temporarily use its hook ID. The same is true for a Claude transcript whose filename is not a native UUID, or a Codex transcript without a readable `session_meta` first record. A future provider hook contract that carries the durable ID directly would close this gap.
