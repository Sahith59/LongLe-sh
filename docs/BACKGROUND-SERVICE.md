# Background service

LongLeash can run as a per-user background service, so closing the setup terminal does not sever
the phone from the laptop. It never installs a root daemon: macOS uses a LaunchAgent in the signed-in
user session, and Linux uses a systemd user unit.

## Setup

Interactive `longleash setup` recommends the background service and shows the selected roots and
connectivity mode before applying them. For automation, make the choice explicit:

```sh
longleash setup --yes --root ~/code --relay hosted --service
longleash setup --yes --root ~/code --relay hosted --no-service
```

`--no-service` keeps foreground behavior. Run `longleash run` and keep that terminal open.

## Daily commands

```sh
longleash service status
longleash service start
longleash service stop
longleash service restart
longleash service logs
longleash service logs --follow
longleash service uninstall
longleash pair
```

`status` combines service-manager state with an authenticated daemon health request. `pair` asks the
running daemon for a new single-use challenge and prints it only in the terminal that requested it;
the complete link is not written to persistent service logs.

Stopping or uninstalling the service preserves configuration, paired-device records, audit history,
repositories, and the managed CLI runtime. `longleash uninstall` removes the service and managed
runtime but still preserves local LongLeash data unless the user removes it separately.

## Platform behavior

### macOS

The managed plist is `~/Library/LaunchAgents/dev.longleash.daemon.plist`. It starts at user login,
uses absolute runtime and data paths, restarts failed jobs at a bounded rate, and writes redacted logs
under `~/.longleash/logs`. LongLeash validates the plist with `plutil` before launchd sees it and
refuses to replace a file or loaded job it does not own.

### Linux

The managed unit is `~/.config/systemd/user/longleash.service`, with a separate mode-0600 environment
file. It starts in the user's systemd session and uses `Restart=on-failure` with a start-rate limit.
By default it may stop when the user fully logs out. LongLeash reports that condition but does not
silently enable lingering or request root; users who deliberately want logout persistence should
follow their distribution's documented `loginctl enable-linger` policy.

## Safety properties

- One process owns a LongLeash data directory. A second foreground or service process fails before
  opening the databases.
- A recognized dead-owner lock is recovered; malformed and symlinked locks fail closed.
- SIGINT and SIGTERM reach the actual daemon child, preventing an orphan after manager shutdown.
- Persistent logs omit prompts, code, project paths, provider frames, pairing material, relay URLs,
  device names, environment values, and arbitrary exception details.
- Updates stage and verify a complete runtime before activation. Reusing configuration preserves an
  existing service choice and restarts only the verified runtime.
- Service removal refuses unmanaged or symlinked definitions and never removes LongLeash data.

## Diagnosis

```sh
longleash service status --json
longleash doctor
longleash service logs
```

If manager state says active but authenticated health fails, inspect the redacted logs. Do not kill
arbitrary Node processes or delete the lock first: the first failure is useful evidence. If a lock
names a process that is genuinely still alive, stop that foreground process or service normally.
