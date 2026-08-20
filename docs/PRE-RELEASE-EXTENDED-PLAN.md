# LongLeash pre-release extension plan

**Status:** active release program

**Created:** 17 August 2026

**Public release rule:** a feature is not advertised as available until its implementation,
automated tests, failure handling, documentation, and physical-device acceptance gate all pass.

This document is the durable checkpoint for the work required before LongLeash is presented as a
finished public product. It separates user-facing promises from internal engineering slices and
records the security boundaries that implementation work must preserve.

## Outcome

A new user should be able to discover LongLeash, understand it in 30 seconds, install it without a
maintainer-specific URL, verify that the phone is pairing with the intended laptop, and keep the
laptop service available without leaving a terminal window open. A user who prefers to operate
their own infrastructure should have an honest, complete path for either LAN-only use or a
self-hosted relay. An agent may help configure and diagnose LongLeash through a deliberately narrow
local MCP server, but it must not gain a route around approvals, workspace boundaries, or device
authority.

## Non-negotiable product boundaries

1. **The coding agents remain on the laptop.** Claude Code and Codex credentials, processes,
   repositories, transcripts, approval history, and durable audit data stay on the laptop.
2. **The hosted relay remains content-blind.** It routes end-to-end encrypted frames and can observe
   ordinary network and routing metadata. It cannot decrypt prompts, code, transcripts, approvals,
   or device credentials.
3. **One writer per physical checkout remains enforced.** Background service, dashboard, MCP, and
   pairing work must not weaken workspace leases or provider process ownership.
4. **Pairing is explicit and revocable.** Scanning a QR proves possession of a short-lived secret;
   the new human verification step must additionally prove that the user is looking at the intended
   laptop before a durable device credential is issued.
5. **MCP is an operator interface, not a bypass.** It runs locally over stdio, exposes bounded typed
   operations, redacts secrets, and uses the same approval, root, lease, and audit controls as the UI.
6. **No root service.** Background operation runs in the signed-in user's context through a macOS
   LaunchAgent or Linux systemd user service. Installation and removal are explicit and reversible.
7. **Local and self-hosted use remain independent.** Failure of LongLeash accounts, billing, or the
   hosted relay must not disable LAN-only or self-hosted operation.
8. **The website describes shipped user outcomes.** Internal labels such as Phase 1 and Phase 2A
   stay in engineering documents and never appear as the primary explanation of the public product.

## Current truth and discovered constraints

| Area | Current state | Release consequence |
| --- | --- | --- |
| Public install | The website pipes a maintainer-specific GitHub raw URL into Bash. | Replace the primary path with a provenance-backed npm package. Keep source inspection available. |
| npm name | The unscoped `longleash` package is already owned by an unrelated maintainer and describes a similar product. | Do not use `npm install longleash` or `npx longleash`. Publish a controlled scoped package such as `@longleash/cli`. |
| Daemon lifetime | `longleash` runs the daemon in the foreground. Closing that terminal ends phone connectivity. | Add explicit user-service lifecycle commands and make background operation the recommended setup. |
| Pairing | A strong single-use QR secret authenticates pairing and durable credentials are minted immediately. | Introduce pending pairing and a human-confirmed short authentication string before commit. |
| MCP | No LongLeash MCP package exists. | Build a local stdio server with narrow setup, health, and control tools. It does not replace the daemon or relay. |
| Desktop view | The daemon serves the same application locally, but there is no first-class dashboard command or desktop information architecture. | Add `longleash dashboard` and a responsive local operations view. |
| Public roadmap | It exposes internal phase names and implementation checkpoints. | Replace them with Available, Building, and Exploring outcomes that are understandable without repository context. |
| Connectivity docs | Hosted and self-hosted concepts exist across repository documents but are not presented as a clear public choice. | Publish a first-party connectivity page and setup paths for hosted relay, self-hosted relay, and LAN-only use. |
| Self-hosted Worker config | The original Wrangler file is tied to LongLeash production domains, Clerk secrets, and hosted rate limits. | Ship and validate a separate accountless `wrangler.selfhost.jsonc`; never ask self-hosters to deploy the production config. |

## The three connectivity modes

The public website and product must use these exact conceptual boundaries.

