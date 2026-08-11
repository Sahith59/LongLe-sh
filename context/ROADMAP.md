# ROADMAP — what's broken, what's next, and why

The running work plan. `DECISIONS.md` says *why things are the way they are*; `BUSINESS.md`
says *how this makes money*; **this file says what we are doing next and in what order.**

Update it as things land. Never delete an item — mark it done with the date, so a later session
can see what was already tried.

Opened 2026-08-09 after the first real field-test round on a phone.

---

## 0. Where the product actually stands (2026-08-09)

| Agent | Status |
| --- | --- |
| **Claude Code** | Shipped. Approve, deny, answer questions, take over, stop, mute, reopen. |
| **Codex CLI** | Built and proven live — remote approve and deny both confirmed on a real session. Not yet used from a real phone through the relay. Needs Codex ≥ 0.147.0. |
| **Gemini CLI** | **Blocked by Google**, not by us. See §5. |

Everything below came out of Sahith using it on his phone for real work, which is worth more
than any amount of reasoning about what might be wrong.

---

## 1. BUGS — found in the field, ranked by how much trust they cost

> **BUG-1, BUG-2 and BUG-3 are all FIXED as of 2026-08-09.** 352 tests green. What each fix
> actually was, and the two mistakes caught on the way, are recorded in place below.

Ordered by damage to trust, not by effort. A product people are asked to *rely on from far away*
loses more from looking unreliable than from missing a feature.

### BUG-1 — Stale approvals never disappear — **FIXED 2026-08-09**

**What happens:** an approval or question appears on the phone. Sahith answers it on the laptop
instead. The card stays on the phone forever, as if still waiting.

**Why it matters more than it looks:** the inbox is the product. If it shows things that are no
longer true, a person stops believing any of it — and the one moment that must never be in doubt
is "does something actually need me right now?" This is the same class of harm as over-asking.

**Root cause — three gaps, all real, found by reading the code:**

1. **Nothing ever sweeps expired approvals.** `ApprovalStore.findExpired()` exists and is
   documented as *"the caller denies them so agents never hang"* — **it has no caller.** An
   approval that outlives its 120s deadline stays `pending` in the database forever.
2. **A session ending does not close its pending approvals.** `sessionEnd()` clears timers and
   announces the end, but leaves any outstanding approval untouched.
3. **The daemon does not notice when the hook goes away.** This is the precise cause of the
   reported symptom. When the question is answered at the keyboard, the agent moves on and the
   hook process exits — its HTTP request dies. The daemon never looks, so it keeps waiting out
   the full timeout with a card on the phone that nothing will ever answer.

**Fix, in that order of value:**

- **Watch for the hook request aborting** (`request.raw.on('close')`) and resolve that approval
  immediately, emitting `approval.decided` with `decidedBy: 'system:answered-at-keyboard'`. This
  makes the card vanish the moment you answer on the laptop — which is the behaviour a person
  expects without being told.
- **Sweep `findExpired()` on a timer** and on startup, emitting `approval.decided` for each, so
  nothing can linger even if the abort signal is missed.
- **Close a session's pending approvals in `sessionEnd()`.**

*(`closeOrphans()` already runs at startup and is correct — it handles the crashed-daemon case.
These three cover the cases it cannot see.)*

**Shipped:** `ExternalSessions.abandon()` handles all three causes; `sweepExpired()` is the
missing caller for `findExpired()` and runs every 15s from the daemon; `sessionEnd()` clears what
it leaves behind. 7 tests.

**Mistake caught by an existing test, worth remembering:** the first version listened on
`request.raw`'s `close` event. That fires when the request BODY finishes reading — not when the
client disconnects — so every approval was abandoned the instant it was created, and every
verdict became `ask`. The correct signal is `reply.raw`'s `close` **guarded by
`writableEnded`**, which distinguishes "we finished replying" from "the client vanished".
A regression test now pins this.

### BUG-2 — Terminal and VS Code sessions look identical — **FIXED 2026-08-09**

**What happens:** a session started in VS Code is indistinguishable from one in a terminal.

**Sahith asked whether the VS Code extension would solve this. It is not needed.**

**Corrected 2026-08-09:** the first plan keyed on `CLAUDE_CODE_ENTRYPOINT`, which only works for
Claude. Sahith pushed back — *"it's not only claude, every AI tool"* — and he was right. Detection
is now **agent-agnostic first**: VS Code exports these to every process it spawns, so Codex and
any future CLI are covered without learning that agent's private conventions. An agent-specific
variable is only ever a refinement on top.

