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
    echo "LongLeash updated."
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
    printf '\nAgents\n'
    if command -v claude >/dev/null 2>&1; then
      printf '  Claude Code     installed, hook %s\n' \
        "$(grep -q longleash-hook "$HOME/.claude/settings.json" 2>/dev/null && echo 'installed' || echo 'NOT installed — run: longleash hooks')"
    else
      printf '  Claude Code     not installed\n'
    fi
    if command -v codex >/dev/null 2>&1; then
      printf '  Codex CLI       %s, hook %s\n' \
        "$(codex --version 2>/dev/null | head -1)" \
        "$(grep -q '>>> LongLeash' "${CODEX_HOME:-$HOME/.codex}/config.toml" 2>/dev/null && echo 'installed' || echo 'NOT installed — run: longleash hooks')"
    else
      printf '  Codex CLI       not installed\n'
    fi
    printf '\n'
    exit 0 ;;
  where)
    echo "$DIR"; exit 0 ;;
  -h|--help|help)
    echo "longleash [folders…]     watch these folders (default: $ROOTS)"
    echo "longleash doctor         show what is actually wired up right now"
    echo "longleash devices        list the phones paired with this laptop"
    echo "longleash revoke <id>    cut off a lost or stolen device, immediately"
    echo "longleash update         pull the newest version, rebuild, re-apply hooks"
    echo "longleash hooks          install the agent hooks (--remove to undo)"
    echo "longleash where          print where LongLeash is installed"
    exit 0 ;;
esac

cd "$DIR/packages/daemon"
if [ "$RELAY" != "off" ]; then export LONGLEASH_RELAY_URL="${LONGLEASH_RELAY_URL:-$RELAY}"; fi
if [ $# -gt 0 ]; then exec pnpm start "$@"; else exec pnpm start $ROOTS; fi
