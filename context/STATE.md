# STATE — living project context

Update this file at the end of any session that changes project state. Newest entries first in the log.

## Where we are

- **Phase (updated 2026-08-04): A, B, C DONE; D1 DONE.** Live deployment: `https://longleash-relay.tsahith59.workers.dev` (Cloudflare Worker + Durable Objects, free tier). Design system "Matte Graphite" (machined keys / engraved stamps / recessed wells; Instrument Sans/Serif + Geist Mono; robot-dog logo chosen by Sahith, wired everywhere). ~380 tests green workspace-wide.
  - **B DONE:** own E2E relay (ciphertext-only rooms, HKDF room tags, AES-GCM frames via noble), LAN-first with relay failover + come-home probe, 30s keepalives both sides, paste-to-pair + in-app QR scanner (jsQR — iOS camera app pairs the wrong browser), landing page at `/welcome`, daemon remembers relay URL in `~/.longleash/config.json` (`off` forgets).
  - **C DONE:** Web Push end to end — VAPID keys minted per daemon (`vapid.json` 0600), per-device subscriptions (`push.db`), fired on `approval.requested`, payload is IDs ONLY (test pins exact key set), pruned on 404/410, silenced on revocation; app has a self-diagnosing Alerts panel (every failure state names itself) + "Send a test alert" (4s delayed so you can lock the phone). Verified on Sahith's iPhone.
  - **D1 DONE:** terminal `claude` sessions visible + gated from the phone via Claude Code hooks (SessionStart/PreToolUse/SessionEnd → secret-authed `POST /hook`; secret in `~/.longleash/hook-endpoint.json` 0600, phone can never read it). Transcript tailed from Claude Code's own JSONL (structured file — the no-TUI-scraping invariant holds). PreToolUse waits up to 120s for the phone, else answers "ask" = terminal behaves as if LongLeash weren't installed; read-only tools never leave the machine. Phone UI: terminal sessions read-only (approvals yes, composer/stop hidden — honest about what it can't do). Install: `node packages/daemon/hooks/install-hooks.mjs` (backs up `~/.claude/settings.json`, idempotent, `--remove` to undo). SDK sessions unaffected (isolateFromUserSettings). **Handoff/Take-over (2026-08-04):** typing into a terminal session on the phone TAKES IT OVER — daemon stops the verified process, adopts the conversation (sessions row with agent_session_id), and wakes it via SDK resume with the reply; ended terminal sessions become reopenable the same way; the reverse trip is `claude --continue` in the folder (hooks re-adopt it). Triple-gated: unit (253), wire (takeOver over WS: kill→adopt→ack→resume id into agent), real-SDK smoke (CLI session codeword recalled after resume). Hook also mirrors permission_mode AND the user's own allow rules (best-effort, safe direction) so the phone only asks what the terminal would ask.
  - **Decided:** NO accounts/OAuth/user DB (pairing is the identity). Cost: $0 (Workers free tier; no push service fees).
  - **Next:** installer/onboarding (one-command install — biggest gap to strangers), then public-release prep (README/license), Phase D2+ (resume terminal sessions via SDK?), E (multi-agent via ACP).
- **Phase (historical):** PLAN v2 (standalone product) adopted 2026-07-29 — see PLAN.md. Machine readiness half done. Coding not started; Phase A gated on spike S0.
- **Done:** tmux 3.7b + mosh 1.4.0 installed (tmux is now an internal component; mosh harmless extra); `~/.tmux.conf` written (history-limit 50000, window-size largest, mouse on); caffeinate LaunchAgent installed + verified (machine previously slept after 1 minute); launchd plists in `scripts/launchd/` + `~/Library/LaunchAgents/`.
- **Dropped from checklist (v2 pivot):** Tailscale install (stuck standalone app can just be trashed — no longer needed), Termius, Happy, Blink. Claude `/remote-control` stays available as Sahith's personal stopgap until Phase C.
- **Next actions:** (1) slice A7 — the React+Vite PWA (Pair, Sessions, Inbox, session detail, New Task, Devices) served by the daemon, with a reachability check separate from pairing and VPN detection; (2) Sahith's kickoff list below. **No API key or paid API account is needed anywhere** — agents run on the user's Claude subscription (S0 + A6 confirmed). S0 PASSED; **A1 DONE** (protocol, 14 tests); **A2 DONE** (event log, 18 tests + eyes-on demo `pnpm demo`); **A3 DONE** (pairing + device auth, 19 tests: QR one-time challenge w/ TTL + sweep, tokens hashed + timing-safe, no-plaintext-in-DB proven, revocation w/ crash-safe listeners, restart durability — VERIFIED ON DEVICE, see below); **A4 DONE** (WS server, 19 tests: token auth on upgrade, live revocation drops sockets mid-connection, subscribe→replay→live tail, per-session isolation, gap signals, hostile input survivable, reconnect storms, backpressure watermark with resync-gap instead of unbounded buffering, heartbeat reaping half-open sockets — VERIFIED ON DEVICE); **A5 DONE** (session manager + agent adapter contract + approval store, 22 tests: allowlisted-root enforcement incl. traversal/prefix/symlink attacks, pinned cwd, streaming→events, crash→session.errored keeping partial output, approvals block the agent until decided, deny carries steering reply, duplicate decisions idempotent, expiry auto-denies so agents never hang, auto-approved tools land in the activity feed per spike S0, single-writer claim, orphan cleanup after daemon crash); **A7 DONE** (React+Vite PWA served by the daemon; hello/roots picker, visible errors, origin labels, stop, reachability + VPN diagnostics; daemon binary `pnpm start <dir>`; /health, POST-only pairing, permission-posture warning; 28 app+http tests); **A6 DONE** (real Claude adapter + 6 contract tests passing against the live SDK — see `agents/2026-08-01-slice-a6-contract.md`). 97 unit/integration tests green workspace-wide, plus 6 contract tests run on demand. `docs/ARCHITECTURE.md` added. Repo live: https://github.com/Sahith59/LongLe-sh (public).

## Sahith's kickoff list (v3 — after the PWA pivot)

**Hard blockers: none.** The web-app decision removed every paid account and signup from the plan. Only item that matters for the build: have the iPhone handy at A7/A8.

Optional reliability config for his own always-on machine (advice, not product requirements — `docs/REQUIREMENTS.md` explains the tiers):
1. `sudo pmset -c sleep 0 && sudo pmset -a autorestart 1` (Mac stays awake on power; recovers after a power cut).
2. System Settings → General → Software Update → ⓘ → turn OFF "Install macOS updates".
3. Laptop-down alert: healthchecks.io free check `longleash-deadman` (5 min period, 10 min grace) → paste ping URL. Interim only; the daemon's own heartbeat replaces it.
4. FileVault: **recommended ON**, Sahith's call, no product impact either way.

## Superseded (do NOT do these)

- ~~Expo account, EAS builds~~ — PWA pivot 2026-08-01.
- ~~Apple Developer Program $99/yr~~ — not needed for any phase; only if native wrappers are ever added.
- ~~Tailscale / Termius / Happy installs~~ — dropped at the standalone-product pivot.

## Old kickoff list (v2, historical)

1. Power config (still pending): `sudo pmset -c sleep 0 && sudo pmset -a autorestart 1`. Lid stays open when away.
2. System Settings → General → Software Update → ⓘ → turn OFF "Install macOS updates".
3. FileVault decision: recommend ON (Privacy & Security → FileVault; recovery key NOT stored on this laptop). Say the decision explicitly so it's recorded.
4. healthchecks.io free account → check `longleash-deadman` (period 5 min, grace 10 min) → paste ping URL to Claude. (Interim; Phase A daemon absorbs this.)
5. Apple Developer Program ($99/yr) — needed by Phase C for push/TestFlight; enrollment can take days, so start it when Phase A is underway.
6. Free Expo account (expo.dev) — needed when the phone app scaffold lands (Phase A).
7. GitHub repo for the monorepo (or Claude runs `git init` locally now and wires the remote later).
8. Trash /Applications/Tailscale.app whenever — it's dead weight now.

## Open questions

- **FileVault decision pending** (status audited 2026-07-29; current state deliberately kept off-repo). Recommendation: ON (System Settings → Privacy & Security → FileVault; recovery key stored somewhere safe, NOT on this laptop). Trade-off if ON: unattended reboot = down until home (dead-man alert detects it). Whatever Sahith decides gets recorded here as "decided", without publishing device security posture.
- Blink vs free Termius — decide after a week of Phase 1 use.
- VibeTunnel: deliberately skipped unless Blink/mosh UX grates after a week.
- Phase 5 (Happy fork for single-app terminals): deferred until two-app UX demonstrably fails in real use.

## Spike checklist (verify BEFORE building on these)

| # | Spike | Status | Outcome |
|---|-------|--------|---------|
| S0 | Agent SDK under subscription OAuth (gates Phase A) | **PASS** 2026-07-29 | Auth/streaming/canUseTool all work. 3 binding findings: PreToolUse hook needed for activity feed; cwd must be pinned AND tested; assert on side effects, never agent text. `agents/2026-07-29-spike-s0.md` |
| S1 | Push payload audit — approval push must carry IDs only, no prompt text on lock screen | not run | — |
| S2 | Credential audit — nothing in `~/.happy` / outbound traffic leaks OAuth or API keys | not run | — |
| S3 | Killed-state notification actions work on the real iPhone | not run | — |
| S4 | Self-hosted happy-server can deliver push through the store apps (gates Phase 3) | not run | — |
| S5 | Gemini CLI via `--experimental-acp` works under Happy (listed deprecated upstream) | not run | — |

## Open questions

- Blink vs free Termius — decide after a week of Phase 1 use.
- VibeTunnel: deliberately skipped unless Blink/mosh UX grates after a week.
- Phase 5 (Happy fork for single-app terminals): deferred until two-app UX demonstrably fails in real use.

## Public-product shape (decided 2026-07-29, refines the goal change)

Bar for public v1: **one command on the laptop, one app on the phone, working in <5 min.**
- `npx longleash init` style CLI installs/configures ALL laptop-side deps silently (tmux, happy-cli, launchd agents, invariants) — users never see them.
- The Happy phone app is the single required phone install (QR pairing).
- Tailscale = optional "advanced mode" only (raw SSH lane, self-hosted relay) — Sahith's own onboarding friction with it proved it can't be required. Termius/healthchecks.io also optional.
- Public v2 (only if v1 traction demands it): fork Happy (MIT) into a branded LongLeash app, adding the terminal session type from `agents/2026-07-29-phase5-blueprint.md`. Never rebuild E2E/relay/push from scratch.

## Verified on real hardware

- **A3 pairing + auth — VERIFIED BY SAHITH 2026-07-31**, iPhone → MacBook over Wi-Fi (phone 192.168.1.207 → laptop 192.168.1.71), running the real `DeviceRegistry`: QR scan paired a real device, token auth succeeded repeatedly with lastSeen updates, and pressing `r` revoked it — revocation listener fired and the phone's token was rejected on the next request. Single-use-challenge replay rejection was not eyeballed in that run but is covered by automated tests and was verified via simulated requests.

## Design round 3 (2026-08-02) — "the UI is AI slop" + three real bugs in one screenshot

Sahith's screenshot carried three genuine bugs dressed as bad design:
1. **Store merged user messages** — two "— reopened —" markers became one giant blue bubble.
   User messages are discrete; only text/thinking merge now. Test added.
2. **Bold-wrapping-code leaked backticks** — `**\`/path\`**` rendered literal backticks in
   bold. Inline parser now nests: strong carries children. Tests added (incl. the exact
   screenshot string).
3. **Paths could not be expanded** — PathChip is now tappable where legal (detail header,
   action rows; NOT inside session-card buttons — nested buttons are invalid), unfolds in
   place with aria-expanded, hit area grown to 44pt via padding+negative-margin. Verified by
   driving the tap in Playwright.

Skin: **Bricolage Grotesque** (deliberately characterful, not the startup sans) + Spline Sans
Mono. Animated **aurora field** in cobalt/teal/amber — transform-only drift on an oversized
fixed layer (compositor-only), static SVG-turbulence grain, translucent neumorphic cards (no
blur — plain compositing), amber attention pulse on approvals. Accounts/OAuth question
answered: NO — pairing is already cryptographic identity; a user DB would be the honeypot the
architecture exists to avoid; the real gap is onboarding (installer), revisit only for a
hosted relay/teams/billing.

Measured: 0 frames >20ms on all screens with aurora running; 2 blurred surfaces (rail+dock,
7-8% viewport) outside sheets; audit caught ink at 4.49:1 on the new field → darkened.
327 tests green. Worker redeployed with the new shell.

## Oracle ARM had no capacity anywhere → the relay now runs free on Cloudflare (2026-08-02)

Sahith hit "Out of capacity for VM.Standard.A1.Flex" in every availability domain and has no
budget. Rather than hunt for another VM, verified current facts with web search and found a
strictly better answer: **Cloudflare Workers + Durable Objects are on the FREE plan** —
100k requests/day, 13k GB-s/day, SQLite-backed DO classes, **no credit card**, and WebSocket
Hibernation is GA so idle rooms accrue no duration. For an open-source product whose users
also have no money, that is the right default: no VM, no capacity lottery, no card.

**Built:** `packages/relay/worker/index.ts` — each pairing is one Durable Object addressed by
`idFromName(roomTag)`; roles live in `serializeAttachment` (survives hibernation) rather than
accept-time tags, so role stays out of the URL. Static assets binding serves the app shell
(free, never reaches the Worker) with SPA fallback. `wrangler.jsonc` with
`new_sqlite_classes` (the free-plan requirement).

**One protocol, two runtimes:** extracted `packages/relay/src/protocol.ts` (close codes, zod
schemas, size caps, `parseClientMessage`) and refactored the Node server onto it — 31 relay
tests green through the refactor. The two implementations cannot drift.

**Room tag now rides the URL** (`/ws?room=…`) as well as the join message: a Durable Object
must be chosen before the upgrade completes. The Node relay ignores the query string, so one
client speaks to both. Applied in the app client, RelayLink, and the pairing host.

**Verified on the real runtime, not mocked:** `wrangler dev --local` (workerd) driven by a
harness asserting the same 18 behaviours the Node suite asserts — join/presence, byte-exact
routing, room isolation, second-host refusal, garbage/early-frame/oversize close codes, short
tag never creating an object, ping, departure. Found and fixed a real bug: the `joined` reply
excluded the joiner, so a lone host was told no host was present. A second "failure" was my
harness matching a stale queued peer event, not the Worker — tightened the check rather than
the code.

**Then the whole product against it:** the one-flow rehearsal now drives either relay
(`EXTERNAL_RELAY_PORT`). Green on BOTH — Cloudflare Worker (sealed pairing → `linked · relay`
→ folder search → reload) and the Node relay on the LAN IP under an insecure context.

`docs/DEPLOY.md` restructured: Cloudflare first (recommended, ~5 min), VPS/Docker second with
an honest table of the Oracle ARM capacity problem and GCP's region limits, Fly third.

324 tests + 8 real-Claude contract tests. Sahith's path is now: sign up, two commands, done.

## B4 engineering complete — Oracle Always Free chosen (2026-08-02)

Sahith chose Oracle Cloud Always Free (permanent, $0) over Fly, moving to paid only once real
users appear. Fly config kept for that day.

**Shipped:** `deploy/docker-compose.yml` (relay + Caddy; relay NOT published to the host, so
the only way in is TLS; healthcheck; named volume for certs) + `deploy/Caddyfile` (automatic
Let's Encrypt, HSTS, WebSocket passthrough) + `scripts/relay-setup.sh` — one idempotent
command from bare Ubuntu to a working HTTPS relay, which is also the update path.

**Verified, not assumed:**
- Image builds for BOTH architectures: arm64 (Oracle's free Ampere — already run locally) and
  linux/amd64 cross-build (their E2.1.Micro fallback when ARM is out of capacity).
- The real compose stack was brought up locally: relay reports healthy, Caddy proxies to it,
  `/health` answers `role:relay` through the proxy. Torn down after.
- `docker compose config` fails loudly with a readable message when the domain is unset.

**Three bugs found while writing the script, before Sahith could hit them:**
1. `LONGLEASH_DOMAIN=x sudo docker compose` — sudo strips the environment, so compose would
   have seen no domain. Now written to `deploy/.env` (gitignored), which also makes updates
   a single command.
2. `command -v git || apt update && apt install git` parses as `(A||B) && C` — reinstalled
   git every run. Fixed to an if-block.
3. `iptables -I INPUT 6` fails with "index too big" on a shorter chain than Oracle's stock
   one; now falls back to position 1.

The script also refuses to proceed when DNS does not point at the machine (the certificate
would fail anyway), and ends by polling the public HTTPS endpoint — it does not claim success
until the relay actually answers from the internet.

`docs/DEPLOY.md` rewritten as a step-by-step Oracle walkthrough (console clicks included),
honest about the card requirement, the ARM capacity lottery, and Oracle's TWO firewalls —
the cloud Security List AND the Ubuntu iptables rules, which is the classic trap.

**Blocked on Sahith:** the repo must be pushed before the VM can clone it (52 files of
Phase B are uncommitted; last commit is 81c7efc). Not committing without his word.

## Field round 8 (2026-08-02) — Reopen was re-executing your instruction

Sahith's screenshots showed a session with "BETA / REOPENED / BETA / REOPENED" then an SDK
error, and `linked · away` while he sat on his home Wi-Fi. Two real bugs, one dangerous.

**1. Reopen re-ran the original prompt (SAFETY).** `resumeSession` re-spawned the agent with
`row.title` — the opening instruction, truncated to 80 chars. On "Say BETA" it merely looked
odd; on "delete the old migrations" it would have re-executed a destructive instruction the
person never asked for twice. The SDK error (`[ede_diagnostic] result_type=user`, thrown by
the Agent SDK, not us) was the downstream symptom of hammering resume with a synthetic prompt.
**Fix:** reopening now makes a conversation READY, never re-runs it — no agent spawned, no
prompt replayed; the agent wakes on the human's next message with their actual words (the
`wake()` path from round 7). Refuses honestly when there is no resume point. Verified against
**real Claude** in a new contract test that reproduces the exact field sequence (stop →
reopen → reopen → type → agent remembers "BETA"), plus stop→reopen→continue.

**2. Two races the contract test exposed** (invisible to fake-agent unit tests):
- A finished run lingered in the live-session map and **shadowed the stored row**, so a
  reopened conversation still reported the dead agent's status. Dead runs now leave the map.
- A late-draining run **stomped a newer status**: stop → reopen left it 'ended' because the
  old consume loop wrote its terminal status afterwards. Runs are now marked `superseded`
  when a reopen/wake takes over, and a superseded run stays silent.
- `SessionManager.shutdown()` added (interrupt + await every agent) and awaited in
  `daemon.stop()` — previously shutdown closed SQLite while consume loops were still writing
  ("database connection is not open" unhandled rejection).

**3. `away` was a lie.** The pill described the person's location; it describes the ROUTE.
Now `linked · direct` / `linked · relay`, with the honest reason documented: an HTTPS page
may not open `ws://` to a private IP (mixed content), so the relay-served app always uses the
relay — even at home. The daemon-origin app still prefers direct with relay failover. Trade
documented in `docs/DEPLOY.md` with a table.

**4. Composer follows capability, not status.** `SessionListing.resumable` (derived from
`agent_session_id`, split out of `SessionSummary` so it stays derived data) flows through
hello → store → UI: anything continuable offers a place to type ("Type to carry this on…");
anything genuinely dead says so instead of showing a button that refuses.

CI now builds the Docker image and asserts the container answers `/health` with `role:relay`
and serves the shell — the deploy path is product surface and was breaking silently twice.

**5. The contract suite had been silently stale.** Running it (excluded from CI, so nobody
had) showed all 6 A6 tests hanging to their 180s timeout — not a new regression: they call
`waitForIdle`, which waits for the agent's stream to CLOSE, and that stopped happening when
the product moved from one-shot runs to conversations. One also asserted auto-approval while
the harness pre-approved nothing, so it could never have passed. Rewritten against today's
contract: a new `untilTurnEnds` helper (status reaches waiting/ended/errored), the
auto-approval test gets its own harness using the production read-only defaults, teardown
awaits `shutdown()`. **8/8 contract tests now green against real Claude in ~39s** (was 18
minutes of hanging). `waitForIdle` kept for unit tests, with a comment on what it means.

324 tests (28 protocol + 31 relay + 56 app + 209 daemon) + 8 contract green against real
Claude. One-flow rehearsal re-verified on the LAN IP under an insecure context. Docker image
rebuilt and verified.

**B4 hand-off to Sahith:** local re-check, then `fly launch`/`fly deploy` (or the $0 VPS
path), then `LONGLEASH_RELAY_URL=wss://…` and the cellular field test.

## Field bug: WebCrypto is HTTPS-only in browsers (2026-08-02) — envelope moved to noble

Sahith's first scan of the one-QR flow died with "undefined is not an object (evaluating
'crypto.subtle.importKey')". Root cause: browsers expose `crypto.subtle` ONLY on secure
contexts; `http://192.168.1.71:8080` is not one. Every rehearsal had run on 127.0.0.1 —
which browsers exempt — so the landmine was invisible until a real phone hit a real LAN IP.

Fix: `@longleash/protocol/envelope` now uses **@noble/ciphers + @noble/hashes** (audited,
pure-JS, zero-dep) for the SAME algorithms — AES-256-GCM, HKDF-SHA256, unchanged wire format.
Runs identically on secure and insecure pages; `crypto.getRandomValues` (not gated) remains
the nonce source. `RelayIdentity.frameKey` is now raw bytes, API otherwise unchanged; all
call sites compile untouched. Regression test deletes `crypto.subtle` and proves seal/open
still work. The one-flow rehearsal now binds the relay on the machine's LAN IP and ASSERTS
`isSecureContext === false` before proceeding — the phone's reality is the rehearsed reality
from now on. Full flow green under it. 321 tests (28 protocol + 31 relay + 56 app + 206
daemon); bundle +6KB gzip.

Explained to Sahith: two terminals exist only in the local try-out (laptop plays both roles);
deployed shape is cloud relay + one `pnpm start ~`. `linked` = direct over home Wi-Fi;
`linked · away` = through the relay, sealed — same abilities, different road.

## One-flow rework + B4 artifacts (2026-08-02) — Sahith's manual test failed, so the dance died

Sahith ran the port-switch choreography and got stuck on "reconnecting": for failover to
work, the phone had to have re-paired against a daemon already running with the relay env —
order-sensitive, fragile, my fault. Instead of a more careful script, the whole flow was
replaced:

**The one QR.** With `LONGLEASH_RELAY_URL` set, the daemon's QR now points at the **relay's
app origin**. The relay serves the built app shell (`staticDir`, SPA fallback, path-climb
guarded, `/health` now declares `role:'relay'`). Pairing completes **through the relay**:
both sides derive a short-lived room+key from the QR challenge secret via
`derivePairingIdentity` (HKDF info strings domain-separated from device rooms — protocol
tests prove the two identities can never address or decrypt each other), the phone sends
`completePairing` sealed, the daemon (`pairing-host.ts`) answers `paired {token, relaySecret}`
sealed, room dies on success/TTL. Registry checks (hash, TTL, one-time burn) unchanged.
`n + Enter` in the bin mints a fresh QR without restarting (fixes the revoke-then-no-QR
annoyance too). LAN pairing URL still printed as a fallback line.

**Client origin-awareness.** `detectOrigin()` via /health (`role:'relay'` vs
`name:'longleash'`): on a relay origin there is no LAN road — lanWire and the home-probe are
disabled (probing /health there would hit the relay itself and lie "home"), the endpoint is
the page's own origin, and `pair()` routes to `pairViaRelay()`.

**Rehearsed green end-to-end** (`one-flow-smoke.mjs`, real processes): relay serves shell →
daemon hosts pairing room → browser opens relay-origin QR → sealed pairing → `linked · away`
→ folder search round-trip → **reload works at the relay origin** (impossible in the old LAN
test). Plus 4 new pairing-host tests (sealed success, sealed refusal, wrong-key silence,
no-double-issue + room death) and 2 protocol domain-separation tests.

**Deploy artifacts, container-verified:** root `Dockerfile` (multi-stage; daemon deps never
installed; `packageManager` pinned pnpm@10.33.2 — unpinned corepack pulled pnpm 11 in-image
and broke the build-script allow-list; `onlyBuiltDependencies` += esbuild), `.dockerignore`,
`fly.toml` (auto_stop off — rooms are standing links), `docs/DEPLOY.md` (Fly ~$2-3/mo
honest-costed + $0 VPS/Oracle path with Caddy TLS; can/cannot-see table; honest limits).
Image built and run locally: /health role, shell, sw.js all serve. tsx moved to relay
runtime deps (image runs TS directly — noted tradeoff).

**320 tests** (27 protocol + 31 relay + 56 app + 206 daemon). Sahith's local check is now
one flow (relay + daemon + scan). Remaining in B4: he deploys (Fly or VPS), then the
cellular field test.

## B3 hands-on rehearsal (2026-08-02) — found the come-home bug before Sahith did

Before handing Sahith the end-to-end script, rehearsed his exact test in Playwright with real
processes (relay + daemon + built app, one tab, no reloads): pair on LAN → daemon leaves that
address (restart on another port, same storage/relay) → page crosses to the relay by itself
(`linked · away`) → folder search through ciphertext → daemon returns home.

**Bug found at the last step:** once on the relay, the app NEVER returned to the LAN — a
healthy relay link never breaks, and nothing retried the direct path. "LAN-first" was only
true at connect time. Fix: while away, probe `/health` on the home origin every 15s (3s
abort; the SW never caches /health, so the probe cannot be lied to) and swap to the LAN the
moment it answers. Rehearsal now green end to end: away in ~5s, home again within ~20s.

**Secure-context finding (sets B4 scope):** on iOS, service workers require HTTPS — a plain
`http://LAN-IP` origin never registers one, so the installed-PWA-away story cannot rest on
the daemon origin's cache. B4 therefore: the relay also serves the app shell over the deploy
platform's TLS (CLAUDE.md anticipated "served by the daemon or relay"), which later wants
pairing-through-the-relay (sealed with a key derived from the QR challenge secret). For
Sahith's B3 hands-on test today: keep the tab open while away; reloading while away starts
working at B4.

Note for his run: his existing device row predates relay secrets → one-time re-pair
(r + Enter, q, restart, rescan). 313 tests green.

## Phase B3 done (2026-08-02) — the whole product works away from home

Sahith asked how to hand-check B2 → built `pnpm --filter @longleash/daemon demo:relay`: the
same message shown from three perspectives (phone plaintext / relay ciphertext / daemon
plaintext), plus a tamper-and-drop. Then B3, both legs:

**Daemon leg:**
- `LongLeashServer` refactored onto a `ConnectionTransport` seam (send/bufferedAmount/close/
  terminate/ping/isOpen) — LAN sockets and relay rooms are now the same thing to every rule
  above it: subscriptions, replay, backpressure watermarks, revocation. All 195 prior tests
  green through the refactor untouched.
- `attachRelay(deviceId, {url, secret})`: a standing virtual connection per device room.
  AES-GCM auth on each frame IS the device identity (stronger than the LAN token check).
  Hello re-offered whenever the room becomes whole (link reconnect, guest join) — idempotent
  client-side. Heartbeat skips relay connections (their link owns liveness — the daemon's own
  32s-reconnect-loop lesson would have recurred here as double-counting).
- `RelayBridge` keeps rooms in lockstep with the registry: opened at startup + live on
  `onPaired` (new DeviceRegistry hook), closed on revocation. `normalizeRelayUrl` accepts an
  https origin. `startDaemon({relayUrl})` + `LONGLEASH_RELAY_URL` env in the bin.
- `relay-bridge.test.ts` (7): **the full Phase A loop as ciphertext** — hello, startSession,
  approval.requested, allow, agent streams "wrote it" — plus tamper-drop-continue, revocation
  closes the room (phone sees host leave), pair-while-running gets a room instantly.

**App leg:**
- `client.ts` rebuilt on a Wire abstraction: `lanWire` (4s open-timeout — a WS to an
  unreachable IP hangs longer than a person waits) and `relayWire` (join as guest, seal/open
  every frame, wait up to 8s for the host, host-left → cycle). **LAN first on every cycle**;
  relay is the fallback road. Same protocol handling above the seam.
- Relay URL learned from `hello.relay.url` + stored; secret captured at pairing (B2) — so a
  device paired today needs nothing extra when the relay goes live.
- Rail shows `linked · away` via the relay (aria label says so too).
- Minimal service worker (`public/sw.js`, network-first, cache fallback, **never caches
  /health or /pair** — a cached /health would fake reachability): the installed PWA boots
  with the daemon unreachable, which is the precondition for using the relay at all.

**Verified live, not just in unit tests** (Playwright, real processes):
- LAN smoke: real daemon + built app — QR pair → linked, relay secret in localStorage, token
  reconnect. The client rewrite did not disturb the working LAN path.
- Relay smoke: app served from a dead origin (= installed PWA away from home) + real relay
  process + real daemon → **failed over, `linked · away`, folder search answered through
  ciphertext**. Screenshot in scratchpad; `demo/smoke-server.ts` is the reusable harness.

313 tests (25 protocol + 30 relay + 56 app + 202 daemon). **B4 remains:** Dockerfile +
fly.toml/compose, deploy needs Sahith's hands (free Fly.io account or any VPS), then the
cellular field test — phone on mobile data, Wi-Fi off, approving real work from anywhere.

## Phase B2 done (2026-08-01) — the E2E envelope and the daemon's relay leg

Sahith confirmed the type pass; B1 has no hands-on surface (told him so — his moment is B4).

**Envelope (`@longleash/protocol/envelope`, 11 tests):** one 32-byte pairing secret per device
→ HKDF-SHA256 derives the relay `roomTag` (one-way; relay learns nothing) and an AES-256-GCM
`frameKey`. Pure WebCrypto — identical code in Node and browser, zero dependencies. `open()`
returns null on ANY failure and never throws: tamper, wrong key, truncation, garbage, foreign
version byte — all covered by tests. Protocol tsconfig gained `lib: [ES2022, DOM]` (type-only).

**Pairing (`auth.ts`, +5 tests):** `completePairing` mints `relaySecret`, stores it (plaintext
by necessity — unlike the token it must be re-derivable-from every restart; it lives on the
user's own laptop), returns it in the LAN-only `/pair` response — the one moment the devices
share a channel the relay is not part of. `listRelayDevices()` = non-revoked with secrets:
one room per device, so revocation simply stops joining that room. `relay_secret` column via
`ensureColumns`; migration test builds the real pre-relay schema on a file and upgrades it.
App `pair()` stores the secret in localStorage TODAY so current pairings work remotely at B3
without re-pairing; `forgetToken()` clears it.

**RelayLink (`daemon/src/relay-link.ts`, 7 tests, run against the REAL RelayServer):** joins
as host, seals outbound, opens inbound; failed-open frames dropped (hostile relay assumed —
verified with a malicious impostor relay speaking garbage: nothing surfaced, no crash);
reconnects with backoff through a relay restart; `stop()` leaves no zombie; outbound while
disconnected is dropped because cursor replay heals gaps end-to-end (no second buffering
layer). Malformed secret → permanent stop, not an infinite retry loop.

283 → **306 tests** (25 protocol + 30 relay + 56 app + 195 daemon). Not yet wired into
`startDaemon`/LongLeashServer — that bridge is B3's core, together with the app's relay
client and LAN-first fallback. B4 = Dockerfile + deploy + Sahith's cellular-data field test.

## Phase B started (2026-08-01) — B1: the relay, a zero-knowledge pipe

Sahith approved the type/polish pass and called Phase B. `packages/relay` exists and is green.

**Typography (same session):** Archivo replaced. Agent prose now sets in **Source Serif 4**,
UI chrome in **Hanken Grotesk**, code stays JetBrains Mono — the open equivalents of Claude's
own Tiempos/Styrene pairing (those are commercial and cannot ship in an open-source repo).
Self-hosted like before. Stop is now a filled red key (`.key.stopkey`, measured ≥4.5:1) —
the brake reads as a brake. Leash glyph sits in the rail wordmark. Audit re-run clean: 24
screen×width combos, reduced-motion, landscape. App tests/build green.

**B1 — `packages/relay` (30 tests):**
- Model: rooms keyed by an opaque high-entropy tag (will be HKDF-derived from the pairing
  secret in B2). One `host` (daemon) per room, capped `guests` (phones). Guest frames → host;
  host frames → all guests; guests never see each other. Payloads are opaque base64 the relay
  never parses — asserted byte-for-byte in tests.
- Holds nothing: no DB, frames to an absent side are dropped (E2E cursors replay the gap),
  empty rooms evaporate, `/health` reveals only `{ok:true}` (test asserts no room tag leaks).
- Hygiene: join timeout drops parked sockets; second host rejected (4409) without disturbing
  the first; guest cap (4429); per-frame size rule (4413) separate from the ws transport cap
  (1009) so close codes tell the truth; slow consumers are dropped at a buffer watermark, not
  buffered forever; heartbeat tolerates 3 missed pongs (the daemon's 32s-reconnect-loop lesson,
  applied on day one).
- `bin/longleash-relay.ts` binds 0.0.0.0 BY DESIGN — it is the public rendezvous service on a
  VPS, not the laptop daemon; the "nothing binds 0.0.0.0" invariant governs the daemon. TLS
  terminates at the platform proxy (Fly/Caddy); relay speaks ws behind it.

**Next:** B2 — E2E envelope (libsodium secretbox; relay key + room tag minted at pairing,
delivered over the LAN QR channel, never to the relay) + daemon outbound relay connection.
B3 — app speaks relay with LAN-first fallback. B4 — Dockerfile + deploy (needs Sahith's hands:
a Fly.io account or any small VPS). 283 tests workspace-wide (14 protocol + 30 relay + 56 app
+ 183 daemon).

## Dogfood round 7 (2026-08-01) — a restart stranded a conversation, and the phone lied about it

Sahith replied to a session showing "waiting for you" and got "That session has finished —
start a new one." Root cause was a **double defect** introduced by the restart cleanup:

1. On startup the daemon silently rewrote running/waiting rows to 'ended' in SQL **without
   appending an event**, so `hello` said one status while the replayed stream still ended
   "waiting". The phone trusts the stream (it must — replay is the source of truth), showed a
   live session, and the send bounced.
2. Even with honest events, killing the conversation was the wrong semantics: the transcript
   and the resume id were sitting on disk the whole time.

**Fix — conversations survive restarts now:**
- Restart reconciliation: stranded sessions with a resume id become 'waiting' (an honest
  status — see next line), ones that never announced a resume id are 'ended'; either way the
  transition is **appended to the event log** so replay and hello agree. Idempotent across
  repeated restarts (guarded, no boot spam).
- `sendMessage` to a dormant session **wakes it**: revives the agent via SDK `resume` with the
  reply as its next prompt — same spawn path the Reopen button already contract-verified
  against real Claude. Obeys the concurrency cap and re-validates the cwd against today's
  allowlist. Audited as `session.wake`.
- `stopSession` on a dormant session ends it cleanly (event appended) instead of erroring.
- Two old tests pinning "finished sessions refuse messages" rewritten to the new contract;
  +13 new tests (restart transitions, replay convergence, wake, follow-ups after wake, cap,
  allowlist re-check, audit). 183 daemon tests green.
- Server error copy for the truly-unresumable case updated; app footnote no longer claims
  restarts kill sessions.

## Mobile formatting pass (2026-08-01) — transcripts are markdown, render them as such

Sahith's phone screenshot showed the truth: agent replies are full markdown (bullet recaps,
fenced commands, numbered steps) and the inline-only renderer produced a ragged wall. Added
`src/ui/prose.tsx` — a small structured reader (paragraphs, bullets, numbered lists with real
starts, ### headings, fenced code with language tag, inline code/bold) with 14 parser tests,
including "unterminated fence mid-stream renders as code" and the exact transcript from his
screenshot. Fences side-scroll inside their card; the page never scrolls sideways.

Also from the same screenshot review:
- Detail header compacted: title + Stop/Reopen on one row, single ellipsizing meta strip —
  the conversation gets the vertical space (readout 56→62dvh).
- Inline code chips keep their shape across line-wraps (`box-decoration-break: clone`).
- Auto-scroll only follows the tail when the reader is at the bottom; scrolling up to read is
  no longer yanked back by streaming.
- Body texture moved to a fixed layer — iOS Safari does not support
  `background-attachment: fixed` (janky scroll repaints on the phone, fine in desktop preview).
- Preview harness gained a `markdown` screen mirroring the screenshot content.
- Audit clean: 24 screen×width combinations (8 screens × 360/390/430), reduced-motion,
  landscape. 253 tests green (14 protocol + 56 app + 183 daemon).

## UI rebuild (2026-08-01) — "Instrument"

Sahith flagged the transcript as "hardly readable" and asked for a professional light-theme
design, explicitly not AI-slop. The whole app was rebuilt around one idea: LongLeash is a
**control panel**, not a card gallery — one pale substrate, surfaces that extrude, readouts
that recess, and status as a physical LED in a drilled socket.

- **Type:** Archivo (variable, wdth+wght) + JetBrains Mono, **self-hosted** in `public/fonts/`
  — the phone may be on a laptop hotspot with no route to the internet, and no third party
  should see who opens the app.
- **Palette:** light only, on purpose. Signal tones (`--live` / `--hold` / `--stop` / `--act`)
  were darkened until each measured ≥4.5:1 on the surface it actually sits on.
- **Motion:** `motion` (Framer Motion v12) — directional screen transitions, staggered list
  entrance, spring on the approval card, drag-to-dismiss sheet. `prefers-reduced-motion`
  honoured and verified.
- **Icons:** `lucide-react`, one glyph per tool. No emoji anywhere.
- **New session** moved from an always-open form into a bottom sheet, so the console shows
  decisions and sessions instead of a form.
- **First-run state** added — the empty console used to be a blank screen.

**Design harness:** `packages/app/preview.html` + `src/preview.tsx` render the real screens
against fixture data (including a deliberately hostile `stress` fixture). `pnpm --filter
@longleash/app dev` → `/preview.html?screen=console`. Not in the production bundle. Vite only
emits `index.html`; verified in `dist/`.

**Found by looking at it, not by assuming** (Playwright at 360/390/430px):
1. The approval command block clipped its **last line mid-glyph** — approving a command you
   cannot fully read. Capped at whole lines with the padding accounted for.
2. Long paths broke mid-word; now break at separators via `<wbr>`.
3. Console approvals did not say **which session** was asking when several were waiting.
4. Secondary ink was 3.7:1 — failing AA. Darkened to 4.7:1; a separate `--hint` token now
   carries decoration only (separators, `aria-hidden`).
5. Three controls were 38–43px — under the 44pt floor.

Audit clean at 360/390/430px across all seven screens: no contrast failures, no undersized
targets, no unlabelled buttons, no horizontal overflow, nothing stuck faded under reduced
motion, no landscape overflow. 229 tests green (14 protocol + 42 app + 173 daemon).

## Audit of A1-A6 (2026-08-01)

Full report: `agents/2026-08-01-audit-a1-a6.md`. Seven flaws found; all critical/high ones fixed the same day (stop button, orphan reconciliation actually wired, expiry sweeper actually running, real audit log replacing a doc overclaim, concurrent-session cap, WS frame cap, session origin). Deferred with named phases: external agents are mirror-only (Phase D, platform limit), sessions not persisted across restart (F), token in query string (B, TLS), event-log retention (F), `sendMessage` steering (E).

## Roadmap change (2026-08-01)

**Externally-started sessions are addressable after all.** Verified: a `PreToolUse` hook in `~/.claude/settings.json` fires for EVERY Claude Code session on the machine (CLI and VS Code extension) and can return allow/deny; all sessions write live transcripts to `~/.claude/projects/**/*.jsonl` that any process may tail. So LongLeash can list and gate sessions it did not start. Constraint: hooks are timeout-bounded (~600 s default), so foreign-session approvals cannot park indefinitely the way our own do — the UI must say so. New **Phase D1 (Attach Mode)** added to PLAN.md, gated on spike **D0**. Still impossible: injecting a prompt into a foreign running session; driving the VS Code chat webview. Full analysis: `agents/2026-08-01-external-sessions-feasibility.md`.

## Dogfood round 6 (2026-08-01) — a schema change broke every existing install

Sahith's session failed with `no such column: agent_session_id`, and reopening failed the same
way. Cause: `CREATE TABLE IF NOT EXISTS` leaves an existing table untouched, so a column added
in a later release reached fresh installs and never reached upgrades. The failure only surfaced
at runtime, well after the release looked healthy — this would have hit every user of every
future version.

Fixed with a real migration step (`src/migrate.ts`): `ensureColumns` compares `PRAGMA
table_info` against what the code expects and adds what is missing, idempotently. Also corrected
the ownership smell that hid it: the `sessions` and `audit` tables lived in the approvals
database but were created by `SessionManager`, so opening that database alone left it
half-formed. `ApprovalStore` now defines every table in its own file.

Verified against a copy of Sahith's actual database: the column is added, all 5 existing sessions
are preserved, and the exact session that failed reopens successfully.

## Dogfood round 5 (2026-08-01) — picking a folder without knowing its path

Two problems. First a bug: the subfolder field appended blindly to the root, so pasting an
absolute path produced `/Users/x/Desktop/Users/x/Desktop/FD_Engineer`. Second, and more
important, Sahith's point that nobody away from their laptop remembers exact paths.

Replaced the path field with **folder search**: `FolderIndex` walks the allowed roots (bounded
depth 4, 4000 entries, 10s cache), skipping hidden and noise directories, and scores matches by
name with location words used only to disambiguate. Deliberately NOT an LLM call — matching is
instant, deterministic, works offline, and the exact folder is shown before anything runs.
Symlinks that resolve outside a root are dropped, so search cannot leak paths the allowlist
forbids. Verified against the real Desktop: "FD_Engineer", "fd_eng" and "FD_Engineer folder in
desktop" all resolve to the right folder; nonsense returns nothing rather than a wrong guess.

**Decided by Sahith:** home-wide with sensitive folders excluded. `src/sensitive.ts` lists
credential/system directories; they are skipped by search AND refused as a session cwd, because
hiding a folder without refusing to run there would be cosmetic. Verified with `longleashd ~`:
projects are findable, `.ssh`/`Keychains` return nothing, and starting a session in `~/.ssh` by
explicit path is refused. Documented honestly in `docs/REQUIREMENTS.md`: an exclusion list is
guesswork and never complete; naming project folders remains the safest setup.

## Dogfood round 4 (2026-08-01) — reopening closed sessions

Sahith: "if session A closes, can I open it again?" Yes, and it now works. The Claude adapter
captures the agent's own session id from the init message; `resumeSession` restarts the agent
with `resume: <id>` in the same pinned directory and reattaches to the SAME LongLeash session, so
events continue in one stream instead of creating a duplicate. Reopening re-checks the allowlist,
so a directory removed from the configuration cannot be reached by reopening old work, and it is
recorded in the audit trail. Verified with real Claude: told it a fact, stopped the session,
reopened it, and it answered a question about that fact correctly.

Known cosmetic artifact: resuming makes Claude replay its closing message, so a line can appear
twice. A "— reopened —" marker now labels the seam.

Also fixed this round: the heartbeat dropped a connection after ONE missed pong, which made the
phone reconnect every ~30s and appear to lose sessions; it now tolerates three misses and treats
any inbound message as proof of life. And finished sessions were listed alongside running ones,
so history read as "four agents running" — Active and Earlier are now separate.

## Dogfood round 3 (2026-08-01) — reload wiped the screen

Refreshing the app lost every session. Two causes, both fixed:
- The daemon only tracked **live** sessions in memory, so nothing survived its own restart either
  (this was deferred audit item #9; it became urgent). Sessions are now persisted in SQLite with
  agent, cwd, origin, title, status and start time. Anything left `running`/`waiting` when the
  daemon died is marked `ended` on startup — showing "working" for an agent that no longer exists
  would be a lie the user cannot act on.
- The app had no way to **discover** existing sessions; it only learned of ones it started. `hello`
  now carries the session list, and the client rebuilds the list and resubscribes to every session
  from its cursor.

Verified end to end: two real Claude sessions, full client reload, both reappear with titles and
honest statuses, both transcripts replay, and a restored session still answers follow-up questions
about its own earlier context. Added `LONGLEASH_DATA` so instances (and test runs) can hold
separate storage.

## Dogfood round 2 (2026-08-01) — the interaction model was wrong

Sahith: "why is each message a new session?" Correct and fundamental. The composer only ever
called `startSession`, so every message spawned a one-shot agent — not a conversation. Fixed as
slice **A9**:
- **Multi-turn sessions.** The Claude adapter now drives the SDK in streaming-input mode: an
  async generator feeds user messages, so a session stays open between turns. A finished turn
  emits `session.status: waiting` instead of ending the session. `sendMessage` delivers
  follow-ups to the same agent and the same transcript. Verified against real Claude: it
  remembered a value across turns and used it three turns later.
- **Session focus.** Tapping a session opens a detail view with its own conversation, its own
  approvals, a reply box, and a stop button; the list shows status, origin, pending-approval
  count and a preview.
- **Directory choice restored.** A picker when several roots exist, plus an optional subfolder
  field, so a single-root daemon no longer traps the user.
- **Approvals appear per session** as well as in the global inbox.

## Dogfood findings (2026-08-01, Sahith on his iPhone)

First real use of the app found four defects, all fixed the same session:
1. **Send did nothing and lost the typed task.** He entered `Desktop` as the directory, which was not an allowed root. The daemon refused correctly, but the client did `if (type === 'error') return` — swallowing it — and cleared the input optimistically. Fixed: errors surface in a dismissible bar, and the prompt is retained until the message is actually on the wire.
2. **Asking for a typed path at all was the deeper bug.** The daemon knows its allowed roots; the client should never guess. Added a `hello` greeting carrying roots + capabilities; the app now preselects the single root or offers a picker.
3. **The terminal printed nothing after startup.** Server had a log hook but `startDaemon` never passed one. Now the daemon prints device connections, session starts, approvals, decisions, auto-approved tools, and completions with timestamps.
4. **The app implied it could see every session.** It now states plainly that sessions started in a terminal or the VS Code chat panel are not visible yet (Phase D1).

## Field findings

- **2026-08-01 — a user's own allow-rules bypass our approval gate.** Verified on this machine: with `allowedTools` set and `isolateFromUserSettings: true`, a `Bash` command still executed without `canUseTool` firing, because `~/.claude/settings.json` `permissions.allow` matched it (the SDK emits a CAN_USE_TOOL_SHADOWED warning saying settings allow-rules shadow the callback). We cannot override this. Response: `readPermissionPosture()` reports the count and examples at daemon startup, the activity feed still shows such actions so nothing is invisible, and `docs/REQUIREMENTS.md` states the caveat plainly. Never claim total approval coverage.

- **2026-08-01 — SECURITY HOLE FOUND BY HAND-TESTING, now fixed.** Live demo with real Claude: asked to create a file, it wrote to `/tmp/phone_test.txt`, OUTSIDE the sandbox, and the approval layer allowed it. The allowlist only governed where a session *started*, never where its tools *wrote*. Fixed: tools declaring a path have it resolved against the session cwd and checked against allowlisted roots; approvals carry `targetPath` + `outsideRoot` so the human sees the reach; `denyOutsideRoot` refuses outright for sandboxed use. Shell commands are deliberately not parsed (that would be security theatre) — they still go to a human who sees the full command. Verified against real Claude: escape attempt refused, no file created. Lesson: automated tests all passed while the product was insecure; only driving a real agent by hand exposed it.

- **2026-08-01 — agents can target paths outside the session directory.** A contract run attempted `Write: /tmp/approved.txt` before self-correcting. cwd pinning governs the agent's process, not every absolute path a tool is handed. The approval card must always show the full target path (it does), and Phase F should flag or block writes landing outside the session's allowlisted root.
- **2026-08-01 — approval behaviour is machine-dependent unless pinned.** Inheriting the developer's Claude Code settings made the same prompt sometimes raise an approval and sometimes not. The adapter now takes `allowedTools` + `isolateFromUserSettings`; the product must choose its permission posture explicitly rather than inherit one.

- **2026-07-31 — A full-tunnel VPN silently kills LAN-direct mode; corrected root cause.** First hypothesis was university client isolation. WRONG: once Cisco AnyConnect (full-tunnel, utun default route) was disconnected, the phone reached the laptop fine on the same university Wi-Fi (phone 192.168.1.207 → laptop 192.168.1.71). Verified by Sahith on-device. Two real bugs found: (1) picking the first non-internal IPv4 handed the phone 192.0.0.2, iOS's RFC 7335 service-continuity range, which Safari refuses to route — address selection must exclude 169.254/16 and 192.0.0.0/29 and prefer 172.20.10/24 (hotspot) then RFC1918; (2) no connectivity check existed, so network failure and pairing failure were indistinguishable. Product consequences: the app MUST detect an active VPN/tunnel and say so, MUST ship a reachability check separate from pairing, and MUST NOT assume LAN-direct works — corporate/university VPNs are the norm for the target user. Phase B relay remains required, but for VPN interference at least as much as for remote access.

## Log

- **2026-08-01 (PIVOT: client is a web app)** — Sahith: no budget for Apple/Google fees, and wants maximum reach for an open-source tool. Client changes from Expo/React Native to an installable **React+Vite PWA** served by the daemon/relay. Rationale: $0 forever, no store review or sideloading, instant updates, desktop browsers get a free client, and adoption friction drops to "open a URL". Accepted trade-off: iOS web push has no lock-screen action buttons (tap → approve in app, ~2s slower); Android does. Native wrappers remain a later option that changes nothing below the client. **A1–A4 unaffected** — the architecture's client-swappability paid off. Also corrected a policy error: "FileVault stays ON" was wrongly recorded as a project invariant; disk encryption is the user's call and LongLeash must never require weakened security. New `docs/REQUIREMENTS.md` codifies required vs recommended vs never-required.

- **2026-07-29 (PIVOT)** — Sahith set final scope: LongLeash is a STANDALONE end-to-end product — no Happy/Termius/Tailscale dependencies, every product surface ours. Adopted the archived Tether architecture + our own E2E relay as PLAN v2 (7 phases A–G, ~29 dev-days, $99/yr Apple at Phase C). Public-product bar unchanged: one command + one app + 5 minutes. Old compose-tools plan superseded; published artifact now outdated (refresh once v2 stabilizes). Checklist pruned: Tailscale/Termius/Happy dropped.

- **2026-07-29 (later still)** — GOAL CHANGE: Sahith wants LongLeash open-sourced and publicly usable, not just personal. Direction agreed: dogfood personal build first, then ship as a setup-orchestrator CLI + docs (not a rebuild of Happy). Tailscale standalone (brew cask) failed on his machine — login hangs, CLI reports service not started; fix in motion: swap to App Store version (or ZeroTier fallback). Phases reordered: agent lanes (Remote Control, Happy) proceed without VPN; terminal lane resumes when the network layer works.
- **2026-07-29 (later)** — Phase 1 build started. Installed tmux 3.7b, mosh 1.4.0; wrote ~/.tmux.conf; caffeinate LaunchAgent running (verified assertion). Tailscale cask install blocked on sudo password → moved to manual checklist. FileVault status audited → flagged as open decision (posture details off-repo). Dead-man plist templated in scripts/launchd/, waiting on healthchecks.io URL.
- **2026-07-29** — Planning finished. 11-agent evaluation (6 researchers, 3 designs, judge, hostile critique) chose Happy-on-Tailnet (79/100) over custom builds Tether (74) and Switchboard (73). Critique found 5 blocking flaws; all fixed in PLAN.md (dead-man direction inverted to healthchecks.io, vscode-N wrapper script, reboot/FileVault story, push-payload spike, Phase-1 prerequisite corrections). Project folder created; plan published as artifact.
