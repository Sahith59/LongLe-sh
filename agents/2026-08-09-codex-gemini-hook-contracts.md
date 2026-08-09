# Codex CLI and Gemini CLI — hook contracts, verified against shipped binaries

**Date:** 2026-08-09
**Purpose:** establish whether LongLeash's approve-from-phone model ports to Codex CLI and
Gemini CLI *before* any adapter code is written.
**Method:** contracts extracted from the installed binaries themselves (embedded JSON Schema,
bundled JS), then **proven with live sessions** — not read from docs or blog posts.

**Verdict: Codex is proven and ready to build. Gemini needs an architecture decision.**

---

## 1. Codex CLI — PROVEN END TO END

### The proof

A real interactive Codex session, driven through a pty, with a LongLeash-style hook installed.
No human touched the terminal.

| Test | Hook returned | Result |
| --- | --- | --- |
| **Approve remotely** | `decision.behavior = "allow"` | Command executed. `/tmp/longleash_probe_out.txt` created with `LONGLEASH_PROBE_OK`. |
| **Deny remotely** | `decision.behavior = "deny"` | Command blocked. File absent. |

**This is the whole product working on a second vendor.** Codex asked for permission, a process
that was not the user answered, and Codex obeyed.

### THE VERSION GATE — the single most important finding

> **Codex hooks do not fire in 0.136.0. They fire in 0.147.0.**

Identical config, identical hook script: **0 events on 0.136.0, 6 events on 0.147.0.** The config
*parses* on 0.136.0 — it is silently inert. There is no warning.

**Consequence for LongLeash:** the installer must check `codex --version` and refuse to claim
Codex support below the working version, because the failure mode is total silence — the exact
thing that would make a user think LongLeash is broken.

*(Discovered accidentally: a startup update prompt consumed a keystroke during a pty run and
upgraded Codex 0.136.0 → 0.147.0 mid-investigation. The upgrade is what made hooks work.
Minimum working version is not yet bisected — 0.147.0 works, 0.136.0 does not.)*

### Config format — verified against Codex's own parser

Lives in `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`). **Not** a separate
`hooks.json` — that path (`hooks/hooks.json`) belongs to *plugins*, and `hooks = "./hooks.json"`
in user config is a hard parse error.

```toml
[hooks]
PermissionRequest = [{ hooks = [{ type = "command", command = "node /path/hook.mjs", timeoutSec = 30 }] }]
PreToolUse        = [{ hooks = [{ type = "command", command = "node /path/hook.mjs", timeoutSec = 30 }] }]
SessionStart      = [{ hooks = [{ type = "command", command = "node /path/hook.mjs", timeoutSec = 30 }] }]
```

Established by feeding the parser deliberately wrong values and reading which keys it rejects:

- **Event keys are PascalCase.** `permission_request` and `permission-request` are **silently
  ignored** — they do not error, they just never fire. (Both spellings appear in the binary;
  only PascalCase is the config key.)
- Value is an **array of matcher entries**; each entry has optional `matcher` and a `hooks` array.
- Handler `type` ∈ **`command` | `prompt` | `agent`**; `command` is required for `type="command"`.
- Unknown fields at matcher level are ignored silently.

**Validation trick worth keeping:** `codex mcp list` loads and validates config without making an
API call. `codex doctor` does **not** validate hooks at all — it accepted every malformed config
tested, including `hooks = 42`. Do not use `doctor` as a config check.

### PermissionRequest contract (from the binary's embedded JSON Schema)

**Input** — required: `cwd`, `hook_event_name`, `model`, `permission_mode`, `session_id`,
`tool_input`, `tool_name`, `transcript_path`, `turn_id`. Optional: `agent_id`, `agent_type`.

`permission_mode` ∈ `default` | `acceptEdits` | `plan` | `dontAsk` | `bypassPermissions`
*(note: differs from Claude Code's set — `dontAsk` and `bypassPermissions` are the non-gating
modes here).*

**Output:**
```json
{ "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": { "behavior": "allow" | "deny", "message": "shown to the model" } } }
```

**Fail-closed guardrails — Codex rejects the whole hook if you send these.** Verbatim from the
binary; every one is a trap LongLeash must avoid:

- `continue: false` → *"PermissionRequest hook returned unsupported continue:false"*
- `stopReason`, `suppressOutput` → unsupported
- `updatedInput`, `updatedPermissions` → unsupported (reserved for future use)
- `interrupt: true` → unsupported

