# Workstream D — verified pairing

**Current 2026-10-05 work:** universal session identity, browser reconnect cleanup, managed service lifecycle and exact phone ↔ LongLeash VS Code editor control are implemented in the rc.14 / extension 0.0.3 candidate. [Current implementation and gates](IDE-CONTROL-IMPLEMENTATION-2026-10.md) supersedes the older ordering and read-only preview limitations below. Physical phone and Marketplace installation acceptance are still open; Workstream D is not declared closed.


Updated: 2026-10-04. Base: `7266155`. Status: **D2 implemented; D3 local hardening and release checks advanced, with device/platform/production acceptance still open. Not published or deployed.** See [D3 evidence and remaining gates](D3-RELEASE-READINESS.md) and [the setup walkthrough](PHONE-LAPTOP-WALKTHROUGH.md).

The owner requested production hardening, one phase at a time, with competitor research and durable context. This authorizes continuing D development after the September customer-feedback work. P5 production acceptance remains a separate launch blocker.

## Slices and exact next work

| Slice | Deliverable | Status |
| --- | --- | --- |
| D1 | Shared transcript derivation and registry commit gate, adversarial tests | Implemented, locally validated |
| D2 | Versioned LAN/relay handshake, authenticated local CLI comparison, phone comparison UI, compatibility and abuse handling | Implemented and locally validated |
| D3 | Release matrix, clean-machine/upgrade acceptance, physical iPhone and production evidence | **In progress; hold for acceptance gates** |

These names belong to the August pre-release extension plan. They are unrelated to the older terminal-hook “D1” in the August context log.

D1 initially left QR producers on v1. **D2 now generates v2 from both foreground and background-service pairing**, and the candidate phone requires it. Existing paired devices retain their credentials. These are uncommitted source/build changes based on `7266155`, not a claim about npm rc.11 or production. Ship compatible app and daemon builds together after D3; old QR links receive update guidance.

## Implemented contract

- `packages/protocol/src/pairing.ts`: strict v2 transcript; exact challenge identity, 256-bit attempt ID, independent phone/daemon nonces, role labels, device name and expiry. Fixed-order JSON avoids object-order ambiguity. Device labels reject invisible/control characters before terminal display.
- HKDF-SHA256 over the exact QR secret text, with a SHA256 transcript salt and separate v2 domains for room, encryption key and display code. Eight decimal digits grouped `0000 0000`. Both devices must derive the code locally; accepting a peer-supplied code defeats comparison.
- `DeviceRegistry.createPairingChallenge({ version: 2 })`: explicit opt-in, existing five-minute default TTL, maximum eight outstanding v2 challenges. This is a capacity bound, **not a network rate limiter**.
- `beginVerifiedPairing`: authenticate secret first, create in-memory pending state. Identical retries return a copy of the same transcript. A different authenticated nonce or name burns the challenge. Wrong-secret requests cannot burn a valid attempt.
- `getPairingVerification` and `confirmPairingLocally`: **local authority only**. D2 must expose these solely through the secret-authenticated local CLI channel. Possessing the QR/attempt ID never grants the local authority route.
- `finishVerifiedPairing`: explicit phone confirmation; requires prior local consent. No token, relay secret, device row or paired callback exists before this transition. A premature call fails without committing. A user who confirms on the phone first must see a waiting state in D2, with carefully bounded continuation after local consent.
- `cancelVerifiedPairing`: terminal cancellation primitive for mismatch/disconnect. D2 transport adapters now call it on loss/rejection. Exact-deadline expiry rejects all further transitions; expired records are removed on access/sweep, and close/restart clears memory.
- A v1 completion cannot redeem a v2 challenge. V2 initiation against a v1 challenge requests an update/new QR. One shared private commit path preserves existing token/revocation behavior.

## Threat model and remaining integration obligations

The human code supplements the 256-bit QR secret. It is neither a password nor a defense against compromised endpoints or a stolen QR secret. This pre-shared-secret construction does not provide forward secrecy. A screenshot of the QR must still be treated as a secret.

D2 integration contract (implementation evidence below; production acceptance remains D3):

