# Public launch and branded domains

LongLeash uses one Cloudflare Worker for the PWA assets, health endpoint, WebSocket relay, and
Durable Object rooms. The public website and the paired app should have separate branded
hostnames even though the same Worker may serve both:

| Surface | Recommended hostname | What opens there |
| --- | --- | --- |
| Public website | `longleash.<tld>` | Product, setup guide, security, docs, and roadmap |
| Canonical alias | `www.longleash.<tld>` | Permanent redirect to the public website |
| Product + relay | `app.longleash.<tld>` | Pairing/PWA at `/`, relay at `/ws`, status at `/health` |
| Legacy compatibility | `longleash-relay.<account>.workers.dev` | Existing laptop relay sockets and rollback; browser pages redirect to the branded app |

This split prevents an unpaired visitor from seeing the pairing gate instead of the product site,
and prevents a paired home-screen app from being replaced by a brochure on refresh.

## Why renaming the Worker is not enough

A `workers.dev` address is formed from the Worker name and the Cloudflare account subdomain:

```text
<worker-name>.<account-subdomain>.workers.dev
```

Changing `longleash-relay` changes only the first part. The account subdomain is shared by the
account, so changing it can affect other Workers and still leaves a `workers.dev` development
address. Cloudflare recommends a Custom Domain when the Worker itself is the public origin. See
[Workers routing](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
and [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

## What the repository already supports

The Worker has fail-safe host-aware routing:

- with no public-host configuration, the existing `workers.dev` behavior is unchanged;
- the configured apex serves the landing page at `/`;
- `www` redirects permanently to the apex;
- the configured app hostname continues to serve the PWA and `/ws`;
- a legacy query-style pairing link accidentally opened on the apex is redirected to the app host
  with its complete query intact;
- new pairing links put their temporary secret in the URL fragment (`#c=…&s=…`), which a browser
  does not send in the HTTP request to Cloudflare;
- browser visits to the configured legacy `workers.dev` address redirect to the account-gated app,
  while `/ws`, `/health`, and account API paths remain available for migration;
- an existing laptop may keep its old `workers.dev` relay URL while the newly signed-in phone uses
  `app.longleash.dev`, because both hostnames reach the same Worker and room namespace.

Before public-host configuration, the public page remains available at `/welcome` for preview.
After branded launch, ordinary legacy browser paths redirect to `app.longleash.dev`; rollback means
restoring the prior Worker version, not leaving an accountless public entrance live.
Its documentation, troubleshooting, roadmap, privacy, and license pages stay on the public site;
GitHub is an explicit source-code and issue-tracker destination, not the reading experience.

The official hosted app launches with a LongLeash account through Google or verified email. Pairing remains a separate
device-authority lock, and LAN/self-hosted use remains accountless. The account never stores provider
credentials, repositories, transcripts, or pairing secrets. See
[Public accounts, device authority, and future billing](PUBLIC-ACCOUNT-STRATEGY.md) and the
[account-enabled launch runbook](ACCOUNT-LAUNCH.md).

## One-time owner steps

These steps require the domain owner and therefore are not safe for an automated coding session to
guess or perform without the exact hostname.

1. `longleash.dev` is owned in the same Cloudflare account as the Worker. Keep auto-renew, registrar
   lock, DNSSEC, account MFA, and recovery codes enabled and tested.
2. Before attaching production, finish Clerk, Google OAuth, contact aliases, terms, privacy, Worker
   secrets, and account acceptance in [ACCOUNT-LAUNCH.md](ACCOUNT-LAUNCH.md).
3. Confirm there are no existing CNAME records on the exact apex, `www`, or `app` hostnames.
   Cloudflare cannot attach a Worker Custom Domain over a conflicting CNAME.
4. Enable a private vulnerability-reporting channel in GitHub or provide a dedicated security
   email, then add that exact channel to the public Security/Privacy copy. Never ask researchers to
   publish credentials or exploit details in an ordinary issue.
5. The exact hostnames are now fixed in `packages/relay/wrangler.jsonc`:

   ```jsonc
   {
     "routes": [
       { "pattern": "longleash.dev", "custom_domain": true },
       { "pattern": "www.longleash.dev", "custom_domain": true },
       { "pattern": "app.longleash.dev", "custom_domain": true }
     ],
     "vars": {
       "PUBLIC_SITE_HOST": "longleash.dev",
       "PUBLIC_WWW_HOST": "www.longleash.dev",
       "PUBLIC_APP_HOST": "app.longleash.dev",
       "PUBLIC_LEGACY_APP_HOST": "longleash-relay.<account>.workers.dev"
     }
   }
   ```

6. Build and run a Wrangler dry run before deployment:

   ```sh
   pnpm --filter @longleash/app build
   pnpm --dir packages/relay exec wrangler deploy --dry-run
   ```

7. Deploy, then wait for Cloudflare to provision the DNS records and certificates. Custom Domains
   let Cloudflare manage both automatically.

## Migration order—do not strand paired phones

The legacy origin stays enabled during the transition. Migration is deliberately additive:

```mermaid
flowchart LR
    Old["Existing workers.dev laptop relay"] --> Keep["Keep socket compatibility"]
    Browser["Legacy browser visit"] --> App
    Domain["Add branded Custom Domains"] --> Site["Apex landing page"]
    Domain --> App["app hostname · PWA + /ws"]
    App --> Verify["Desktop + iPhone acceptance matrix"]
    Verify --> Installer["Change new-install default relay"]
    Installer --> Observe["Observe one release window"]
    Observe --> Decide{"Legacy traffic remains?"}
    Decide -->|"yes"| Keep
    Decide -->|"no"| Retire["Optional later retirement"]
```

After branded routing passes, update these public defaults together in one release:

- `scripts/install.sh` — new installations use `wss://app.<domain>/ws`;
- `scripts/release.sh` — release verification reads `https://app.<domain>/build.json`;
- `docs/ACCEPTANCE.md` and this guide — branded smoke-test URLs;
- the landing page's production app URL, if it cannot be derived from `app.<apex>`.

Existing installations remember their relay URL. Do not silently rewrite it while a daemon is
running. Their laptop socket can keep using `workers.dev` through the compatibility window while
the browser is redirected to the signed-in branded app; users may explicitly update after the new
host is verified.

## Mandatory release gate

Run all of the following before calling the branded release live:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm --dir packages/relay exec wrangler deploy --dry-run
curl -fsS https://app.longleash.dev/health
curl -fsS https://app.longleash.dev/api/auth/config
curl -fsS https://app.longleash.dev/build.json
curl -I https://www.longleash.dev/
```

Also require HTTP 200 and the LongLeash public shell at every first-party route:

```text
/
/docs
/docs/getting-started
/docs/daily-use
/docs/troubleshooting
/docs/security
/docs/session-portability
/docs/faq
/roadmap
/privacy
/terms
/license
```

Click every landing documentation card and footer link on desktop and a narrow phone viewport.
Documentation, roadmap, privacy, and license must stay on the branded site. Only **Source on
GitHub**, installer source, implementation evidence, and issue-reporting actions should leave it.

Then perform the complete [real-device acceptance checklist](ACCEPTANCE.md) on a new iPhone home
screen install and on an already-paired device. The QR must open the app hostname, pairing must
complete, the app must reconnect over cellular, and `longleash doctor` must report matching builds.

## Rollback

Do not delete the `workers.dev` deployment during launch. If a branded certificate, DNS record,
PWA update, or WebSocket route fails:

1. keep existing laptop relay sockets on the legacy endpoint;
2. restore the previous Worker version in Cloudflare;
3. point new-install documentation back to the known-good origin;
4. preserve the failing build ID, exact hostname, time, and Cloudflare request ID before retrying.

The domain is presentation and routing, not the trust boundary. Relay payloads remain
end-to-end encrypted on either hostname; Cloudflare can still observe traffic timing, size, IP
metadata, and connection activity.
