#!/usr/bin/env bash
# Real systemd-user acceptance for the ephemeral Ubuntu GitHub runner. This intentionally refuses
# developer machines: it installs, kills, restarts, and removes a user unit as release evidence.
set -euo pipefail

if [[ "${CI:-}" != "true" || -z "${RUNNER_TEMP:-}" || "$(uname -s)" != "Linux" ]]; then
  echo "Refusing to run outside an ephemeral Linux CI runner." >&2
  exit 2
fi

tarball="${1:-}"
if [[ -z "$tarball" || ! -f "$tarball" ]]; then
  echo "Usage: systemd-acceptance.sh <verified-package.tgz>" >&2
  exit 2
fi
tarball="$(realpath "$tarball")"

case "${XDG_RUNTIME_DIR:-}" in
  /run/user/*) ;;
  *) echo "A real systemd user runtime is required." >&2; exit 2 ;;
esac
systemctl --user show-environment >/dev/null

case_dir="$(mktemp -d "$RUNNER_TEMP/longleash-systemd.XXXXXX")"
project="$case_dir/project"
data="$case_dir/data"
install_home="$case_dir/install"
bin_dir="$case_dir/bin"
mkdir -p "$project" "$data" "$install_home" "$bin_dir"

export LONGLEASH_DATA="$data"
export LONGLEASH_INSTALL_HOME="$install_home"
export LONGLEASH_BIN_DIR="$bin_dir"
export LONGLEASH_PACKAGE_SPEC="$tarball"
export LONGLEASH_ALLOW_LOCAL_PACKAGE=1

wrapper="$bin_dir/longleash"
unit="$HOME/.config/systemd/user/longleash.service"
environment="$HOME/.config/longleash/service.env"

cleanup() {
  systemctl --user stop longleash.service >/dev/null 2>&1 || true
  systemctl --user disable longleash.service >/dev/null 2>&1 || true
  rm -f "$unit" "$environment"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  rm -rf "$case_dir"
}
trap cleanup EXIT

diagnose_failure() {
  status=$?
  echo "systemd acceptance failed; collecting service evidence" >&2
  systemctl --user status longleash.service --no-pager >&2 || true
  journalctl --user-unit longleash.service -n 200 --no-pager >&2 || true
  if [[ -f "$environment" ]]; then
    echo "managed environment file (values redacted):" >&2
    sed -E 's/=.*/=<redacted>/' "$environment" >&2 || true
  fi
  if [[ -f "$data/config.json" ]]; then
    echo "isolated configuration:" >&2
    sed -E 's/(secret|token|key)"[[:space:]]*:[[:space:]]*"[^"]*"/\1":"<redacted>"/Ig' "$data/config.json" >&2 || true
  fi
  return "$status"
}
trap diagnose_failure ERR

if systemctl --user is-active --quiet longleash.service || [[ -e "$unit" ]]; then
  echo "Refusing to replace a pre-existing LongLeash user service." >&2
  exit 2
fi

npm exec --yes --registry=https://registry.npmjs.org/ --package="$tarball" -- \
  longleash setup --yes --root "$project" --relay off --skip-hooks --service

test -x "$wrapper"
status_json="$($wrapper service status --json)"
node -e '
  const state = JSON.parse(process.argv[1]);
  if (!state.installed || !state.loaded || !state.active || !state.healthy) process.exit(1);
' "$status_json"
test "$(stat -c %a "$unit")" = "600"
test "$(stat -c %a "$environment")" = "600"
grep -q '^Restart=on-failure$' "$unit"
grep -q '^StartLimitBurst=5$' "$unit"

first_pid="$(systemctl --user show longleash.service --property MainPID --value)"
test "$first_pid" -gt 1

# A full-cgroup crash proves bounded restart behavior without leaving the daemon child behind.
systemctl --user kill --kill-whom=all --signal=SIGKILL longleash.service
for _ in $(seq 1 100); do
  next_pid="$(systemctl --user show longleash.service --property MainPID --value)"
  if systemctl --user is-active --quiet longleash.service && [[ "$next_pid" -gt 1 && "$next_pid" != "$first_pid" ]]; then
    break
  fi
  sleep 0.2
done
test "${next_pid:-0}" -gt 1
test "$next_pid" != "$first_pid"
$wrapper service status --json >/dev/null

# Re-applying a verified release must restart the active unit, not report health from old memory.
before_update="$next_pid"
npm exec --yes --registry=https://registry.npmjs.org/ --package="$tarball" -- \
  longleash setup --reuse-config --yes --skip-hooks --service
after_update="$(systemctl --user show longleash.service --property MainPID --value)"
test "$after_update" -gt 1
test "$after_update" != "$before_update"
$wrapper service status --json >/dev/null

$wrapper service logs >/dev/null
$wrapper service stop
! systemctl --user is-active --quiet longleash.service
$wrapper service start
systemctl --user is-active --quiet longleash.service

printf 'preserve\n' > "$data/acceptance-sentinel"
$wrapper service uninstall
! systemctl --user is-active --quiet longleash.service
test ! -e "$unit"
test -f "$data/acceptance-sentinel"

printf '{"platform":"linux","manager":"systemd-user","lifecycle":"passed"}\n'
