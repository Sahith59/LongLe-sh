# LongLeash Delegate — Product and Engineering Plan

**Status:** Phases 0–1D implementation-complete; live-device and vendor dogfood gates pending
**Owner:** LongLeash
**Working name:** Delegate
**Future multi-agent workspace:** Crew

This document is the durable source of truth for LongLeash's agent-to-agent work. It preserves
the product decision, architecture, safety boundaries, rollout plan, and release criteria so the
feature is not rebuilt from partial chat history or memory.

## Product thesis

LongLeash should let a person delegate work from any visible agent session to another Claude or
Codex session from their phone. The person sees and can edit exactly what context crosses the
boundary, every receiving session remains independently controllable, and no agent can grant
permission on the person's behalf.

The concise product promise is:

> Delegate work between Claude and Codex from your phone, see exactly what context crosses, and
> bring the result back without surrendering control.

This is a credible product direction. Anthropic, OpenAI, and GitHub are all investing in parallel
agents, subagents, handoffs, or isolated agent workspaces. The useful behavior is controlled,
bounded delegation—not autonomous agents chatting indefinitely. LongLeash's distinctive position
is cross-provider, local-first, phone-controlled delegation with visible context and human-owned
approvals.

## Naming

- **Delegate** is the user-facing action for sending a bounded task to another session.
- **Delegation** is the durable parent/child relationship and its lifecycle.
- **Briefing** is the editable context sent to the child.
- **Return** is the editable result sent back to the parent.
- **Crew** is the later coordinated multi-agent workspace.
- Do not call this feature "Relay" in the UI. Relay already means LongLeash's encrypted network
  transport, and using it for orchestration would make diagnostics and documentation ambiguous.

## Approved V1 experience

From any LongLeash session:

1. The person long-presses a transcript message or taps **Delegate** in the session header.
2. They choose Claude or Codex as the receiving agent.
3. They choose a role: **Investigate**, **Review**, **Implement**, or **Test**.
4. They choose context scope: **Selected message**, **Recent conversation**, or **Entire task**.
5. LongLeash builds a structured briefing.
6. The briefing is shown in a full, editable mobile sheet. Nothing is sent invisibly.
7. The person taps **Start delegated session**.
8. LongLeash creates a new child session with visible source attribution.
9. The child runs as an ordinary LongLeash session with its own stream, Stop control, questions,
   and approvals.
10. When the child completes useful work, LongLeash prepares a return summary.
11. The person reviews and edits the return before sending it into the parent.

All four combinations must work:

- Claude to Claude
- Claude to Codex
- Codex to Claude
- Codex to Codex

Phone-, Terminal-, and VS Code-origin sessions may be delegation sources. V1 always creates a new
child instead of injecting work into an arbitrary existing live session.

## Briefing contract

A briefing is structured, human-readable, and fully editable:

```text
Delegated by the user through LongLeash.
Source: Claude · Fix authentication redirect · selected message 18
Role: Review

Objective
...

Relevant context
...

Decisions already made
...

Files or components involved
...

Expected deliverable
...

Constraints
...

Quoted conversation context
...
```

Rules:

- The receiving agent is told the material came from another session; it is never represented as
  fresh words typed directly by the person.
- Quoted transcript material is untrusted context. Text such as "the user already approved this"
  never grants authority.
- The default briefing generator is deterministic and local. It selects and formats durable
  transcript events; it does not silently call another model.
- A later optional **Improve briefing** action may ask the source agent for a handoff summary, but
  its result is still previewed and editable.
- The briefing has a visible context-size estimate and an enforced maximum. Truncation is explicit,
  deterministic, and keeps the selected message plus the newest relevant context.

## V1 safety boundaries

These are product invariants, not deferred polish:

1. **Human-reviewed boundaries.** Briefings and returns are previewed before delivery.
2. **Independent approvals.** Every child keeps its own approval queue. An agent cannot approve,
   answer, or provide consent for another agent.
3. **Honest attribution.** Every delegation and return displays its source agent and session.
4. **No infinite loops.** V1 does not automatically bounce messages between sessions.
5. **Bounded depth.** V1 allows at most two delegation edges below a root session.
6. **Idempotent creation.** Reconnects, retries, and double taps cannot create duplicate children.
7. **One writer per checkout.** Two writable sessions cannot concurrently own the same working
   directory.
8. **Explicit external takeover.** Returning into a live Terminal- or VS Code-owned session requires
   an explicit **Take over and return** confirmation. LongLeash never types into it silently.
