# DECISIONS — the running log

Every decision that shapes LongLeash, with **why**, so nobody (including future us) has to
re-derive it or accidentally undo it. Newest at the bottom of each section.

**How to use this file:** append when a decision is made or reversed. Never delete an entry —
if a decision is overturned, add a new one that says so and why. A decision without its reason
is worthless six months later, so the reason is mandatory.

---

## 0. The vision (restated by Sahith, 2026-08-08 — read this first)

**The problem:** a developer who leans on AI agents cannot leave their desk. Every agent that
needs a decision — an approval, a choice — blocks until a human is physically in front of the
laptop. Four hours away means four hours of stalled work.

**The product:** the human's remaining job — deciding — moves to their phone. Every agent
session on the laptop (terminal, IDE, whatever) is visible and answerable from anywhere.

**The scope, explicitly:** *not Claude-only.* Claude Code, Codex, Gemini CLI, Cursor — any tool
with agentic capability on the machine. This is the differentiator and the reason the product
exists; treating it as a Claude accessory is a category error.

**The measure of success:** people pay for things that make their lives easier. If a developer
can genuinely walk away for five hours and stay in control, that is worth money.

## 1. Product shape

**Standalone open-source product, not a wrapper around someone else's tool** *(2026-07-29)*
One daemon, our own relay, our own web app. Rationale: every product surface must be ours or
we inherit someone else's roadmap and outages.

**Web app (PWA), not native iOS** *(2026-08-01, revised from Expo/native)*
$0 cost and zero-friction install matter more for an open-source product than lock-screen
action buttons. Killed the need for an Apple Developer account ($99/yr), EAS builds, and App
Store review. **Cost of the choice:** notifications can't carry Approve/Deny buttons; you open
the app to answer.

**No accounts, no OAuth, no user database** *(2026-08-03)*
Asked directly whether to add login/signup/Google OAuth. Answer was no:
- Pairing already establishes cryptographic identity — an account would add nothing.
- A user table is exactly the honeypot this architecture exists to avoid.
- A signup wall in front of *your own laptop* is absurd.
- Hosting cost and breach liability for zero benefit.
**Revisit only if:** a hosted relay with quotas, teams, or billing arrives.

**Per-session gate (mute) controlled from the phone** *(2026-08-08)*
Can only ever ask for LESS, never more. A session in an auto-approving mode ignores refusals
from anyone; offering a switch that pretended otherwise would be a broken promise with a nicer
label.

---

## 2. Architecture invariants (violating these breaks the product)

**Never scrape a TUI to detect prompts — structured channels only.**
This is why Omnara struggled and it must not be why we do. Everything comes from Claude Code's
own hooks and its transcript JSONL — a file format, not a screen.

**A hook must never break the terminal.**
Every failure path in `longleash-hook.mjs` exits 0 with no output, which Claude Code reads as
"no opinion". Daemon down, endpoint stale, network weird → the session behaves as if LongLeash
were not installed.

**Never ask about something whose answer cannot matter.** *(2026-08-08, learned the hard way;
manual mode/allowlist replication superseded 2026-08-11)*
An auto-approving session runs the command regardless. Paging a phone about it is worse than
silence — it teaches the user their answers are theatre. This is why the mode filter lists the
modes that GATE (`default`, `acceptEdits`) rather than the ones that don't: the "don't" list was
incomplete the moment `auto` appeared, and over-asking is the unforgivable direction.
Under-asking merely hands the decision to the terminal, which is safe by construction.

**The relay stores nothing and reads nothing.** Ciphertext routing only. HKDF-derived room tags,
AES-GCM frames. Keys live on the two devices.

**Push payloads carry IDs only.** A `kind` discriminator (`approval` / `question` / `test`) is
allowed because it names the SHAPE of the interaction, never its content. The in-app inbox is
the source of truth, never the notification.

**Typed API operations only — never a generic exec endpoint.** Remote start only into
allowlisted roots. Every mutating call audit-logged.

**Nothing binds `0.0.0.0`.** LAN address or loopback only; the relay is outbound.

**One writer per conversation.** The phone can take a terminal session over, but only by ending
the terminal side first. Two drivers is never allowed.

**Never require a user to weaken their security.** Disk encryption, firewalls, OS updates are
their call. See `docs/REQUIREMENTS.md`.

**Say what cannot be done rather than pretending.** VS Code chat panels are sealed webviews;
non-tmux terminals are uncapturable. The UI and docs say so.

---

## 3. Technical decisions

