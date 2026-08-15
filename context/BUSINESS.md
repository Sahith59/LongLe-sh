# BUSINESS — the plan, in plain language

> [!IMPORTANT]
> **Historical plan, superseded 2026-08-15.** The `$7/month hosted-relay` thesis predates official
> Claude and Codex remote products and major open-source competitor changes. Read
> [`docs/MONETIZATION-PLAN.md`](../docs/MONETIZATION-PLAN.md) for the current evidence-backed plan.
> This file remains as the original reasoning record.

**This is the file to read.** It explains the money side of LongLeash in ordinary words: what
we sell, what stays free, how we keep users' trust, how anyone will ever hear about it, and
what the honest chances are.

`PRICING.md` is the **evidence file** — every number in here traces back to it. If you want the
sources and the raw research, go there. If you want to understand the plan, stay here.

Written 2026-08-09 because the previous version was unreadable.

---

## 0. The whole plan in one paragraph

LongLeash is free and open source forever — all of it, every feature, for anyone willing to run
their own server. We sell one thing: **we run the server for you.** That costs $7/month, takes
zero setup, and is framed honestly as *supporting the project* rather than renting a feature.
We do not put limits inside software people can read and recompile, because those limits are
fake. We put limits on **our own server**, because those are real. Before any of that matters,
100 real people have to be using it for free — distribution is the actual bottleneck, not price.

---

# PART 1 — The companies I kept naming, explained

I threw names at you without explaining them. Here is what each one is and why it matters.

### Home Assistant / Nabu Casa — the one that matters most

**Home Assistant** is free open-source software you install on a small computer at home. It
controls your smart devices — lights, locks, thermostat, cameras — all in one place, without
sending anything to Google or Amazon. It is one of the biggest open-source projects in the world.

The problem it has is **exactly ours**: the software runs at your house. When you are at your
house, it works. When you are at the airport and want to check whether you locked the door, your
phone cannot reach a computer sitting on your home wifi. Getting through that wall means
configuring your router, buying a domain, dealing with your internet provider — hours of
networking work most people cannot do.

**Nabu Casa** is the company the Home Assistant creators started. It sells one product:
**$6.50/month, and your phone can reach your house from anywhere.** No router configuration, no
domain, nothing to learn. You click a button and it works.

Here is why I keep bringing them up:

| | Home Assistant / Nabu Casa | LongLeash |
|---|---|---|
| Free software you run on your own machine | yes | yes |
| The hard part is reaching it from outside | yes | yes |
| Paid product = "we handle the reaching-it part" | yes | yes |
| Software stays fully free and open | yes | yes |

**It is the same business, aimed at a different machine.** They point at your house. We point at
your laptop.

And it works: **160,000 people pay them** out of about 527,000 who use the free software. That is
roughly $12.5 million a year, with no investors — the founders own it outright.

### The others (shorter)

**Coolify** — free open-source software for hosting your own websites on your own server; a
free alternative to services like Heroku or Vercel. They also sell a hosted version at **$5/month**
for people who do not want to manage a server. About **1 in 100** of their free users pay.

**ngrok** — a small tool that gives your laptop a temporary public web address, so someone on the
internet can reach something running on your machine. **$8/month.** Same shape as our relay,
sold as a standalone product.

**Tailscale** — makes all your devices behave as if they are on the same private network no matter
where they physically are. Free for personal use, around **$8/user/month** for teams. This is what
technical people currently use instead of buying something like LongLeash.

**Healthchecks.io** — watches your scheduled jobs and emails you when one fails to run. Open
source, self-hostable, **$5/month** hosted. Tiny one-person business that has run profitably for
years. Proof that this shape works even at small scale.

**Sidekiq** — a Ruby background-job library. Relevant for one reason, covered in Part 3.

### The pattern across all of them

> **The software is free. The thing that connects you to it from far away costs money.**

