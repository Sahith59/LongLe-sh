# Customer feedback and measurement

**Updated:** 10 September 2026
**Status:** P0 sender/domain prerequisites are owner-confirmed. P1–P4 are implemented as a tested
release candidate. P5 production deployment and owner-controlled acceptance remain pending.

**Owner decisions, 10 September:** Resend selected for outbound email; explicit Clerk owner ID
provided; existing support destination and weekly Monday-morning New York digest approved.
See [Resend setup and release boundaries](RESEND-SETUP.md). The owner subsequently confirmed the
Resend sending domain and restricted API key. A signed webhook and live delivery check are still
required before delivery is called proven.

**Sequence decision:** finish and verify the support, feedback, account visibility, and measurement
release in production first. Customer interviews are explicitly deferred until afterward at the
owner’s request. Workstream D remains parked. No interview quota blocks this release.

## What we know

The owner reports that the latest phone acceptance checks pass. The supplied Cloudflare screenshots
show 68.09k requests, 1.96k reported unique visitors, and a peak of 201 daily unique visitors with
the dashboard set to Previous 30 days. These are owner-supplied screenshots, not a fresh account audit.

The subsequent Clerk Production Users screenshot and owner confirmation show only the founder's
account. Current baseline: **1 reported registered account; 0 external registered accounts**.
This is evidence of no external registrations visible in that production instance, not proof that
no human has visited, that all traffic is bots, or that nobody uses the accountless version.
Do not calculate human visitor-to-sign-up conversion using 1.96k as the denominator.