**Cloudflare Workers + Durable Objects for the relay** *(2026-08-02)*
Chosen after Oracle Always Free failed (no ARM capacity in any region) and Fly/VPS were
rejected for cost. Free tier: 100k requests/day, no credit card. One Durable Object per room.
**Live at** `https://longleash-relay.tsahith59.workers.dev`.

**noble crypto, not WebCrypto** *(2026-08-02)*
`crypto.subtle` is undefined on non-secure origins, and `http://LAN-IP` is not one. Discovered
on a real phone; earlier rehearsals passed only because 127.0.0.1 is browser-exempt.

**Answers to questions travel as the denial reason** *(2026-08-08; superseded 2026-08-11)*
A PreToolUse hook can only allow / deny / stay out — it cannot supply a tool result (verified
against docs AND a live session). So LongLeash stops `AskUserQuestion` and puts the answer in
the reason field. Claude reads it correctly. **Cost:** the terminal paints it red under
`Error:`, so the message opens with "Not an error".

**Claude permissions come from `PermissionRequest`; questions use native `updatedInput`**
*(2026-08-11, supersedes both decisions above)*
Current Claude Code exposes the real boundary directly: `PermissionRequest` fires only when its
own permission engine is about to show a dialog. LongLeash no longer guesses from permission
modes or reimplements a user's evolving allow-rule grammar. `PreToolUse` remains synchronous
only for `AskUserQuestion`, whose documented answer path is `permissionDecision: "allow"` plus
the original questions and an `answers` map in `updatedInput`. REASON: this removes both false
phone prompts and the red fake-error shown for a perfectly valid question answer.

**Mirroring a permission must never remove laptop control** *(2026-08-11)*
For terminal sessions the hook writes a visible handoff to `/dev/tty`: press L and
LongLeash aborts its pending request, causing the agent's native permission prompt to appear
immediately. The phone remains an additional control surface, never the only one. A timeout is
still a failure fallback; it is not the laptop UI.

**Questions bypass every permission-mode filter.** Claude Code shows question dialogs in every
mode because it is asking the human to CHOOSE, not asking to be ALLOWED.

**Codex CLI integrates on `PermissionRequest`, not `PreToolUse`** *(2026-08-09, proven live)*
Codex fires `PermissionRequest` **only when it has already decided it needs a human**. REASON:
this removes the entire class of bug that produced the auto-mode over-asking failure — on Claude
Code we must replicate "would this have asked?" ourselves; on Codex we must not try. Confirmed
live: in `bypassPermissions` mode `PermissionRequest` never fires while `PreToolUse` does.
Full contract: `agents/2026-08-09-codex-gemini-hook-contracts.md`.

**Codex hooks are version-gated and fail SILENTLY** *(2026-08-09)*
Identical config produced 0 hook events on Codex 0.136.0 and 6 on 0.147.0. The config parses
either way — there is no warning. REASON to care: the failure mode is total silence, which a user
reads as "LongLeash is broken." The installer must check `codex --version` and refuse to claim
Codex support below the working version rather than appear installed and do nothing.

**Codex tool calls are deduped by a derived key** *(2026-08-09, claim narrowed same day)*
Duplicate delivery was observed with three hook events registered, and NOT with the two LongLeash
actually installs. So "fires twice, always" was an over-claim; the trigger is unestablished.
Dedupe ships anyway. REASON: it costs nothing, and one decision appearing as two cards teaches a
person their inbox double-counts — the same harm as over-asking. The key is
`turn_id : sha256(tool_name + tool_input)`, because `PermissionRequest` carries **no
`tool_use_id`** (only `PreToolUse` does). That gap was found by a live smoke test *after* unit
tests passed against a fixture that had invented the field — fixtures now track shipped schemas.

**Never tell users to pass `--dangerously-bypass-hook-trust`** *(2026-08-09)*
Codex hashes hook commands and asks the user to review new or changed hooks. REASON: it is a
security control the user is entitled to, and instructing them to disable it violates "never
require a user to weaken their security." The installer explains the prompt instead of evading it.

**Managed Codex app-server threads do not load external-session hooks** *(2026-08-10)*
The adapter is already the structured lifecycle, transcript, Stop, and approval channel for a
phone-started Codex thread. Loading the global hook as well gates one command twice. Worse, an
older installed hook can wait on an older daemon before app-server emits its own approval request,
so the phone sees no card and Codex appears frozen. Managed threads therefore use a hook-free
configuration home which symlinks the normal Codex auth and persisted history. `codex resume <id>`
still works; global hooks remain enabled for the terminal and VS Code sessions they actually own.
This is pinned by a real approval-side-effect contract and a real stop/reopen/context contract.

