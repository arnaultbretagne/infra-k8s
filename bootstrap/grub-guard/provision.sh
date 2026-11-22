#!/usr/bin/env bash
# Install grub-cfg-guard (see the header of ./grub-cfg-guard for why).
# Called by bootstrap/bootstrap.sh; safe to re-run, and to run alone on a node
# already up:
#   sudo -n ./bootstrap/grub-guard/provision.sh
#
# - /usr/local/sbin/grub-cfg-guard
# - /etc/apt/apt.conf.d/99grub-cfg-guard: runs it after every dpkg run, the
#   unattended-upgrades ones included, directly rather than through systemd
#   (on 2026-11-22 systemd was the part of the host that had failed)
# - grub-cfg-guard.timer: hourly, in case apt's run met a degraded host and
#   could not repair yet
# - /var/lib/node_exporter/textfile: read by node-exporter's textfile
#   collector (observability/kube-prometheus-stack.yaml)
# Then runs it once: a node whose grub.cfg would not boot fails here.
set -euo pipefail

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

HERE="$(cd "$(dirname "$0")" && pwd)"

log() { printf '    -> %s\n' "$*"; }
fail() { printf '    grub-cfg-guard provisioning failed: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "must run as root"
for cmd in awk findmnt flock logger mountpoint paste; do
  command -v "$cmd" >/dev/null 2>&1 || fail "missing command: $cmd"
done

log "guard script"
install -o root -g root -m 0755 "$HERE/grub-cfg-guard" /usr/local/sbin/grub-cfg-guard
install -d -o root -g root -m 0755 /var/lib/node_exporter/textfile

log "apt hook"
cat >/etc/apt/apt.conf.d/99grub-cfg-guard <<'EOF'
// infra-k8s bootstrap/grub-guard: after every dpkg run, check that grub.cfg would boot and
// regenerate it if not. Never fails apt: a broken grub.cfg is reported by the HostGrub* alerts.
DPkg::Post-Invoke { "if [ -x /usr/local/sbin/grub-cfg-guard ]; then /usr/local/sbin/grub-cfg-guard || true; fi"; };
EOF
grep -q 'grub-cfg-guard' <<<"$(apt-config dump 2>/dev/null)" || fail "apt does not read /etc/apt/apt.conf.d/99grub-cfg-guard"

log "hourly timer"
cat >/etc/systemd/system/grub-cfg-guard.service <<'EOF'
[Unit]
Description=grub-cfg-guard: check that grub.cfg would boot, regenerate it if not

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/grub-cfg-guard
EOF
cat >/etc/systemd/system/grub-cfg-guard.timer <<'EOF'
[Unit]
Description=grub-cfg-guard, hourly

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
RandomizedDelaySec=5min

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now grub-cfg-guard.timer >/dev/null 2>&1
systemctl is-active --quiet grub-cfg-guard.timer || fail "grub-cfg-guard.timer is not active"

log "first run"
/usr/local/sbin/grub-cfg-guard || fail "grub.cfg would not boot and could not be regenerated (journalctl -t grub-cfg-guard)"
