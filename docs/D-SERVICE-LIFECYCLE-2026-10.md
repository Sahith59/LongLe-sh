# Workstream D service lifecycle correction — 2026-10-05

## Failure and correction

The rc.12 → rc.13 macOS upgrade left a daemon child alive after launchd stopped its CLI parent. The orphan kept the daemon lock and listener, so the replacement could fail to start while a generic authenticated health check still saw the old process. This was observed on the owner's laptop; this change did not touch that running service.

The managed wrapper now accepts an internal `__service-run` argument and uses shell `exec` to start the daemon directly with the configured, validated project roots. launchd and systemd therefore supervise the daemon PID. macOS bootout paths also inspect the daemon lock for an existing legacy orphan. Shutdown is restricted to a process whose UID, orphan parent PID, executable command, and managed installation path match the lock, with SIGTERM followed by bounded SIGKILL if necessary. Unknown processes remain untouched.

Service install, start, restart, stop, and uninstall use the same macOS bootout handling, including a managed definition whose job is already unloaded. The Linux unit keeps its existing systemd kill policy while using the direct daemon entry. Service readiness now requires an authenticated `/health` response with the exact build from the packaged `runtime/app/dist/build.json` **and** a daemon lock PID matching launchd's or systemd's managed PID. Missing or mismatched evidence fails readiness.

## Local evidence

- CLI tests: 46 passed, including direct wrapper PID/argument execution, macOS loaded and unloaded orphan retirement, lock replacement refusal, unrelated process preservation, service definition ownership, rollback, exact build readiness, and manager PID correlation on macOS and Linux.
- CLI typecheck and build passed.
- npm package verification passed: 34 files in the rc.14 local tarball. This was a local validation artifact, not a publication.
- `git diff --check` passed.
- **Real isolated macOS launchd acceptance:** installed the local rc.14 tarball into `/tmp/longleash-isolated-service.E9bniv` without service setup or provider hook changes, then bootstrapped a unique disposable launchd label pointing to that package's managed `__service-run` wrapper. launchd reported PID 19774, identical to the daemon lock PID; authenticated `/health` returned build `dc74e96`, identical to the packaged build. Bootout removed the lock and process. A second bootstrap → bootout → bootstrap → bootout cycle used distinct daemon PIDs 27182 and 27225, both exited without orphans. The owner's `dev.longleash.daemon` PID stayed 41486 throughout. The disposable label was unloaded at the end.

## Remaining acceptance

Run an isolated real macOS upgrade from a prior packaged service that produces a legacy orphan; the real launchd test above covered the corrected direct daemon path, not that upgrade transition. Run a clean Linux systemd-user lifecycle with the packaged tarball. The owner's live service must only be updated in a coordinated step.


## Release and owner follow-up

Exact rc.14 tag CI `37349423372` passed the Linux systemd-user install/crash/update/logs/stop/start/uninstall gate and both Linux/macOS tarball checks. During the owner rc.13 → rc.14 rollout, initial setup failed readiness and left the old stalled daemon alive. A subsequent `longleash service start` used the new bounded retirement logic successfully without manual signals. The new direct daemon PID matched launchd, authenticated health/build checks passed, and CPU fell to 0.1% after nearly two minutes. This proves the recovery command; the initial setup failure is still under investigation and seamless legacy upgrade acceptance remains open.


### Initial activation cause and rc.15 correction

A disposable real launchd reproduction showed `bootout` returning immediately while the supervised Node CLI parent and its daemon child still existed with their original parent relationship after 1.2 seconds. rc.14 allowed only orphan PPID1 and checked for 500 ms, so it could skip that child before starting the replacement.

The correction captures the exact managed job's supervisor PID **before** bootout. Retirement may then accept that same surviving parent only when its UID and managed `longleash.mjs run` command also match. An arbitrary foreground process is not accepted. Unloaded jobs still require an orphan. Child lock kind/PID/token are rechecked before signaling; no provider process is matched by title. `ps -ww` prevents display-width truncation, although width did not cause this observed failure. rc.15 is assigned for this correction; it is not yet the live baseline.


### rc.15 verification and rollout

CLI **48/48** tests and typecheck pass, including disappearing-process ESRCH and unrelated foreground preservation. A disposable real launchd transition using the old managed parent/lock-backed child shape passed in **2.36 s**: both old processes exited, new direct manager PID matched lock and endpoint, owner service unchanged, disposable job verified unloaded.

PR #34 / release `ed7d72d` passed main test/image and tag Linux/macOS tarball + systemd checks. The owner's actual rc.14 → rc.15 setup then completed on the first attempt; authenticated service health and CLI/daemon/relay build agreement passed. The released package is available in the matching GitHub prerelease and npm `rc` tag; registry checksum matches the installed CI tarball. This supersedes the candidate-only status above.