**Gemini CLI cannot approve through hooks — it needs ACP** *(2026-08-09)*
Gemini's hook output has no `permissionDecision`; its internal decision variable is only ever
assigned `"ask"`. A hook can deny or escalate, never resolve. REASON this is disqualifying: a
phone that can only say *no* still forces the walk back to the desk, which is the exact thing the
product exists to prevent. Gemini support therefore goes over `--acp`
(`session/request_permission`) as a distinct session type — matching the architecture already
stated in `CLAUDE.md`.
**SETTLED 2026-08-09 by Sahith: ACP.** Full approve/deny is non-negotiable — a phone that can only
say *no* is not the product. Accepted cost: a `gemini` the user typed themselves is not
attachable; Gemini sessions are started from LongLeash. The UI must say so plainly rather than
let a user wonder why their terminal session never appeared.

**Gemini work is BLOCKED by Google, not by us** *(2026-08-09)*
ACP `initialize` succeeds, but `session/new` returns *"This client is no longer supported for
Gemini Code Assist for individuals… migrate to Antigravity."* A plain `gemini -p` fails the same
way (`IneligibleTierError`, `tierId: free-tier`), so **Gemini CLI does not run on this machine at
all** under `oauth-personal` auth. REASON not to proceed: an ACP adapter written against a
handshake we have never completed cannot be tested or gated, and would ship looking finished.
Unblocks with a `gemini-api-key` or Vertex auth — which costs per token and therefore changes what
Gemini support asks of a *user*, making it a product decision and not merely a build task.
**Until a third agent actually runs, the claim is "Claude + Codex, proven" — never "any agent."**

**Revoking a device is a LAPTOP operation, and goes through the running daemon** *(2026-08-09)*
`longleash devices` / `longleash revoke <id>`, authorised by the same 0600 secret the hooks
use. Two REASONS, both load-bearing:
- **Laptop-only:** revocation is rooted in physical possession of the machine, so someone
  holding a stolen unlocked phone can neither cut off the owner's other devices nor un-revoke
  themselves. The phone protocol deliberately has no revoke operation at all (tested).
- **Through the live daemon, not the database:** the listeners that make revocation *real* —
  closing the open socket, shutting the relay room, dropping the push subscription — are
  in-process. A separate CLI writing to SQLite would leave a stolen phone revoked on paper and
  still listening in practice, which is the worst possible outcome: it reads as done.

The registry already had `revokeDevice`/`onRevoked` and the server already closed revoked
sockets; what was missing was any way to trigger it. That gap is now closed.

**Codex is driven through `codex app-server`, not `codex exec`** *(2026-08-09)*
`exec` runs non-interactively as `bypassPermissions`, so it never asks — which would mean a
session started from a phone that routes no decisions back to it. `app-server` is Codex's own
JSON-RPC interface, gives streaming plus real approval requests, and satisfies the existing
`AgentFactory` contract so `SessionManager` never learns which vendor it is running. REASON this
matters beyond Codex: it is the second proof that the adapter boundary is the right one — a whole
new vendor landed without touching the manager.

**Stop must never wait on the agent it is stopping** *(2026-08-09)*
The Codex adapter fires `turn/interrupt` and kills after a 250ms grace rather than awaiting the
reply. REASON: someone presses Stop precisely when the agent is wedged, and an awaited reply that
never arrives leaves the process alive while the phone reports it stopped. A control that is
unreliable exactly when it is needed is worse than no control.

**Tailwind v4 + tokens in `@theme`** *(2026-08-03)*
So future shadcn / 21st.dev components inherit our system instead of bringing their own.

**`resumable` and `resumeId` ride on live events, not just `hello`** *(2026-08-04)*
A fact that changes AS a session ends cannot be sent only before it begins. This bug hid the
Reopen button until a reconnect.

**A LAN address is not required to run** *(2026-08-08)*
With a relay configured the daemon only dials out. Refusing to start without a local address
grounded the product on exactly the setup (phone tethering) where remote access matters most.

---

## 4. Design system — "Matte Graphite"

*(2026-08-03, after three rejected rounds)*

**Diagnosis of what was wrong:** an aurora gradient behind frosted glass on a light background
is the single loudest "AI generated this" signal of 2026. Four aesthetics were stacked
(neumorphism + glassmorphism + aurora + display grotesque). Everything was elevated, so nothing
was. No thesis tied to what the product does.