| | Hosted relay | Self-hosted relay | LAN-only |
| --- | --- | --- | --- |
| Best for | Fast setup and access away from home | Users who want remote access and control the internet service | Users who only need the same trusted network |
| Internet component | Operated by LongLeash | Operated by the user | None |
| LongLeash account | Required for the official hosted app and relay ticket | Not required by the reference relay | Not required |
| Phone to laptop path | Encrypted through `app.longleash.dev` | Encrypted through the user's relay | Direct local network connection |
| Content readable by relay | No | No, if the reference protocol is deployed unchanged | Not applicable |
| Operator can observe | Routing metadata, timing, frame sizes, availability | The user's server may log equivalent metadata | Local network metadata only |
| Operations owner | LongLeash | User | User |
| Works away from the LAN | Yes | Yes, when the user's relay is internet reachable | No |
| Updates and TLS | Managed | User managed | Local app and daemon updates only |

“Self-hosted” must never be described as everything running on one local laptop while also promising
access from anywhere. Remote self-hosting still needs an internet-reachable relay. LAN-only is the
mode with no relay at all.

## Workstream A: public clarity and navigation

### Scope

- Change the browser title to a short, punchy line without em dashes.
- Remove em dashes from public marketing and documentation copy where ordinary punctuation is
  clearer.
- Replace the internal-phase roadmap with a glanceable feature map:
  - **Available:** Claude Code and Codex control, approvals and replies, stop, tuning, terminal
    handoff, safe parallel sessions, reviewed delegation, hosted relay, LAN, and self-hosting.
  - **Building:** durable background service, verified pairing, npm distribution, VS Code companion,
    local operations dashboard, and agent-assisted setup.
  - **Exploring:** parallel specialist review, team administration, and optional paid operations.
- Use consistent Lucide icons and provider/location badges. Do not depend on hover to communicate
  state. Every icon-only action requires an accessible name.
- Add a first-party `/connectivity` page with the comparison above and complete setup paths.
- Add “Got no time? Let your agent wire it” beneath each setup path. Until the MCP release gate
  passes, label it Coming soon and do not publish a command that does not work.

### Acceptance gate

- A first-time reader can answer within 30 seconds: what LongLeash does, where agents run, what the
  relay can read, which providers work, how to install, and which connectivity mode fits them.
- 320 px, 390 px, tablet, and desktop layouts have no horizontal overflow or hover-only meaning.
- Keyboard navigation, visible focus, landmark structure, heading order, and reduced-motion mode pass.
- Page titles, descriptions, Open Graph metadata, navigation, and canonical routes are correct.
- No public page presents Phase 1, Phase 2A, or a maintainer checkpoint as a customer feature name.

## Workstream B: verified npm distribution

**Implementation checkpoint (17 August 2026):** complete in the local Workstream B commit. Public
availability is deliberately not claimed yet because the package has not been pushed or published.

### Package shape

- `@longleash/cli`: the supported `longleash` executable, setup wizard, service lifecycle, doctor,
  update, devices, dashboard, hooks, and MCP entry point.
- `@longleash/mcp`: optional if a separately versioned package is operationally useful. Prefer one
  signed CLI package with `longleash mcp` unless dependency isolation requires a split.
- The package contains built artifacts required at runtime. It must not clone a mutable Git branch
  during normal installation.
- The package declares the exact repository, license, supported operating systems, Node floor,
  included files, and executable entry points. `npm pack --dry-run` must be inspected in CI.

### Supply-chain controls

- Publish only from a protected GitHub Actions workflow using npm trusted publishing with OIDC.
- Require npm account 2FA, a protected release environment, protected tags, clean tests, and a
  public repository/source match.
- Generate npm provenance automatically through trusted publishing. Do not store a long-lived npm
  write token in GitHub.
- Pin action revisions or trusted major versions according to repository policy and give the publish
  job only `contents: read` and `id-token: write`.
- Fail publication if the package contains `.env`, credentials, local databases, logs, pairing URLs,
  test secrets, or unexpected files.
- The website must not switch to the npm command until the published tarball installs and passes the
  clean-machine matrix on macOS and Linux.

### Owner dependency

The maintainer controls the `@longleash` npm organization and has enabled 2FA. The unscoped package
name is not available. After the first scoped package exists, the
trusted publisher can be bound to the exact GitHub repository and workflow. This is the only owner
action required for package identity; no npm token should be shared in chat or committed.

