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

**Never ask about something whose answer cannot matter.** *(2026-08-08, learned the hard way)*
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

**Answers to questions travel as the denial reason** *(2026-08-08)*
A PreToolUse hook can only allow / deny / stay out — it cannot supply a tool result (verified
against docs AND a live session). So LongLeash stops `AskUserQuestion` and puts the answer in
the reason field. Claude reads it correctly. **Cost:** the terminal paints it red under
`Error:`, so the message opens with "Not an error".

**Questions bypass every permission-mode filter.** Claude Code shows question dialogs in every
mode because it is asking the human to CHOOSE, not asking to be ALLOWED.

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

## 5. Money and go-to-market *(open — see §7)*

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

- Relay at scale: who pays when there are thousands of users?
- Is there a paid tier that does not require closing the source?
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