9. **Typed API only.** Delegation never becomes a generic remote shell or arbitrary process API.
10. **Encrypted transport unchanged.** The hosted relay routes ciphertext and does not learn
    briefings, returns, transcript text, agent prompts, or approval content.
11. **Audit every mutation.** Draft creation, child start, cancellation, return, and workspace
    ownership changes record the device and time.

## Workspace policy

Parallel agents are safe only when their writes cannot collide.

### V1

- Every V1 role is treated as potentially writable. Claude, Codex, and externally started
  sessions do not expose one stable cross-provider read-only contract strong enough to make a
  product safety claim.
- Every delegation acquires the same exclusive, sequential workspace lease before starting.
- Launch pauses/releases the source's active writer and grants the lease to the child.
- Returning work releases the child lease before the source may write again.
- The UI says **Move sole workspace control** and never labels a role read-only based on prompting.

### Phase 2

- Git repositories gain isolated worktrees and separate branches for concurrent writers.
- Non-git folders remain sequential unless an explicit isolation provider exists.
- Worktree creation, validation, merge/handoff, preservation, and cleanup use typed daemon APIs.
- Dirty trees are preserved by default. Cleanup never deletes uncommitted work without a separate,
  explicit confirmation.

## Architecture

LongLeash already has the core runner layer:

- a vendor-neutral `AgentKind`;
- Claude and Codex factories behind one `AgentFactory` contract;
- typed remote session start;
- durable cursor-addressed transcripts;
- resumable native session identifiers;
- per-session approvals and Stop;
- origin attribution for phone, Terminal, and VS Code;
- a one-writer session claim.

Delegation is therefore an orchestration layer above `SessionManager`, not a new agent adapter.

### New daemon responsibility: `DelegationManager`

`DelegationManager` owns:

- validating source sessions and stable source event references;
- generating deterministic briefing drafts;
- enforcing delegation depth and idempotency;
- acquiring and releasing workspace leases;
- starting a target session through `SessionManager`;
- persisting parent/child relationships and lifecycle state;
- preparing and delivering reviewed returns;
- auditing orchestration mutations.

`SessionManager` remains responsible for individual agent lifecycle, transcript, approvals, and
native resume behavior. It must not absorb multi-agent workflow policy.

### Durable schema

The initial `delegations` record contains:

| Field | Meaning |
|---|---|
| `delegation_id` | Stable LongLeash identifier |
| `idempotency_key` | Unique client operation key preventing duplicate children |
| `source_session_id` | Parent session |
| `source_seq` | Optional selected event sequence |
| `target_session_id` | Child session, assigned when started |
| `target_agent` | Claude or Codex |
| `role` | investigate, review, implement, or test |
| `context_scope` | selected, recent, or task |
| `depth` | Number of delegation edges below the root |
| `briefing` | Exact approved text delivered to the child |
| `return_text` | Exact reviewed text returned to the parent, when present |
| `status` | draft, starting, running, ready, returned, cancelled, or failed |
| `failure` | User-safe failure detail, when present |
| `created_by` | Device that initiated it |
| `created_at` / `updated_at` | Durable lifecycle timestamps |

The database must enforce one target session per delegation and one delegation per idempotency key.
Lifecycle transitions are validated; arbitrary status rewrites are forbidden.

### Session relationship metadata

Session listings and start events eventually expose optional relationship metadata:

- `parentSessionId`
- `delegationId`
- `delegationRole`
- `delegationDepth`

Older clients ignore these optional fields. Older databases gain nullable columns through the
existing migration helper without losing historical sessions.

### Stable transcript references

Protocol events already have a per-session monotonic `seq`. UI transcript blocks must retain their
source sequence range:

- `firstSeq`
- `lastSeq`

Merged streaming deltas extend `lastSeq`. Tool and user blocks remain discrete. A selected message
is referenced by session ID and sequence, never by array index or display text.

### Protocol evolution

The intended typed operations are:

- `previewDelegation` — returns a deterministic draft and source metadata without mutating state.
- `startDelegation` — carries the approved briefing, target, role, source reference, workspace mode,
  and idempotency key.
- `cancelDelegation` — stops/cancels the child through normal lifecycle rules.
- `prepareReturn` — produces an editable result draft.
- `returnDelegation` — delivers the approved return to the parent or requests explicit takeover.

