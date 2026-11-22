# Run by the tests workflow from this folder (tests/README.md); by hand, README.md.
# 1. bootstrap/grub-guard/grub-cfg-guard against a fake /boot and a fake grub-mkconfig, case by case.
# 2. promtool on the HostGrub* alerts, as the observability Flux Kustomization renders them.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
guard="$here/../../bootstrap/grub-guard/grub-cfg-guard"
fixtures="$here/fixtures"
# The two filesystems of g4, as the fixtures name them.
boot_uuid=4a4687f4-bb37-406e-b467-27d897639c1e
root_uuid=d5525426-9b37-4b61-acd2-4a6470f81f48

failed=0
pass() { echo "✔ $1"; }
fail() { echo "✖ $1"; failed=1; }

# A fresh fake host: $boot with the kernels the fixtures load, an empty
# textfile directory, and a grub-mkconfig writing $MKCONFIG_OUTPUT to -o.
setup() {
  work=$(mktemp -d)
  boot="$work/boot"
  mkdir -p "$boot/grub" "$work/textfile"
  for v in 6.12.101+deb13-amd64 6.12.107+deb13-amd64; do
    touch "$boot/vmlinuz-$v" "$boot/initrd.img-$v"
  done
  cat >"$work/grub-mkconfig" <<'EOF'
#!/usr/bin/env bash
[ "$1" = -o ] || exit 2
[ -n "${MKCONFIG_OUTPUT:-}" ] || exit 1
cp "$MKCONFIG_OUTPUT" "$2"
EOF
  chmod +x "$work/grub-mkconfig"
}

# Runs the guard on the fake host; separate /boot unless SEPARATE=0.
guard() {
  GRUB_CFG="$boot/grub/grub.cfg" BOOT_DIR="$boot" TEXTFILE_DIR="$work/textfile" \
    GRUB_MKCONFIG="$work/grub-mkconfig" GRUB_GUARD_LOCK="$work/lock" \
    GRUB_GUARD_BOOT_SEPARATE="${SEPARATE:-1}" GRUB_GUARD_BOOT_UUID="${UUID:-$boot_uuid}" \
    "$guard" "$@" 2>"$work/stderr"
}

metric() { awk -v m="$1" '$1 == m { print $2 }' "$work/textfile/grub_cfg_guard.prom" 2>/dev/null || true; }

# --- A good config passes and is reported as such.
setup
cp "$fixtures/separate-boot.cfg" "$boot/grub/grub.cfg"
if guard && [ "$(metric grub_cfg_valid)" = 1 ] && [ -n "$(metric grub_cfg_guard_last_run_timestamp_seconds)" ] \
  && [ -z "$(metric grub_cfg_guard_last_repair_timestamp_seconds)" ]; then
  pass "a good config passes: grub_cfg_valid 1, no repair"
else
  fail "a good config passes: grub_cfg_valid 1, no repair"
fi
if [ "$(stat -c %a "$work/textfile/grub_cfg_guard.prom")" = 644 ] && ! ls -A "$work/textfile" | grep -q '^\.'; then
  pass "the metrics file is readable by node-exporter, no temporary file left"
else
  fail "the metrics file is readable by node-exporter, no temporary file left"
fi

# --- The 2026-11-22 config is caught by --check, which changes nothing.
setup
cp "$fixtures/broken-2026-11-22.cfg" "$boot/grub/grub.cfg"
if ! guard --check && cmp -s "$fixtures/broken-2026-11-22.cfg" "$boot/grub/grub.cfg" \
  && [ ! -e "$work/textfile/grub_cfg_guard.prom" ] && grep -q '/boot/vmlinuz-6.12.101+deb13-amd64 is not on' "$work/stderr" \
  && grep -q "searches filesystem $root_uuid" "$work/stderr"; then
  pass "--check fails on the 2026-11-22 config, says why, changes nothing"
else
  fail "--check fails on the 2026-11-22 config, says why, changes nothing"
fi

# --- The 2026-11-22 config is regenerated when the new one boots.
setup
cp "$fixtures/broken-2026-11-22.cfg" "$boot/grub/grub.cfg"
if MKCONFIG_OUTPUT="$fixtures/separate-boot.cfg" guard \
  && cmp -s "$fixtures/separate-boot.cfg" "$boot/grub/grub.cfg" \
  && cmp -s "$fixtures/broken-2026-11-22.cfg" "$boot/grub/grub.cfg.guard-broken" \
  && [ ! -e "$boot/grub/grub.cfg.new" ] \
  && [ "$(metric grub_cfg_valid)" = 1 ] && [ -n "$(metric grub_cfg_guard_last_repair_timestamp_seconds)" ]; then
  pass "a broken config is replaced by a regenerated one that boots, the broken one kept"
else
  fail "a broken config is replaced by a regenerated one that boots, the broken one kept"
fi
repaired=$(metric grub_cfg_guard_last_repair_timestamp_seconds)
if guard && [ "$(metric grub_cfg_guard_last_repair_timestamp_seconds)" = "$repaired" ]; then
  pass "the repair time survives the next good run"
else
  fail "the repair time survives the next good run"
fi