Verified in a live VS Code session:

```
CLAUDE_CODE_ENTRYPOINT=claude-vscode     ← Claude Code's own answer
VSCODE_PID=<set>
__CFBundleIdentifier=com.microsoft.VSCode
```

The hook inherits this environment, and the protocol **already** has `origin: 'vscode'` with the
label *"in VS Code"* in the app. Nothing new is needed but plumbing:

**Shipped:** `hooks/surface.mjs`, shared by both hooks, sending `ll_surface`. The daemon stores it
and reports it as `origin`, which the app already labels *"in VS Code"*. 6 unit tests plus a live
check: **the Codex hook reported `vscode` from a real VS Code session using no Codex-specific
variable at all.**

**Real-world detail a test caught:** Cursor's bundle id is `com.todesktop.230313mzl4w4u92` — it
contains nothing recognisable, so matching bundle ids alone silently classifies Cursor as a
terminal. `TERM_PROGRAM` is what the forks actually set, and is checked first.

**This saves an entire workstream.** The VS Code extension was already ranked "nice-to-have,
would not have prevented any bug so far" (`DECISIONS.md` §6) — it stays there. Do not build an
extension to answer a question the environment already answers.

*(Unchanged and still honest: VS Code's **chat panel** is a sealed webview and cannot be read.
This is about the CLI core running inside VS Code, which is a different thing and is readable.)*

### BUG-3 — Machine plumbing shown as if the human said it — **FIXED 2026-08-09**

**What happens:** the transcript shows blocks like these as user messages:

```
<ide_opened_file>The user opened the file … in the IDE.</ide_opened_file>
<task-notification> <task-id>… <status>completed</status> …</task-notification>
```

**Root cause:** `humanSaid()` strips only `<command-name>` markup. Everything else injected into
the conversation by the harness or the IDE — file-open notices, background-task notifications,
system reminders — arrives as a `type: 'user'` text block and is rendered as speech.

**Fix:** treat a user text block as machine plumbing when it consists only of tag-wrapped
content with no human prose outside it. Name the known ones explicitly
(`ide_opened_file`, `task-notification`, `system-reminder`, `local-command-stdout`,
`command-message`) **and** keep the general rule, because this list will grow and the next tag
must not require a release to hide.

**Shipped:** `humanSaid()` strips the named tags wherever they sit, then drops anything still made
entirely of tags — so the *next* tag we have never seen also stays off the phone. 11 tests,
including the two exact blocks from the screenshots, a truncated block, an unfamiliar tag, and
the cases that must SURVIVE: a real message alongside machinery, prose that merely mentions a tag,
and a code block full of angle brackets. Dropping real speech is worse than showing noise.

---

## 1b. FIELD TEST 2026-08-09 (evening) — what actually broke, with root causes

Sahith ran the checklist on his phone. Most of it failed. The verdict he gave is correct and is
recorded here verbatim so it is not softened later: *"you're just taking the conventional easy
path… telling me everything is done from your end but when I see the actual things nothing is
even working."*

**What I did wrong, precisely:** I verified components — unit tests, a local live run of one
adapter, a hook firing on this machine — and then called the PRODUCT done. I never once loaded
the app on the phone that was going to be tested. Every gate I built tested the code; none tested
the thing a person actually holds.

### ROOT CAUSE A — the phone was never running any of the new code *(explains bugs 3 and 5)* — **FIXED 2026-08-09**

**The relay serves the web app.** `packages/relay/wrangler.jsonc` binds `ASSETS`, and the phone
loads the PWA from `longleash-relay.tsahith59.workers.dev`, not from the laptop.

Measured 2026-08-09:

| | bundle |
| --- | --- |
| what the phone was served | `assets/app-CMkblIa3.js` |
| what the laptop had built | `assets/app-DKiRsnYx.js` |

So `git pull` + `pnpm build` + `longleash update` update the LAPTOP and change nothing the phone
sees. The agent picker, the vendor labels, the VS Code labelling — all shipped, none reachable.
**Every user hits this**, and nothing announces it.

**Fixed, two guards:**
1. **`scripts/release.sh` (`longleash release`)** — typechecks, tests, builds, deploys the relay
   with the app it was built from, then reads `build.json` back OFF the relay and refuses to
   call it a release unless what is served matches HEAD. Deploying the laptop alone is no longer
   a thing you can accidentally do.