Relevant server events/acknowledgements carry the delegation ID, target session ID, status, and
user-safe errors. Clients must never infer success from socket delivery alone.

## Mobile UX

### Entry points

- A **Delegate** action in the session header.
- A message action on eligible user and agent transcript blocks.
- A child session banner linking back to its parent.
- A parent session section listing its delegated children and their live status.

### Delegate sheet

The sheet is a short staged flow, not one dense form:

1. **Send to** — clear Claude and Codex cards; unavailable agents explain why.
2. **Ask it to** — Investigate, Review, Implement, or Test.
3. **Context** — selected message, recent conversation, or entire task.
4. **Briefing** — full-width editor with context estimate and source attribution.
5. **Workspace** — exclusive sequential ownership now; isolated worktree when supported.
6. **Review** — concise consequences and **Start delegated session**.

The keyboard must not cover the editor or primary action. The sheet must fit 320 px-wide screens,
respect safe areas, preserve a draft through reconnects, and make destructive/costly choices
explicit.

### Relationship presentation

- Session cards receive a restrained `CHILD · REVIEW` or `PARENT · 2 ACTIVE` marker.
- Agent colors remain the primary vendor distinction; relationship markers use neutral LongLeash
  styling so role and vendor are not confused.
- The session detail shows a compact lineage breadcrumb, never a noisy graph by default.
- A dedicated graph or Crew view is reserved for multiple simultaneous children in Phase 2/3.

## Delivery phases

### Phase 0 — Durable plan and foundation

- [x] Preserve the approved product and engineering plan.
- [x] Link it from the main build plan.
- [x] Add durable delegation identity and lifecycle storage.
- [x] Add parent/child session metadata.
- [x] Retain stable event sequence ranges on transcript blocks.
- [x] Add focused migrations, protocol, store, and manager tests.

**Exit:** a delegation relationship survives daemon and browser restarts and can be represented
without launching a child from the UI yet.

### Phase 1A — Briefing preview

- [x] Deterministic transcript selection and briefing builder.
- [x] Context size calculation and explicit truncation.
- [x] `previewDelegation` protocol request/response.
- [x] Mobile agent, role, scope, and briefing editor.
- [x] Local draft preservation across reconnect/backgrounding.
- [x] Accessibility and narrow-screen interaction contracts.

**Exit:** the phone can create and edit the exact briefing, but nothing launches until confirmed.

**Implementation note (2026-08-12):** the code-level exit is met. The design harness exposes
`preview.html?screen=delegate` for real narrow-screen review. Automated markup, focus, touch-target,
safe-area, 320-class breakpoint, draft, protocol, truncation, and no-launch tests pass. A live
in-app browser was not attached during this slice, so physical-device visual QA remains a release
check and is not represented as completed here.

### Phase 1B — Start and observe a child

- [x] Idempotent `startDelegation`.
- [x] Target capability discovery from the daemon.
- [x] Target child launch through the existing `SessionManager`.
- [x] Durable source/child navigation and status.
- [x] Independent child approvals, Stop, errors, and notifications.
- [x] Depth and concurrent-session limits.

**Exit:** all four Claude/Codex combinations launch once, remain controllable, and survive reconnects.

**Implementation note (2026-08-12):** the code-level exit is met. A persisted
`DelegationManager` now owns validation, exact-byte briefing delivery, lifecycle reconciliation,
depth/concurrency limits, and audit events above the existing `SessionManager`. The authenticated
WebSocket protocol advertises installed targets, requires explicit confirmation, and reconciles a
lost acknowledgement by durable idempotency key. The phone shows a capability-aware final
confirmation, opens the attributed child, and keeps parent/child status and navigation current;
the child continues to use ordinary per-session approvals, notifications, errors, and Stop.

Verification used three independent gates: focused lifecycle and UI contracts; the complete
repository test/typecheck/build pipeline; and a cross-layer behavior plus rendered-mobile audit.
The final clean run passed 659 automated tests (44 protocol, 31 relay, 473 daemon, 111 app), every
package typecheck, and every production build. Authenticated WebSocket tests cover launch,
reconnect, duplicate delivery, and Stop; controllable adapters cover all four Claude/Codex
directions, exact briefing bytes, approvals, failure, shutdown, and restart recovery. Headless
Chrome mobile emulation passed at true 320x700 and 390x844 CSS viewports with zero horizontal
overflow and a reachable 50 px launch action. Physical-phone and live paid/vendor-agent dogfood
remain release checks; Phase 1C return and Phase 1D workspace safety are intentionally not claimed
by this phase.

