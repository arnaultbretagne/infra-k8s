# Run by the tests workflow from this folder (tests/README.md): promtool as tested, checked against its sha256.
set -euo pipefail
version=3.7.3
sha256=fc9e5da126817438cf2820d9a7206c75e3122802ba8d20add3a6219a59ca6913
dir="${RUNNER_TEMP:-$(mktemp -d)}/promtool"
mkdir -p "$dir"
curl -fsSL --retry 5 -o "$dir/prometheus.tar.gz" \
  "https://github.com/prometheus/prometheus/releases/download/v$version/prometheus-$version.linux-amd64.tar.gz"
echo "$sha256  $dir/prometheus.tar.gz" | sha256sum -c -
tar -xzf "$dir/prometheus.tar.gz" -C "$dir" --strip-components=1 "prometheus-$version.linux-amd64/promtool"
PROMTOOL="$dir/promtool" node run.mjs