2. **A stale phone announces itself.** The build is stamped into the bundle and written to
   `dist/build.json`; the daemon reports it in `hello` as `expectsApp`; the app compares it with
   its own stamp and shows an Update bar that clears the service-worker cache before reloading.
   *"Out of date" and "broken" must never look alike* — that confusion is what made an entire
   working release read as a broken product.

### ROOT CAUSE B — the hook holds the terminal hostage for two minutes *(bug 1, the worst one)* — **FIXED 2026-08-09**

`waitMs` defaults to **120_000**. While the hook blocks, Claude Code shows no prompt at all — the
person at the keyboard has NO way to answer, and the screenshot shows exactly that: a question,
then `Hatching… 42s`, and no options.

This violates the invariant in `DECISIONS.md` §2 — *"graceful degradation, never obstruction"*.
A two-minute block IS obstruction. It is worse than the over-asking bug, because over-asking
merely annoyed; this removes the person's ability to answer their own terminal.

**There was a second fault underneath, and it was the real one.** Presence was
`connectionCount() > 0 || push.count() > 0` — and a push REGISTRATION is permanent. So the daemon
always believed someone was watching, and held the terminal the full two minutes even with the
phone face-down in a drawer.

**Fixed.** Presence is now three-valued, and the hold follows from it:

| who can answer | hold |
| --- | --- |
| `connected` — the app is OPEN | 45s |
| `push` — reachable, app closed | 20s |
| `none` | **never held at all** |

Pinned by a test asserting the shipped defaults, so nobody quietly raises them back.

**2026-08-11 correction:** shorter timeouts reduced the damage but did not restore control.
The terminal still showed no native options while the phone wait was active. The hook now gives
the laptop an explicit handoff (`L`) and aborts the remote wait immediately; ordinary
permissions moved from guessed `PreToolUse` filtering to Claude's authoritative
`PermissionRequest`. Already-running terminal/VS Code sessions are observed asynchronously and
every real interaction repairs missed PID/surface metadata.

### Bug 6/7 — Stop refused forever *(root cause found in Sahith's own daemon log)* — **FIXED**

The log showed `stop terminal ext_… -> refused`, over and over, for the same sessions. Two causes:
**the Codex hook never reported a pid at all** (so `session.pid === null`), and the process check
matched only `\bclaude\b`, so even a reported Codex pid would have failed.

Both fixed via a shared `hooks/agent-pid.mjs`. And the aftermath changed: a session whose process
is gone is now **ended** rather than refused. Refusing left it listed as running forever with a
Stop button that did nothing — which is also **why dead sessions kept appearing (bug 7)**.

The safety property is unchanged and tested: a recycled pid is still never killed.

### Bug 2 — notification opened the home screen — **FIXED**

The payload carried `sessionId` all along; `notificationclick` ignored it. Now it postMessages a
live app (no reload, no lost place) or cold-starts with `?session=<id>`, which the app consumes and
strips from the address bar.

### 2026-08-10 resolution of the remaining confirmed items

- **Old sessions:** hello now carries process liveness separately from stored status. Historical
  replay can restore a transcript/status but cannot manufacture a process, including for a row
  completely absent from hello. Dormant sessions live under Earlier and say Reopen.
- **Stale approvals:** orphan/session-end/Stop paths all emit or reconcile the terminal event that
  removes the card; the phone also clears every approval owned by a non-live session seed.
- **Codex completion and connection-refused symptoms:** current `response_item`, nested turn/error,
  and authoritative `item/completed` shapes are implemented. A real approval contract found the
  remaining freeze: managed app-server threads were also running the global external hook, so an
  old hook could block before the native app-server request arrived. Managed threads now use a
  hook-free config layer while sharing Codex auth/history. Real start, approval side effect, Stop,
  and stop/reopen/context contracts pass.
- **VS Code invisibility:** async lifecycle observers discover already-running IDE sessions on the
  next tool call, and every permission/question repairs missed PID, agent, and surface metadata.
  Cards and detail views stamp both the agent and TERMINAL/VS CODE origin.

### The process change that follows

**No feature is "done" until it has been used on the phone through the relay.** Unit tests, a
local adapter run and a hook firing on the dev machine are necessary and have now been proven
insufficient — three times. The gate is the product, not the code.

---

## 2. FEATURE — Agent-to-agent: make any agent work with any other

Sahith's idea, and the strongest one in this round: *"if there are multiple agent sessions going
on… make some of the agents communicate or work together — Claude↔Claude or Claude↔Codex."*

### Why this is genuinely good, and not superficial

