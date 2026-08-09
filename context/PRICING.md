# PRICING — strategy, evidence, and what is still unknown

The commercial counterpart to `DECISIONS.md`. Same rule: **every conclusion carries its
evidence**, so a future session can tell a researched finding from a guess.

**Status:** research in progress (2026-08-08). Nothing here is final until §5 says it is.

---

## 1. What we are actually selling

Not "a phone app for Claude Code." The product is:

> **A developer who leans on AI agents can leave their desk.** Every agent session on their
> laptop — any vendor, terminal or IDE — stays visible and answerable from their phone.

The buyer is a developer whose agents block on human decisions and who currently pays for that
by sitting in a chair. What they are buying back is **hours of their life**, not software.

That framing sets the ceiling: the price has to feel small against the value of one afternoon
away from the desk, and small against what they already pay for the agents themselves
(Claude Max, Cursor, Copilot).

---

## 2. Constraints any pricing model must survive

These are not preferences; a model that violates one of them will fail.

1. **MIT-licensed and self-hostable.** Anyone can run the daemon and their own relay for free.
   We can only charge for something people cannot trivially do themselves.
2. **The free tier must be genuinely complete**, or the open-source positioning — currently the
   main source of trust — turns into resentment.
3. **The metered unit must correlate with value received AND with our cost.** Charging for
   something that costs us nothing invites circumvention and feels arbitrary.
4. **A free first-party alternative exists for one vendor** (`/remote-control`, free with
   Pro/Max). Anything we charge for must be something that feature cannot do.
5. **No accounts today.** Billing implies identity, which reopens a decision deliberately closed
   in `DECISIONS.md` §1. Any paid tier must be designed against that, or explicitly overturn it.

---

## 3. The concurrent-agents model — examined and (provisionally) rejected

Sahith's initial proposal: free = 3–5 concurrent agents, paid = more.

**Why it looks wrong:**
- Value is **binary**, not per-agent. "Can I leave my desk?" is answered by the first agent.
  Someone running two agents already has the whole benefit.
- Most developers run 1–3 agents, so the free tier would serve nearly everyone completely, and
  conversion would approach zero.
- Concurrency costs us almost nothing — it fails constraint 3.
- Trivially circumvented in an MIT-licensed daemon — fails constraint 1.

**SETTLED 2026-08-08 by market research (§6.2): rejected.** No product in this category prices
on concurrent agents. The only one that counts sessions at all (Port22) uses it as a free-tier
cap of 2, never as a paid ladder. There is no precedent to follow and no evidence anyone will
pay this way.

---

## 4. Candidate models under evaluation

*(filled in from research — see §6 for evidence)*

| Model | Charge for | Survives constraints? |
| --- | --- | --- |
| Hosted relay + push | infrastructure we run | TBD |
| Machines / devices | linear with real value | TBD |
| History retention | storage we pay for | TBD |
| Teams / audit | multi-user, org needs | TBD |
| One-time purchase | no recurring cost | TBD |

---

## 5. THE DECISION

> **Not yet made.** Do not implement billing until this section names a model, a price, and the
> evidence behind both.

---

## 6. Evidence log

*(populated by research agents 2026-08-08)*

### 6.1 Open-source monetisation precedent

_pending_

### 6.2 Direct competitor pricing *(researched 2026-08-08)*

**The modal price in this category is $0.** Happy (23.2k stars, MIT), Sculptor (MIT), Paseo,
Nimbalyst, VibeAround and self-hosted ClawTab are all free and uncapped, because users bring
their own agent subscription and the vendor's marginal cost is near zero.

