#!/usr/bin/env bash
# The speech bricks, end to end, on a kind cluster where apps/speech is applied (see
# .github/workflows/speech-e2e.yml). Every request leaves the pod `client` in namespace speech-playground,
# through the Services stt and tts on port 80, as the playground will. Writes a Markdown report to $REPORT.
set -uo pipefail

FIXTURE=fr-mls-1406_1028_000000.opus
# The clip says: « pendant le second siècle je fis serment d'ouvrir tous les trésors de la terre à
# quiconque me mettrait en liberté mais je ne fus pas plus heureux dans le troisième je promis de faire
# puissant monarque mon libérateur d'être toujours près de lui en esprit » (README.md).
EXPECTED_WORDS=(siècle serment trésors terre liberté troisième monarque libérateur)
STT_MODELS=(parakeet-tdt-0.6b-v3 whisper-large-v3-turbo)
TTS_MODEL=kokoro
TTS_VOICE=ff_siwis
TTS_TEXT="Bonjour, je suis la voix française du cluster. Il fait beau aujourd'hui à Rennes."

REPORT=${REPORT:-/dev/stdout}
FAILURES=0
pass() { echo "PASS $*"; echo "- ✅ $*" >> "$REPORT"; }
fail() { echo "FAIL $*"; echo "- ❌ $*" >> "$REPORT"; FAILURES=$((FAILURES + 1)); }
in_client() { kubectl -n "${CLIENT_NS:-speech-playground}" exec client -- "$@"; }