That is not an accident or a marketing trick. It is because connecting from far away genuinely
requires a computer that is always on, always reachable, that someone has to pay for, monitor,
and fix at 2am when it breaks. That computer is a real, recurring cost. Charging for it is honest.

For LongLeash, that computer is **the relay**.

---

# PART 2 — The percentages, explained

You said the numbers were confusing. Here they are with the jargon removed.

### "Conversion rate" just means: out of everyone who tries it free, how many pay?

100 people install it. 3 of them pay. That is a **3% conversion rate**. That is all it means.

Real numbers from real products:

| Product | Out of every 100 free users, how many pay |
|---|---|
| Coolify | **1** |
| Typical developer tool | **1 to 5** |
| A good freemium product | **3 to 5** |
| A great one | **6 to 12** |
| **Nabu Casa** | **30** |

Nabu Casa's 30 out of 100 is extraordinary — roughly ten times the normal rate.

### Why is Nabu Casa's number so much higher? This is the important part.

Researchers read 321 comments from people explaining why they pay Nabu Casa. The **number one
reason was not the feature.** It was to fund the project.

The single most-upvoted comment, from a person who is technically capable of doing it himself
for free:

> *"I personally wanted to fund further development, even though it would be trivial to use the
> same solution I have for my other services."*

And the founder built it that way deliberately:

> *"The Home Assistant Cloud functionality is a perk for becoming a supporter of the Home
> Assistant project. You are not paying to just maintain the cloud servers."*

> *"We don't want to come to rely on donations and have to show Wikipedia-style beg banners."*

**What that means in plain terms:** a subscription is a donate button that comes with something
useful attached — and it works ten to thirty times better than an actual donate button.

For comparison: **core-js** is a piece of code running on 52% of the top 1,000 websites on Earth.
Its author asks for donations. He makes **$400 a month.** That is under $2 an hour. Meanwhile
Plausible (analytics software) makes $8,500/month from subscriptions and had received a grand
total of six $5 donations.

Donations do not work. Subscriptions do. Same money, different button.

### So how many users do we need?

At **$7/month**, to make **$10,000/month** we need about **1,430 people paying**.

How many free users that requires depends entirely on the conversion rate:

| If we convert at… | Free users needed | Realistic? |
|---|---|---|
| 1 in 100 (Coolify — pure convenience) | 143,000 | No |
| 3 in 100 (typical dev tool) | 48,000 | Very hard |
| 10 in 100 (decent community) | 14,300 | Hard but possible |
| 30 in 100 (Nabu Casa — people fund it) | **4,800** | Genuinely reachable |

**Your $10k/month target is not crazy.** But it depends on being the kind of project people *want*
to fund — not on any pricing trick. That is earned by being open, being reliable, and being
visibly maintained by a person who cares. There is no shortcut.

### Smaller milestones, which matter more right now

$10,000/month is far away. These are the numbers to actually aim at:

| Milestone | Paying users | Free users needed (at 10%) | What it proves |
|---|---|---|---|
| **$100/month** | 14 | ~140 | Strangers will pay. This is the hard one. |
| **$500/month** | 71 | ~710 | It is a real product, not a favour from friends. |
| **$1,000/month** | 143 | ~1,430 | It pays for itself and your time. |
| **$10,000/month** | 1,430 | ~14,300 | It is a business. |

**The jump from $0 to $100 is harder than the jump from $100 to $1,000.** Getting the first
fourteen strangers to hand over a card is the entire game. After that it is repetition.

---

# PART 3 — Free vs paid: how it actually works

This is the part you asked about most directly. It rests on one distinction that everything else
follows from.

### The one idea: you cannot limit code, you can only limit your own server

Two questions that look the same but are completely different:

**Question 1: "Can we make the free version stop at 3 agents?"**
**No.** LongLeash is open source. The limit would be a few lines in a file anyone can open, delete,
and rebuild. It is a polite request, not a limit.

And this is not theoretical. It has happened to everyone who tried it. **OpenProject** put a
licence check in their open-source code. Someone published a guide to removing it. That guide now
has **537 stars and 217 forks on GitHub**, and it is completely legal under their own licence.