**The system:** one physical logic, three materials — **raised** (you can press it),
**engraved** (the machine is telling you), **recessed** (you read out of it). Near-black ground,
matte machined keys with a four-layer bulge, no gloss anywhere.

**Colour discipline:** the interface speaks in LUMINANCE. Brighter = closer to you; the
brightest key on screen is the thing that needs you. Two dim tints (sage `#a5c2af`, clay
`#c99b93`) are TEXT INK ONLY — never a fill, never a border. A uniformly grey screen means
nothing wants you, readable from across a room.

**Type:** Instrument Serif (voice), Instrument Sans (interface), Geist Mono (machine).
Self-hosted so it renders on a laptop hotspot with no internet.

**Motion:** one easing curve `cubic-bezier(.32,.72,.24,1)`, three durations (180/260/400ms),
exits ~65%. Transform and opacity only. The session title is a shared element that flies
between the card and the detail header.

**Logo:** the machined robot-dog with carabiner clip and sage LED, chosen by Sahith 2026-08-03.

---

## 5. Money and go-to-market

**Commercial strategy settled** *(2026-08-09)*
Plain-language plan: `context/BUSINESS.md`. Evidence: `context/PRICING.md`. Five decisions:

1. **The free tier is complete and uncapped for self-hosters** — every feature, forever.
   REASON: it is the entire trust position, and the one thing no first-party competitor can copy.
   Nabu Casa recommends free alternatives to its own paid product *by name* and still converts at
   30%; crippling the free path does not raise conversion, it destroys the reason people fund you.
2. **Limits live on our relay, never in shipped code.** Free on our relay = 2 concurrent sessions;
   self-hosted = unlimited. REASON: a counter in an MIT-licensed daemon is a suggestion. No
   counterexample was found in the research — every metered OSS free tier gets bypassed, and the
   bypass becomes the project's public story (OpenProject's bypass gist: 537 stars, legally clean).
   This also *preserves* Sahith's original session-cap idea by moving it somewhere enforceable.
3. **$7/month or $70/year. Round numbers, never .99.** REASON: the proven band for "reach the
   thing I already run" is $5–8 (Nabu Casa $6.50, Coolify $5, Healthchecks $5, ngrok $8,
   Tailscale $8). Overturns an earlier $10 recommendation that was drawn from consumer mobile-app
   data — the wrong market. Round pricing is what every credible developer tool uses; .99 signals
   discount, which is the wrong signal for an unproven tool.
4. **Everything open except the relay and the billing/account layer.** REASON: the Nabu Casa line
   verbatim — *"Our account page and relayer are not open source."* An infrastructure boundary, not
   a feature boundary, so the open-source promise stays whole.
5. **No billing until 100 people use LongLeash for free.** REASON: 72% of the 130 launches in this
   category since Jan 2025 drew ≤1 comment. Distribution is the bottleneck, not price. Any price
   set before real users exist is a guess with a payment form attached.

**Order of work that follows from this** *(2026-08-09)*: Codex CLI support → revoke-device button
→ relay onto its own account → ten strangers install it → the demo video → launch.

**Revoke-device is a security gap, not a feature** *(2026-08-09)*
A paired phone can approve indefinitely and there is currently no way to un-pair it from the
laptop. REASON: a stolen phone keeps its approval power. This is the only outstanding hole in an
otherwise sound trust story and it must ship before strangers are told to install LongLeash.

**Relay ownership** *(decided 2026-08-08, action pending)*
Every installed copy currently points at Sahith's personal Cloudflare Worker. Only routes
ciphertext, so no privacy issue, but it is on a personal account with a 100k req/day free tier.
**Decision: create a separate Cloudflare account for LongLeash (tomorrow, 2026-08-09).**
Later option: a "deploy your own relay" step in the installer.

**No npm/npx publishing yet** *(2026-08-08)*
LongLeash is a long-running daemon, not a one-shot tool — the wrong shape for `npx`.
`better-sqlite3` would need compiling on every stranger's machine. Revisit when the daemon is
bundled with SQLite prebuilds, and then as `npm i -g`, not `npx`.

---

## 6. Open questions

- ~~Relay at scale: who pays when there are thousands of users?~~ **Answered §5**: subscribers do,
  at $7/mo. Still unmeasured: what one relay user actually costs us. Measure at 50 users before
  promising a free hosted tier forever.
