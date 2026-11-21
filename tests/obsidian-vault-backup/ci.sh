# Run by the tests workflow from this folder (tests/README.md): the test, then the same test once per part of
# the script broken on purpose, each of which must fail.
set -euo pipefail
npm ci --no-audit --no-fund
npm test

summary=${GITHUB_STEP_SUMMARY:-/dev/null}
echo '### Broken on purpose: each run must fail' >> "$summary"
for mutate in exclude backup-dir cryptcheck retention silent budget; do
  out=$(mktemp)
  if MUTATE=$mutate npm test > "$out" 2>&1; then
    echo "::error::the test passed with MUTATE=$mutate"
    cat "$out"
    exit 1
  fi
  echo "MUTATE=$mutate: failed, as it must:"
  grep -E '^✖' "$out" | sort -u
  { echo "- \`MUTATE=$mutate\`: failed, as it must:"; echo '```'; grep -E '^✖' "$out" | sort -u; echo '```'; } >> "$summary"
done
