# D3 release readiness — 2026-10-04

**Current 2026-10-05 release:** universal session identity, browser reconnect cleanup, managed service lifecycle and exact phone ↔ LongLeash VS Code editor control are released in rc.14 / extension 0.0.3 at build `614d44d`. Exact-commit CI, npm publication, production HTTP checks and installed laptop build checks pass. The first owner upgrade needed `longleash service start` recovery; its initial activation race is reproduced, with an rc.15 correction under verification. [Current implementation and gates](IDE-CONTROL-IMPLEMENTATION-2026-10.md) supersedes the older ordering and read-only preview limitations below. Physical phone and Marketplace installation acceptance are still open; Workstream D is not declared closed.


**Field update, 2026-10-05:** rc.12 was subsequently published and deployed. The owner's physical iPhone then exposed repeated empty Claude VS Code cards, so D remains open. The rc.13 correction and read-only companion preview are documented in [VS Code field correction](VSCODE-LIVE-INVENTORY-2026-10.md); the historical rc.12 candidate figures below are retained as the earlier checkpoint. The owner must retest the real provider matrix after rc.13 is live.

**Prior release update:** rc.13 is now on npm and deployed at build `37de078`; its owner-preview VSIX is attached to the GitHub prerelease and installed locally. Automated deployment remains blocked by D1 token scope, while the manual exact-commit production matrix passed. The installed daemon is healthy after stopping an orphan rc.12 process. Physical phone and exact IDE handoff acceptance remain open.

**Release checkpoint:** D3 and Workstream D remain open until physical phone acceptance. The owner has now authorized committing, pushing, publishing and deploying the candidate for live testing. Record each actual release result below; do not mark a gate passed because a command was planned. Continue D before E/F.

## Findings fixed in this candidate

1. **Missing new Codex VS Code conversations:** the watcher only recognized files present at startup or files with a subsequent mtime increase. A new transcript created after startup could remain invisible until a second write. It now discovers newly encountered files immediately, recognizes changed timestamps, and uses the same `CODEX_HOME` as the hook installer when configured. Existing allowlisted-root and VS Code-source checks remain.
2. **Misleading diagnostics:** npm CLI `doctor` lacked the build/hook evidence referenced in acceptance docs. It now reports packaged/daemon/relay build comparison, pairing protocol and per-provider configured hooks. Missing build evidence says unknown. Hook configuration is explicitly not evidence of provider trust or fresh-process hook loading. Doctor now uses the validated local endpoint request path rather than sending its secret to an unchecked endpoint URL.
3. **Dependency release gate:** production workspace audit initially returned 13 advisories (4 high, 9 moderate). Updated Fastify to 5.12.5, fast-uri overrides to 3.1.8/4.1.5, brace-expansion to 5.0.12 and ip-address to 10.7.1; regenerated the independent npm shrinkwrap. Both dependency graphs now report zero known production vulnerabilities. This is a dated advisory scan, not proof that software has no vulnerabilities.
4. **Package acceptance:** actual installed tarball smoke now checks v2 daemon health, local QR creation/cancellation and absence of QR secrets in redirected startup output, in addition to install/reinstall/rollback/uninstall.
5. **Release provenance:** legacy release script's uncommitted-source guard now includes dependency manifests, lockfile and workflows.
6. **Session visibility evidence:** socket checklist covers all four Claude/Codex × terminal/VS Code origins and proves phone reconnect retains one correctly labeled card.
7. **Local endpoint after network movement:** read-only inspection of the owner's running rc.11 service found it listening on `10.66.62.167` while `hook-endpoint.json` still named `192.168.1.71`. The daemon now republishes that 0600 record atomically after a successful rebind, serializes network moves, and retries after failed moves. A real-daemon regression changes listener host and verifies the authenticated endpoint follows it. The currently running old service needs a version update/restart to receive this fix.