### Acceptance gate

- Fresh macOS and Linux users can run `npx @longleash/cli@latest setup` and receive the same verified
  build that CI tested.
- `npm view` shows the expected owner, source repository, integrity, version, and provenance.
- Install, upgrade, downgrade, doctor, and uninstall are idempotent and preserve user data unless the
  user explicitly requests data removal.
- The old GitHub-pipe installer remains documented only as a transparent fallback during migration.

### Implementation evidence and remaining release gates

- `@longleash/cli` packages the built phone app, daemon, device utility, and provider hooks without
  cloning a mutable branch or running a LongLeash install lifecycle script.
- Setup stages a versioned release, serializes concurrent installers, verifies package identity,
  restores configuration and managed files on failure, switches the active symlink atomically, and
  makes background operation an explicit reviewed choice. Uninstall removes only managed files and preserves user data.
- Direct and transitive runtime dependencies are pinned through exact manifest versions plus a
  checked npm shrinkwrap. The package verifier enforces the file allowlist, official-registry
  SHA-512 integrity, expected bundled dependency notices, public package identity, and an 8 MiB
  unpacked-size ceiling.
- The real tarball passed macOS arm64 install, doctor, repeat setup, forced activation failure,
  rollback, wrapper execution, and uninstall. The production dependency audit reported no known
  vulnerabilities. Repository typechecks, 837 ordinary tests, production builds, relay dry-run,
  and VSIX packaging passed.
- The tokenless publish workflow uses an exact tag/version match, a protected GitHub environment,
  pinned actions, npm 11, `contents: read`, and `id-token: write`. It runs the tarball matrix on
  Linux Node 22.14 and macOS Node 24 before publishing.
- The real Claude reopen contract passed after its assertion was corrected to count assistant text
  instead of the user's prompt. The Codex live contract is currently blocked by the local Codex
  account's provider usage limit; it is not recorded as a product pass or failure.

Before changing the public website to npm, the maintainer must push this commit, let the clean
Linux/macOS workflow pass, bootstrap the first `rc` package with npm 2FA, bind the trusted publisher,
publish a second `rc` through that tokenless workflow, verify its ownership, integrity, and
provenance, and repeat the real tarball matrix from the public registry. The one-time bootstrap
release cannot carry provenance because npm cannot bind a trusted publisher before the package
exists. Until the complete sequence passes, `@latest` is not a valid public promise.

## Workstream C: resilient background service

### User experience

```text
longleash setup
longleash service status
longleash service start
longleash service stop
longleash service restart
longleash service logs
longleash service uninstall
longleash run                 # explicit foreground mode
```

Setup explains the allowed roots, relay choice, agent hooks, login-start behavior, and local data
path before writing configuration. The recommended option installs the per-user background service.
Foreground mode remains useful for debugging and development.

### macOS implementation

- Install a per-user LaunchAgent under `~/Library/LaunchAgents`; never a root LaunchDaemon.
- Use absolute executable and data paths, explicit environment, standard output/error log paths,
  `RunAtLoad`, and bounded restart behavior.
- Use modern `launchctl bootstrap`, `bootout`, `kickstart`, and `print` operations where supported.
- Validate the generated plist with `plutil` before loading it.

### Linux implementation

- Install a systemd user unit under `~/.config/systemd/user`.
- Use an explicit executable, environment file, working directory, `Restart=on-failure`, bounded
  restart delay, and a clean SIGTERM shutdown.
- Use `systemctl --user daemon-reload`, enable/start, status, journal logs, disable, and removal.
- Document user-session behavior and optional lingering honestly; do not silently request root.

### Service invariants

- One daemon instance per user data directory.
- Updates use an atomic staged install and only restart after verification succeeds.
- A crash cannot create a restart storm.
- Logs redact device tokens, relay secrets, pairing fragments, prompts, code, and environment values.
- Sleep and network changes recover through the existing outbound relay reconnection and listener
  rebind logic. The service must expose health and version through the local authenticated boundary.
- Removing the service does not remove paired devices, settings, audit history, or repositories.

### Acceptance gate

- Phone control survives closing the setup terminal, opening a new shell, agent restarts, laptop
  sleep/wake, Wi-Fi changes, relay interruption, daemon crash, and user login.
