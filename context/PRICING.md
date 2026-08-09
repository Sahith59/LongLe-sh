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
| **LongLeash Cloud** | **$7/mo or $70/yr** | Our relay + push. Zero setup, no Cloudflare account, no port forwarding. Framed as **supporting the project**, not renting a feature. |
| **Teams** | **$20/user/mo** | Shared visibility across a team's agents, audit of who approved what, SSO later. Well under Conductor's $60, inside the $63–100 team budget, paid with employer money. |

**Price history of this recommendation, kept so the reasoning is auditable:** ~$6 (intuition) →
$10 (general subscription data, §6.1) → **$7 (category-specific data, §6.0)**. The $10 correction
was itself wrong: RevenueCat's $10 median comes from 115,000 *consumer mobile apps*, a different
market. Every product in LongLeash's actual category — open-source, self-hostable, paid hosted
remote access — clusters at **$5–8**: Nabu Casa $6.50, Coolify $5, Healthchecks $5, ngrok $8,
Tailscale $8. Above ~$10 users compare against a $0.99 domain rather than a coffee.
**Round numbers, never .99** (§6.1) — charm pricing signals *discount*, which is the wrong signal
for an unproven tool.

**Why ≤$20 regardless: the wallet, not psychology.** 62% of developers personally spend ≤$20/mo
on *all* AI tooling combined, and Claude Pro already consumes most of that.

**The highest-leverage move is packaging, not the number.** Sidekiq's commercial licence sold
33 copies ($1,650, "a failure"); repackaged as a $500 add-on with the OSS core still free it
made **$70,000 in a year — 42x, from packaging alone.** Before tuning a price, ask what the
paid *thing* is.

**Positioning, which matters more than the number:** do not sell "control your agents from your
phone." That is free from Anthropic, free from Happy, and bundled into Warp at $20. Sell **"the
one that does not drop when you have actually left the house"** — the single complaint users
voice about every incumbent (§6.4), and the thing LongLeash spent a week of field testing
fixing.

**Revenue expectation — REVISED UPWARD 2026-08-08 by §6.0, and the earlier figure was too
pessimistic.** OSS conversion is not one number; it spans **1% (Coolify) to 30% (Nabu Casa)**,
and the gap is explained by *why* people pay. Nabu Casa's 30% comes from users who state plainly
they could self-host and pay anyway — **to fund the project.**