| Product | Price | Free tier limit | Open source | Vendors |
| --- | --- | --- | --- | --- |
| Anthropic Remote Control | free with any paid Claude plan | — (`--capacity` defaults to 32 sessions) | no | Claude only |
| **Happy** | **$0** | none | MIT, 23.2k★ | Claude, Codex |
| **ClawTab** | **$4.99/mo** for hosted relay; self-host free | — | MIT | Claude, Codex, OpenCode |
| **Port22** | **$19.99/YEAR** unlimited | 1 Mac, 2 sessions | no | Claude, Codex, OpenCode |
| Omnara | historically $9/mo (10 sessions free) | 10 agent sessions/mo | Apache-2.0 | Claude, Codex |
| Cosyra | $29.99/mo | 1 hour compute | no | Claude, Codex, **Gemini**, OpenCode |
| Conductor | $50/mo Pro; **$60/user/mo Teams** | local Mac only | no | Claude, Codex, Cursor |
| Sculptor, Paseo, Nimbalyst, VibeAround | $0 | none | yes | various |

**Findings that directly settle open questions:**

1. **Concurrent agents is NOT a pricing metric in this category.** Only Port22 uses session count,
   and only as a free-tier cap (2), never as a paid ladder. **Sahith's proposed model has no
   precedent anywhere in the market.** §3's rejection now rests on evidence, not reasoning alone.
2. **Where products do meter, they meter whoever pays the compute bill.** Cloud-hosted products
   charge compute-hours (Cosyra 120h; Conductor cloud-workspace hours). Local products charge for
   **machines** (Port22) or **hosted relay access** (ClawTab $4.99).
3. **Multi-vendor support commands no premium today.** Nobody charges extra for Gemini. The two
   products with the broadest agent rosters (Vibe Kanban: 10+ agents; Terragon: 4) are **both
   dead**.
4. **Someone already ships the exact model previously proposed here.** ClawTab: MIT + self-host
   free, $4.99/mo for the hosted relay. That validates the shape and removes its novelty.
5. **Price anchors are brutal.** Port22 asks **$19.99/year** — $1.67/month — for unlimited Macs
   and sessions. Any $10/mo ask sits 6× above a functioning competitor.

**The category is a graveyard** — this matters more than any price:
- **Terragon / Terry**: dead, open-sourced Jan 2026
- **Vibe Kanban**: sunsetting; parent company Bloop shut down Apr 2026
- **Omnara**: pivoted away from phone-control to an agent API platform; the mobile app has not
  been updated since Apr 2026
- **Conductor**: charging $50/mo while its mobile app is still "coming soon"

Anthropic shipping Remote Control free on every paid plan is the compression event that these
outcomes trail.

**The single positive signal:** Conductor charges **$60 per user per month for Teams** and is
still trading. The money in this category, where it exists at all, is at the team/org level —
not the individual developer.

Sources: [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control) ·
[Happy](https://happy.engineering/) · [ClawTab](https://clawtab.cc/) ·
[Port22](https://www.tryport22.com/) · [Cosyra](https://cosyra.com) ·
[Conductor pricing](https://www.conductor.build/pricing) ·
[Omnara GitHub](https://github.com/omnara-ai/omnara) ·
[Vibe Kanban](https://github.com/BloopAI/vibe-kanban) ·
[Terragon snapshot](https://github.com/terragon-labs/terragon-oss) ·
[Sculptor](https://imbue.com/product/sculptor) · [Paseo](https://paseo.sh) ·
[Product Hunt alternatives](https://www.producthunt.com/products/claude-code-remote-access/alternatives)

### 6.3 Developer willingness to pay

_pending_

### 6.4 Does the core assumption hold? (do developers run multiple agents; is the pain real)

_pending — this is the finding that matters most; if it is negative, the strategy changes, not
the price_

---

## 7. Open questions that pricing depends on

- Do developers run more than one agent CLI? (If no, the cross-vendor moat is theoretical.)
- Is the pain voiced by real people in public, or is it inferred from Sahith's own experience?
- Would a developer pay for remote access to something already running on their own machine?
  (Home Assistant / Nabu Casa is the closest precedent — see §6.1.)
- Can we bill without building accounts, or does billing force that decision open?
