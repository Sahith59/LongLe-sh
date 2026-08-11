#!/usr/bin/env bash
#
# Ship a release everywhere it has to land.
#
#   bash scripts/release.sh
#
# WHY THIS EXISTS. The phone loads the web app from the RELAY (`packages/relay/wrangler.jsonc`
# binds `../app/dist` as ASSETS), not from the laptop. So `git pull` + build + restart updates
# the daemon and changes NOTHING a phone sees. On 2026-08-09 that shipped a whole release —
# agent picker, vendor labels, VS Code labelling — that no phone could ever load, and the
# product simply looked broken. There was nothing to notice, because nothing said anything.
#
# Two guards now exist and this script is the first:
#   1. releasing deploys the relay together with the app it was built from, and
#   2. the daemon reports the build it expects, so a stale phone announces itself.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n\n' "$1" >&2; exit 1; }

BUILD="$(git rev-parse --short HEAD)"

if [ -n "$(git status --porcelain -- packages scripts)" ]; then
  die "There are uncommitted changes under packages/ or scripts/.
  The build is stamped with the git commit, so an uncommitted release would claim to be
  something it is not. Commit first, then release."
fi

# The relay and the laptop must come from the same checkout. Releasing from a development
# checkout while `longleash` still points at an older installed clone creates the exact split
# brain this command exists to prevent: the phone updates, but every local hook and daemon
# restart keeps executing the old product.
if command -v longleash >/dev/null 2>&1; then
  INSTALLED_DIR="$(longleash where 2>/dev/null || true)"
  if [ -n "$INSTALLED_DIR" ] && [ "$INSTALLED_DIR" != "$PWD" ]; then
    INSTALLED_BUILD="$(git -C "$INSTALLED_DIR" rev-parse --short HEAD 2>/dev/null || true)"
    [ "$INSTALLED_BUILD" = "$BUILD" ] || die "The phone release would be $BUILD, but the installed laptop copy is ${INSTALLED_BUILD:-unknown} at:
  $INSTALLED_DIR
  Update that copy first, then release from it. Refusing to create another relay/laptop split."
  fi
fi

bold "Checking the whole product holds up"
pnpm typecheck || die "Typechecking failed. Nothing was deployed."
ok "every package typechecks"
pnpm test || die "Tests failed. Nothing was deployed."
ok "every package test passes"

bold "Building the web app"
pnpm --filter @longleash/app build >/dev/null || die "The web app did not build."
[ -f packages/app/dist/build.json ] || die "dist/build.json is missing — the daemon cannot tell a phone which build to expect."
STAMPED="$(node -p "require('./packages/app/dist/build.json').build")"
[ "$STAMPED" = "$BUILD" ] || die "The bundle is stamped $STAMPED but HEAD is $BUILD."
ok "built and stamped $BUILD"

bold "Deploying the relay — this is what the phone actually loads"
pnpm --filter @longleash/relay deploy:worker || die "The relay did not deploy. The phone is still on the OLD app."
ok "relay deployed with build $BUILD"

bold "Verifying the phone would really get it"
sleep 3
SERVED="$(curl -fsS https://longleash-relay.tsahith59.workers.dev/build.json 2>/dev/null || echo '')"
if [ -z "$SERVED" ]; then
  printf '  \033[33m!\033[0m Could not read build.json from the relay. Check it by hand before trusting this release.\n'
else
  SERVED_BUILD="$(printf '%s' "$SERVED" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).build" 2>/dev/null || echo '?')"
  [ "$SERVED_BUILD" = "$BUILD" ] \
    && ok "the relay is serving $SERVED_BUILD" \
    || die "The relay is serving $SERVED_BUILD but this release is $BUILD. The phone would NOT get this."
fi

printf '\n\033[1mReleased %s.\033[0m\n\n' "$BUILD"

# The daemon is a long-running process: it keeps executing whatever code it was STARTED with.
# Releasing while it runs updates the relay and the files on disk and changes nothing about the
# daemon's behaviour — which on 2026-08-09 wasted an entire test round, because every fix was
# on disk and none of it was in the process being tested. Say so loudly rather than assume.
if pgrep -f 'longleashd|packages/daemon' >/dev/null 2>&1; then
  printf '\033[33m  ! A daemon is still RUNNING the old code.\033[0m\n'
  printf '    Nothing in this release applies to it until you restart it:\n\n'
  printf '        stop it with Ctrl-C in its terminal, then:  longleash\n\n'
else
  printf '  Start it with:  longleash\n\n'
fi
printf '  On the phone: pull down to refresh, or tap Update if the app offers it.\n\n'
