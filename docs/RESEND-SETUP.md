# Resend setup for LongLeash support

Status: provider selected by the owner on 10 September 2026. Sending is **not enabled**.
Incoming Cloudflare Email Routing stays in place. This runbook does not authorize a paid plan.

## Owner setup

1. Create or sign in to your account at [Resend](https://resend.com).
2. Open Domains and add `longleash.dev` for **sending**. Do not enable Resend inbound receiving.
3. Share the DNS record types, names, and values requested by Resend for review. These are public
   DNS values, not credentials. Add only the reviewed sending records in Cloudflare. Preserve the
   existing apex MX records, Clerk records, and existing SPF senders. Do not add a second SPF policy
   at the same hostname. A sending/bounce-subdomain MX record is different from an apex incoming MX.
4. Wait for the sending domain to show Verified. Leave open and click tracking disabled: LongLeash
   does not need recipient-tracking pixels or rewritten support links.
5. In API Keys, create a **Sending access** key restricted to `longleash.dev`. A production sender
   does not need account-wide administrative permissions. Store it in your password manager.
6. From the LongLeash checkout, run:

   ```sh
   pnpm --dir packages/relay exec wrangler versions secret put RESEND_API_KEY
   ```

   Paste the key only into Wrangler's hidden prompt. Never put it in chat, Git, a screenshot, a
   frontend environment variable, or a command argument. Use Node 22 or newer if Wrangler requests it.
   This command creates an **undeployed version**. Do not deploy that version yourself: it is a
   secret-staging step, not the P0–P5 feature release. If prompted to update unrelated skills, decline.
7. Report only that the domain is verified and the secret-staging command succeeded. Sharing its
   version ID is safe. A sending-only key cannot be used to administer or inspect domains, so the
   dashboard verification result is still needed.

The provided Clerk owner ID has been staged separately as `OWNER_USER_IDS` on undeployed Worker
version `0d329de6-ba78-43a5-8a9c-936c9de1c5f5`. It is not stored in the public source or frontend.
Before the feature deployment, verify the latest version includes both secrets; never promote an
old secret-only version over newer application code.

## Sending boundaries

- Sender and Reply-To: `support@longleash.dev`.
- Owner destination: the already-confirmed support-routing destination. The configured value is
  server-side; customer-supplied recipients cannot redirect owner notifications.
- Owner has approved a weekly Monday-morning digest in `America/New_York`. Target 09:00 local time,
  including daylight-saving transitions, with one report per completed UTC reporting week. This is
  a recorded preference, not an enabled schedule.
- No customer outreach or research invitations are sent as part of setup. Only controlled test
  delivery to an owner-approved address happens during acceptance.
- A provider API success means **accepted**, not **delivered**. Live delivery requires provider
  delivery evidence and actual inbox verification. Replies to unverified customer addresses are not
  enabled by this adapter.

## Implemented locally

The adapter uses a fixed HTTPS endpoint and sender, bounded input and provider responses, a
10-second timeout, no redirects, stable idempotency keys, and explicit accepted/retry/review states.
The D1 outbox records an immutable payload before the first send, claims jobs with expiring leases,
backs off on failure, and caps automatic attempts at eight and 23 hours. Resend's keys last 24 hours;
an older uncertain send must be reviewed, not blindly resent with a new key.

The initial owner notification contains no report text, account email, or private report proof.
Ticket creation and notification creation share a database transaction via a trigger; deletion
cascades into its queued notification. An in-flight send cannot be recalled, so emails deliberately
contain only a generic notification and authenticated owner-inbox link.

## Required before activation

- Finish P1 private follow-up/history, reply-address verification, consent, and privacy disclosure.
- Provision storage, apply reviewed migrations, configure rate limits and sender flags, and verify
  the full owner sign-in flow. Owner access requires recent first- and second-factor verification;
  a valid Google login alone is not treated as proof of MFA.
- Wire and test delivery/bounce handling, suppression, email-outage visibility, operational outbox
  review, and scheduler configuration. The scheduler handler exists but no cron is configured yet.
- Send one controlled test; verify From, Reply-To, SPF/DKIM alignment, delivery, and reply receipt.
- Complete P2 account visibility, P3 optional measurement, P4 digest generation, and P5 production
  acceptance. None is declared complete by adding the Resend adapter.

References: [domain verification](https://resend.com/docs/dashboard/domains/introduction),
[restricted API keys](https://resend.com/docs/dashboard/api-keys/introduction),
[idempotency window](https://resend.com/docs/dashboard/emails/idempotency-keys).