- Stop and uninstall are reliable and leave no live process.
- Foreground and service modes cannot run simultaneously against the same data directory.
- macOS and Linux clean-user tests cover install, start, crash recovery, update, logs, stop, and
  uninstall.

### Implementation evidence and remaining release gates

- The release candidate implements a managed macOS LaunchAgent and Linux systemd user unit with absolute
  executable paths, mode-0600 definitions, explicit environments, non-root ownership, validated
  writes, bounded restart behavior, and transactional rollback.
- A data-directory instance lock rejects live duplicate writers, recovers only recognized dead
  owners, and fails closed on malformed or symlinked locks. CLI signal forwarding prevents an
  orphan daemon when the service manager stops its parent process.
- Pairing QRs are requested across the authenticated laptop-local boundary and never created at
  service boot. Durable logging drops provider frames and fails closed on prompts, code, paths,
  pairing data, URLs, device names, environment values, and arbitrary exception text.
- macOS arm64 physical service acceptance passed install, authenticated health, duplicate-writer
  refusal, forced crash recovery, stop, restart, uninstall, and data preservation against an isolated
  temporary home and data directory. No maintainer daemon or data was used.
- Linux lifecycle, rollback, ownership, permissions, restart policy, and login-scope reporting pass
  deterministic manager tests. A real clean Linux systemd-user run, macOS sleep/wake and login
  checks, and the complete release-candidate matrix remain required before Gate 2 closes.
- `@longleash/cli@0.1.0-rc.4` was built and exercised from the same tarball on clean GitHub-hosted
  Linux Node 22 and macOS Node 24 jobs, then published through npm trusted publishing. The public
  registry artifact exposes an npm signature and SLSA provenance; a fresh independent install
  reported 218 verified registry signatures and 21 verified attestations.
- The `rc` channel resolves to `0.1.0-rc.4`. Prerelease installations now remain on `rc` when users
  run `longleash update`, while stable installations follow `latest`; exact-version rollback remains
  available. This prevents the npm bootstrap's unavoidable `latest` tag from downgrading an RC user.

## Workstream D: human-verifiable pairing

### Protocol

1. The daemon creates the existing high-entropy, short-lived pairing challenge.
2. Phone and daemon derive an ephemeral encrypted pairing channel from that challenge.
3. Both derive the same short authentication string from a domain-separated transcript containing
   protocol version, challenge identity, and both ephemeral roles.
4. The terminal shows the code and states that the user must compare it with the phone.
5. The phone shows the same code with two explicit actions: **Codes match** and **They do not match**.
6. The daemon keeps the pairing pending. It does not create or persist a device token or relay secret.
7. Only the confirmed path commits the device. Rejection, expiry, disconnect, daemon restart, or a
   second competing attempt destroys pending state.

The code is not a replacement for the 256-bit QR secret. It is a human-checkable confirmation that
the encrypted session reached the laptop in front of the user.

### Migration and abuse handling

- Introduce a versioned pairing message rather than changing version 1 ambiguously.
- A current phone with an older daemon receives a precise update requirement.
- An older phone cannot silently skip confirmation against a newer daemon.
- Rate-limit pending attempts locally and through the hosted relay ticket boundary.
- Never log the QR secret, durable device token, relay secret, or complete pairing URL.
- Pairing screenshots and browser history guidance remain visible.

### Acceptance gate

- LAN, hosted relay, and reference self-hosted relay pairing pass.
- Matching, mismatch, timeout, replay, QR reuse, competing guest, corrupt frame, relay disconnect,
  daemon restart, stale app, and stale daemon cases are tested.
- No durable device row or usable credential exists before confirmation.
- Physical iPhone tests verify readability, camera flow, background/foreground transitions, and the
  negative “wrong code” path.

## Workstream E: LongLeash MCP

### Purpose

The MCP server lets Claude Code or Codex explain, configure, diagnose, and operate LongLeash through
the same local authority that the CLI and dashboard use. It reduces setup friction; it does not keep
the laptop online and does not carry phone traffic. The background daemon and selected network mode
remain responsible for those jobs.

### Initial safe tools

