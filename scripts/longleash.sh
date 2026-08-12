#!/usr/bin/env bash
#
# Everything the `longleash` command does. This file lives IN the repo on purpose.
#
# The installer used to bake the whole command into ~/.local/bin/longleash, which meant the
# command was a snapshot of the day it was installed: `longleash update` pulled new code but
# the command kept doing whatever it did in the beginning. New subcommands were invisible, and
# nothing said so — the user just saw a command that quietly did less than the docs claimed.
#
# Now ~/.local/bin/longleash is a two-line stub that runs this, so behaviour ships with the code.
#
# The stub provides: LONGLEASH_DIR, LONGLEASH_DEFAULT_ROOTS, LONGLEASH_DEFAULT_RELAY.
set -euo pipefail

DIR="${LONGLEASH_DIR:?the longleash stub must set LONGLEASH_DIR}"
ROOTS="${LONGLEASH_DEFAULT_ROOTS:-$HOME}"
RELAY="${LONGLEASH_DEFAULT_RELAY:-off}"

hooks_install() {
  # Every agent present gets wired up. Each installer refuses on its own terms — a missing or
  # too-old CLI must never stop the others from being installed.
  node "$DIR/packages/daemon/hooks/install-hooks.mjs" "$@" || true
  if command -v codex >/dev/null 2>&1; then
    node "$DIR/packages/daemon/hooks/install-codex-hooks.mjs" "$@" || true
  else
    printf '\n  Codex CLI not found — skipping its hook. Install Codex, then run: longleash hooks\n'
  fi
}