Nobody can do it. Anthropic will never ship a Codex bridge; OpenAI will never ship a Claude one.
**Cross-vendor message passing can only be built by a third party** — the same structural
asymmetry that justifies the whole product (`DECISIONS.md` §7). And LongLeash already has both
halves: it *reads* every session's transcript, and it can *inject* text into any session (that is
what take-over already does). The remaining work is routing and a good interface, not new plumbing.

### The version to build: **Relay — the human is the router**

From a session on the phone: pick a message, choose another session, send it.

```
Codex session ─┐
               ├─► "Send to…" ─► Claude session (arrives as a normal message)
Claude session ┘
```

Concretely: hold a message → **Send to…** → pick a live session → it arrives there as if typed.
Optionally with a one-line note ("what do you think of this?").

Why this shape:

- **It is the vision, not a detour.** The product exists so the human's remaining job — deciding
  and directing — works from anywhere. Routing between agents is exactly that job.
- **It cannot run away.** Every hop is a deliberate human action, so there is no loop that burns
  tokens while you are asleep.
- **It is small.** Reading and injecting both already exist.
- **It demos in five seconds**, which matters for the launch video (`BUSINESS.md` §5).

### The version NOT to build yet: autonomous agent-to-agent

Letting two agents talk unsupervised is where this gets expensive and where the graveyard is.
**Vibe Kanban** (10+ agents, orchestration) and **Terragon** both built in that direction and
both are dead (`PRICING.md` §6.2). It also quietly deletes the human from a product whose entire
premise is keeping the human in control from a distance.

**Revisit only when:** Relay is used often enough that people ask for a saved multi-step route.
Then it is a feature with evidence behind it rather than an assumption.

### The context problem — SETTLED 2026-08-09, and it decides the design

Sahith asked the question that makes or breaks this: *"if Claude is working on something and I
want it to talk to Codex — will Codex have all the context Claude already has?"*

**No. Not automatically, and pretending otherwise would ship a useless feature.** A forwarded
message arrives as one paragraph. Codex would have no idea what Claude has been doing, what it
already tried, or what was ruled out. It would answer confidently from nothing — the worst
possible failure, because it *looks* like collaboration.

What the receiving agent does and does not share:

| | Shared? |
| --- | --- |
| The files on disk, the repo, the branch | ✅ same folder — it can just read them |
| What has been tried and rejected | ❌ only in the other agent's conversation |
| The reasoning behind the current approach | ❌ same |
| The user's stated goal and constraints | ❌ same |

Dumping the whole transcript is not the answer either: it blows the context window on long
sessions, and most of it is noise the other agent must then wade through.

**CORRECTED 2026-08-09 — the first design was not implementable. Read this before building.**

The original plan was "ask the source agent to write the briefing in its own session." Reading
the code killed it: **there is no way to send a message into a session running at the keyboard.**
`takeOver` does not inject — it **stops the terminal process** (verified pid) and resumes the
conversation through the SDK. That is destructive by design and correct for what it does, but it
means the source agent cannot be asked anything without ending its terminal session.

What can actually reach each kind of session:

| Target | Can LongLeash put a message into it? |
| --- | --- |
| A session LongLeash started (SDK) | ✅ `sessions.sendMessage()` |
| A finished terminal session it adopted | ✅ resumes it under the same conversation id |
| **A terminal session running right now** | ❌ **only by killing it** (`takeOver`) |

**The design that works: brief a NEW session.**

```
1. In session A on the phone: "Ask another agent…", plus a one-line intent
     ("second opinion on the retry logic")
2. LongLeash composes a briefing from A's transcript — which it already tails, so this
     needs no cooperation from A and does not disturb it at all
3. You see the briefing on the phone and can EDIT it before anything is sent
4. LongLeash starts a NEW session in the same folder with that briefing as its first
     prompt, attributed: "Relayed from Claude in ~/api by LongLeash: …"
5. That session appears in your inbox like any other. Its answer can be relayed onward.
```

Why this is better than the original idea, not merely a fallback:

- **Nothing is disturbed.** The source keeps running at the keyboard, untouched.
- **It works from every source**, including a live terminal session — the case that matters
  most and the one the original design could not serve.
- **A fresh agent with a purpose-built briefing is what you actually want** for a second
  opinion. Injecting into a long-running session would bury the question in unrelated context.
- **You edit the briefing before it goes.** No agent speaks for you unreviewed — the same
  principle as never approving a tool you did not see.