Notice which projects succeed: **Sentry's** self-hosted version has no event limit at all.
**Plausible's** community edition has zero limits by choice. They gave up on counters because
counters do not work — they just make you look like you are trying something.

The worst part is not that people bypass it. It is that **the bypass becomes the story.** A Reddit
post titled "how to unlock LongLeash's paid features" is not a bug report, it is your reputation.

**Question 2: "Can we make our own server stop at 3 agents?"**
**Yes. Completely.** It is our machine. We decide who gets what. Nobody can patch a server they
do not control.

> **The rule: gate on what we run, never on what we ship.**
> A user can compile `longleashd` and delete anything they like. They cannot recompile our relay,
> and they cannot mint our push-notification certificate.

### This actually gives you the session limit you originally wanted

You wanted the free tier capped at 3–5 concurrent agents. I pushed back on putting it in the code
— but on **our relay** that limit is real and unbypassable. So you get the idea you wanted, in the
one place it can be enforced.

### The tiers

| | **Free — your own relay** | **Free — our relay** | **Cloud — $7/mo** | **Teams — $20/user/mo** |
|---|---|---|---|---|
| All agents (Claude, Codex, Gemini…) | ✅ | ✅ | ✅ | ✅ |
| All features, full source code | ✅ | ✅ | ✅ | ✅ |
| Concurrent sessions | unlimited | **2** | unlimited | unlimited |
| Push notifications to your phone | you set up your own | ✅ | ✅ | ✅ |
| Setup time | ~15 minutes of config | 60 seconds | 60 seconds | 60 seconds |
| We keep it running, monitored, fixed | — | best effort | ✅ | ✅ |
| See your teammates' agents | — | — | — | ✅ |
| Audit log of who approved what | local only | local only | local only | ✅ shared |
| Cost to us | $0 | small | small | small |

**Read the first column carefully. It is the whole trust strategy.** Someone who runs their own
relay gets *literally everything*, unlimited, forever, for free. Nothing is held back. They pay
with 15 minutes and the ongoing responsibility of maintaining a server.

That is not charity. It is what makes the paid tier honest: we are selling **convenience and
upkeep**, which is a real thing worth real money, instead of selling **artificial pain relief**,
which is what a crippled free tier actually is.

Nabu Casa proves this. Their own documentation **recommends Tailscale, ZeroTier and DuckDNS by
name — free alternatives to their paid product — on the same page as the thing they sell.** And
30% of their users still pay. Generosity did not cost them conversion; it is *why* they convert.

### The one thing they keep closed, and we should too

> *"Our account page and relayer are not open source."* — Nabu Casa

The daemon, the app, the protocol, the hooks: **all open.** The relay code and the billing/account
layer: **ours.** That is the line. Not a feature line — an infrastructure line.

### Why $7 and not $10 or $5

I moved this number twice. Here is the honest history so you can judge it:

1. **~$6** — my gut. No evidence.
2. **$10** — I found data showing $10 is the most common subscription price and that cheap apps
   earn far less per customer. **That data was from 115,000 consumer mobile apps.** Wrong market.
   You are not competing with meditation apps.
3. **$7** — the products in *your actual category* all cluster in one band:

| Nabu Casa | Coolify | Healthchecks | ngrok | Tailscale |
|---|---|---|---|---|
| $6.50 | $5 | $5 | $8 | $8 |

**$5–$8 is a proven band for "let me reach the thing I already run."** $7 sits in the middle.

Two supporting details:
- **Round numbers, never $6.99.** Prices ending in .99 signal *discount*. Every serious developer
  tool prices round — Copilot $10, Cursor $20, Claude $20, Raycast $10, Docker $9. A .99 on a new
  tool from an unknown developer reads as cheap, which is the opposite of trustworthy.
