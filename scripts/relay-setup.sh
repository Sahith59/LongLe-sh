#!/usr/bin/env bash
# Sets up a LongLeash relay on a fresh Ubuntu server, from nothing to a working HTTPS
# endpoint. Safe to re-run: that is also how you deploy an update.
#
#   curl -fsSL https://raw.githubusercontent.com/Sahith59/LongLe-sh/main/scripts/relay-setup.sh | bash -s -- my-relay.example.com
#
# What it does: installs Docker, opens the host firewall for 80/443, clones or updates the
# repo, builds the relay image, and starts it behind Caddy with an automatic certificate.
set -euo pipefail

DOMAIN="${1:-${LONGLEASH_DOMAIN:-}}"
REPO="${LONGLEASH_REPO:-https://github.com/Sahith59/LongLe-sh.git}"
DIR="${LONGLEASH_DIR:-$HOME/longleash}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\n\033[31mError: %s\033[0m\n' "$1" >&2; exit 1; }

[ -n "$DOMAIN" ] || die "Give me the hostname this relay will answer on.
   Usage: bash relay-setup.sh <your-domain>"

case "$DOMAIN" in
  http*|*/*) die "Hostname only — no https:// and no trailing path. Example: relay.example.com" ;;
esac

# ── The name must already point here, or the certificate cannot be issued ────
say "Checking that $DOMAIN points at this server"
PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org || true)"
RESOLVED="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
if [ -n "$PUBLIC_IP" ] && [ -n "$RESOLVED" ] && [ "$PUBLIC_IP" != "$RESOLVED" ]; then
  printf '   This server is %s but %s resolves to %s.\n' "$PUBLIC_IP" "$DOMAIN" "$RESOLVED"
  die "Fix the DNS record first, or the certificate step will fail."
fi
[ -n "$RESOLVED" ] || printf '   (Could not resolve it yet — continuing; DNS may still be propagating.)\n'

# ── Docker ───────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER" || true
fi
DOCKER="docker"
docker info >/dev/null 2>&1 || DOCKER="sudo docker"

# ── Host firewall ────────────────────────────────────────────────────────────
# Oracle's Ubuntu images ship iptables rules that drop everything except SSH, and the rules
# are saved to disk. Opening the cloud Security List alone is not enough — this is the step
# that traps almost everyone.
say "Opening ports 80 and 443 on the host firewall"
if command -v ufw >/dev/null 2>&1 && sudo ufw status 2>/dev/null | grep -q "Status: active"; then
  sudo ufw allow 80/tcp >/dev/null && sudo ufw allow 443/tcp >/dev/null
  printf '   ufw rules added.\n'
else
  for PORT in 80 443; do
    if ! sudo iptables -C INPUT -p tcp --dport "$PORT" -m state --state NEW -j ACCEPT 2>/dev/null; then
      # Above the catch-all REJECT that Oracle's images place at the end. Index 6 matches
      # their stock chain; a shorter chain rejects that index, so fall back to the top.
      sudo iptables -I INPUT 6 -p tcp --dport "$PORT" -m state --state NEW -j ACCEPT 2>/dev/null \
        || sudo iptables -I INPUT 1 -p tcp --dport "$PORT" -m state --state NEW -j ACCEPT
    fi
  done
  sudo mkdir -p /etc/iptables
  sudo netfilter-persistent save >/dev/null 2>&1 \
    || sudo sh -c 'iptables-save > /etc/iptables/rules.v4' 2>/dev/null \
    || printf '   (Could not persist rules; they apply now but may reset on reboot.)\n'
  printf '   iptables rules added.\n'
fi

# ── Code ─────────────────────────────────────────────────────────────────────
if [ -d "$DIR/.git" ]; then
  say "Updating the code in $DIR"
  git -C "$DIR" pull --ff-only
else
  say "Cloning into $DIR"
  if ! command -v git >/dev/null 2>&1; then
    sudo apt-get update -qq && sudo apt-get install -y -qq git
  fi
  git clone --depth 1 "$REPO" "$DIR"
fi

# ── Build and run ────────────────────────────────────────────────────────────
say "Building and starting the relay (first build takes a few minutes)"
cd "$DIR/deploy"
# Written to a file rather than passed inline: when docker needs sudo, sudo drops the
# environment and compose would see no domain at all. It also makes updates one command.
printf 'LONGLEASH_DOMAIN=%s\n' "$DOMAIN" > .env
$DOCKER compose up -d --build

# ── Prove it actually works ──────────────────────────────────────────────────
say "Waiting for the certificate and a healthy answer"
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 "https://$DOMAIN/health" 2>/dev/null | grep -q '"role":"relay"'; then
    printf '\n\033[32m✓ Relay is live at https://%s\033[0m\n\n' "$DOMAIN"
    printf 'On your laptop, run the daemon with:\n\n'
    printf '  LONGLEASH_RELAY_URL=wss://%s pnpm start ~\n\n' "$DOMAIN"
    exit 0
  fi
  sleep 5
done

die "It did not answer on https://$DOMAIN within five minutes.
   Check, in this order:
     1. $DOCKER compose -f $DIR/deploy/docker-compose.yml logs caddy
     2. Oracle Console → your instance → subnet → Security List: ingress for TCP 80 and 443
     3. curl -I http://$DOMAIN   (port 80 must work for the certificate to be issued)"
