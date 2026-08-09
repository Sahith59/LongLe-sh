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

## 4. Candidate models — judged against the evidence

| Model | Verdict |
| --- | --- |
| **Concurrent agents** | **Rejected.** No precedent in the market (§6.2). Value is binary. |
| **Hosted relay + push** | **Viable, occupied.** ClawTab does exactly this at $4.99. Costs us real money, so it satisfies constraint 3. Low ceiling. |
| **Machines / devices** | Weak. Port22 sells unlimited machines for $19.99/**year** — the anchor is on the floor. |
| **History retention** | Weak. Storage is cheap; nobody in this category meters it. |
| **Teams / audit** | **Strongest.** Conductor sustains $60/user/mo. Team budgets are $63–100/mo (§6.3) and are *employer* money, which is the only wallet with room. |
| **One-time purchase** | Possible (Pushover's model). Removes churn risk but caps revenue and does not fund a relay that runs forever. |

---

## 5. THE DECISION *(provisional, 2026-08-08 — awaiting Nabu Casa precedent)*

**Price is not the bottleneck. Distribution is.** 72% of launches in this category drew ≤1
comment (§6.4). The likely failure is not mispricing; it is that nobody ever hears about it.
Therefore: **do not build billing until 100 people use LongLeash for free.** Until that number
exists, any price is a guess with a payment form attached.

**When billing is built, the recommended shape:**

| Tier | Price | What it is |
| --- | --- | --- |
| **Free, forever** | $0 | Everything. Self-hosted relay. No feature withheld. Non-negotiable — it is the trust and the differentiation. |
| **LongLeash Cloud** | ~$6/mo | Our relay + push. Zero setup, no Cloudflare account. Sits between ClawTab's $4.99 and the $9 Omnara could not sustain. |
| **Teams** | ~$12/user/mo | Shared visibility across a team's agents, audit of who approved what, SSO later. Far under Conductor's $60, inside the $63–100 team budget, and paid with employer money. |

**Do not choose $9 over $10 believing evidence supports it — none does (§6.3).**

**Positioning, which matters more than the number:** do not sell "control your agents from your
phone." That is free from Anthropic, free from Happy, and bundled into Warp at $20. Sell **"the
one that does not drop when you have actually left the house"** — the single complaint users
voice about every incumbent (§6.4), and the thing LongLeash spent a week of field testing
fixing.

**Honest revenue expectation.** At the category-realistic 1–3% conversion, 1,000 paying
individuals requires 33k–100k free users — implausible for a solo project in a market where
most launches go unnoticed. **$10k/month from individual developers is not supported by any
evidence gathered.** A realistic individual-tier outcome is tens to low hundreds of dollars per
month. Teams is the only path evidenced to reach four figures, and it is a different sales
motion, not a different price tag.

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

### 6.3 Developer willingness to pay *(researched 2026-08-08)*

**The solo developer's discretionary wallet is ~$20/month, and it is already spent.**
Pragmatic Engineer survey (n=906, Jan–Feb 2026): employer-paid exceeds self-paid; personally
funded developers cluster at **$20/mo or free tiers**, while employers fund the $100–200 tiers.
Only ~5% keep separate work and personal subscriptions. Team spend medians: **$63/mo (agencies),
$100/mo (in-house)**.

A LongLeash subscription is therefore a *second* discretionary purchase from a budget already
consumed by Claude Pro ($20) or ChatGPT Plus ($20).

**Free→paid conversion for developer tools: 1–3%** (the low end of the 2–5% SaaS median).
Disclosed: GitLab ~5%, Postman ~3%, MongoDB Atlas ~2%. **Caveat recorded honestly:** nearly every
"devtools 1–3%" citation traces to one OpenView report, and no primary open-source-specific
conversion study was found.

**$5 vs $10 "psychological threshold" is folklore, not evidence.** No published A/B test, van
Westendorp study, or elasticity dataset for indie dev tools compares those points. The nearest
real datum points the other way (Appcues: +25% ARPU for −5% conversion). **Do not choose $9 over
$10 believing research supports it — it does not.**

### 6.4 Does the core assumption hold? *(researched 2026-08-08)*

**The pain is real and loudly voiced — this is settled.** High-engagement Hacker News threads:
[Omnara launch, 310 pts / 168 comments](https://news.ycombinator.com/item?id=44878650) ·
["Stop Doom Scrolling, Start Doom Coding", 577 pts / 405 comments](https://news.ycombinator.com/item?id=46517458) ·
[Anthropic Remote Control launch, 544 pts / 313 comments](https://news.ycombinator.com/item?id=47154391).
Boris Cherny (Claude Code's creator) describes running 5 Claudes in parallel and using
notifications to know when one needs input.

**Multi-tool usage holds, directionally.** Pragmatic Engineer (n=906): **"70% use between two and
four tools simultaneously, while 15% use five or more."** Median 2.4–3.1 tools/dev (n=2,847).
**Honest caveat:** "multiple tools" includes chatbots and IDE plugins — *no survey measures
"multiple agentic CLIs concurrently" directly.* Directionally supported, not proven.

**THE FINDING THAT MATTERS MOST — the market is saturated and clears at zero.**
**130 distinct Hacker News launches in this exact category since Jan 2025. 94 of them (72%)
received ≤1 comment. Only 8 broke 50 points.** The two that got real traction were Anthropic's
own feature and Omnara — which has since pivoted away.

The top comment on the Omnara launch is the whole business problem in one line:
> *"if I can whittle away at a free and open source version, why should I ever consider paying
> for this?"*

And the accepted DIY answer in these threads is Tailscale + tmux + Termius — free, already owned.

**Also: Warp already ships the cross-vendor answer.** Claude Code, Codex, Gemini CLI and OpenCode
in one pane, **with mobile remote control, bundled at $20/mo** — a price developers already pay.
The multi-vendor thesis is real but it is *not unoccupied*.

**THE LIVE WEDGE — what users actively complain about:** the official feature is unreliable.
> *"its really buggy though, and often doesnt actually trigger the change"*
> *"Connections drop so fast and flakily. So many times I stepped out of the house in a rush
> hoping remote control would help… every time i've been sorely disappointed"*
> *"stopped sending me notifications on Android"*

**This is precisely what LongLeash spent 2026-08-04→08 fixing**: 30s keepalives both sides,
instant reconnect on network change and app foreground, listener rebinding when the laptop
changes network, a self-diagnosing Alerts panel, a test-alert button, relay-only operation when
tethered. That alignment is not a coincidence — it came from real field testing.

**And the best design principle found in the wild validates an existing invariant:**
> *"agents run on their own, phone only pings when something's irreversible and actually needs a
> human. per-call approval you stop reading by day two."*

Which is `DECISIONS.md` §2 "never ask about something whose answer cannot matter," arrived at
independently.

Sources: [Pragmatic Engineer AI tooling 2026](https://newsletter.pragmaticengineer.com/p/ai-tooling-2026) ·
[devtools conversion benchmarks](https://www.getmonetizely.com/articles/whats-the-right-ratio-of-free-to-paid-users-in-developer-saas) ·
[Happy](https://github.com/slopus/happy) · HN threads linked above.

**Not verifiable:** reddit.com blocks automated fetching, so r/ClaudeAI and r/cursor sentiment
could not be checked. Stack Overflow's 2026 survey is unpublished — any "SO 2026" figure
circulating is recycled 2025 data.

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