- **Stay under $20 no matter what.** Not psychology — arithmetic. A survey of 6,378 developers
  found **62% personally spend $20/month or less on all AI tooling combined**, and Claude Pro
  already eats most of that. You are asking for a *second* purchase from an emptied wallet.

### The most useful thing I found in all the research

**Sidekiq.** The author sold a $50 commercial licence for his open-source project. He sold
**33 copies. $1,650 total.** He calls it *"a failure."*

Then he changed nothing about the price philosophy — he changed the **package**. Same free open
source core, but now a **$500 paid add-on** with extra capabilities built on top. Result:
**~$70,000 in one year. Forty-two times more.**

> **What you are selling matters more than what you charge for it.**

Do not spend another day tuning $7 versus $9. Spend it on making the *thing being sold* obviously
worth buying.

---

# PART 4 — Trust and security

You asked how we make users trust this. Worth stating clearly, because **this is LongLeash's
strongest selling point and most of it is already built.**

### What a user is actually afraid of

Put yourself in a stranger's head. They are being asked to install software that lets a phone
approve things an AI does on their work laptop, with a server in the middle. Three fears:

**Fear 1: "Can the LongLeash people read my code and my conversations?"**

No. And this is architecture, not a promise.

Your laptop scrambles every message before it leaves. Only your phone has the key to unscramble
it. The relay in the middle receives an unreadable block of bytes, looks up which room it belongs
to, and forwards it. It cannot read the contents any more than the postal service can read a
letter inside a sealed steel box it has no key to.

> If someone stole our entire relay server tomorrow, they would get **a pile of scrambled bytes
> and nothing else.** No code, no conversations, no passwords, no email addresses.

That claim is checkable because the source is public. That is why open source matters here — it
turns "trust us" into "verify us."

**Fear 2: "Could someone else take control of my laptop?"**

Pairing happens once, by scanning a QR code that only exists on your own screen. That handshake
creates a key that lives on your two devices and nowhere else.

There is **no account, no password, no email** — which means there is no password to steal, no
"forgot password" flow to trick, and **no database of users to breach.** The most common way
products like this get compromised does not exist here, because we never built the thing that
gets compromised.

**Fear 3: "What happens if LongLeash disappears, or gets hacked?"**

- **Hacked:** there is nothing to take. No user database, no credentials, no stored content.
- **Disappears:** the software is on your machine and works on your own wifi with no relay at all.
  You can run your own relay in about 15 minutes. You are never stranded.

### What we do that earns trust, concretely

- **The source is public** — every claim above is verifiable rather than asserted
- **No account required** — nothing to breach
- **Notifications carry no content** — the alert on your lock screen says *something needs you*,
  never *what*. Your code never appears on a notification server.
- **Every approval is logged on your own laptop** — you can see exactly what was approved, when
- **Agents can only touch folders you allowed** — not the whole machine
- **There is no "run any command" endpoint** — every operation is a specific named action. A stolen
  phone cannot invent new powers.
- **We say plainly what LongLeash cannot do** — VS Code chat panels are sealed by VS Code and
  cannot be read; terminals not running under tmux cannot be captured on macOS. We put that in the
  UI and the docs instead of hiding it.

That last one is worth more than it looks. **Admitting a limitation is the cheapest trust signal
that exists**, and almost nobody does it. Every competitor's landing page implies it captures
everything. Ours will say what it misses. Technical users notice.

### Honest gaps — things to fix before telling strangers to install this

Not blockers, but do not skip them:

1. ~~**No way to un-pair a lost phone.**~~ **CLOSED 2026-08-09.** `longleash devices` lists what
   is paired; `longleash revoke <id>` cuts one off immediately — open socket dropped, relay room
   shut, push subscription removed, token refused. Laptop-only by design, so a thief holding the
   phone cannot revoke *you*. See `DECISIONS.md` §3.
2. **The relay is on your personal Cloudflare account.** Fine while it is you and five friends.
   Not fine when strangers depend on it. Move it. *(Already logged in DECISIONS.md §5.)*
