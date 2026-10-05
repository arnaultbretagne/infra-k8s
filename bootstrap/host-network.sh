#!/usr/bin/env bash
# ============================================================================
# host-network — the node declares its own address (static), instead of
# asking DHCP for it.
#
# Why: with `inet dhcp`, every carrier loss makes dhcpcd ask the router again;
# when no answer comes within its 5 s reboot window, it drops the address and
# falls back to IPv4LL (169.254.x.x). A blip of a few seconds then becomes an
# outage that only an out-of-band reboot ends — and netguard, seeing the link
# up with no connectivity, reads it as a datapath takeover and disables k0s.
# Seen on 2026-09-17 and 2026-10-05. A router-side DHCP reservation does not
# help: the node still waits for the router's answer.
#
# Input (env): PUBLIC_IP — the node's address, already assigned (as for
# bootstrap.sh). Everything else is read from the address in effect: the
# interface holding PUBLIC_IP, its prefix, MAC (a router-side reservation is
# keyed on it), MTU, default gateway, and /etc/resolv.conf.
#
# Only ifupdown is handled: when that interface is not declared `inet dhcp` in
# /etc/network/interfaces, nothing is changed. Idempotent: an interface already
# declared static by this script is left alone.
#
# Applying bounces the interface (a few seconds): `ifdown` with the stanza that
# brought it up, the new files, `ifup`. It runs in a transient systemd unit, so
# an SSH session dropping meanwhile does not stop it halfway; if the gateway
# does not answer within 60 s, the previous files are put back and the
# interface brought up again with them.
#
#   sudo -n env PUBLIC_IP=<address> ./bootstrap/host-network.sh [--dry-run]
# ============================================================================

set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

INTERFACES=/etc/network/interfaces
INTERFACES_D=/etc/network/interfaces.d
MARKER="# Written by infra-k8s bootstrap/host-network.sh"

