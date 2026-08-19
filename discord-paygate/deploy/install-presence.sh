#!/usr/bin/env bash
# Install Ripley's Discord gateway presence keeper as a systemd service on a
# fresh Debian/Ubuntu VM.
#
#   1. put this file and presence.js in the same directory on the VM
#   2. sudo bash install-presence.sh
#   3. paste the bot token when prompted
#
# The token is read from the terminal with echo off, so it never reaches your
# shell history, a file you might commit, or a chat log. It ends up only in
# /etc/ripley/presence.env, root-owned, mode 600.
#
# Safe to re-run: it updates presence.js and restarts the service.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP=/opt/ripley
ENV_DIR=/etc/ripley
UNIT=/etc/systemd/system/ripley-presence.service

die() { echo "error: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run with sudo: sudo bash $(basename "$0")"

# presence.js may sit beside this script or under scripts/, depending on
# whether you uploaded two files or cloned the repo.
SRC=""
for c in "$DIR/presence.js" "$DIR/scripts/presence.js" "$DIR/../scripts/presence.js"; do
  [ -f "$c" ] && { SRC="$c"; break; }
done
[ -n "$SRC" ] || die "presence.js not found next to this script"

# ── Node ─────────────────────────────────────────────────────────────────────
# presence.js uses the global WebSocket, stable from Node 22.5. Distro
# packages are usually older, so check the version rather than just presence.
node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit((a>22||(a===22&&b>=5))?0:1)' 2>/dev/null
}
if node_ok; then
  echo "==> node $(node -v) is new enough"
else
  echo "==> installing Node 22 from NodeSource"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  node_ok || die "node is still older than 22.5 after install: $(node -v 2>/dev/null || echo none)"
  echo "==> node $(node -v) installed"
fi

# ── service account + files ──────────────────────────────────────────────────
id -u ripley >/dev/null 2>&1 || {
  echo "==> creating the ripley system user"
  useradd --system --home "$APP" --shell /usr/sbin/nologin ripley
}
install -d -o ripley -g ripley -m 755 "$APP" "$APP/scripts"
install -o ripley -g ripley -m 644 "$SRC" "$APP/scripts/presence.js"
echo "==> installed $APP/scripts/presence.js"

# ── token ────────────────────────────────────────────────────────────────────
install -d -o root -g root -m 700 "$ENV_DIR"
if [ -s "$ENV_DIR/presence.env" ] && grep -q '^DISCORD_BOT_TOKEN=.\+' "$ENV_DIR/presence.env"; then
  echo "==> keeping the existing token in $ENV_DIR/presence.env"
else
  echo
  echo "Paste the bot token (Developer Portal -> Bot -> Reset Token)."
  echo "Nothing will appear as you type or paste."
  printf 'token: '
  read -rs TOKEN
  echo
  [ -n "$TOKEN" ] || die "no token entered"
  # A bot token is three dot-separated parts. Catches pasting a client secret
  # or an application ID by mistake, which would otherwise fail at 4004 later.
  case "$TOKEN" in
    *.*.*) : ;;
    *) die "that does not look like a bot token (expected three dot-separated parts)" ;;
  esac
  umask 077
  printf 'DISCORD_BOT_TOKEN=%s\nPRESENCE_TEXT=ripleybot.com\nPRESENCE_TYPE=3\nPRESENCE_STATUS=online\n' "$TOKEN" > "$ENV_DIR/presence.env"
  unset TOKEN
  chown root:root "$ENV_DIR/presence.env"
  chmod 600 "$ENV_DIR/presence.env"
  echo "==> wrote $ENV_DIR/presence.env (root only)"
fi

# ── unit ─────────────────────────────────────────────────────────────────────
cat > "$UNIT" << 'UNITFILE'
[Unit]
Description=Ripley Discord gateway presence keeper
After=network-online.target
Wants=network-online.target
# presence.js exits 1 on a fatal auth error (revoked token, disabled bot).
# Retrying that forever just hammers Discord's gateway, so stop after five
# failures in ten minutes and leave the unit failed for a human to look at.
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
Type=simple
User=ripley
Group=ripley
WorkingDirectory=/opt/ripley
EnvironmentFile=/etc/ripley/presence.env
ExecStart=/usr/bin/env node /opt/ripley/scripts/presence.js
Restart=always
RestartSec=5s

# It makes one outbound TLS connection and needs nothing else from the box.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6
MemoryMax=256M

[Install]
WantedBy=multi-user.target
UNITFILE
chmod 644 "$UNIT"
systemctl daemon-reload
systemctl enable --now ripley-presence >/dev/null 2>&1 || true
systemctl restart ripley-presence

echo "==> waiting for the gateway handshake"
for _ in $(seq 1 15); do
  journalctl -u ripley-presence -n 50 --no-pager 2>/dev/null | grep -q 'online as' && break
  sleep 1
done

echo
if systemctl is-active --quiet ripley-presence && journalctl -u ripley-presence -n 50 --no-pager | grep -q 'online as'; then
  echo "ripley-presence is running. The bot should read Online now."
else
  echo "ripley-presence did not come online. Recent log:"
fi
echo
journalctl -u ripley-presence -n 15 --no-pager
echo
echo "follow it with:  journalctl -u ripley-presence -f"