| If conversion is… | Users needed for $10k/mo at $7 |
| --- | --- |
| 1% (Coolify — infrastructure convenience only) | ~140,000 — not achievable |
| 5% (Bessemer's stated OSS ceiling) | ~28,000 — hard |
| 15% (halfway to Nabu Casa) | ~9,500 — plausible with a real community |
| 30% (Nabu Casa — stewardship motive) | **~4,800 — genuinely reachable** |

So the target is not absurd. It is **conditional on being the kind of project people want to
fund**, which is earned through openness, reliability and visible stewardship — not through
pricing tactics. The earlier claim that $10k/mo "is not supported by any evidence" was based on
consumer-SaaS conversion rates that do not describe this category.

---

## 6. Evidence log

*(populated by research agents 2026-08-08)*

### 6.0 THE STRUCTURAL TWIN: Home Assistant / Nabu Casa *(researched 2026-08-08)*

**This is the closest precedent that exists, and it outranks the general subscription data in
§6.1 because it is the same shape: open-source software you self-host, with a paid hosted
service whose main value is remote access.**

**Price: $6.50/mo or $65/yr, unchanged since Feb 2022.** Includes remote access via
`*.ui.nabu.casa` (no port forwarding, works behind CGNAT), voice-assistant integrations, cloud
TTS/STT, 5GB encrypted backup, webhook endpoints, camera relay.

**Conversion: 30.4%** — the `cloud` integration is configured on **160,237 of 526,947** reporting
installs (Home Assistant's own opt-in analytics). Cross-checked against the Open Home
Foundation's 2025 annual report (CHF 8.84M revenue, 52 staff) and 2026 budget (CHF 11.12M royalty
income from Nabu Casa): 160k × ~$78 ≈ $12.5M. The two estimates agree. **Bootstrapped, zero
investors.**

**That is ~10–30x the OSS category benchmark, and the reason is not the feature.** Across 321
on-topic user comments the top reason for paying is **"to fund the project"** (14%, and every
single top-voted comment), from people who say outright they could self-host:
> *"I personally wanted to fund further development, **even though it would be trivial to use the
> same solution I have for my other services**"* [75 upvotes]

The founder is explicit that this is the design:
> *"The Home Assistant Cloud functionality is **a perk for becoming a supporter of the Home
> Assistant project**… You are not paying to just maintain the cloud servers."*
> *"**We don't want to come to rely on donations** and have to show Wikipedia-style beg banners."*

**The subscription is the donate button with a product attached** — and it converts 10–30x better
than actual donations (Plausible: $8,500 MRR vs six $5 donations; core-js: 9B downloads → $400/mo).

**They deliberately do not cripple the free path.** Their own remote-access docs recommend
Tailscale, ZeroTier and DuckDNS *by name, on the same page as the paid product.* But:
> *"Our account page and relayer are not open source."*

**That is the exact template for LongLeash:** everything open except the relay and the account
layer.

**Proven price band for "remote access to what I already run": $5–8/mo.**
Nabu Casa $6.50 · Coolify $5 · Healthchecks $5 · ngrok $8 · Tailscale $8. Above ~$10/mo users
start comparing against a $0.99 domain rather than a coffee. Annual at 10× monthly is the
near-universal convention.

**OSS free→paid conversion, real numbers:** Coolify **1%** (1,700 cloud customers vs 154,000
self-hosters). Nabu Casa **30%**. The spread between those two *is* the strategy question.

**Metered free tiers in open source are always circumvented — no counterexample found.**
OpenProject's enterprise-token bypass gist has 537 stars / 217 forks and is legally clean under
AGPL. Tellingly, the projects that succeed **do not ship counters at all**: Sentry self-hosted
has no event quota; Plausible CE has zero limits by choice; PostHog's OSS build caps
*structurally*, not numerically.

> **Gate on infrastructure, never on a counter in the binary.** A self-hoster can compile
> `longleashd`; they cannot mint our push certificate or our relay's address space.

**Documented failure modes to avoid:** donations alone never work (core-js: on 52% of the top
1,000 sites, $400/mo, under $2/hour, plus hate mail). Retroactive licence changes get forked and
the fork wins the defaults (HashiCorp→OpenTofu in 5 weeks; Redis→Valkey, still the default in
Fedora 42, Ubuntu 26.04, Debian 13). Selling the self-hostable artifact fails — Keygen's founder:
users *"could fork the code and give themselves the EE features without any ramifications."*

Sources: [Nabu Casa pricing](https://www.nabucasa.com/pricing/) ·
[HA analytics](https://analytics.home-assistant.io/) ·
[Open Home Foundation 2025 report](https://www.openhomefoundation.org/assets/documents/annual-report-2025-11-jun-2026.pdf) ·
[HA Cloud launch](https://www.home-assistant.io/blog/2017/12/17/introducing-home-assistant-cloud/) ·
[HA remote access docs](https://www.home-assistant.io/docs/configuration/remote/) ·
[Coolify pricing](https://coolify.io/pricing) · [Healthchecks](https://healthchecks.io/pricing/) ·
[ngrok](https://ngrok.com/pricing) · [Tailscale](https://tailscale.com/pricing) ·
[core-js funding](https://github.com/zloirock/core-js/blob/master/docs/2023-02-14-so-whats-next.md) ·
[Keygen fair source](https://keygen.sh/blog/keygen-is-now-fair-source/)

### 6.1 Conversion and price psychology *(researched 2026-08-08 — the most rigorous of the three)*

**Citation hygiene first — several "benchmarks" in circulation are fabricated.**
**OpenView Partners shut down in December 2023.** Any citation of an "OpenView 2024/2025/2026
Product Benchmarks" report is fabricated; the last real one is 2023. Likewise a claimed
"ProfitWell 2026 SaaS Monetization Index" could not be found to exist. The widely-quoted
"opt-in 18.2% / opt-out 48.8%" traces to an SEO agency's own 86 clients, and "opt-in >25% /
opt-out >60%" is one consultant's stated personal opinion (*"I'm not an analyst"*).

**Credible conversion benchmarks** (Poyar × ChartMogul × ProductLed, Jan 2026, N=200; and
Lenny × Pendo, N=1,000+):
- Freemium self-serve: **3–5% good, 6–12% great**; median across all products 8%
- ~25% of freemium products convert **below 2.5%**
- **Developer-focused products converted at 5% median — HALF the rate of non-developer
  products.** This is the only credible devtools-specific number that exists.
- **No rigorous OSS-user→paid benchmark exists at all.** Bessemer's *"often less than five
  percent"* is a stated design target, not a measurement. Filing-derived ratios are far worse
  (MongoDB 0.014%, GitLab ~0.02%) but compare downloads to organisations.

**THE PRICE-LEVEL FINDING THAT CORRECTS OUR OWN RECOMMENDATION.**
There is **no published randomised test comparing ~$5 vs ~$10** for a software subscription.
The two largest observational datasets point the other way:
- **RevenueCat** (115,000+ apps, $16B revenue): median monthly price **$10.00**, mode **$10.00**.
  Year-1 realised LTV per payer: **$10.69 low-priced vs $62.19 high-priced.** Download→paid was
  *higher* for high-priced apps (2.8% vs 1.4%).
- **Adapty** (16,000+ apps): global median **$12.99/mo**; high-price apps earn **~3x the LTV**.

Both are observational, not causal — but **there is no large-N evidence that going below $10
buys conversion, and consistent evidence that low tiers end with 3–6x lower LTV per payer.**
The "$10 psychological ceiling" is a *descriptive modal price*, not a demand cliff; no study
privileges $10 over any other boundary.

**The real reason to stay ≤$20 is the wallet, not psychology.**
State of AI 2026 (Devographics, n=6,378, *personal* spend): **62.1% of developers personally
spend ≤$20/month on all AI tooling combined**; 81.4% spend ≤$50. And $0-spenders fell from
52.4% → 39.7% year over year, so personal payment is normalising fast.

**Never use .99 for this product.** Anderson & Simester (2003) is the real study — but the
effect is a *discount signal*, works only on unfamiliar goods bought by uninformed buyers,
collapses from "+40%" in a tiny pilot to **+7%, and ~zero for familiar items**, in the
best-powered arm (N=90,000). Never tested in B2B or software. The quality-signalling literature
(Stiving 2000; Schindler & Kibarian 2001) says round numbers are what credibility-seeking
sellers use where buyers cannot verify quality before purchase — which describes a new developer
tool exactly. Observation: **every developer tool prices round** (Copilot $10, Cursor $20,
Claude $20, Raycast $10, Docker $9); the consumer bundle Setapp prices $14.99.

**THE MOST ACTIONABLE FINDING: repackaging beats price tuning.**
**Sidekiq** — a $50 commercial licence of the open-source project sold **33 copies = $1,650**,
which the author calls *"a failure."* Repackaged as a **$500 paid add-on with the OSS core still
free**: ~140 copies = **$70,000 in one year. ~42x.** Not a price increase — a different package.
Also: Server Density's fixed-plan repackaging (the one properly controlled A/B found anywhere,
2012) **doubled revenue per visitor while cutting signups 25%**; Baremetrics cut its cheapest
plan and LTV rose 143%.

**The documented failure:** Indie Worldwide raised $29 → $49 and removed monthly.
*"Growth almost immediately stagnated. Signups went down. Churn went up."* Held a year:
**$37,980 revenue vs $51,560 expenses — a $13,580 loss.** Reversed to $29 and recovered.
"Raising prices always increases revenue" is **not** supported by traceable data; the
most-cited backing (*"1% price improvement → 11% operating profit"*) is Marn & Rosiello,
**HBR 1992**, on large industrial firms.

Sources: [ChartMogul/Poyar 2026](https://chartmogul.com/reports/saas-conversion-report/) ·
[Lenny × Pendo](https://www.lennysnewsletter.com/p/what-is-a-good-free-to-paid-conversion) ·
[RevenueCat State of Subscription Apps 2026](https://www.revenuecat.com/state-of-subscription-apps) ·
[Adapty 2026](https://adapty.io/state-of-in-app-subscriptions-report/) ·
[State of AI 2026 spend](https://2026.stateofai.dev/en-US/usage/) ·
[Anderson & Simester 2003 PDF](https://www.kellogg.northwestern.edu/faculty/anderson_e/htm/personalpage_files/Papers/Effects_of_9_Price_Endings_on_Retail_Sales.pdf) ·
[Strulov-Shlain 2023](https://gwern.net/doc/economics/2023-strulovshlain.pdf) ·
[Sidekiq $70k](https://www.mikeperham.com/2013/10/01/how-to-make-100k-in-oss-by-working-hard/) ·
[Server Density A/B](https://www.kalzumeus.com/2012/08/13/doubling-saas-revenue/) ·
[Indie Worldwide failure](https://anthonycastrio.substack.com/p/i-made-a-mistake) ·
[Bessemer open source](https://www.bvp.com/atlas/roadmap-open-source)

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

## 6.5 Provenance of the evidence *(recorded 2026-08-08)*

Kept so a later reader can weigh each claim rather than trusting the file wholesale.

**Verified first-hand against vendor pages:** GitHub Copilot, Claude, Cursor Pro, Raycast, Zed,
Setapp, TablePlus, 1Password, Google AI plans, Cline — and every load-bearing figure below.

**The conclusion rests only on first-hand verified facts:** Anthropic Remote Control and Warp
bundle this free with subscriptions developers already hold; Happy Coder gives it away MIT at
23.2k stars for both Claude Code and Codex; Omnara — the only venture-backed paid entrant, YC
S25, 310 HN points — went $9/mo → free → pivoted out entirely; 130 category launches on HN since
Jan 2025 with 72% drawing ≤1 comment; the ~$20/mo personal-wallet ceiling.

**Verified via secondary sources only:** ChatGPT tiers, Cursor Pro+/Ultra, Warp tiers,
Windsurf→Devin Desktop, Fig→Amazon Q, JetBrains All Products, Dash.

**Unresolved, do not cite:** WebStorm individual price, Google AI Ultra price.

**Never corroborated:** Reddit (r/ClaudeAI, r/cursor) — reddit.com blocks automated fetching.
Stack Overflow's 2026 survey is unpublished; any circulating "SO 2026" figure is recycled 2025
data. And no rigorous evidence exists that $5 converts better than $10 for developer tools —
that remains a **negative finding**, not a gap to fill with intuition.

---

## 7. Open questions that pricing depends on

- Do developers run more than one agent CLI? (If no, the cross-vendor moat is theoretical.)
- Is the pain voiced by real people in public, or is it inferred from Sahith's own experience?
- Would a developer pay for remote access to something already running on their own machine?
  (Home Assistant / Nabu Casa is the closest precedent — see §6.1.)
- Can we bill without building accounts, or does billing force that decision open?