1. Specify and validate every wire message. Authenticate the initial transcript over the encrypted QR rendezvous, then bind confirmation/rejection to the attempt-specific encrypted channel. Never accept a plaintext HTTP confirmation on an untrusted LAN.
2. Keep local consent separate from all phone messages, including reflected messages and extra-field injection. Test remote callers, hostile browser origins and missing/wrong local secrets.
3. Bind transport ownership to the attempt. Invalidate on relay/LAN disconnect, expiry, competing guest and CLI cancellation. Drop corrupt frames without turning unauthenticated traffic into a cancellation oracle.
4. Require fresh QR after failure; do not reconnect and silently restore consent. Handle lost commit responses explicitly: the device may exist even if the phone did not receive credentials. Provide local revocation/re-pair recovery rather than a second mint or automatic success.
5. Add local and hosted ticket rate limits, bounded payload sizes, bounded pending sockets/timers and log redaction. The registry cap alone is insufficient.
6. Ship old-app/new-daemon and new-app/old-daemon update messages. Once v2 becomes the default, no user-facing route may keep creating v1 challenges as a fallback.
7. Persist browser credentials and record pairing success only after the committed response. Clear QR fragments promptly; preserve hosted-auth return state without sending secrets to telemetry, logs or third parties.
8. Keep foreground daemon pairing and background-service `longleash pair` usable, including non-TTY failure, Ctrl-C and expiry. Do not restart a user's live daemon during implementation.

## Design direction for D2

Applied guidance: frontend-design, ui-ux-pro-max (design-system and UX searches), framer-motion; ECC security-review and competitive-platform-analysis. Preserve **Matte Graphite**: Instrument Sans/Serif and Geist Mono, recessed code readout, restrained sage/clay, clear text states. The skill search's generic store badges, ratings and alternative palette were not adopted: LongLeash is a PWA and has no evidence for invented ratings.

Phone: “Compare with your laptop”, large grouped code, named device, expiry and explicit **Codes match** / **They do not match** actions. Explain that no device is connected yet. Show waiting-for-laptop and expired states with concrete next steps. Never preselect confirmation or advance on a timer. A mismatch must be easy to choose without color recognition. Do not allow arbitrary device names to resemble terminal controls.

Use semantic buttons, visible keyboard focus, screen-reader labels for grouped digits, 44px minimum targets, text contrast at least 4.5:1, 375px portrait/landscape and enlarged text checks. Motion may use a short opacity transition through `motion/react`; respect reduced motion and never delay confirmation/rejection behind animation. D1 changed no UI. D2 browser evidence is recorded below; physical iPhone acceptance is still pending.

## D1 evidence

Tests were written first and failed before implementation. Then:

- `pnpm test`: **1,039 passed** (protocol 80, relay 127, app 188, daemon 578, VS Code 30, CLI 36).
- `pnpm typecheck`: all six packages passed.
- `pnpm build`: all workspace builds passed, including bundled CLI/app.
- 36 new tests cover transcript derivation, independent Node-crypto compatibility vector, domain separation/decryption, role/field binding, malformed inputs/control characters, pending persistence, local/remote consent, legacy bypass, replay, competing attempts, stale IDs, expiry, capacity, callback timing and restart.

Cancellation tests exercise the registry primitive; they are **not** transport-disconnect acceptance. No new live provider contracts, hosted v2 pairing, physical iPhone test, security audit, deployment or release was performed. D2/D3 remain required.

## Launch blockers carried forward