Security references: [Fastify maintainer advisory](https://github.com/fastify/fastify/security/advisories/GHSA-4mh8-r7rc-xpvc), [fast-uri advisory](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj), [ip-address advisory](https://github.com/advisories/GHSA-j6r3-76f7-8jcv), [brace-expansion advisory](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr). The npm graph can resolve different compatible transitive versions from pnpm; both graphs are locked and audited independently.

## Evidence gathered

| Gate | Result / limit |
| --- | --- |
| Full automated suite after local-endpoint fix | **1,071 pass:** protocol 80, relay 127, app 192, daemon 600, VS Code 30, CLI 42. Exact-commit CI remains required |
| Typechecks and builds | All six packages pass |
| Real provider contract suite | **11 pass**, Claude + Codex start/stream, approval, denial, cwd, stop/reopen/continuation and resumable transcript; run in disposable test projects, before dependency refresh |
| Session discovery wire matrix | All four provider/origin combinations pass, including reconnect without duplicates; synthetic hook payloads against real daemon/WS, not physical VS Code UI acceptance |
| CLI package verification | Passed on local rc.12 candidate (34 files); exact-commit CI remains required before publication |
| Actual installed tarball | Passed on rc.12, macOS arm64 / Node 26.0.0; isolated config/install/root, no service installation or real provider-config changes |
| Install transaction | Setup twice, wrapper, config permissions, activation failure rollback, uninstall preserves data |
| Published-package data upgrade and rollback | **Passed on macOS:** paired a synthetic device against npm rc.11, stopped it, started the candidate against the same isolated data, authenticated that device over WebSocket, then rolled back to rc.11 and authenticated again. Added `verify-upgrade.mjs` to the Linux/macOS candidate CI matrix; those CI runs remain pending |
| Pairing | D2 LAN/reference-relay/workerd suites retained; added packaged v2 health/create/cancel/no-log-secret check |
| Workspace production dependency audit | Zero known vulnerabilities after updates |
| Packaged npm production dependency audit | Zero known vulnerabilities; shrinkwrap consistency check passes |
| Worker deploy dry-run | Passed; no deployment |
| Current public production read-only matrix | Passed for **7266155**, not this uncommitted candidate |
| Cloudflare remote migration listing | Now succeeds: **No migrations to apply**. Earlier 7403 did not recur. Does not prove owner/login/email business flows |
| Release script syntax / diff whitespace | Passed |

Logs were written under `/tmp/longleash-d3-*`; this document is the durable summary. Candidate package integrity is in the local pack-verification output. No test log containing QR secrets or provider transcript content was added to the repository.

## Still required to close D3

1. **Physical iPhone:** camera QR, Safari and installed PWA, both confirmation orders, mismatch/cancel/expiry, Wi-Fi/cellular, background/lock/network loss, fresh-QR recovery, notifications, reduced motion, enlarged text and VoiceOver. The connected tool environment does not provide the owner's physical phone; browser emulation cannot substitute.
2. **Exact candidate CI:** clean Linux Node 22/macOS Node 24 tarball matrix and real Linux systemd-user lifecycle. Local Docker daemon is unavailable; these gates were not claimed passed. Do not trigger current main deployment just to get CI evidence. Run candidate checks through a non-deploying branch/PR after the user's release checkpoint.
3. **Platform service acceptance:** real macOS login service lifecycle/upgrade on an isolated user or agreed disposable setup. The user's currently running daemon and service were preserved.
4. **Release compatibility:** macOS published rc.11 → candidate → rc.11 device-data continuity now passes using real packaged daemons and an authenticated WebSocket. Old/new QR rejection and registry persistence tests also pass. Complete the exact candidate CI and physical old/new browser/service-update matrix; this local test did not drive browser storage, camera or an OS service upgrade.
5. **P5 authenticated production acceptance:** owner MFA, ordinary-account denial, signup/sign-in, persisted feedback and signed mail/inbox evidence. Public readiness/config and no-pending-migration results are necessary but insufficient.
6. **Session field acceptance:** fresh terminal and VS Code integrated-terminal sessions for both providers; vendor panels tested separately with honest read-only controls where only transcript observation exists. The unrelated LongLeash companion sidebar still lacks authenticated live sync (`PHASE2A-CHECKPOINT.md`). A clarification about where the user previously saw missing sessions was requested; no answer was available at this checkpoint.
7. **Coordinated immutable release:** rc.12 is assigned. Commit reviewed candidate source, rebuild/test exact commit, pass CI, publish through the trusted tag workflow and deploy the app/relay from that same commit. Verify live build and update/restart the laptop deliberately before physical production acceptance. rc.11 currently published does not contain these changes; never republish it.

Some final device/production checks necessarily follow the controlled rollout; they cannot be truthfully marked complete before deployment. The owner has authorized that rollout. Do not call the product or Workstream D closed from local evidence alone.

## Next session

Read this file, `WORKSTREAM-D-VERIFIED-PAIRING.md`, `PHONE-LAPTOP-WALKTHROUGH.md`, `ACCEPTANCE.md` and `CUSTOMER-FEEDBACK-AND-MEASUREMENT.md`. Resolve the outstanding session-surface clarification and acceptance gates. The detailed walkthrough is prepared now and must receive the exact released version/build once live.
