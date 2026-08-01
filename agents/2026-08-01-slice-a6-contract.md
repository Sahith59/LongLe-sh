# Slice A6 — real Claude contract tests (2026-08-01)

**Result: 6/6 passing against real Claude.** The adapter contract is verified against reality, not against a test double that only ever agreed with our assumptions. Four findings below change the product.

## Verified against the real Agent SDK

| Behaviour | Status |
|---|---|
| Runs on the user's Claude **subscription** — no API key, no billed API account | ✅ (`apiKeySource: "none"`) |
| Session starts, streams text, ends cleanly | ✅ |
| A gated tool blocks the real agent until a human decides | ✅ (target file provably absent while the decision is held) |
| ALLOW → the tool genuinely executes | ✅ (asserted on the approved path's contents) |
| DENY → the tool never runs, and the steering reply reaches the agent | ✅ |
| cwd is pinned: the agent really runs inside the session directory | ✅ (agent reports its own `pwd`) |
| Auto-approved tools appear in the activity feed | ✅ |
| A transcript is written where `claude --resume` can find it | ✅ |

## Findings that changed the code

1. **`PreToolUse` fires before `canUseTool`, so it cannot know whether a tool will be gated.**
   Reporting activity from that hook labelled approval-gated actions as "auto-approved" — a lie on
   the phone. Activity is now reported from `PostToolUse`, cross-referenced against what actually
   asked for permission.

2. **Which tools require approval depends on the machine's Claude Code settings.** With settings
   inherited, the same prompt sometimes raised an approval and sometimes completed silently. The
   adapter now accepts `allowedTools` and `isolateFromUserSettings`, and the contract suite pins
   both so approvals are deterministic rather than per-developer. The product must decide its
   permission posture explicitly instead of inheriting one.

3. **Agents do not always target the session directory.** One run attempted
   `Write: /tmp/approved.txt` before self-correcting via `pwd`. cwd pinning holds for the agent's
   *process*, but a tool can still be handed an absolute path elsewhere. Consequences: the approval
   card must always show the full target path (it does), and Phase F should flag or block writes
   that land outside the session's allowlisted root.

4. **Assert on the approved path, never a guessed one.** Tests that assumed a filename were flaky
   because the agent chooses its own approach. The suite now reads the path out of the approval it
   answered — deterministic regardless of the model's strategy.

## Running them

```
cd packages/daemon && pnpm test:contract        # real Claude, uses plan allowance
LONGLEASH_DEBUG=1 pnpm test:contract            # with a full event trace
```

Excluded from `pnpm test` and from CI (no Claude auth there). Each run is a handful of short
sessions; keep them infrequent to respect plan rate limits.