Read-only repository review on 2026-10-04 observed public `build.json` at `7266155` and enabled feedback configuration, while [the CI deploy run](https://github.com/Sahith59/LongLe-sh/actions/runs/34538133508) failed its D1 remote migration step with Cloudflare 7403. Local read-only migration listing also failed 7403. A live build alone does not establish the database schema or complete deployment provenance.

P5 still needs verified production migrations, owner MFA/ordinary-account denial, real account flow, signed mail delivery/inbox evidence and physical-device acceptance. `emailDelivery:false` in public feedback config is not proof that owner notifications are disabled. Follow `CUSTOMER-FEEDBACK-AND-MEASUREMENT.md` and `RESEND-SETUP.md` before declaring launch readiness.


## D2 implementation and evidence — 2026-10-04

- **Shared wire flow:** strict `pair-begin`, transcript, confirm/reject/ping, waiting and committed messages. The transcript crosses the encrypted QR rendezvous; confirmation and credentials use the transcript-bound key. LAN uses `/pair/v2` WebSocket, not a plaintext secret-bearing HTTP confirmation. The Node relay and Cloudflare Durable Object carry the same encrypted frames.
- **Local authority:** secret-authenticated `/local/pairing/status|confirm|cancel`; hostile browser origins and missing/wrong secrets are refused. A transport identity prevents a second socket from replaying a begin message to inherit consent. A competing authenticated relay begin also invalidates the pending challenge.
- **Laptop:** `longleash pair` keeps an interactive prompt open, requires literal `yes`, and waits for both devices. Ctrl-C/EOF/expiry cancels. Non-TTY fails before QR generation. Foreground mode displays the code and accepts `y` / `x`; service logs never receive QRs/codes. Production QR producers use v2.
- **Phone:** large eight-digit readout, explicit match/mismatch, waiting with the code retained, expiry and recovery copy, cancellation. Fresh fragment navigation in an existing tab after a mismatch now restarts pairing (found and fixed during real-browser QA).
- **Credential boundary:** account-scoped browser storage is written only after the committed response, token last. Account change/storage failure gives local revoke/re-pair recovery. QR fragments and pending session storage are removed when consumed. OAuth fallback URLs strip pairing parameters/fragment, and hosted sign-in clears the current QR URL before mounting the provider.
- **Bounds:** eight pending v2 challenges; ten local QR requests/minute; sixteen LAN pairing sockets; 8KiB encrypted frames; eight queued frames; sixty frames/minute/session; five-minute QR expiry (phone countdown uses authenticated remaining lifetime so clock differences do not reject valid attempts); thirty-second authenticated-traffic inactivity limit. Existing hosted account ticket (30/minute) and relay guest/host limiters remain enforced. A single corrupt frame is dropped; sustained abuse can close an attempt.
- **No automatic recovery of consent:** socket loss requires a new QR. If the final response is lost after commit, a device may exist; the phone explicitly directs the user to inspect/revoke it. Local completion receipts contain only device ID and expire after sixty seconds.

Validation:

- `pnpm test`: **1,064 passed** — protocol 80, relay 127, app 192, daemon 595, VS Code 30, CLI 40. D2 adds 25 tests beyond D1's 1,039.
- `pnpm typecheck`: all six packages passed.
- `pnpm build`: all workspace builds passed. Final CLI packaging build includes the last cancellation-race guards.
- `pnpm --filter @longleash/cli pack:verify`: passed; packaged file/content/integrity checks, no publication.
- Integration tests use the actual browser pairing state machine, local CLI workflow, HTTP local authority and WebSocket LAN/reference relay. The storage test proves no credentials before both confirmations and simulates a laptop/phone clock difference.
- Actual **workerd + Durable Object** integration passes for accountless and hosted-mode ticket enforcement; missing tickets are denied. Tickets are synthetic and locally signed for the test. This does **not** exercise live Clerk sign-in, real production secrets or deployed routing.
- Chrome browser QA at **375×812** and **812×375** verified comparison, waiting, cancellation, mismatch and new-QR recovery. At 375px the document width is 375px, and action buttons are 50px tall. [Comparison screenshot](evidence/d2-pairing-375px.jpg) contains only an expired synthetic display code, no QR credential.
- Browser inspection found extension-origin warnings; no app failure was observed in these flows. Reduced-motion handling is implemented, but OS-level reduced motion, largest accessibility text, camera and physical iPhone backgrounding are not claimed as manually accepted.
- Only an isolated in-memory test server was started and then stopped. The user's real daemon was not restarted. No commit, release, production migration, external outreach or payment was performed.

## D3 next: acceptance before release

1. Record a coordinated candidate app/daemon/CLI build; verify old app/new daemon, new app/old daemon and existing paired-device migration on packaged installs. Do not advertise npm rc.11 as containing these changes.
2. Run physical iPhone camera + installed PWA pairing on home Wi-Fi and cellular relay, with both confirmation orders, mismatch, screen lock/background, expiry, network loss, competing guest and fresh-QR recovery. Check reduced motion, enlarged text and focus/screen-reader reading.
3. Verify foreground and background-service prompts on clean macOS/Linux installs, including EOF/Ctrl-C and service lifecycle. Measure whether the conservative 30s inactivity behavior is understandable on phones.
4. Reconcile the failed Cloudflare migration/production deployment; verify P5 owner MFA, ordinary-account denial, persisted feedback, signed email delivery/inbox, consent and signup. Preserve evidence; public build health alone is insufficient.
5. Review the release evidence and then publish/deploy through the authorized release process. Until these gates pass, describe D2 as a locally validated candidate.

## After D3

The standing technical queue is **E: local stdio MCP setup/diagnostics**, **F: desktop operations dashboard**, and **VS Code authenticated snapshot sync** from `PHASE2A-CHECKPOINT.md`. These remain planned, not implemented in this phase.

Two user-requested **GPT-6 Sol** agents produced the [market study](MARKET-VIABILITY-2026-10.md) and [independent critique](MARKET-VIABILITY-CRITIQUE-2026-10.md). Their recommendation is to prioritize a six-to-eight-week external-use/exact-price validation window before broad expansion. That is a recommendation, not permission for outreach, billing or team development. Keep the existing monetization gates. The owner targets $7–8k gross MRR ($6k acceptable) and commits at least 14–16 development hours/week; extra sales/support time is unknown. That target is unvalidated and requires far more than feature completeness.