| Capability | MCP operation | Safety behavior |
| --- | --- | --- |
| Inspect | status, version, doctor, supported providers, service state | Read-only; redact paths where possible and all secrets always |
| Plan setup | validate prerequisites, propose roots, explain connectivity choices | Dry-run by default; return exact planned writes |
| Configure | set allowed roots, relay mode, hooks, update channel | Explicit user confirmation; atomic backup and rollback |
| Service | install, start, stop, restart, logs, uninstall | Explicit confirmation for persistent or destructive changes |
| Devices | list, begin pairing, revoke one, revoke all | Pairing secret stays out of model context; revocation requires confirmation |
| Sessions | list, inspect status, stop, tune, open dashboard | Same device, approval, provider, and workspace-lease checks as the product |
| Diagnostics | create redacted support bundle | Excludes prompts, code, tokens, environment values, and raw transcripts by default |

### Explicitly excluded

- Generic shell execution.
- Arbitrary file reads or writes.
- Returning pairing URLs, device tokens, relay secrets, provider credentials, or Clerk tokens to the
  model.
- Disabling approvals, expanding roots, moving workspace ownership, or deleting data without an
  explicit confirmation step and audit record.
- A public HTTP listener. The default transport is local stdio.

### Setup experience

Each connectivity guide contains a “Got no time?” path with provider-specific copyable MCP
configuration for local and project scope. The agent first runs a dry inspection, shows the user the
plan, applies approved changes, starts or verifies the service, and returns a redacted health report.

### Acceptance gate

- Claude Code and Codex can install/configure the MCP server at supported scopes using documented
  commands.
- Tool schemas, timeouts, cancellation, errors, logs, version negotiation, and concurrent calls pass.
- Prompt-injection tests prove repository content cannot invoke privileged setup or leak secrets.
- MCP and CLI operations produce the same config and audit results.

## Workstream F: desktop operations dashboard

### Scope

- `longleash dashboard` opens the loopback application using the daemon's current bound port.
- Desktop information architecture shows service health, update/build state, connectivity path,
  paired devices, allowed roots, active sessions, pending approvals, workspace ownership, and
  redacted recent diagnostics.
- The phone remains the primary away-from-desk control surface. The dashboard adds observability and
  keyboard-scale management; it does not create a second source of truth.
- Destructive actions retain confirmation, reason, audit, and immediate UI feedback.

### Acceptance gate

- The dashboard never opens a relay URL or exposes a token in the browser address bar.
- Loopback access has a local-auth boundary and cannot be reached through DNS rebinding or a hostile
  web origin.
- Empty, loading, reconnecting, stale-build, failure, partial-provider, and many-session states are
  designed and tested at mobile and desktop widths.

## Release sequence

### Gate 0: preserve the baseline

- [x] Record the known-good production build and CI run.
- [x] Run the existing full test, typecheck, build, packaging, and self-host configuration suite.
- [x] Do not start or stop the maintainer's local daemon during implementation unless explicitly
  requested.

### Gate 1: public truth

- [x] Ship browser title and metadata copy.
- [x] Ship outcome-based roadmap.
- [x] Ship connectivity comparison and setup documentation.
- [x] Separate the accountless self-hosted Worker configuration from branded production and pass a Wrangler dry run.
- [ ] Mark npm, service, pairing confirmation, MCP, dashboard, and VS Code companion accurately until
  their own gates pass.

### Gate 2: distribution and lifecycle

- [x] Build scoped npm package and package-content checks.
- [x] Build macOS LaunchAgent and Linux systemd user-service lifecycle.
- [ ] Complete clean-machine and update/rollback matrices.
- [x] Obtain npm scope ownership and configure OIDC trusted publishing.
- [x] Publish a release candidate, verify provenance, then change the public install command.

### Gate 3: verified pairing

- [ ] Land versioned pending-pairing protocol.
- [ ] Land terminal and phone comparison UI.
- [ ] Pass adversarial, compatibility, relay, LAN, and physical-device matrices.

### Gate 4: agent-assisted setup and dashboard

- [ ] Land local MCP server and provider setup recipes.
- [ ] Land loopback dashboard command and desktop states.
- [ ] Pass authority, injection, secret-redaction, concurrency, and accessibility gates.

### Gate 5: public release candidate

- [ ] Dependency and supply-chain audit.
- [ ] Worker dry run and production deploy from protected CI.
- [ ] Hosted account, relay, legacy endpoint, LAN, self-hosted, service, pairing, MCP, dashboard, and
  provider matrices.
