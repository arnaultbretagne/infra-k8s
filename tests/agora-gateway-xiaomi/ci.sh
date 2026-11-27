# Run by the tests workflow from this folder (tests/README.md): agentgateway 1.6.0 as released, checked against
# its sha256. The tokens are signed by the test itself (xiaomi-route.test.mjs): nothing of Agora's is fetched.
set -euo pipefail
agentgateway_sha256=496ed27e6a96b55a9ad7cabe5c2be7172511f44a3cb113e533d22bf93a7f079d
dir="${RUNNER_TEMP:-$(mktemp -d)}/xiaomi"
mkdir -p "$dir"
curl -fsSL --retry 5 -o "$dir/agentgateway" \
  https://github.com/agentgateway/agentgateway/releases/download/v1.6.0/agentgateway-linux-amd64
echo "$agentgateway_sha256  $dir/agentgateway" | sha256sum -c -
chmod +x "$dir/agentgateway"
npm ci --no-audit --no-fund
# The run's ✔/✖/ℹ lines go to the summary; the failures are also annotations, which GitHub's API reads back
# without the logs.
status=0
AGENTGATEWAY="$dir/agentgateway" npm test 2>&1 | tee "$dir/out.txt" || status=$?
node -e '
const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n")
const esc = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")
if (process.argv[2] !== "0") console.log("::error title=xiaomi tests::" + esc(lines.filter((l) => l.trim()).slice(-80).join("\n")))
' "$dir/out.txt" "$status"
exit "$status"
