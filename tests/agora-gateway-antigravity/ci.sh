# Run by the tests workflow from this folder (tests/README.md): agentgateway 1.6.0 as released, checked against
# its sha256, and Agora's GrantSigner at the commit that brought the `antigravity` profile (agora is public).
set -euo pipefail
agentgateway_sha256=496ed27e6a96b55a9ad7cabe5c2be7172511f44a3cb113e533d22bf93a7f079d
agora_ref=afdf6f694c41c688884abbe4de9f487453ef66e7
dir="${RUNNER_TEMP:-$(mktemp -d)}/antigravity"
mkdir -p "$dir"
curl -fsSL --retry 5 -o "$dir/agentgateway" \
  https://github.com/agentgateway/agentgateway/releases/download/v1.6.0/agentgateway-linux-amd64
echo "$agentgateway_sha256  $dir/agentgateway" | sha256sum -c -
chmod +x "$dir/agentgateway"
git init -q "$dir/agora"
git -C "$dir/agora" fetch -q --depth 1 https://github.com/arnaultbretagne/agora.git "$agora_ref"
git -C "$dir/agora" checkout -q FETCH_HEAD -- packages/credentials/src
npm ci --no-audit --no-fund
# The run's ✔/✖/ℹ lines go to the summary; the failures, and the ℹ lines the tests print, are also annotations,
# which GitHub's API reads back without the logs.
status=0
AGENTGATEWAY="$dir/agentgateway" AGORA_GRANTS="$dir/agora/packages/credentials/src/grants.ts" npm test 2>&1 | tee "$dir/out.txt" || status=$?
node -e '
const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n")
const esc = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")
const info = lines.filter((l) => /^\s*ℹ (?!tests|suites|pass|fail|cancelled|skipped|todo|duration)/.test(l))
if (info.length) console.log("::notice title=antigravity::" + esc(info.join("\n")))
if (process.argv[2] !== "0") console.log("::error title=antigravity tests::" + esc(lines.filter((l) => l.trim()).slice(-80).join("\n")))
' "$dir/out.txt" "$status"
exit "$status"