- [ ] Physical iPhone installation, camera, pairing, verification, backgrounding, notification,
  approval, reply, stop, tuning, handoff, delegation, revoke, update, and recovery checklist.
- [ ] Documentation link crawl, code-block execution check, responsive and accessibility review.
- [ ] Only after every applicable box is backed by evidence may the release be called ready.

## Rollback strategy

- Website changes can roll back independently without changing device credentials or daemon state.
- npm releases are immutable. A bad version is deprecated, its dist-tag is moved to the last known
  good version, and users receive a precise downgrade command.
- Service installation keeps the prior executable and configuration until the new health check
  passes. Failed upgrades restore the prior version and restart it.
- Pairing protocol ships with explicit version negotiation. Rollback never treats an unconfirmed
  pending pair as a valid device.
- MCP and dashboard are optional clients of the daemon authority. Disabling either does not affect
  phone connectivity or existing sessions.

## Evidence log

| Date | Evidence | Result |
| --- | --- | --- |
| 17 Aug 2026 | Repository audit | Current public installer is GitHub-clone based; daemon is foreground-only; pairing commits on secret proof without a human confirmation step. |
| 17 Aug 2026 | npm registry audit | `longleash@0.4.1` belongs to another maintainer; `@longleash/cli` and `@longleash/mcp` return 404 but require ownership of the `@longleash` scope before use. |
| 17 Aug 2026 | npm ownership checkpoint | Maintainer confirmed creation of the `@longleash` organization and account-level 2FA. Package publication remains blocked until Workstream B creates and verifies the first package. |
| 17 Aug 2026 | Official platform review | npm trusted publishing supports GitHub OIDC and provenance; macOS recommends per-user LaunchAgents for user processes; MCP stdio is appropriate for a local server launched by the client. |
| 17 Aug 2026 | Baseline release evidence | Production commit `04e7d4e` passed CI run `32048432762`. The Workstream A candidate passed 826 automated tests, every package typecheck and build, verified VSIX packaging, `git diff --check`, and an accountless Wrangler dry run whose only runtime bindings were `ROOM` and `ASSETS`. LongLeash was not started or stopped. |
| 17 Aug 2026 | Workstream A implementation | Public titles and metadata use outcome copy; the roadmap has no Phase 1 or Phase 2A product labels; first-party connectivity documentation covers hosted relay, self-hosted relay, and LAN-only; rendered-route tests cover landmarks and the keyboard-reachable comparison table. Physical responsive and browser accessibility acceptance remains part of Gate 5 and is not inferred from source tests. |
| 20 Aug 2026 | Workstream B release bootstrap | `@longleash/cli@0.1.0-rc.1` was published from the locally verified tarball and its registry SHA-512 integrity matched exactly. This one-time bootstrap has no provenance; trusted-publisher release evidence is still required before `latest`. |
| 20 Aug 2026 | Workstream C implementation | Per-user launchd and systemd lifecycles, authenticated service health and pairing, duplicate-daemon locking, signal forwarding, fail-closed durable logs, public service documentation, and ownership/rollback tests are implemented. Isolated macOS launchd acceptance passed; clean Linux, login, sleep/wake, and release-candidate matrices remain open. |
| 20 Aug 2026 | Workstream C public candidate | Protected PR #8 merged as `9ad3409`; CI, production deployment, and the independent branded-route/security/auth matrix passed on that exact commit. `@longleash/cli@0.1.0-rc.4` passed clean Linux and macOS tarball jobs and was published through npm trusted publishing with an npm signature and SLSA provenance. The public `rc` channel, fresh install, CLI entry point, registry signatures, attestations, and prerelease update-channel behavior were verified. Physical iPhone, macOS login and sleep/wake, and real systemd-user acceptance remain open. |

## Next implementation checkpoint

Workstreams A and B are isolated commits, and Workstream C is published as the `rc.4` public
candidate. The next product workstream is D, human-verifiable pairing, but Workstream C's physical
macOS login and sleep/wake checks plus a real Linux systemd-user run must still close before the
lifecycle gate is called release-ready. Keep the website on npm `rc` until every applicable public
release gate passes and a stable version is intentionally promoted to `latest`. Physical browser and
device acceptance remains mandatory before the public release candidate gate closes.