### Phase 1C — Reviewed return

- [x] Deterministic return draft from the child's last completed work.
- [x] Editable return sheet.
- [x] Parent delivery with honest attribution.
- [x] Explicit takeover for live Terminal/VS Code parents.
- [x] Returned/cancelled/failed lifecycle completion.

**Exit:** a person can complete the full parent → child → reviewed return loop safely.

**Implementation note (2026-08-12):** the code-level exit is met. `ReturnBuilder` selects only the
last durably completed child prose turn, excludes tool/thinking/partial noise, and applies an
explicit deterministic 24,000-character bound. The phone presents the current parent/child route,
attached attribution, an autosaved exact-text editor, truncation disclosure, explicit external
takeover, and a separate human-confirmed recovery action after uncertain delivery. Delivery uses a
durable `sending`/`sent` marker: a crash at the vendor boundary is reported as uncertain and is
never automatically retried into duplicate work. Returned text, operation identity, actor, and
timestamp are durable and replay-safe; simultaneous identical returns converge while changed
returns fail before a second parent injection.

### Phase 1D — Workspace lease and release hardening

- [x] Typed workspace lease registry.
- [x] Honest sequential fallback for every V1 role.
- [x] Pause/release/return behavior for writers.
- [x] Crash and daemon-restart lease reconciliation.
- [x] Clear conflict and recovery UI.

**Exit:** two writable agents cannot touch the same checkout concurrently through LongLeash.

**Implementation note (2026-08-12):** the code-level exit is met. A realpath-canonicalized SQLite
lease registry provides atomic owner → reservation → owner transfer with mutation audit records.
Managed sessions acquire before spawn, release on every terminal path, and use a bounded drain
deadline so an uncooperative adapter cannot freeze or falsely complete a handoff. External
Terminal/VS Code conflicts are OS-paused where process identity can be verified; hooked writes are
denied, weaker enforcement is labeled honestly, failed takeover re-pauses the process, and lease
release resumes it. Startup retains only re-adopted external owners or valid starting reservations
and removes stale authority. Failed launch/return races restore a genuinely live writer or release
the reservation, including the edge where a process exits while restoration is in flight.

The combined Phase 1C/1D clean gate passes 690 automated tests (45 protocol, 31 relay, 497 daemon,
117 app), all package typechecks, and all production builds under Node 26. Authenticated WebSocket,
SQLite migration, exact-byte, concurrent retry, crash-boundary, source → child → source ownership,
external conflict, interrupt-timeout, shutdown, 320-class layout, focus, safe-area, and minimum
touch-target contracts are covered. This environment had no controllable in-app browser attached,
so fresh rendered-device screenshots, physical-phone keyboard/touch review, the four live paid
Claude/Codex combinations, and the 20-delegation dogfood bar remain release gates—not claimed
results.

### Phase 2 — Isolated parallel specialists

- [x] Git worktree provider and per-session branches for ordinary phone launches.
- [ ] Apply isolated worktrees to delegated children after merge/return review UX exists.
- [ ] Multiple children per parent.
- [ ] Parallel review/research/implementation roles.
- [ ] Changes, tests, and branch status summaries.
- [ ] Preserve, merge/handoff, and safe cleanup flows.
- [ ] Compact task/delegation overview.

**Exit:** multiple writers operate safely in isolated checkouts and their results can be brought back.

### Phase 3 — Crew

- [ ] Coordinator session and shared task list.
- [ ] Task dependencies and explicit ownership.
- [ ] Visible agent mailboxes and attributed messages.
- [ ] Maximum agents, depth, turns, runtime, and usage budgets.
- [ ] Pause, interrupt, redirect, retry, and remove-agent controls.
- [ ] Human checkpoints before expanding the team or merging work.
- [ ] Cross-agent discussion without cross-agent consent or approval.

**Exit:** LongLeash supports a bounded, observable cross-provider team rather than an uncontrolled
conversation loop.

## Release-quality verification

The feature is not release-ready until these behaviors are covered by automated tests where
possible and real-device tests where necessary:

