// The speech bricks, end to end: each STT model transcribes the French fixture and must return every word of
// expected-words.txt; the TTS (Kokoro, ff_siwis) must return a non-empty WAV for a French sentence.
//
//   STT_URL=http://stt TTS_URL=http://tts node tests/speech/check.mjs      # from a pod beside the bricks
//
// STT_URL / TTS_URL default to the production Services (from namespace speech-playground). ONLY=stt or
// ONLY=tts runs one brick. Exit code: the number of failed checks. Node 18+, no dependency.
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const STT_URL = process.env.STT_URL ?? 'http://stt.speech.svc.cluster.local';
const TTS_URL = process.env.TTS_URL ?? 'http://tts.speech.svc.cluster.local';
const FIXTURE = path.join(here, 'fixtures/fr-mls-1406_1028_000000.opus');
const WORDS = fs.readFileSync(path.join(here, 'expected-words.txt'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const STT_MODELS = ['parakeet-tdt-0.6b-v3', 'whisper-large-v3-turbo'];
const TEXT = "Bonjour, je suis la voix française du cluster. Il fait beau aujourd'hui à Rennes.";

let failures = 0;
const report = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failures++; };

async function stt(model) {
  const form = new FormData();
  form.set('file', new Blob([fs.readFileSync(FIXTURE)], { type: 'audio/ogg' }), path.basename(FIXTURE));
  form.set('model', model);
  form.set('language', 'fr');
  form.set('response_format', 'json');
  const t0 = Date.now();
  const res = await fetch(`${STT_URL}/v1/audio/transcriptions`, { method: 'POST', body: form, signal: AbortSignal.timeout(900_000) });
  const body = await res.text();
  if (!res.ok) return report(false, `STT ${model}: HTTP ${res.status} ${body.slice(0, 300)}`);
  const text = JSON.parse(body).text;
  const missing = WORDS.filter((w) => !text.toLowerCase().includes(w));
  report(missing.length === 0, `STT ${model} (${((Date.now() - t0) / 1000).toFixed(1)} s): « ${text.trim()} »${missing.length ? ` — missing: ${missing.join(', ')}` : ''}`);
}

async function tts() {
  const t0 = Date.now();
  const res = await fetch(`${TTS_URL}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'kokoro', voice: 'ff_siwis', input: TEXT, response_format: 'wav' }),
    signal: AbortSignal.timeout(300_000),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok) return report(false, `TTS kokoro/ff_siwis: HTTP ${res.status} ${buf.toString().slice(0, 300)}`);
  const wav = buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WAVE';
  report(wav && buf.length > 44 + 24000, `TTS kokoro/ff_siwis (${((Date.now() - t0) / 1000).toFixed(1)} s): ${buf.length} bytes, ${wav ? 'RIFF/WAVE' : 'not a WAV'}`);
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, buf);
}

const only = process.env.ONLY;
for (const fn of [
  ...(only === 'tts' ? [] : STT_MODELS.map((m) => () => stt(m))),
  ...(only === 'stt' ? [] : [tts]),
]) {
  try { await fn(); } catch (e) { report(false, String(e)); }
}
console.log(`${failures} failure(s)`);
process.exit(failures);