- ~~Is there a paid tier that does not require closing the source?~~ **Answered §5**: yes — the
  relay and billing layer stay ours, everything shipped stays open.
- Billing implies identity, which §1 deliberately closed. Reopen it *on purpose* when billing
  arrives. Probable shape: the paid account lives entirely relay-side; the daemon still knows
  nothing about a user.
- Do developers run more than one agent CLI concurrently? Surveys show 70% use 2–4 AI tools, but
  that counts chatbots and editor plugins. **Directionally supported, not proven.**
- VS Code extension: nice-to-have, would not have prevented any bug so far.

---

## 7. Competitive reality *(researched 2026-08-08)*

**The fact that dominates everything:** Anthropic shipped `/remote-control` in **February
2026**. It bridges a running Claude Code session to claude.ai/code and the Claude iOS/Android
apps. Free with Pro/Max — which our users already pay for. It is first-party, and it does the
core thing LongLeash does.

**Its real limits (as of this research):**
- Officially a **research preview** — may change or be withdrawn
- **One remote session per Claude Code instance**; it is per-session, not an inbox across all
- Terminal must stay open; ~10 minute unreachability times the session out
- Single-user only
- Claude Code only

**Where LongLeash is genuinely different:**
- **One inbox across every session**, not one session at a time
- **Terminal sessions appear without being explicitly enabled** — you don't have to remember
- **Self-hosted**: chat content never transits Anthropic's cloud; our relay cannot read it
- **Lock-screen push** with content-free payloads
- **Take-over / handoff** between phone and keyboard, both directions
- **Per-session gating**, mode visibility, audit log
- Open source

**Others in the space:** Happy (free, open source), Omnara (freemium, App Store), Cosyra (cloud
containers, paid), Claude Remote, Cursor/Warp background agents.

**CORRECTION (2026-08-08, same day).** The read above was wrong because it measured LongLeash
against Claude Code. Sahith restated the vision: LongLeash is a **control plane for every local
AI agent** — Claude Code, Codex, Gemini CLI, and whatever comes next — not a Claude accessory.
The problem is not "Claude Code lacks a phone client"; it is **a developer cannot leave their
desk, because any agent that needs a decision blocks until a human is physically there.**

That reframing survives the competitive fact, because of a structural asymmetry:

> **No first-party will ever be cross-vendor.** Anthropic will not ship a Codex client. OpenAI
> will not ship a Claude client. Google will ship neither. A universal control plane can only be
> built by a third party. `/remote-control` is not a competitor to that — it is a competitor to
> one row of it.

**And it is buildable, not aspirational** — verified 2026-08-08. Every major agent CLI now
exposes the same structured shape LongLeash already integrates with:
- **Claude Code** — `PreToolUse` hooks (built, shipped)
- **Codex CLI** — `PermissionRequest` hook: *"runs when Codex is about to ask for approval… can
  allow the request, deny the request, or decline to decide and let the normal approval prompt
  continue"* — the same three-way contract, so the existing hook design ports directly
- **Gemini CLI** — hooks on `onToolUse` / `onBeforeRequest`, configured in `settings.json` with
  the same layered precedence

The hard parts (relay, E2E, push, approvals, questions, take-over, gating) are agent-agnostic
and already built. Each new agent is a hook script and an adapter, not a new product.

**What stays genuinely hard, and must not be waved away:**
- Three hook systems, each young and each evolving — permanent maintenance cost. (It is also the
  moat: the same work that is annoying for us is prohibitive for a casual competitor.)
- Unknown how many developers run more than one agent CLI. Needs evidence, not assumption.
- Open source and self-hostable means weak pricing power over the core.

Sources: [Codex PermissionRequest hooks](https://github.com/openai/codex/issues/28833) ·
[Codex hooks system](https://deepwiki.com/openai/codex/3.11-hooks-system) ·
[Gemini CLI hooks](https://geminicli.com/docs/hooks/) ·
[Google's hooks announcement](https://developers.googleblog.com/tailor-gemini-cli-to-your-workflow-with-hooks/)

Sources: [Claude Code Remote Control docs](https://code.claude.com/docs/en/remote-control) ·
[Best Mobile Apps for Claude Code 2026](https://nimbalyst.com/blog/best-mobile-apps-for-claude-code-2026/) ·
[Happy](https://happy.engineering/) · [Omnara](https://www.omnara.com/pricing) ·
[Product Hunt alternatives](https://www.producthunt.com/products/claude-code-remote-access/alternatives)