- **Attribution is mandatory.** An agent that cannot tell where a claim came from treats
  another model's guess as established fact.

**The gap that blocked this — CLOSED 2026-08-09.** LongLeash can now start **Codex** sessions as
well as Claude ones, so "Claude → Codex" is buildable and Relay can ship genuinely cross-vendor.

**`src/adapters/codex.ts`** drives `codex app-server` — the JSON-RPC interface Codex ships for
exactly this. Protocol taken from Codex's own `generate-json-schema` output and confirmed against
a live server, so nothing in it is guessed: `initialize` → `thread/start` → `turn/start`, with
approvals arriving as server→client requests and streaming over notifications. It satisfies the
same `AgentFactory` contract as Claude, so `SessionManager` never learns which agent it is running.

**30 unit tests + a live run**: a real Codex thread, the approval routed out to `canUseTool` with
the exact command, allowed, and the file written — `proof.txt` contained `LIVE_OK`.

Three things the gates caught that would have shipped broken:

1. **The five approval families do not share a vocabulary.** `item/*` answers `accept`/`decline`;
   `execCommandApproval` and `applyPatchApproval` answer `ReviewDecision`, whose refusal is
   **`abort`** — not `decline`, not `denied`. The wrong word is rejected and the turn stalls with
   nothing visible. A table pins all five, with a test per direction.
2. **`interrupt` awaited Codex's reply.** The moment someone presses Stop is exactly when Codex is
   most likely wedged, so that await could hang forever and the process would never die — a phone
   insisting it had stopped something still running. Now fire-and-forget with a 250ms grace, then
   kill regardless. **Stop has to mean stopped.**
3. **The assistant's own messages were reported as tools it ran** ("auto-ran agentMessage" in the
   activity feed) — the same wrongness as BUG-3, found only by the live run.

**The honest limitation to put in the UI:** the new agent gets a briefing, not a memory. It will
not know what the briefing left out, and a long back-and-forth will drift. Relay is for "get a
second opinion" or "hand off a task", not for two agents sharing a mind.

---

## 3. FEATURE — Running with the laptop closed

Sahith: *"can we run these agents with my laptop closed… run these things anywhere in the world
irrespective of my laptop?"*

### The honest physics first

**A sleeping Mac does not compute.** No software fixes that from inside. Closing the lid on a
MacBook sleeps it unless it is on power *and* driving an external display (clamshell mode).
Nothing LongLeash does can make a suspended CPU run an agent.

But the common real-world failure is **not** the lid — it is the machine idling out mid-run while
sitting open on a desk. That one we can fix, and it is worth doing.

### Three tiers, in order of what we should build

**Tier 1 — hold the machine awake while work is in flight** — **SHIPPED 2026-08-09**
Take a macOS power assertion (the mechanism behind `caffeinate -i`) **only while at least one
agent session is actually running**, and release it the moment the last one finishes. So the
laptop does not idle-sleep in the middle of a two-hour job, and it is not held awake all night
for nothing.

This does **not** violate "never require a user to weaken their security" — sleep is not a
security control, the assertion is scoped to real work, and it is visible and revocable.

**Shipped:** `src/awake.ts`. `caffeinate -i` — **idle sleep only**, never display sleep, because
your screen locking is a security control we must not weaken to solve a problem you did not ask
us to solve. Held while any session is `running`/`waiting`, released on the last one and on
shutdown. Spawned **attached**, so the OS reaps it even if the daemon is killed `-9`: LongLeash
cannot leave a laptop permanently unable to sleep.

11 unit tests (one assertion regardless of session count, recovery if `caffeinate` dies
underneath us, spawn failure never takes the daemon down, clean no-op off macOS) plus a live
check on this Mac: caffeinate processes went 1 → 2 → 2 → 1 across start / 1 session / 3 sessions
/ all ended.

**Tier 2 — say clearly what a closed lid does** *(documentation, not code)*
If the lid closes on battery, the machine sleeps and agents pause. Say so in `REQUIREMENTS.md`
and in the app. Offer the two real answers: clamshell mode (power + external display), or
`sudo pmset -b disablesleep 1` — **presented as the user's choice, never as a step LongLeash
requires**, because it is a system-wide change with real battery and heat consequences.

**Tier 3 — the actual answer: run the daemon somewhere that never sleeps** *(the strategic one)*
Same software, different host: a desktop that stays on, a home server, or a cheap VPS. LongLeash
is already just a daemon plus a relay — nothing about it assumes a laptop.