3. **The installer is `curl … | bash`.** Standard practice, but security-minded people hate it.
   Offer a "download and read it first" path in the README and stop apologising.
4. **A hook runs on every single tool call.** If it ever crashes, it breaks someone's terminal.
   Already designed for — every failure path exits silently and the session behaves as if
   LongLeash were not installed. Keep it that way. **This invariant is not negotiable.**
5. **Eventually: a third-party security review**, and a written policy for what we do if something
   goes wrong. Not now. Before you have thousands of users, yes.

---

# PART 5 — How anyone will ever hear about it

You asked about "GTM" — go-to-market. It means: how does this get in front of real people.

### The uncomfortable fact you need to internalise

Researchers found **130 separate launches of products like LongLeash on Hacker News since January
2025.** Of those, **94 — that is 72% — received one comment or fewer.** Only 8 broke 50 points.

**The overwhelming failure mode is not bad pricing. It is total silence.**

So: **spend ten times more effort on distribution than on pricing.** The $7 number took a day of
research and it does not matter much. Getting 5,000 people to know this exists is the actual job,
and it is much harder than anything you have built so far.

### Step 1 — Make it work for ten people who are not you *(before anything public)*

Everything currently works on one machine: yours. That is not the same as working.

- Find **ten** developers (Discord, Twitter, friends, r/ClaudeAI) and personally walk each one
  through installing it
- Watch them do it. Do not help until they are stuck. **Write down every place they hesitate.**
- Every single thing that confuses a stranger is a bug, even if the code is correct
- Ship the "revoke device" button and move the relay off your personal account

**You are done with this step when someone you have never met installs it without asking you a
question.**

### Step 2 — The video *(this is the highest-leverage thing you will ever make)*

One screen recording. Under 45 seconds. No talking, no intro, no logo animation.

```
0:00  Laptop. Claude Code is working. It stops and asks a question.
0:03  Hand picks up a phone — you can see it is a real phone, in a real room
0:05  Phone buzzes. Lock screen: "A session needs you."
0:08  Tap. The question is there. Two options.
0:11  Tap an answer.
0:13  Cut back to the laptop. Claude has the answer and is working again.
0:16  Text on screen: "You were not at your desk."
```

**That video is your entire product.** People will not read your README. They will watch sixteen
seconds and immediately understand something no paragraph can explain. Make it excellent. Re-shoot
it five times. It is worth more than a week of code.

Show it on a real phone in a real room. Not a simulator. The realness is the point.

### Step 3 — Where to actually post it, in order

| Where | Why | Notes |
|---|---|---|
| **r/selfhosted** | People here *love* "free, open source, runs on your own machine" | Best single audience for this exact product. Lead with self-hosting, not pricing. |
| **r/ClaudeAI** | Exact users, actively frustrated with the official feature | Read the rules — they are strict about promotion. Be a participant first. |
| **Hacker News — "Show HN"** | Highest ceiling; where developer tools get discovered | Tuesday–Thursday, ~8am US Eastern. **One shot.** Do not waste it on a shaky build. |
| **X / Twitter** | The video travels here | Tag nobody. Let it stand alone. |
| **`awesome-claude-code` GitHub lists** | Free, permanent, high-intent traffic | Open a PR. Takes ten minutes. Do this early. |
| **r/LocalLLaMA** | Privacy-minded, self-hosting-minded | The E2E encryption story lands hard here. |

**Rules for posting:**
- **Lead with the problem, never the product.** "I could not leave my desk while my agents were
  running, so I built this" beats any feature list.
- **Be honest about what it does not do.** Say the VS Code and tmux limitations out loud. Someone
  will find them anyway; being first is a trust win instead of a credibility loss.
- **Do not post to all six places on the same day.** One at a time, fix what breaks, then next.
- **Answer every single comment.** For the first year, you responding personally *is* the product.
- **Never fake anything** — no invented testimonials, no fake user counts. This audience detects
  it instantly and never forgives it.