# --- A regenerated config that would not boot either is not swapped in.
setup
cp "$fixtures/broken-2026-11-22.cfg" "$boot/grub/grub.cfg"
if ! MKCONFIG_OUTPUT="$fixtures/broken-2026-11-22.cfg" guard \
  && cmp -s "$fixtures/broken-2026-11-22.cfg" "$boot/grub/grub.cfg.guard-rejected" \
  && [ ! -e "$boot/grub/grub.cfg.guard-broken" ] && [ "$(metric grub_cfg_valid)" = 0 ]; then
  pass "a regenerated config that would not boot is rejected: grub_cfg_valid 0"
else
  fail "a regenerated config that would not boot is rejected: grub_cfg_valid 0"
fi

# --- grub-mkconfig failing: nothing replaced, reported.
setup
cp "$fixtures/broken-2026-11-22.cfg" "$boot/grub/grub.cfg"
if ! guard && cmp -s "$fixtures/broken-2026-11-22.cfg" "$boot/grub/grub.cfg" \
  && [ ! -e "$boot/grub/grub.cfg.new" ] && [ "$(metric grub_cfg_valid)" = 0 ]; then
  pass "grub-mkconfig failing leaves grub.cfg alone: grub_cfg_valid 0"
else
  fail "grub-mkconfig failing leaves grub.cfg alone: grub_cfg_valid 0"
fi

# --- The check follows the layout: the 2026-11-22 config is right for a host whose /boot is on /.
setup
cp "$fixtures/broken-2026-11-22.cfg" "$boot/grub/grub.cfg"
if SEPARATE=0 UUID=$root_uuid guard --check; then
  pass "/boot/vmlinuz-* entries pass when /boot is on the root filesystem"
else
  fail "/boot/vmlinuz-* entries pass when /boot is on the root filesystem"
fi
cp "$fixtures/separate-boot.cfg" "$boot/grub/grub.cfg"
if ! SEPARATE=0 UUID=$root_uuid guard --check; then
  pass "/vmlinuz-* entries fail when /boot is on the root filesystem"
else
  fail "/vmlinuz-* entries fail when /boot is on the root filesystem"
fi

# --- A kernel that is gone, or an entry searching another filesystem, fails.
setup
cp "$fixtures/separate-boot.cfg" "$boot/grub/grub.cfg"
rm "$boot/initrd.img-6.12.101+deb13-amd64"
if ! guard --check && grep -q 'initrd.img-6.12.101+deb13-amd64 is not on' "$work/stderr"; then
  pass "a missing initrd fails"
else
  fail "a missing initrd fails"
fi
setup
cp "$fixtures/separate-boot.cfg" "$boot/grub/grub.cfg"
if ! UUID=00000000-0000-0000-0000-000000000000 guard --check; then
  pass "an entry searching another filesystem fails"
else
  fail "an entry searching another filesystem fails"
fi

# --- An empty config fails; a host without GRUB is left alone.
setup
: >"$boot/grub/grub.cfg"
if ! guard --check; then pass "an empty grub.cfg fails"; else fail "an empty grub.cfg fails"; fi
setup
if GRUB_CFG="$work/none/grub.cfg" GRUB_MKCONFIG=/nonexistent "$guard" 2>/dev/null \
  && [ ! -e "$work/textfile/grub_cfg_guard.prom" ]; then
  pass "a host without GRUB: nothing to do"
else
  fail "a host without GRUB: nothing to do"
fi

# --- 2. The alerts.
promtool=${PROMTOOL:-}
if [ -z "$promtool" ]; then
  # As tests/flux-alerts/ci.sh: the version it is tested with, checked against its sha256.
  version=3.7.3
  sha256=fc9e5da126817438cf2820d9a7206c75e3122802ba8d20add3a6219a59ca6913
  dir="${RUNNER_TEMP:-$(mktemp -d)}/promtool-grub"
  mkdir -p "$dir"
  curl -fsSL --retry 5 -o "$dir/prometheus.tar.gz" \
    "https://github.com/prometheus/prometheus/releases/download/v$version/prometheus-$version.linux-amd64.tar.gz"
  echo "$sha256  $dir/prometheus.tar.gz" | sha256sum -c -
  tar -xzf "$dir/prometheus.tar.gz" -C "$dir" --strip-components=1 "prometheus-$version.linux-amd64/promtool"
  promtool="$dir/promtool"
fi
rules=$(mktemp -d)
# The bretagne-critical PrometheusRule's spec, out of the render (top-level keys at column 0, spec
# indented by two spaces).
"${KUBECTL:-kubectl}" kustomize "$here/../../observability" | awk '
  function done() {
    if (doc ~ /(^|\n)kind: PrometheusRule\n/ && doc ~ /\n  name: bretagne-critical\n/) printf "%s", doc
    doc = ""
  }
  /^---$/ { done(); next }
  { doc = doc $0 "\n" }
  END { done() }
' | awk '
  /^spec:$/ { on = 1; next }
  on && /^[^ ]/ { exit }
  on { sub(/^  /, ""); print }
' >"$rules/rules.yaml"
grep -q 'alert: HostGrubConfigUnbootable' "$rules/rules.yaml" || { echo "✖ bretagne-critical not found in the render"; exit 1; }
cp "$here/alerts.test.yaml" "$rules/"
if (cd "$rules" && "$promtool" check rules rules.yaml && "$promtool" test rules alerts.test.yaml); then
  pass "promtool: the HostGrub* alerts"
else
  fail "promtool: the HostGrub* alerts"
fi

exit "$failed"
