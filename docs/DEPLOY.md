# Deploying the relay

The relay is the one LongLeash piece that runs on the internet. It routes end-to-end
encrypted frames between your phone and your laptop and serves the public app shell — it
holds **no keys, no tokens, no transcripts, no database**. If someone seized the server,
they would learn that ciphertext moved. The daemon, with all the real access, stays on your
laptop and only ever dials **out** — no port forwarding, no router changes, nothing exposed
at home.

Three ways to run it, cheapest first. Cloudflare Workers is the maintained deployment path for
this repository. Always check the current provider pricing before promising a permanent cost.

---

## Option A — Cloudflare Workers ← recommended

The relay is a few WebSockets and does not write application data. Cloudflare currently documents
100,000 Workers requests per day on the Free plan, and a WebSocket upgrade counts as one request.
Each room uses a hibernatable Durable Object so idle sockets do not consume active duration. Plan
limits and Durable Object pricing can change; verify the current
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) before launch.
The Worker also serves the app itself over HTTPS.

### 1. Sign up (2 minutes)

<https://dash.cloudflare.com/sign-up> — email and password. No card, no plan to choose.

### 2. Deploy (3 minutes)

```sh
cd ~/LongLeash
pnpm --filter @longleash/app build          # the app shell the relay will serve
pnpm --filter @longleash/relay deploy:worker
```

The first run opens a browser to authorise wrangler. When it finishes it prints your URL:

```
https://longleash-relay.<your-subdomain>.workers.dev
```

Check it:

```sh
curl https://longleash-relay.<your-subdomain>.workers.dev/health   # → {"ok":true,"role":"relay"}
```

### 3. Point your laptop at it

```sh
cd ~/LongLeash/packages/daemon
LONGLEASH_RELAY_URL=wss://longleash-relay.<your-subdomain>.workers.dev pnpm start ~
```

Scan the QR it prints, add the page to your home screen, and it works from any network.

### Updating later

```sh
pnpm --filter @longleash/app build && pnpm --filter @longleash/relay deploy:worker
```

### Notes

- **Staying inside the free plan.** A request is a WebSocket *connection*, not a message —
  your phone and laptop reconnecting a few dozen times a day is nowhere near 100,000.
  Hibernation means idle rooms are not billed for time.
- **Custom domain for a public product:** use separate public and app hostnames and keep
  `workers.dev` as a compatibility path during migration. Follow
  [Public launch and branded domains](PUBLIC-LAUNCH.md). Cloudflare recommends a Custom Domain when
  the Worker is the origin and provisions its DNS record and certificate automatically.
- **Privacy is unchanged.** Cloudflare routes the same sealed frames as any other relay and
  can read none of them. See the table at the end of this page.

---

## Option B — Any VPS with Docker (free on some tiers, or a few dollars)

Use this if you would rather own the machine. The same relay, as a container behind Caddy.

Suitable free-forever hosts, if you can get one:

| Host | Catch |
| --- | --- |
| Oracle Cloud Always Free | 4 ARM cores free forever, but ARM capacity is frequently exhausted — you may get "Out of capacity" in every availability domain for days. The AMD `VM.Standard.E2.1.Micro` shape is a separate pool and usually available. Card required. |
| Google Cloud Always Free | One `e2-micro`, but **only** in `us-west1`, `us-central1`, or `us-east1`, with 1 GB egress a month. Card required. |

### Setup

You need a hostname pointing at the server. With no domain, use `sslip.io`: if your IP is
`140.238.1.2`, your hostname is `140-238-1-2.sslip.io` and already resolves.

**Open ports 80 and 443 in your host's cloud firewall first.** On Oracle that is the subnet's
Security List; the script handles the separate Ubuntu firewall.

```sh
ssh ubuntu@<your-public-ip>
curl -fsSL https://raw.githubusercontent.com/Sahith59/LongLe-sh/main/scripts/relay-setup.sh \
  | bash -s -- <your-hostname>
```

It installs Docker, opens the OS firewall, builds the relay, and starts it behind Caddy with
an automatic Let's Encrypt certificate. It only reports success once the relay actually
answers over HTTPS from the public internet, then prints your laptop's command.

Update later with:

```sh
cd ~/longleash && git pull && cd deploy && docker compose up -d --build
```

### If something does not work

| Symptom | Cause and fix |
| --- | --- |
| `curl` to the hostname hangs | Ports not open in the **cloud** firewall (the script only handles the OS one). |
| Certificate never issues | Port **80** must be reachable — Let's Encrypt uses it to verify. Test `curl -I http://<hostname>`. |
| "Out of capacity" on Oracle | ARM is heavily contended. Try the AMD `E2.1.Micro` shape, or use Option A. |
| Phone shows `reconnecting` | Is the daemon running with `LONGLEASH_RELAY_URL` set? Its terminal should say `relay: holding N room(s)`. |
| Logs | `cd ~/longleash/deploy && docker compose logs -f` |

---

## Option C — Fly.io (~$2–3/month)

Worth it when you want a managed VM and do not mind a small bill.

```sh
brew install flyctl && fly auth signup
cd ~/LongLeash && fly launch --no-deploy --copy-config && fly deploy
curl https://<your-app>.fly.dev/health
```

Then `LONGLEASH_RELAY_URL=wss://<your-app>.fly.dev pnpm start ~`.

---

## `linked · direct` vs `linked · relay`

The pill in the app's top bar tells you which **road** your messages take — never where you
are standing.

| Pill              | Meaning                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `linked · direct` | Phone and laptop are talking straight across your own network. No middleman. |
| `linked · relay`  | Messages travel through the relay, sealed end-to-end. Works from anywhere. |

Which one you get depends on **where you opened the app from**:

- Opened from your laptop's own address (`http://192.168.1.71:4321`) while at home →
  **direct**, with automatic failover to the relay if you leave.
- Opened from the relay's address (the deployed `https://…` one) → **relay**, always —
  even sitting next to the laptop.

That second case is a browser rule, not a choice we made: a page served over HTTPS is
forbidden from opening an insecure `ws://` connection to a device on your local network
(mixed content). Since your laptop has no public certificate for its private IP, the
HTTPS app cannot reach it directly, so it uses the relay. The upside is that the relay
address is the one that *always* works — any network, any country, installable as an app.
If you want the direct path at home, open the laptop's own address while you are there.

## What the relay can and cannot see

| The relay sees                    | The relay can never see                    |
| --------------------------------- | ------------------------------------------ |
| that a room with an opaque tag exists | whose room it is (the tag is a one-way hash) |
| ciphertext frames moving          | any message content, path, or approval     |
| joins and leaves, with roles      | device tokens, relay keys, or a new pairing fragment secret |

Every frame is sealed with AES-256-GCM using keys derived from a secret only your two
devices hold. A tampered frame fails authentication and is dropped — this is covered by
adversarial tests, not just asserted. Revoking a device closes its room immediately.

New pairing links place their temporary secret after `#`. Browsers do not transmit URL fragments
in HTTP requests, so the relay origin does not receive it while serving the PWA. Cloudflare still
sees ordinary transport metadata such as source IP, timing, request paths, and frame sizes.

Honest limits, so trust is earned rather than asked for: the laptop itself must be yours and
secure (the daemon holds real access, by design); the relay operator can observe traffic
timing and volume, as any carrier can; and "unbreakable" is not a word cryptography honestly
offers — what we offer is standard, boring, testable crypto with nothing exotic to get wrong.