### Step 4 — The second launch: cross-vendor

Right now LongLeash works with Claude Code. So do a dozen other things.

When it works with **Claude Code *and* Codex *and* Gemini CLI, in one inbox** — that is a claim
nobody else can make, and one that no first-party ever will:

> **Anthropic will never ship a Codex client. OpenAI will never ship a Claude client. Google will
> ship neither. A tool that watches all of them can only be built by someone who is not any of
> them.**

That is a bigger launch than the first one. It is also *why* the product exists, so it should be
built and announced deliberately, not slipped in.

**One honest caveat:** Warp already bundles Claude Code, Codex, Gemini and OpenCode in one app
with mobile control, for $20/month that developers already pay. The cross-vendor idea is real but
it is **not unoccupied.** Your angle against Warp is that you are free, open source, self-hostable,
and you do not require adopting a whole new terminal.

### Step 5 — Only now, turn on payment

**Do not build billing until 100 people use LongLeash for free.**

Until that number exists, a price is a guess with a payment form attached. And you will learn more
from ten conversations with real users than from another week of pricing research — including
mine.

### What not to do

- Do not build a landing page with fake testimonials
- Do not build billing now
- Do not buy ads (this audience actively distrusts them)
- Do not launch on Product Hunt as your main shot — low value for developer tools
- Do not spend weeks on the website before the product survives ten strangers

---

# PART 6 — The honest odds

You asked for this straight, so here it is straight.

### What has to go right

1. **It works reliably on machines you have never seen.** Hardest part. Everything works on your
   laptop; strangers have different setups, weird networks, corporate laptops.
2. **Cross-vendor actually ships.** Without Codex and Gemini, you are one of a dozen Claude phone
   apps and the differentiator is a claim rather than a fact.
3. **Thousands of people find out it exists.** The real bottleneck.
4. **Enough of them want it hosted rather than self-hosted.**
5. **You keep maintaining it for 18–24 months** through the agent vendors constantly changing
   their hook APIs. Most projects die here, not at launch.

Item 5 is the one that kills most projects and the one nobody plans for.

### My actual estimates

| Outcome | Odds | Why |
|---|---|---|
| **Someone who is not your friend installs and uses it weekly** | **~80%** | The product works. It solves a real, loudly-voiced problem. Mostly needs you to finish and post. |
| **$100/month (about 14 payers)** | **~50%** | Needs a working public version, the video, and a couple of good posts. Very achievable if you actually launch. |
| **$1,000/month (about 143 payers)** | **~20%** | Needs real word of mouth and roughly a year of sustained work. |
| **$10,000/month (about 1,430 payers)** | **~5%** | Requires becoming *the* answer in this category, cross-vendor shipped, and two years of consistency. |

**5% is not a rejection.** Most side projects have a 0% shot at $10k/month because they never
launch and never charge. 5% on a $120,000/year outcome is a better bet than almost any other way
you could spend your evenings. But you should hear the number honestly rather than a comfortable
version of it.

### What honestly works against you

- **The category is a graveyard.** Terragon: dead. Vibe Kanban: shut down. Omnara (YC-backed, 310
  points on Hacker News): pivoted away entirely. Conductor charges $50/month while its mobile app
  is still "coming soon." These were funded teams.
- **Anthropic gives their version away free** with a plan your users already pay for.
- **The most common answer in these threads is "I already do this with Tailscale + tmux, for
  free."** You are competing with a setup people already own.
- **A direct competitor already ships your exact business model.** ClawTab: MIT licensed,
  self-host free, $4.99/month hosted. Your plan is not novel — which is reassuring (it validates
  the shape) and sobering (you are not first).
- **You are one person** with a job search running in parallel.

### What honestly works for you

- **The pain is real and loud.** Not inferred from your own experience — voiced repeatedly in
  public. Hacker News threads on this topic pull 300–580 points.