log()  { printf '    %s\n' "$*"; }
ok()   { printf '    \033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '    \033[1;33m⚠ %s\033[0m\n' "$*"; }
fail() { printf '    \033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ─── The apply step, inside its transient unit ────────────────────────
# $2: the staging directory, holding interfaces, iface.conf, resolv.conf and
# the values the check needs (iface, gateway).
if [ "${1:-}" = "__apply" ]; then
  STAGE=$2
  IF=$(cat "$STAGE/iface") GW=$(cat "$STAGE/gateway")
  BACKUP="$STAGE/backup"
  mkdir -p "$BACKUP"
  cp -p "$INTERFACES" "$BACKUP/interfaces"
  cp -p /etc/resolv.conf "$BACKUP/resolv.conf"
  logger -t host-network "switching $IF to a static address; previous files in $BACKUP"
  ifdown "$IF" || true
  install -m 0644 "$STAGE/interfaces" "$INTERFACES"
  install -m 0644 "$STAGE/iface.conf" "$INTERFACES_D/$IF"
  # dhcpcd no longer runs for it: the resolver is the node's own file now.
  install -m 0644 "$STAGE/resolv.conf" /etc/resolv.conf
  ifup "$IF" || true
  for _ in $(seq 30); do
    if ping -c1 -W2 "$GW" >/dev/null 2>&1; then
      logger -t host-network "$IF static, gateway $GW reachable"
      exit 0
    fi
    sleep 2
  done
  logger -t host-network "gateway $GW unreachable after 60 s: restoring the previous configuration"
  ifdown "$IF" || true
  rm -f "$INTERFACES_D/$IF"
  install -m 0644 "$BACKUP/interfaces" "$INTERFACES"
  install -m 0644 "$BACKUP/resolv.conf" /etc/resolv.conf
  ifup "$IF" || true
  exit 1
fi

DRY_RUN=false
[ "${1:-}" = "--dry-run" ] && DRY_RUN=true

[ "$(id -u)" -eq 0 ] || fail "Must run as root"
[ -n "${PUBLIC_IP:-}" ] || fail "PUBLIC_IP not set (the node's address, already assigned)"
command -v ifup >/dev/null || { warn "ifupdown not installed: the network is managed otherwise, left as is"; exit 0; }

# ─── What is in effect ────────────────────────────────────────────────
read -r IF CIDR < <(ip -4 -o addr show scope global | awk -v ip="$PUBLIC_IP" '{ split($4, a, "/"); if (a[1] == ip) { print $2, $4; exit } }') || true
[ -n "${IF:-}" ] || fail "PUBLIC_IP is not assigned to this host: $PUBLIC_IP"
GW=$(ip -4 route show default dev "$IF" | awk '/^default/ { print $3; exit }')
[ -n "$GW" ] || fail "No default route through $IF"
MAC=$(cat "/sys/class/net/$IF/address")
MTU=$(cat "/sys/class/net/$IF/mtu")
NAMESERVERS=$(awk '/^nameserver/ { print $2 }' /etc/resolv.conf)
[ -n "$NAMESERVERS" ] || fail "No nameserver in /etc/resolv.conf to keep"
SEARCH=$(awk '/^(domain|search)/ { $1 = ""; sub(/^ /, ""); print; exit }' /etc/resolv.conf)

if [ -f "$INTERFACES_D/$IF" ] && grep -qF "$MARKER" "$INTERFACES_D/$IF"; then
  if grep -q "^iface $IF inet static" "$INTERFACES_D/$IF" && grep -q "address $CIDR\$" "$INTERFACES_D/$IF"; then
    ok "$IF already static ($CIDR via $GW)"
    exit 0
  fi
  fail "$INTERFACES_D/$IF was written for another address: check it by hand"
fi
if ! awk -v ifc="$IF" '$1 == "iface" && $2 == ifc && $3 == "inet" && $4 == "dhcp" { found = 1 } END { exit !found }' "$INTERFACES"; then
  warn "$IF is not declared 'inet dhcp' in $INTERFACES: left as is"
  exit 0
fi

# ─── The new files ────────────────────────────────────────────────────
# Kept after the run: the previous files stay there, under backup/.
if $DRY_RUN; then
  STAGE=$(mktemp -d)
else
  mkdir -p /var/lib/host-network
  STAGE=$(mktemp -d "/var/lib/host-network/$(date +%Y%m%d-%H%M%S).XXXX")
fi
printf '%s\n' "$IF" > "$STAGE/iface"
printf '%s\n' "$GW" > "$STAGE/gateway"

# The interfaces file without the interface's stanza: its `auto` or
# `allow-hotplug` line, its `iface … inet` line and the options under it.
awk -v ifc="$IF" '
  ($1 == "auto" || $1 == "allow-hotplug") && NF == 2 && $2 == ifc { next }
  $1 == "iface" && $2 == ifc && $3 == "inet" { skipping = 1; next }
  skipping && /^[ \t]/ { next }
  { skipping = 0; print }
' "$INTERFACES" > "$STAGE/interfaces"

cat > "$STAGE/iface.conf" <<EOF
$MARKER: the node's own address, not
# DHCP's, so that a link loss never takes it away. Keep the router's DHCP
# reservation for this MAC, so that nothing else is given the address.
auto $IF
iface $IF inet static
    address $CIDR
    gateway $GW
    hwaddress ether $MAC
    mtu $MTU
EOF

{
  printf '%s\n' "$MARKER: the resolver the DHCP lease gave."
  [ -n "$SEARCH" ] && printf 'search %s\n' "$SEARCH"
  for ns in $NAMESERVERS; do printf 'nameserver %s\n' "$ns"; done
} > "$STAGE/resolv.conf"

if $DRY_RUN; then
  log "$IF: $CIDR via $GW, MAC $MAC, MTU $MTU — would become static"
  for f in iface.conf resolv.conf; do printf '\n--- %s\n' "$f"; cat "$STAGE/$f"; done
  printf '\n--- %s, changed lines\n' "$INTERFACES"
  diff "$INTERFACES" "$STAGE/interfaces" || true
  rm -rf "$STAGE"
  exit 0
fi

# ─── Apply, out of this session ───────────────────────────────────────
log "$IF: $CIDR via $GW — switching to static (the interface bounces for a few seconds)"
systemd-run --quiet --unit="host-network-apply-$(date +%s)" --collect --property=Type=oneshot \
  --wait "$(readlink -f "$0")" __apply "$STAGE" \
  || fail "the gateway did not answer with the static address: the previous configuration is back ($STAGE/backup)"
ok "$IF static: $CIDR via $GW"