This is a useful traffic baseline, not evidence of 1,960 customers. Cloudflare's zone metrics use
IP-based visits and can include crawlers, bots, API traffic, and the founder's testing. Requests also
include individual resource requests, not just page visits. Neither chart proves activation,
returning product users, or willingness to pay.
[Cloudflare metric definitions](https://developers.cloudflare.com/analytics/faq/about-analytics/)

The production implementation before this release has Clerk accounts and public support/security/privacy
email links. This candidate adds private feedback, live Clerk-backed owner visibility, explicit opt-in
measurement, and aggregate reporting. Historical successful pairing and remote-action retention cannot
be reconstructed. Do not report the pre-release gap as zero activity.

## 1. Establish the account baseline first

1. Open Clerk Dashboard, select LongLeash, then **Production**.
2. Open **Users** and inspect individual profiles for their email identifiers. Keep this list private.
3. Open **Overview**, choose a completed reporting interval, and examine registrations, active users,
   and retention. Do not mix projections for an incomplete interval into actual results.
4. Record the reporting date, population, total accounts, newly created accounts, and founder/test
   exclusions. Deleted accounts mean current total accounts and historical sign-ups can differ.
5. Use Clerk as the authoritative identity store. Do not create another user database just to count.

Clerk's activity includes authentication and token refreshes; its retention is account-session
retention, not evidence of a successful coding-agent intervention. These reports update daily.
[Clerk analytics](https://clerk.com/docs/guides/dashboard/analytics)
Profiles expose email and other account identifiers through the owner dashboard.
[Clerk user profiles](https://clerk.com/docs/guides/dashboard/user-profile)

Do not treat an email identifier as permission for bulk marketing. Keep support replies, research
participation, and marketing subscriptions separate. Ask users explicitly if they want research
follow-up; do not subscribe existing accounts automatically. No customer outreach is authorized by
this document. Local/LAN and self-hosted users need not register and cannot be enumerated through Clerk.

## 2. Private feedback before a public comment wall

Build a website-native **Talk to the founder** section and `/feedback` page, also reachable from the
phone guide. Offer **Report a bug**, **Request a feature**, and **Ask for help**. A private channel
avoids publishing customer emails, project details, or accidentally pasted credentials.

Initial requirements:

- Short subject, category, and message. No attachments or arbitrary email recipients initially.
  Warn against submitting code, transcripts, pairing links, tokens, or credentials.
- A random private link is the verified reply channel. Research contact and marketing consent remain
  deferred instead of being inferred from a support report.
- Do not require a functioning login to report a login/setup problem. Guest submissions need abuse
  protection and verified reply-address handling before sending email to that address.
- Do not claim a message was sent until the server has durably accepted it. Handle offline, timeout,
  double-submit, spam rejection, and notification-provider failure without losing the message.
- Owner notifications link to an authenticated private inbox; avoid copying full messages into email.
  Keep a visible direct `support@longleash.dev` fallback and private security-reporting link.
- No fabricated live-chat presence or response-time guarantee. Show a realistic reply expectation
  only after the owner commits to it.
- Reply/status history: Received, Needs information, Planned, Resolved, or Not planned with a reason.
  Do not promise that every request will be implemented.

Build a small first-party private inbox: bounded tickets, owner replies, and statuses only. Keep
Clerk as identity and put support records in separate hosted storage, never in relay rooms or the
laptop transcript database. No CRM, organizations, attachment uploads, public wall, or automatic AI
replies in this release. Outbound delivery stays behind a provider adapter, selected after verifying
account availability and cost with the owner; do not purchase a subscription without approval.
Public feature voting can follow only if customers actually want it;
publication must be explicit, redacted, and moderated, never automatic from a private ticket.

The existing public privacy notice says there is no product analytics. Before collecting new data,
update it to explain support-message storage, processors, access, retention, deletion, and optional
measurement. User-submitted support text is an explicit new hosted-data category, not relay traffic.

## 3. Measure useful outcomes, not an open tab

Keep three separate views: **site traffic**, **hosted accounts**, and **observed product use**.

| Metric | Definition / source |
| --- | --- |
| Registered accounts | Clerk production account count, with test exclusions stated |
| Account-active users | Clerk's authenticated-session activity; label it explicitly |
| Paired users | Distinct consenting hosted accounts whose browser confirms completed pairing |
| Activated users | Paired accounts with a daemon-acknowledged successful remote action |
| Weekly product-active users | Distinct measured accounts with a successful action in the last 7 complete UTC days |
| Repeat users | Activated accounts with successful actions on two or more distinct UTC dates |
| D7 / D30 product retention | Activated cohort performing another successful action on UTC day 7 / 30 after activation; only fully observable cohorts enter the denominator |
| Action reliability | Successful, failed, and unknown outcomes among observed attempts, split by action type |
| Customer feedback | Open issues, age of unanswered reports, recurring blockers, and resolved reports |

Eligible remote actions: approval, reply, stop, handoff, tuning, and reviewed delegation. Count
acknowledged success, not taps or replayed transcript entries. A reply accepted for delivery does
not prove the agent completed the user's task. Do not claim an action happened away from the desk
unless the user tells us; being on a phone does not establish location.

Collection design gates:

- Proposed default: optional product measurement, explained at opt-in; declining never affects
  pairing or control. LAN/self-hosted installs send no product telemetry to LongLeash by default.
- Only allowlisted action/outcome enums, opaque analytics identity, random event ID, build version,
  and bounded timestamps. Never send email, names, paths, prompts, code, transcripts, tool content,
  full URLs, room identifiers, provider conversation IDs, pairing tokens, or frame keys.
- An opaque identifier is pseudonymous, not anonymous. Keep Clerk mapping and any deletion mechanism
  server-side and restricted. Emails belong in account administration, not event payloads.
- Authenticate hosted ingestion; server-derive account scope. Deduplicate retries across reconnects
  and tabs, bound payloads/rates/queues, and reject unsupported fields and unreasonable timestamps.
- Browser reports are observational evidence, not billing-grade proof. Never decrypt relay frames
  for analytics. Losing telemetry must never block an approval or other product action.
- State measurement start date, opt-in coverage, excluded test accounts, data freshness, and missing
  periods. Do not extrapolate measured retention to all users or label young cohorts as failures.
- Proposed retention: raw product events 30 days, per-account daily aggregates 90 days, support
  tickets 90 days after closure. Finalize retention and deletion behavior before collection starts.

## 4. Owner visibility and reporting

Clerk's existing dashboard is the immediate account view. The release adds an owner-only hosted
view with account totals and a paginated Clerk-backed user list (email, verification state, joined
date, and last account activity), plus product measurements and a separate feedback inbox. Do not
duplicate email/name records into the analytics store. Any customer list/export must enforce
server-side owner authorization, MFA-backed access, no shared caching, and no email addresses in
logs, repository artifacts, or CI. Owner status comes from an explicit server-side Clerk user-ID
allowlist, never a client-controlled role, first signup, or an email suffix. Missing configuration
denies access. Account visibility grants no laptop or conversation authority.

Recommended reporting schedule: a weekly aggregate digest, with the owner dashboard available on
demand. Separately notify the owner when new feedback arrives. Confirm the destination inbox,
cadence/timezone, and outbound email provider before scheduling; nothing is scheduled yet.
Reports must identify their measurement window, generation time, source freshness, exclusions,
sample/coverage limitations, and unknown metrics. Failed reports retry with deduplication and alert
the owner; do not silently reuse yesterday's counts or send customer lists as attachments.

## 5. Customer conversations: deferred until this release is live

Do not recruit or contact users during this implementation program. After production acceptance
and when willing external users exist, interview people who failed setup and people who returned. Ask:

1. What were you trying to do the last time you opened LongLeash?
2. Did you get it done? Where did you get stuck?
3. Have you used it again on another day? What brought you back, or stopped you?
4. What would you have done without it?
5. After discussing actual use, which operated benefit would justify paying, if any?

Record themes without copying customer identities into Git. Feature requests are clues about a
problem, not automatic roadmap votes. Prioritize repeated blockers and retained users' needs.

## 6. Email readiness: current evidence and owner runbook

Read-only public DNS checks on 9 September returned three Cloudflare MX records and an SPF record
including `_spf.mx.cloudflare.net`. The `_dmarc.longleash.dev` TXT lookup returned no record.
This establishes DNS configuration only. A subsequent authenticated CLI inspection verified enabled
exact support/security/privacy forwarding rules and their verified destination (see P0 evidence
below). Incoming support delivery was subsequently confirmed by the owner on 10 September;
outbound sender verification and reply tests remain pending.
DKIM was not audited; do not infer its absence from the DMARC lookup.

Owner steps, one at a time:

1. Choose the private inbox that should receive support and owner notifications. Do not post login
   credentials, tokens, or a customer email list in chat.
2. Open [Cloudflare's account-level Email Routing shortcut](https://dash.cloudflare.com/?to=/:account/email-service/routing),
   select the account, then `longleash.dev`, and inspect routing rules. The screenshot's domain-level
   **Email** menu shows DMARC Management and Email Security; it is not the account-level Email
   Service menu. Alternate navigation: leave the domain view, then **Compute > Email Service >
   Email Routing**. Do not recreate an existing exact rule.
3. Confirm an enabled exact `support@longleash.dev` rule forwards to that inbox and the destination
   is verified. If verification is pending, open the verification email in that inbox.
4. Send a harmless support test from another address you control. Confirm receipt, spam-folder
   placement, and the routing activity result. Repeat for the existing security/privacy aliases.
5. Verify outbound domain sending separately. Ordinary Reply in a forwarded Gmail message uses
   Gmail's sender by default, not `support@longleash.dev`. Use a verified outbound service for the
   owner inbox reply action, or a mailbox service with an authenticated custom-domain sender.
6. Test the outward message's From, Reply-To, SPF/DKIM/DMARC alignment and a reply back to support.
   Audit existing Google/Clerk/other domain senders before adding or tightening DMARC. Preserve MX
   and existing SPF senders; never add a second SPF policy record or blindly enforce reject.

References: [routing rules and verified destinations](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/),
[forwarded-mail reply behavior](https://developers.cloudflare.com/email-service/reference/postmaster/).

Cloudflare Email Routing is an inbound path, not evidence of outbound sending access. Check the
current account's sending capabilities and limits before selecting the outbound adapter. The
support inbox and reporting jobs must never send through personal credentials embedded in code.

### P0 live evidence: 9 September 2026 (owner timezone)

| Check | Result |
| --- | --- |
| Current public build | `380508d`; existing read-only production script passed against expected commit `380508da145690ef231521c35c6d792e0f013b0a` |
| Production checks | Public documentation routes, branded/legacy redirects, TLS endpoints, security headers, auth readiness, and unauthenticated API denials passed; not a browser signup or paired-laptop test |
| Existing hosted-auth unit tests | `packages/app/test/hosted-auth.test.ts`: 6 passed under Node 22 |
| GitHub access | Authenticated access verified with network permission; an initial sandbox-limited attempt was not evidence of an expired token |
| Cloudflare access | Existing Wrangler OAuth login works; local shell default Node 20 was bypassed using the already-installed Node 22, without changing the machine default |
| Inbound routing rules | Exact support/security/privacy aliases are enabled and forward to the owner's Gmail destination; catch-all disabled |
| Destination | Cloudflare marks the existing destination verified; the private address and rule identifiers are intentionally not copied into repository documentation |
| Outbound settings | `wrangler email sending settings longleash.dev` returned `Unauthorized`, API code `2036`; cause not established, and sending-domain readiness remains unknown |
| Actual receipt/reply | Pending owner-controlled inbox test; no email was sent in this check |
| New-user registration | Pending an owner-controlled fresh account and mailbox verification; existing founder sign-in does not pass this gate |

The owner confirmed incoming support-mail receipt on 10 September. Next, open the
[account-level Email Sending shortcut](https://dash.cloudflare.com/?to=/:account/email-service/sending)
and report whether `longleash.dev` is onboarded, needs setup, or access is restricted. Do not purchase
a plan, change DNS, or expose tokens merely to resolve the CLI error.

No DNS changes, rule replacements, new subscriptions, customer messages, local daemon restarts, or
production deployments occurred during these checks. Code implementation may proceed while owner
email verification is pending, but P0 and P5 cannot be marked passed, and email-dependent features
must stay disabled until delivery and sender authentication pass. Deploying dormant code does not
meet the owner's requirement that all of P0–P5 be complete and live.

### Implementation checkpoint: 10 September 2026

Latest candidate evidence:

- P1 now supports idempotent customer follow-ups, complete owner/customer message history, reports
  retained until closure, and deletion 90 days after closure.
- P2 reads the paginated account directory directly from Clerk Production, classifies configured
  owner/test IDs separately, and persists no duplicate email/name table.
- P3 is off by default. A keyed pseudonymous account reference is derived server-side; strict action
  acknowledgements aggregate atomically in D1; duplicate events do not inflate results; opting out
  deletes raw events and per-account daily aggregates.
- P4 separates provider acceptance from signed delivery evidence, stores no webhook recipient or
  payload, sends private-content-free notifications, and deduplicates the Monday 09:00 New York
  aggregate digest for each completed UTC week.
- Full automated evidence after the dependency refresh: protocol 58 tests, relay 124 tests, app 188
  tests, VS Code 30 tests, daemon 564 tests, and CLI 36 tests passed. All workspace typechecks and
  builds passed; the Worker dry-run resolved every binding; three migrations applied successfully to
  a real local workerd D1. The production dependency audit reports no known moderate-or-higher issue.
- These facts establish a production candidate, not P5 acceptance. Remote D1 migration, exact live
  build deployment, signed Resend delivery, owner/ordinary-account denial checks, and the physical
  iPhone flow remain outstanding until recorded below.

- Incoming support email: **owner-confirmed pass**. The account-level sending-domain list was
  retried and also returned Unauthorized (code 2036); outgoing domain readiness is still unknown.
- Created branch `feat/customer-feedback`. The P1 candidate adds separate feedback SQL storage,
  same-origin bounded submission, 256-bit private-report proofs stored only as hashes server-side,
  idempotent retries, owner allowlist authorization, rate/global intake limits, access expiry,
  proof-authorized deletion, and revision-checked owner web replies.
- Public `/feedback` and hosted `/owner/feedback` candidate pages use the existing visual tokens,
  labelled controls, 16px form text, mobile stacking, visible navigation, and explicit delivery states.
  No owner email addresses or example customers are hardcoded into the UI.
- Feedback remains fail-closed: no `FEEDBACK_ENABLED=true`, storage binding, rate-limit binding,
  owner-ID secret, or production schema migration has been provisioned. No public navigation links
  advertise it. No new customer data has been collected.
- Verification: relay suite **63 tests passed**, app suite **188 tests passed**, app and relay
  TypeScript checks passed, and the app production bundle built. The relay suite was rerun with
  loopback access after the sandbox-only run stalled on socket tests; the sandbox run was stopped.
- These are code/fixture tests, not a live email, real D1, or visual iPhone acceptance pass. The
  candidate still needs private-thread follow-up/history, consented research-contact handling,
  notification integration, privacy disclosure updates, wired retention scheduling, browser/real-D1
  tests, deployment configuration, and full P1 release review. Do not mark P1 complete yet.
- The candidate expires reports 90 days after creation. This differs from the proposed
  post-closure policy above and must be reconciled in code, disclosures, and retention tests
  before activation. Owner allowlisting now also requires verified first- and second-factor ages
  of at most ten minutes; no downgrade to single-factor authorization is allowed. The complete
  enrollment/reverification browser flow still needs implementation and acceptance.
- Owner identity was provided and staged as `OWNER_USER_IDS` on an **undeployed** Worker version;
  see the Resend runbook for the version ID. It is not an active owner-dashboard deployment.
- Resend adapter and durable owner-notification outbox added locally: bounded requests/responses,
  immutable persisted payloads, atomic job leases, backoff, eight-attempt/23-hour retry limits,
  and explicit acceptance versus delivery semantics. The scheduler handler is wired in code;
  no production cron, database, or sending flag has been configured.
- Fresh regression evidence: relay **114 tests passed** including a local workerd-D1 migration,
  retry/concurrent outbox, private-read, and expiry test; app **188 tests passed**; relay/app
  TypeScript checks and app build passed. Local D1 is not remote-production D1 evidence.
- Owner dependencies: Resend sending-domain verification and a domain-restricted sending key,
  a fresh owner-controlled signup acceptance run, and the owner MFA acceptance check. Do not
  substitute an email suffix, first registered user, or user-editable role for the owner allowlist.
- No application code was pushed/deployed, no production database was created, and no laptop daemon was
  started or restarted. Workstream D and interviews remain parked.

## Acceptance and execution order: one work package at a time

Each package gets its own implementation commit and recorded test evidence. A later package must
not be described as complete because an earlier one shipped. Use the protected CI deployment path;
do not change the laptop service or pairing protocol for customer-reporting work.

| Package | Deliverable | Exit evidence |
| --- | --- | --- |
| P0: baseline and readiness | Record founder-only count; verify contact inbox and outbound identity; test public CTA and signup as a fresh user | Owner-controlled non-founder test identity can sign up, verify, sign out, and sign back in; is clearly excluded from adoption counts; support receives and replies correctly |
| P1: private feedback | Website section and `/feedback`, phone-guide entry, bounded guest/signed-in submission, private owner inbox and replies | Mobile submission to durable ticket to owner reply to user receipt; retry, abuse, cross-user, and email-outage tests pass |
| P2: owner account visibility | Server-authorized account list, totals, explicit founder/test exclusions, feedback status management | Compare every paginated count to Clerk; ordinary users and signed-out clients cannot read any owner data; owner cannot fetch laptop data through this view |
| P3: product measurement | Optional consent, completed-pair and acknowledged-action events, repeat-use and reliability summaries | Declining/withdrawing consent stops collection; repeated/reordered events do not inflate usage; synthetic fixtures demonstrate known counts and retention denominators |
| P4: recurring reports | On-demand owner summary, scheduled aggregate digest, new-feedback notification | One controlled live delivery, retry/idempotency tests, scheduler verification, accurate unavailable/zero/immature labels, no customer details in email |
| P5: production acceptance | Reviewed privacy/support docs, deployment, live cross-account/phone/recovery matrix | Exact live build and CI recorded; owner checks pass; feature rollback works without affecting agent sessions; unresolved blockers listed |

P0 can diagnose problems using a separate owner-controlled test account; it does not require customer
interviews. Obtain owner confirmation before creating external accounts or sending test email.
Do not delete the founder account, modify customer accounts, or publish test counts as adoption.

For P1, guest reply-address verification is bounded and rate-limited; do not send arbitrary user
content to an unverified address. Support replies must be readable through a verified, expiring
access flow or delivered to a verified recipient. A guessed ticket ID alone never grants access.
Render submissions as text, never executable markup; notifications contain no submitted text.

For P3, aggregate landing-page/CTA counts may help diagnose acquisition separately from account
activation. Collect only allowlisted page/action identifiers, never query strings, pairing
fragments, fingerprinting, IP-based customer identity, or automatically captured forms. Label
browser measurements as estimates; blockers and consent mean coverage is incomplete.

For P4, propose a daily aggregate snapshot on demand and a weekly Monday digest after the previous
UTC reporting week closes. Confirm recipient and delivery time before enabling its schedule.
Show total accounts, external accounts, new signups, account activity, measured activated/repeat
users, observed action outcomes, and unresolved feedback. With the current baseline, external
accounts are 0, uncollected activation is **Not measured**, and retention is **No eligible cohort**,
not 0%. Missing source data fails visibly; report-generation success is not inbox-delivery success.

Deployment safeguards: enable new hosted features independently behind server-controlled flags;
keep storage migrations additive and separate from relay state; test rollback, pagination/load
limits, provider timeouts, privacy deletion including stored summaries, retention jobs, and owner
credential revocation. Use staging fixtures for synthetic usage, not invented production activity.
Do not expand Clerk's sibling-domain authorization merely to show a feedback form on the public site.
Authenticated owner operations stay on the hosted app origin; public guest forms receive a narrowly
scoped submission boundary, not access to account APIs.

After P5, review this production release with the owner, then resume Workstream D and customer
discovery. This program does not waive existing pairing, lifecycle, or final public-release gates.

Each implementation slice needs separate evidence: unauthorized and cross-account access denial,
guest spam/forged-email rejection, stored XSS and input limits, duplicate submission/event handling,
provider outage recovery, export/deletion/retention enforcement, withdrawal of consent, no-secret
payload inspection, and 320px/iPhone keyboard-safe submission and close controls. Verify that
analytics failure cannot affect the daemon, relay, or accountless use. Do not declare these tests
passed merely because the earlier phone release passed.

Keep the preview free for now. At the owner's request, interviews start after this bounded release,
not during implementation. Do not keep expanding this program into an unbounded CRM project while
external adoption remains unproved. Charging still requires the actual
reliability, support, billing, and entitlement gates in [the monetization plan](MONETIZATION-PLAN.md).
Traffic counts alone do not pass those gates, and a low price cannot compensate for missing value.