- Claude→Claude, Claude→Codex, Codex→Claude, and Codex→Codex.
- Phone-, Terminal-, and VS Code-origin parents.
- The child receives exactly the briefing shown at confirmation.
- The parent and child display accurate, navigable attribution.
- Agent-authored claims of approval never authorize a tool or permission.
- Child approvals open the child, not the home screen or parent.
- Child Stop closes its process and pending approvals.
- Daemon restart preserves relationships and resolves orphaned work accurately.
- Relay reconnect and repeated requests do not create duplicate children or duplicate returns.
- A return cannot silently take over a live external session.
- Two writable sessions cannot share one checkout lease.
- Every V1 role uses exclusive sequential ownership; no role is labeled read-only without an
  enforceable cross-provider contract.
- Transcript truncation retains the selected message and discloses omitted context.
- Long briefings, long paths, the mobile keyboard, and 320 px-wide screens remain usable.
- The hosted relay continues to receive ciphertext and routing metadata only.
- At least 20 real dogfood delegations complete with no permission-boundary or workspace-loss event.

## Product validation

Measure whether this solves work rather than merely demonstrating orchestration:

- percentage of briefing previews that become started delegations;
- completion and reviewed-return rate;
- time saved versus manual copy/paste and re-explanation;
- how often people edit generated briefings and returns;
- child Stop, failure, duplicate, and workspace-conflict rates;
- rework after a returned result;
- cross-vendor delegation share;
- wall-clock and usage increase compared with one session;
- roles used most often and roles abandoned before launch.

The first dogfood workflows should be bounded and easy to judge: code review, bug-hypothesis
investigation, test design, and documentation review. Parallel implementation comes only after
workspace isolation is reliable.

## Explicit non-goals for V1

- Unbounded autonomous agent conversations.
- An agent choosing to create more agents without the person's confirmation.
- Arbitrary existing-session injection.
- Shared write access to one checkout.
- Cross-agent approval or consent delegation.
- A generic remote execution endpoint.
- Hidden transcript transfer.
- Automatic merging, committing, pushing, or deleting worktrees.
- Building orchestration on an experimental vendor-only team API.

LongLeash may integrate native vendor capabilities later, but its durable product model remains
provider-neutral and does not depend on one vendor preserving an experimental interface.

## Decision log

### 2026-08-11 — Product direction approved

- Build agent-to-agent delegation.
- Start with editable, human-mediated handoffs.
- Support every Claude/Codex source-target combination.
- Create a new child in V1 instead of linking arbitrary live sessions.
- Build phase by phase and release only after end-to-end verification.
- Reserve autonomous multi-agent coordination for Crew after the controlled path is reliable.

### 2026-08-11 — Architecture boundary

- Add `DelegationManager` above `SessionManager`.
- Keep individual agent lifecycle and approvals inside `SessionManager`.
- Use durable event sequence references for selected transcript content.
- Enforce sequential workspace ownership before adding parallel worktrees.

## Progress ledger

Update this section whenever a slice lands. A future session should be able to read only this file,
the linked commits, and current tests to know what is complete and what comes next.

| Date | Slice | Status | Evidence |
|---|---|---|---|
| 2026-08-11 | Product research and architecture | Complete | Approved plan recorded in this document |
| 2026-08-11 | Phase 0 foundation | Complete | Full test, typecheck, and production build gate passed |
| 2026-08-12 | Phase 1A briefing preview | Implementation complete; device QA pending | 631 automated tests, all package typechecks, and all production builds passed; live browser unavailable for visual QA |
| 2026-08-12 | Phase 1B start and observe | Implementation complete; physical-device dogfood pending | 659 automated tests, authenticated WebSocket launch/reconnect/Stop coverage, all package typechecks and builds, and 320/390 px rendered Chrome QA passed |
| 2026-08-12 | Phase 1C reviewed return | Implementation complete; live-device/vendor QA pending | Deterministic reviewed draft, durable at-most-once return delivery, explicit takeover, exact attribution, and concurrent retry coverage in the 690-test clean gate |
| 2026-08-12 | Phase 1D workspace hardening | Implementation complete; live-device/vendor QA pending | Atomic durable leases, sequential handoff, process conflict enforcement, bounded interrupt recovery, restart reconciliation, and conflict UI coverage in the 690-test clean gate |
| 2026-08-12 | Phase 2 foundation: safe parallel launch + portable settings/handoff | Implementation complete; physical-device/vendor QA pending | Automatic isolated Git worktrees for a second phone-launched writer; verified external-process drain before takeover; universal Terminal/VS Code workspace handoffs; persisted Claude/Codex model and effort controls; 702-test clean gate plus all typechecks and production builds |