This is exactly what **Herdr** tells people to do: *"laptop, desktop, or a box you rent."*

### What Herdr means for us (researched 2026-08-09)

[herdr.dev](https://herdr.dev/) — Apache 2.0, one-line install, macOS/Linux/Windows beta.
A background runtime that owns agent terminals so they survive: *"Close the lid or drop the
network and the agents keep working."* Detects **19 agent CLIs** and shows each as
working / blocked / idle.

**Take it seriously — it overlaps us and it is good.** But the two products solve different halves:

| | Herdr | LongLeash |
| --- | --- | --- |
| Keeps agents alive across disconnects | ✅ its whole point | partially (tmux) |
| Detects many agent CLIs | ✅ 19 | 2 proven, structurally |
| **How it knows an agent is blocked** | reads terminal state | **the agent's own hook tells us** |
| **Answer an agent from your phone** | ❌ not the product | ✅ the whole product |
| Content never leaves your machine | local | ✅ E2E, relay cannot read |

**The distinction that matters:** knowing an agent is "blocked" from its terminal is inference.
Knowing *what it is asking* and *answering it* requires the structured channel — hooks, ACP —
which is precisely the invariant LongLeash was built on and the reason Omnara struggled.
**Herdr keeps the agent alive; LongLeash lets you make its decision from a train.**

**So this is not a threat to copy — it is a gap to name.** Their 19-CLI list does undercut any
claim that "supporting many CLIs is hard." Ours must be: *"we don't just see that it is stuck —
we let you unstick it, from anywhere, without your code leaving your machine."*

**Also worth stealing, honestly:** their session persistence is better than ours. Surviving a
dropped network and a restart with the layout intact is a real feature and a real complaint we
have already fixed halfway. Put it on the list.

---

## 4. THE PLAN — in order

Each step ends with something usable, and nothing is claimed done until it is triple-gated:
unit tests, a wire test, and a real-CLI or real-phone check.

### Now — trust and cleanliness (this is what makes it launchable)
1. **BUG-1 stale approvals** — the inbox must always be true.
2. **BUG-3 transcript noise** — no machine plumbing shown as speech.
3. **BUG-2 VS Code vs terminal** — cheap, and it removes a whole planned workstream.
4. **Codex end-to-end on the real phone** through the relay. Built and proven locally; not yet
   used in anger.

### Next — the differentiator
5. **Relay (agent-to-agent), human-routed.** The thing no first party can ship.
6. **Stay-awake while working** (Tier 1) — closes the most common "why did it stop?"

### Then — reach
7. **Run the daemon on a machine that never sleeps** — document it, make the installer work on a
   plain Linux box, prove it end to end. This is also the honest answer to "anywhere in the world."
8. **Session persistence across restarts**, learning from Herdr.

### Held
- **Gemini** — blocked externally (§5).
- **VS Code extension** — not needed for BUG-2; no other bug has called for it.
- **Billing** — not until 100 people use it free (`BUSINESS.md` §7).
- **Autonomous agent-to-agent** — only with evidence from Relay usage.

---

## 5. Blocked, and not by us

**Gemini CLI — Google cut off free-tier individual accounts** *(2026-08-09)*
ACP `initialize` succeeds; `session/new` returns *"This client is no longer supported for Gemini
Code Assist for individuals… migrate to Antigravity."* Plain `gemini -p` fails identically
(`IneligibleTierError`, `tierId: free-tier`), so Gemini CLI does not run on this machine at all
under `oauth-personal`.

No adapter will be written against a handshake we have never completed. Unblocks with a
`gemini-api-key` or Vertex auth — which costs per token where the old tier was free, so it is a
**product decision** about what we ask of a user, not just a build task.

**Until a third agent actually runs, the claim is "Claude + Codex, proven" — never "any agent."**

---

## 6. What makes us different — keep this honest

Re-read before writing any landing page. Each line must survive a skeptical developer.

1. **We do not guess what an agent wants — it tells us.** Hooks and ACP, never screen-scraping.
   Herdr infers "blocked" from a terminal; we receive the actual question and send back the
   actual answer.
2. **One inbox across every agent and every session** — not one session at a time.
3. **Your code never leaves your machine.** E2E encrypted; the relay routes bytes it cannot read;
   notifications carry no content.
4. **Cross-vendor is structurally ours.** No first party will ever ship a competitor's client.
5. **We say what we cannot do.** Sealed webviews, non-tmux terminals, Gemini today. Naming limits
   is the cheapest trust we can buy, and almost nobody does it.
