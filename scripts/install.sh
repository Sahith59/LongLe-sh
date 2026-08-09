#!/usr/bin/env bash
#
# LongLeash installer — nothing to nothing-left-to-do, in one command.
#
#   curl -fsSL https://raw.githubusercontent.com/Sahith59/LongLe-sh/main/scripts/install.sh | bash
#
# or, from a clone:  bash scripts/install.sh
#
# Design rules this file keeps:
#   • never needs sudo, and never edits anything outside $HOME
#   • idempotent — running it twice changes nothing the second time
#   • every prerequisite failure explains itself and how to fix it, then stops
#   • verifies at the end rather than declaring success on faith
#
set -euo pipefail

# Overridable so a fork — or a test — can install from somewhere else.
REPO_URL="${LONGLEASH_REPO:-https://github.com/Sahith59/LongLe-sh.git}"
INSTALL_DIR="${LONGLEASH_HOME:-$HOME/.longleash-app}"
BIN_DIR="$HOME/.local/bin"
DATA_DIR="$HOME/.longleash"
DEFAULT_RELAY="wss://longleash-relay.tsahith59.workers.dev/ws"
NEEDED_NODE_MAJOR=22

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n\n' "$1" >&2; exit 1; }

step() { printf '\n'; bold "$1"; }

# ---------------------------------------------------------------- prerequisites

step "Checking what this machine already has"

case "$(uname -s)" in
  Darwin) ok "macOS" ;;
  Linux)  ok "Linux" ;;
  *) die "LongLeash currently supports macOS and Linux. Yours reports $(uname -s)." ;;
esac

command -v git >/dev/null 2>&1 || die "git is required. Install Xcode command line tools with: xcode-select --install"
ok "git"

if ! command -v node >/dev/null 2>&1; then
  die "Node.js $NEEDED_NODE_MAJOR or newer is required.
  Install it from https://nodejs.org (choose the LTS build), then run this again."
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt "$NEEDED_NODE_MAJOR" ]; then
  die "Node.js $NEEDED_NODE_MAJOR or newer is required; this machine has $(node --version).
  Update it from https://nodejs.org, then run this again."
fi
ok "Node.js $(node --version)"

# pnpm comes with Node via corepack; enabling it is not a system change worth a prompt.
if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@10.33.2 --activate >/dev/null 2>&1 || true
  fi
fi
command -v pnpm >/dev/null 2>&1 || die "pnpm is required and could not be enabled automatically.
  Install it with:  npm install -g pnpm"
ok "pnpm $(pnpm --version)"

# The agents LongLeash watches. The daemon runs without any of them, but with nothing to show.
if command -v claude >/dev/null 2>&1; then
  ok "Claude Code $(claude --version 2>/dev/null | head -1 || echo 'installed')"
  HAVE_CLAUDE=1
else
  warn "Claude Code not found — install it from https://claude.com/claude-code"
  HAVE_CLAUDE=0
fi

# Codex is optional. Its hooks silently do nothing below 0.147.0, so an old Codex is
# reported as "too old" rather than wired up to fail quietly later.
CODEX_MIN="0.147.0"
if command -v codex >/dev/null 2>&1; then
  CODEX_VER="$(codex --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  if [ -n "$CODEX_VER" ] && [ "$(printf '%s\n%s\n' "$CODEX_MIN" "$CODEX_VER" | sort -V | head -1)" = "$CODEX_MIN" ]; then
    ok "Codex CLI $CODEX_VER"
    HAVE_CODEX=1
  else
    warn "Codex CLI ${CODEX_VER:-?} is too old for hooks — LongLeash needs $CODEX_MIN or newer."
    warn "Update with 'codex update', then run: longleash hooks"
    HAVE_CODEX=0
  fi
else
  HAVE_CODEX=0
fi

if [ "$HAVE_CLAUDE" = "0" ] && [ "$HAVE_CODEX" = "0" ]; then
  warn "No supported agent CLI found. LongLeash will install anyway, but there is nothing to watch yet."
fi

# ------------------------------------------------------------------ get the code

step "Getting LongLeash"

if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" pull --ff-only --quiet 2>/dev/null || warn "Could not update; using the copy already here."
  ok "Updated $INSTALL_DIR"
elif [ -f "$(dirname "${BASH_SOURCE[0]}")/../package.json" ] && [ -z "${LONGLEASH_FORCE_CLONE:-}" ]; then
  # Run from a clone: install in place rather than making a second copy.
  INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  ok "Using this checkout: $INSTALL_DIR"
else
  git clone --quiet --depth 1 "$REPO_URL" "$INSTALL_DIR"
  ok "Cloned to $INSTALL_DIR"
fi

step "Installing dependencies and building the app"
dim "     (a minute or two the first time)"

LOG="$(mktemp -t longleash-install)"
# --config.confirmModulesPurge=false: piped into bash there is no TTY to answer a prompt
# with, and an installer that hangs on an invisible question is worse than one that fails.
run_quietly() {
  if ! "$@" >"$LOG" 2>&1; then
    printf '\n\033[31m✗ %s\033[0m\n\n' "That step failed. The last lines were:" >&2
    tail -25 "$LOG" >&2
    printf '\nFull log: %s\n\n' "$LOG" >&2
    exit 1
  fi
}
( cd "$INSTALL_DIR" && run_quietly pnpm install --prod=false --config.confirmModulesPurge=false )
ok "Dependencies installed"
( cd "$INSTALL_DIR" && run_quietly pnpm --filter @longleash/app build )
ok "Web app built"
rm -f "$LOG"

# ------------------------------------------------------------------ configuration

step "Configuring"