# One transcription; prints the text, fails when the request fails or a word is missing.
stt_test() {
  local model=$1 out
  out=$(in_client curl -sS --fail-with-body --max-time 900 \
    -F "file=@/fixtures/$FIXTURE" -F "model=$model" -F language=fr -F response_format=json \
    http://stt.speech.svc.cluster.local/v1/audio/transcriptions) || { echo "  request failed: $out"; return 1; }
  local text
  text=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).text)' "$out") || { echo "  not JSON: $out"; return 1; }
  echo "  $model: $text"
  local lower missing=()
  lower=$(node -e 'process.stdout.write(process.argv[1].toLowerCase())' "$text")
  for w in "${EXPECTED_WORDS[@]}"; do [[ $lower == *"$w"* ]] || missing+=("$w"); done
  if ((${#missing[@]})); then echo "  missing words: ${missing[*]}"; return 1; fi
  LAST_TEXT=$text
}

# One synthesis as WAV; fails when the request fails or the body is not a non-empty RIFF/WAVE.
tts_test() {
  local body
  body=$(node -e 'process.stdout.write(JSON.stringify({model:process.argv[1],voice:process.argv[2],input:process.argv[3],response_format:"wav"}))' \
    "$TTS_MODEL" "$TTS_VOICE" "$TTS_TEXT")
  in_client curl -sS --fail-with-body --max-time 300 -H 'content-type: application/json' -d "$body" \
    -o /tmp/speech.wav http://tts.speech.svc.cluster.local/v1/audio/speech || return 1
  local head size
  head=$(in_client head -c 12 /tmp/speech.wav | od -An -c | tr -d ' \n')
  size=$(in_client stat -c %s /tmp/speech.wav)
  echo "  tts: $size bytes, header $head"
  [[ $head == RIFF*WAVE ]] && ((size > 44 + 24000)) || return 1 # header + at least half a second of audio
  LAST_SIZE=$size
}

# The memory of a brick's container, from its cgroup: working set (current − inactive file, what the
# kubelet evicts and OOM-kills on) and the peak since start.
memory() {
  local pod
  pod=$(kubectl -n speech get pod -l app="$1" -o jsonpath='{.items[0].metadata.name}')
  kubectl -n speech exec "$pod" -- sh -c '
    cur=$(cat /sys/fs/cgroup/memory.current); peak=$(cat /sys/fs/cgroup/memory.peak 2>/dev/null || echo 0)
    inact=$(awk "/^inactive_file /{print \$2}" /sys/fs/cgroup/memory.stat)
    echo "$(( (cur - inact) / 1048576 )) $(( peak / 1048576 ))"'
}

scale() { # app replicas
  kubectl -n speech scale deploy/"$1" --replicas="$2"
  if (($2 == 0)); then
    kubectl -n speech wait --for=delete pod -l app="$1" --timeout=300s
  else
    kubectl -n speech rollout status deploy/"$1" --timeout=1800s
  fi
}

expect() { # pass|fail description command...
  local want=$1 what=$2; shift 2
  if "$@"; then got=pass; else got=fail; fi
  if [[ $got == "$want" ]]; then pass "$what (expected $want)"; else fail "$what (expected $want, got $got)"; fi
}

{
  echo "### Speech e2e"
  echo
  echo "**Both bricks up**"
} >> "$REPORT"
for m in "${STT_MODELS[@]}"; do
  LAST_TEXT=
  expect pass "STT $m transcribes the French clip with every expected word" stt_test "$m"
  [[ -n $LAST_TEXT ]] && echo "  - \`$m\`: « $LAST_TEXT »" >> "$REPORT"
done
LAST_SIZE=
expect pass "TTS $TTS_MODEL/$TTS_VOICE returns a WAV for a French sentence" tts_test
[[ -n $LAST_SIZE ]] && echo "  - WAV of $LAST_SIZE bytes" >> "$REPORT"
kubectl cp speech-playground/client:/tmp/speech.wav "${ARTIFACTS:-/tmp}/tts-ff_siwis.wav" >/dev/null 2>&1 || true

{
  echo
  echo "**Memory once the models are loaded** (cgroup of the container, after one request per model)"
  echo
  echo "| Brick | Working set | Peak since start |"
  echo "|---|---|---|"
} >> "$REPORT"
for app in stt tts; do
  read -r ws peak < <(memory "$app")
  echo "memory $app: working set ${ws}Mi, peak ${peak}Mi"
  echo "| $app | ${ws} MiB | ${peak} MiB |" >> "$REPORT"
done

echo -e "\n**Network policy** (each refusal beside its control: the outsider client, under no policy, reaches the same target)" >> "$REPORT"
outsider() { kubectl -n speech-outsider exec client -- curl -sSk --max-time 10 -o /dev/null "$1"; }
STT_POD=$(kubectl -n speech get pod -l app=stt -o jsonpath='{.items[0].metadata.name}')
from_stt() { kubectl -n speech exec "$STT_POD" -- python -c "import socket,sys; socket.create_connection((sys.argv[1], int(sys.argv[2])), 10)" "$@"; }
expect pass "control: the outsider connects to example.com:443" outsider https://example.com
expect fail "a client outside speech-playground reaches stt" outsider http://stt.speech.svc.cluster.local/health
expect pass "stt connects to huggingface.co:443" from_stt huggingface.co 443
expect pass "control: the outsider connects to huggingface.co:80" outsider http://huggingface.co
expect fail "stt connects to huggingface.co:80 (a port not named)" from_stt huggingface.co 80
expect fail "stt connects to example.com:443 (a host not named)" from_stt example.com 443
expect pass "control: the outsider connects to the kube-apiserver" outsider https://kubernetes.default.svc.cluster.local/version
expect fail "stt connects to the kube-apiserver" from_stt kubernetes.default.svc.cluster.local 443
expect pass "control: the outsider reaches source-controller in flux-system" outsider http://source-controller.flux-system.svc.cluster.local/
expect fail "stt connects to source-controller in flux-system" from_stt source-controller.flux-system.svc.cluster.local 80

echo -e "\n**TTS at 0 replicas**" >> "$REPORT"
scale tts 0
for m in "${STT_MODELS[@]}"; do expect pass "STT $m" stt_test "$m"; done
expect fail "TTS" tts_test

echo -e "\n**STT at 0 replicas**" >> "$REPORT"
scale tts 1
scale stt 0
for m in "${STT_MODELS[@]}"; do expect fail "STT $m" stt_test "$m"; done
expect pass "TTS" tts_test

echo
echo "$FAILURES failure(s)"
exit "$FAILURES"