Exit code 2 + stderr also works as a denial (`"PermissionRequest hook exited with code 2 but did
not write a denial reason to stderr"`), mirroring Claude Code.

### The structural advantage over Claude Code

> **`PermissionRequest` fires only when Codex has already decided it needs a human.**

Claude Code's `PreToolUse` fires on *every* tool call, so `longleash-hook.mjs` has to replicate
Claude's internal "would this have asked?" logic — the mode filter, the allow-rules parsing. That
replication is exactly what caused the auto-mode over-asking bug (`DECISIONS.md` §2).

**On Codex that entire class of bug cannot exist.** Codex tells us. Confirmed live: in
`bypassPermissions` mode `PermissionRequest` never fired at all, while `PreToolUse` fired
normally. No mode filter needed — subscribe to `PermissionRequest` only.

### Two behaviours the adapter must handle

1. **A hook can fire more than once for one decision — CLAIM CORRECTED 2026-08-09.**
   An earlier version of this report said "every hook fires TWICE, always." That over-claimed.
   What was actually observed:
   - With `SessionStart` + `PreToolUse` + `PermissionRequest` all registered: **every event
     delivered twice**, byte-identical, same `turn_id`.
   - With only `SessionStart` + `PermissionRequest` registered (what LongLeash ships): **exactly
     once each**, across repeated runs.

   So duplication is real but conditional, and the trigger is not established. Dedupe stays,
   because it costs nothing and the failure it prevents — one decision showing as two cards —
   teaches a person their inbox double-counts.

2. **`PermissionRequest` carries no `tool_use_id`.** Only `PreToolUse` does; the
   `permission-request.command.input` schema simply lacks the field. The dedupe key is therefore
   derived: `turn_id : sha256(tool_name + tool_input)`. *Found by a live smoke test after unit
   tests had passed against a fixture that invented a `tool_use_id`.* Fixtures now track the
   shipped schema.

3. **Directory trust gates hooks.** Codex prompts *"Do you trust the contents of this directory?
   Trusting the directory allows project-local config, hooks, and exec policies to load."* Until
   answered, hooks do not load.

### Hook trust — a real install-time gate