case "${1:-}" in
  update)
    git -C "$DIR" pull --ff-only
    ( cd "$DIR" && pnpm install --silent --prod=false && pnpm --filter @longleash/app build >/dev/null )
    # Hooks are re-applied on update: a new release may add an agent or change a hook's shape,
    # and a stale hook fails silently, which is the worst way for this to break.
    hooks_install
    echo "LongLeash files, app, and hooks updated."
    if pgrep -f 'longleashd|packages/daemon' >/dev/null 2>&1; then
      printf 'IMPORTANT: a running daemon still has the old code in memory.\n'
      printf 'Stop it with Ctrl-C and run longleash again before testing this update.\n'
    fi
    exit 0 ;;
  hooks)
    hooks_install "${@:2}"
    exit 0 ;;
  devices)
    exec node "$DIR/packages/daemon/bin/longleash-devices.mjs" ;;
  revoke)
    exec node "$DIR/packages/daemon/bin/longleash-devices.mjs" revoke "${@:2}" ;;
  doctor)
    # What is actually wired up right now, rather than what the docs assume.
    printf '\nLongLeash\n'
    printf '  code            %s\n' "$DIR"
    printf '  version         %s\n' "$(git -C "$DIR" log --oneline -1 2>/dev/null || echo unknown)"
    printf '  web app built   %s\n' \
      "$([ -f "$DIR/packages/app/dist/index.html" ] && echo yes || echo 'NO — run: longleash update')"
    printf '  relay           %s\n' "$RELAY"
    printf '  watching        %s\n' "$ROOTS"
    DAEMON_BUILD=""
    ENDPOINT="$HOME/.longleash/hook-endpoint.json"
    if [ -f "$ENDPOINT" ]; then
      HOOK_URL="$(node -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).url||'')}catch{}" "$ENDPOINT")"
      if [ -n "$HOOK_URL" ]; then
        DAEMON_HEALTH="$(curl -fsS --max-time 2 "${HOOK_URL%/hook}/health" 2>/dev/null || true)"
      else
        DAEMON_HEALTH=""
      fi
      if [ -n "$HOOK_URL" ] && [ -n "$DAEMON_HEALTH" ]; then
        DAEMON_BUILD="$(printf '%s' "$DAEMON_HEALTH" | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{try{process.stdout.write(JSON.parse(s).build||'')}catch{}})")"
        printf '  daemon          reachable (%s) · build %s\n' \
          "${HOOK_URL%/hook}" "${DAEMON_BUILD:-unknown/old}"
      else
        printf '  daemon          NOT reachable — start: longleash\n'
      fi
    else
      printf '  daemon          has never started — start: longleash\n'
    fi
    LOCAL_BUILD="$(node -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).build||'')}catch{}" "$DIR/packages/app/dist/build.json")"
    BUILD_MATCH="$([ -n "$LOCAL_BUILD" ] && [ -n "$DAEMON_BUILD" ] && [ "$LOCAL_BUILD" = "$DAEMON_BUILD" ] && echo match || echo MISMATCH)"
    printf '  code builds     laptop %s · daemon %s · %s\n' \
      "${LOCAL_BUILD:-missing}" "${DAEMON_BUILD:-unknown/old}" "$BUILD_MATCH"
    if [ "$RELAY" != "off" ]; then
      # Configuration stores the WebSocket endpoint (`wss://host/ws`), while build.json is
      # served from the corresponding HTTPS app origin.
      RELAY_ORIGIN="${RELAY/wss:\/\//https://}"
      RELAY_ORIGIN="${RELAY_ORIGIN/ws:\/\//http://}"
      RELAY_ORIGIN="${RELAY_ORIGIN%/ws}"
      # The bare static-asset URL can briefly remain cached after Wrangler activates a release.
      # Key the check by the build we expect and ask intermediaries to revalidate, or doctor can
      # report a mismatch after the public app is already correct.
      RELAY_BUILD="$(curl -fsS --max-time 3 -H 'Cache-Control: no-cache' "${RELAY_ORIGIN%/}/build.json?doctor=${LOCAL_BUILD:-unknown}" 2>/dev/null | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{try{process.stdout.write(JSON.parse(s).build||'')}catch{}})" || true)"
      printf '  app builds      laptop %s · relay %s%s\n' \
        "${LOCAL_BUILD:-missing}" "${RELAY_BUILD:-unreachable}" \
        "$([ -n "$LOCAL_BUILD" ] && [ "$LOCAL_BUILD" = "$RELAY_BUILD" ] && echo ' · match' || echo ' · MISMATCH')"
    fi
    printf '\nAgents\n'
    if command -v claude >/dev/null 2>&1; then
      printf '  Claude Code     installed, hook %s\n' \
        "$(grep -Fq "$DIR/packages/daemon/hooks/longleash-hook.mjs" "$HOME/.claude/settings.json" 2>/dev/null && echo 'installed for this build' || echo 'STALE/MISSING — run: longleash hooks')"
    else
      printf '  Claude Code     not installed\n'
    fi
    if command -v codex >/dev/null 2>&1; then
      printf '  Codex CLI       %s, hook %s\n' \
        "$(codex --version 2>/dev/null | head -1)" \
        "$(grep -Fq "$DIR/packages/daemon/hooks/longleash-codex-hook.mjs" "${CODEX_HOME:-$HOME/.codex}/config.toml" 2>/dev/null && echo 'installed for this build' || echo 'STALE/MISSING — run: longleash hooks')"
    else
      printf '  Codex CLI       not installed\n'
    fi
    printf '\n'
    exit 0 ;;
  release)
    # Ships to the relay too — the phone loads the app from there, not from this laptop.
    exec bash "$DIR/scripts/release.sh" ;;
  where)
    echo "$DIR"; exit 0 ;;
  -h|--help|help)
    echo "longleash [folders…]     watch these folders (default: $ROOTS)"
    echo "longleash doctor         show what is actually wired up right now"
    echo "longleash devices        list the phones paired with this laptop"
    echo "longleash revoke <id>    cut off a lost or stolen device, immediately"
    echo "longleash revoke --all   cut off EVERY paired device and start fresh"
    echo "longleash update         pull the newest version, rebuild, re-apply hooks"
    echo "longleash hooks          install the agent hooks (--remove to undo)"
    echo "longleash release        build, test, and deploy the app the PHONE loads"
    echo "longleash where          print where LongLeash is installed"
    exit 0 ;;
esac

cd "$DIR/packages/daemon"
if [ "$RELAY" != "off" ]; then export LONGLEASH_RELAY_URL="${LONGLEASH_RELAY_URL:-$RELAY}"; fi
if [ $# -gt 0 ]; then exec pnpm start "$@"; else exec pnpm start $ROOTS; fi
