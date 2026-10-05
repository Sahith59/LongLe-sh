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
