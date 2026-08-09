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

**What would change this verdict:** evidence that a meaningful population runs many agents in
parallel, and that agent count is how this category actually meters. Agent research pending.

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

### 6.2 Direct competitor pricing

_pending_

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