Codex hashes hook commands (`trusted_hash`) and shows a review prompt when one is new or changed:
*"1 hook is new or changed. Hooks need review… Trust all and continue / Continue without trusting
(hooks won't run)."*

`--dangerously-bypass-hook-trust` exists for automation. **LongLeash must not use it or tell users
to** — it disables a security control the user is entitled to. The installer should instead say
plainly: *"Next time you start Codex it will ask you to trust the LongLeash hook. Say yes, or
LongLeash cannot see Codex sessions."*

### Operational notes

- `codex exec` **blocks forever if stdin is not closed.** Always redirect `< /dev/null`.
- `codex exec` runs as `bypassPermissions`, so `PermissionRequest` never fires there. Interactive
  sessions are the real target anyway.
- `CODEX_HOME` fully isolates config — use it for tests, never touch the user's real config.
- `transcript_path` points at a rollout JSONL, the analogue of Claude's transcript.

---

## 2. Gemini CLI — WORKS DIFFERENTLY, NEEDS A DECISION

Gemini CLI 0.45.0 ships hooks (`gemini hooks`), but they are **not** Claude-compatible and, more
importantly, **cannot approve.**

### Its event names are its own

Gemini ships a `hooks migrate` command that translates Claude Code hooks. Its own mapping table:

| Claude Code | Gemini CLI |
| --- | --- |
| `PreToolUse` | **`BeforeTool`** |
| `PostToolUse` | **`AfterTool`** |
| `UserPromptSubmit` | **`BeforeAgent`** |
| `Stop` / `SubAgentStop` | **`AfterAgent`** |
| `PreCompact` | **`PreCompress`** |
| `SessionStart` / `SessionEnd` / `Notification` | unchanged |

Tool names differ too: `Edit`→`replace`, `Bash`→`run_shell_command`, `Read`→`read_file`,
`Write`→`write_file`, `LS`→`ls`. Env var is `$GEMINI_PROJECT_DIR`. Gemini also has events Claude
lacks: `BeforeModel`, `AfterModel`, `BeforeToolSelection`.

Config lives in `settings.json` under `hooks`, shaped like Claude's
(`{matcher, sequential, hooks:[{type,command,timeout}]}`).

### The blocker: no allow path

Gemini's hook output has **no `permissionDecision` field**. It uses top-level `decision`, and the
runtime only recognises:

- `decision: "block"` or `"deny"` → tool fails with a policy violation
- `decision: "ask"` → forces a confirmation prompt
- `continue: false` → stops the agent
- `hookSpecificOutput.tool_input` → rewrites arguments

Traced through the dispatcher: the internal `hookDecision` variable **is only ever assigned
`"ask"`**. The subsequent policy check can yield allow/deny/ask_user, but a hook can only
*escalate* to `ask_user` — never resolve one.

> **On Gemini, a hook can deny remotely but cannot approve remotely.** Approving would still
> require walking to the laptop — which is the entire thing LongLeash exists to prevent.

### The route that does work: ACP

Gemini ships `--acp` (Agent Client Protocol) and implements `session/request_permission` — a real
bidirectional permission channel with full allow/deny. This matches the architecture already
written in `CLAUDE.md` (*"other agents via ACP"*).

The trade-off is a genuine product decision, not a technical one:

| | Hooks | ACP |
| --- | --- | --- |
| User runs `gemini` normally in their own terminal | ✅ | ❌ — LongLeash launches and drives it |
| Approve from phone | ❌ **cannot** | ✅ |
| Deny from phone | ✅ | ✅ |
| See the session at all | ✅ | ✅ |
| Matches how Claude/Codex support works | ✅ | ❌ different UX |

A third option exists: an in-process **message bus**
(`tool-confirmation-request`/`tool-confirmation-response`) which does carry a real `confirmed`
boolean — but it is internal to the CLI process and not reachable from outside it.

**Route chosen 2026-08-09 by Sahith: ACP.** Full approve/deny is non-negotiable; the accepted cost
is that a `gemini` the user typed themselves is not attachable.

### BLOCKED — Google cut off Gemini CLI for free-tier individuals *(2026-08-09)*

ACP `initialize` succeeds (protocol version 1; auth methods `oauth-personal`, `gemini-api-key`,
`vertex-ai`). **`session/new` is rejected by Google:**

> `-32000` — *"This client is no longer supported for Gemini Code Assist for individuals. To
> continue using Gemini, please migrate to the Antigravity suite of products."*

This is **not ACP-specific and not a LongLeash bug.** A plain `gemini -p 'hi'` fails identically:

```
IneligibleTierError … reasonCode: 'UNSUPPORTED_CLIENT', tierId: 'free-tier',
tierName: 'Gemini Code Assist for individuals'
```

So on this machine, with `oauth-personal` auth, **Gemini CLI does not run at all.** No LongLeash
integration can be built, tested, or gated against it.

**Paths forward, in order of preference:**
1. **A `gemini-api-key` (AI Studio).** ACP advertises it as an auth method, so it likely restores
   `session/new`. Costs per token, unlike the old free OAuth tier — which changes what Gemini
   support *asks of a user*, and therefore belongs in the product decision, not just the build.
2. **Vertex AI** — same idea, heavier setup, aimed at organisations.
3. **Wait.** This is a live migration and the policy may move again.

**Do not write the ACP client until one of these produces a working `session/new`.** An untested
adapter against a protocol we have never completed a handshake on is exactly the kind of thing
that ships looking finished and fails in front of a user.

**What this costs the strategy:** the cross-vendor claim is **Claude + Codex today, proven**, not
three. That is still a claim no first party can make. But "any agent" must not be said until a
third one actually runs.

---

## 3. What this means for the roadmap

- **Codex support is unblocked and proven.** Build it on `PermissionRequest`, dedupe on
  `tool_use_id`, gate on Codex version, and surface the trust prompt honestly in the installer.
- **The cross-vendor thesis survives contact with reality** — but only because it was tested.
  Two of the three agents needed genuinely different integrations, and one of them cannot do the
  core action through the obvious path.
- **The maintenance cost named in `DECISIONS.md` §7 is real and now measured**: three vendors,
  three event vocabularies, three decision contracts, one version cliff that fails silently. This
  is also the moat — it is tedious enough that a casual competitor will not do it.

---

## 4. Reproduction

Test lab (isolated via `CODEX_HOME`, never touches the user's real config):
`<scratchpad>/codexlab/` — `probe.mjs` (logging hook), `drive_tui.py` (pty driver that clears the
directory-trust dialog, then sends a prompt), `home/config.toml`.

The credential copy required for the lab was deleted after testing. The user's
`~/.codex/config.toml` and `~/.codex/auth.json` were never modified (mtimes verified unchanged).