mkdir -p "$DATA_DIR" "$BIN_DIR"

RELAY="${LONGLEASH_RELAY_URL:-$DEFAULT_RELAY}"
if [ "$RELAY" = "off" ]; then
  ok "Relay disabled — this install works on your local network only"
else
  ok "Relay: $RELAY"
  dim "     (this is how your phone reaches the laptop from anywhere;"
  dim "      it only ever routes encrypted bytes it cannot read)"
fi

# Which folders agents may touch. Everything else on the machine stays off limits.
ROOTS="${LONGLEASH_ROOTS:-$HOME}"
ok "Agents may work in: $ROOTS"

# ------------------------------------------------------------------ the command

step "Creating the longleash command"

cat > "$BIN_DIR/longleash" <<WRAPPER
#!/usr/bin/env bash
# Created by the LongLeash installer. Safe to edit — the two lines below are the settings.
set -euo pipefail
LONGLEASH_DIR="$INSTALL_DIR"
DEFAULT_ROOTS="$ROOTS"
DEFAULT_RELAY="$RELAY"

case "\${1:-}" in
  update)
    git -C "\$LONGLEASH_DIR" pull --ff-only
    ( cd "\$LONGLEASH_DIR" && pnpm install --silent --prod=false && pnpm --filter @longleash/app build >/dev/null )
    echo "LongLeash updated."
    exit 0 ;;
  hooks)
    # Wire up every agent present. Each installer refuses on its own terms rather than
    # half-installing, so a missing or too-old CLI never blocks the others.
    node "\$LONGLEASH_DIR/packages/daemon/hooks/install-hooks.mjs" "\${@:2}" || true
    if command -v codex >/dev/null 2>&1; then
      node "\$LONGLEASH_DIR/packages/daemon/hooks/install-codex-hooks.mjs" "\${@:2}" || true
    fi
    exit 0 ;;
  devices)
    exec node "\$LONGLEASH_DIR/packages/daemon/bin/longleash-devices.mjs" ;;
  revoke)
    exec node "\$LONGLEASH_DIR/packages/daemon/bin/longleash-devices.mjs" revoke "\${@:2}" ;;
  where)
    echo "\$LONGLEASH_DIR"; exit 0 ;;
  -h|--help|help)
    echo "longleash [folders…]     watch these folders (default: \$DEFAULT_ROOTS)"
    echo "longleash devices        list the phones paired with this laptop"
    echo "longleash revoke <id>    cut off a lost or stolen device, immediately"
    echo "longleash update         pull the newest version and rebuild"
    echo "longleash hooks          re-install the agent hooks (--remove to undo)"
    echo "longleash where          print where LongLeash is installed"
    exit 0 ;;
esac

cd "\$LONGLEASH_DIR/packages/daemon"
if [ "\$DEFAULT_RELAY" != "off" ]; then export LONGLEASH_RELAY_URL="\${LONGLEASH_RELAY_URL:-\$DEFAULT_RELAY}"; fi
if [ \$# -gt 0 ]; then exec pnpm start "\$@"; else exec pnpm start \$DEFAULT_ROOTS; fi
WRAPPER
chmod +x "$BIN_DIR/longleash"
ok "Installed $BIN_DIR/longleash"

# Put it on PATH for future shells, without duplicating the line if it is already there.
PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'
for profile in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
  [ -e "$profile" ] || continue
  grep -qF '.local/bin' "$profile" 2>/dev/null && continue
  printf '\n# Added by the LongLeash installer\n%s\n' "$PATH_LINE" >> "$profile"
  ok "Added ~/.local/bin to PATH in $(basename "$profile")"
done

# ------------------------------------------------------------------ hooks

step "Connecting to your agents"
if [ "$HAVE_CLAUDE" = "1" ]; then
  node "$INSTALL_DIR/packages/daemon/hooks/install-hooks.mjs" >/dev/null
  ok "Claude Code — terminal sessions will appear on your phone"
  dim "     (your ~/.claude/settings.json was backed up first)"
else
  warn "Claude Code skipped — install it, then run: longleash hooks"
fi

if [ "$HAVE_CODEX" = "1" ]; then
  node "$INSTALL_DIR/packages/daemon/hooks/install-codex-hooks.mjs" >/dev/null
  ok "Codex CLI — sessions will appear on your phone"
  dim "     (your ~/.codex/config.toml was backed up first)"
  dim "     Codex will ask you to review the new hook on its next start — say yes,"
  dim "     or it will not run. That prompt is Codex protecting you; do not bypass it."
else
  warn "Codex skipped — install or update Codex, then run: longleash hooks"
fi

# ------------------------------------------------------------------ verify

step "Verifying"
[ -x "$BIN_DIR/longleash" ] || die "The longleash command was not created."
ok "Command is executable"
[ -f "$INSTALL_DIR/packages/app/dist/index.html" ] || die "The web app did not build."
ok "Web app present"
node -e "
const { execSync } = require('node:child_process')
execSync('node ' + JSON.stringify('$INSTALL_DIR/packages/daemon/hooks/longleash-hook.mjs'), {
  input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'verify', tool_name: 'Read' }),
})
" >/dev/null 2>&1 && ok "Hook script runs" || die "The hook script failed to run."

printf '\n'
bold "LongLeash is installed."
printf '\n'
echo "  Start it:      longleash"
echo "  Then:          scan the QR with your phone and add it to your home screen"
printf '\n'
dim "  If 'longleash' is not found, open a new terminal window first."
[ "$HAVE_CLAUDE" = "1" ] || dim "  Install Claude Code, then run: longleash hooks"
printf '\n'