- **The official feature is genuinely unreliable, and people say so:**
  > *"Connections drop so fast and flakily. So many times I stepped out of the house in a rush
  > hoping remote control would help… every time I've been sorely disappointed."*
  
  **That is your opening, and you already closed it.** The week of 2026-08-04 to 08 was spent on
  exactly this: keepalives both directions, instant reconnect on network change, listener
  rebinding when the laptop changes network, relay-only operation while tethered, a self-diagnosing
  alerts panel. You did not know it at the time, but you built directly at the one complaint every
  incumbent has.
- **Cross-vendor is structurally defensible.** No first-party can ever do it. That is not a
  temporary lead, it is permanent.
- **The graveyard is also an opening.** The funded teams that died were burning investor money on
  cloud containers. You have near-zero costs and no runway to run out of.
- **You already discovered the right design principle independently.** The best-received comment
  in the whole space:
  > *"agents run on their own, phone only pings when something's irreversible and actually needs a
  > human. per-call approval you stop reading by day two."*
  
  That is your "never ask about something whose answer cannot matter" rule, which you arrived at
  from a real bug rather than from a blog post.

### The part that is not about money

You are job-hunting. **A working open-source product with real users, real GitHub stars, and a
public architecture document is worth more in interviews than most side income would be.** A
LongLeash with 500 users and $0 revenue is still a very strong signal to a hiring manager — it
demonstrates shipping, systems thinking, security judgment, and follow-through, which is exactly
what senior interviews probe for and what most candidates cannot show.

That is not a consolation prize. It is a second, much more likely payoff running in parallel, and
it makes the 5% bet clearly worth taking.

### The realistic timeline

| When | What |
|---|---|
| **Next 2–4 weeks** | Codex support. Revoke-device button. Relay moved to its own account. |
| **Month 2** | Ten strangers install it. Fix everything they trip on. Record the video. |
| **Month 3** | First public launch. Expect fewer people than you hope. |
| **Months 4–6** | Gemini support. Second launch on cross-vendor. First 100 users. |
| **Month 6+** | *Only now:* turn on billing. First dollar. |
| **Months 12–24** | If it is going to work, this is where it compounds. |

**First dollar is realistically six months out.** Anyone who tells you faster is selling something.

---

# PART 7 — Decisions to confirm, and what happens next

### Confirm these five

1. **Free tier is complete and uncapped for self-hosters.** Everything, forever, no feature held
   back. ← the trust foundation
2. **Limits live on our relay, never in the code.** Free-on-our-relay = 2 concurrent sessions.
   ← this is your session-limit idea, in the only place it works
3. **Price: $7/month, or $70/year.** Round, never .99.
4. **Everything open except the relay and the billing layer.** The Nabu Casa line.
5. **No billing until 100 people use it free.**

### Then, in order

1. **Codex CLI support** — makes the cross-vendor claim true instead of aspirational
2. **Revoke-device button** — the one real security gap
3. **Move the relay to its own Cloudflare account**
4. **Ten strangers install it**
5. **The video**
6. **Launch**

### Still unknown — flagged honestly, not hidden

- **We do not know what one relay user costs us per month.** Cloudflare's WebSocket Hibernation
  should make idle connections nearly free, but that is unmeasured. **Measure it with the first 50
  users before promising a free hosted tier forever.** If it turns out expensive, the free hosted
  tier gets a sleep-after-inactivity rule — which is fine, because self-hosting is always there.
- **We do not know how many developers run more than one agent CLI.** Surveys show 70% use 2–4 AI
  tools, but that counts chatbots and editor plugins. Nobody has measured "multiple agent CLIs at
  once." Directionally supported, not proven.
- **Billing requires identity, and we deliberately built no accounts** (`DECISIONS.md` §1). When
  billing arrives, that decision has to be reopened on purpose. Probable answer: the paid account
  lives entirely on the relay side, so the daemon still knows nothing about a user.

---

*Evidence, sources, and the full research log: `PRICING.md`.
Architectural and product decisions: `DECISIONS.md`.*
