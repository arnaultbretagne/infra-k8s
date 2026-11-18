// Criterion 6(b), replayable: the playground's API on a preview, with the preview's own speech bricks.
//
//   node tests/speech-playground/preview-check.mjs              # BASE defaults to PR 371's preview
//   BASE=https://pr-<n>-speech-playground.preview.bretagne.dev node tests/speech-playground/preview-check.mjs
//
// The preview is behind its gate (Pocket-ID, admin; or the gateway gate, for an execution with the previews
// profile): run it from where the gate lets you through. Node 18+, no dependency. Exit code: the failures.
//
// 1. GET  /api/services  cluster-stt and cluster-tts available; xiaomi-mimo unavailable (no Secret in a preview).
// 2. POST /api/stt       tests/speech/fixtures/fr-mls-1406_1028_000000.opus (French, Multilingual LibriSpeech,
//                        CC BY 4.0), language fr, with parakeet-tdt-0.6b-v3 then whisper-large-v3-turbo: 200, and
//                        the text holds every word of tests/speech/expected-words.txt.
// 3. POST /api/tts       Kokoro, ff_siwis, a French sentence: 200, audio/mpeg, an MP3 of a few kB at least.
// 4. POST /api/tts       xiaomi-mimo: 503, unavailable.
//
// A model loads on its first request. The preview's gate waits 30 s for the response's headers (oauth2-proxy's
// default), and the playground answers an STT request only once the transcription is done: a first request
// that meets that wait (502 or 504 from the gate) is sent once more.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = (process.env.BASE ?? 'https://pr-371-speech-playground.preview.bretagne.dev').replace(/\/$/, '')
const SPEECH = join(dirname(fileURLToPath(import.meta.url)), '../speech')
const FIXTURE = join(SPEECH, 'fixtures/fr-mls-1406_1028_000000.opus')
const WORDS = readFileSync(join(SPEECH, 'expected-words.txt'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
const TEXT = "Bonjour, ceci est la voix française du playground. Il fait beau aujourd'hui à Rennes."

let failures = 0
const report = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures++ }

async function send(path, init) {
  for (let attempt = 1; ; attempt++) {
    const started = Date.now()
    const r = await fetch(BASE + path, { ...init, redirect: 'manual', signal: AbortSignal.timeout(300000) })
    const body = Buffer.from(await r.arrayBuffer())
    if ((r.status === 502 || r.status === 504) && attempt === 1 && !r.headers.get('content-type')?.includes('json')) {
      console.log(`  (${path}: ${r.status} from the gate after ${Date.now() - started} ms, once more)`)
      continue
    }
    return { status: r.status, type: r.headers.get('content-type') ?? '', timing: r.headers.get('server-timing') ?? '', body, ms: Date.now() - started }
  }
}
const json = (r) => { try { return JSON.parse(r.body.toString('utf8')) } catch { return null } }

// 1. The services.
const list = await send('/api/services')
const services = json(list)?.services ?? []
const by = (id) => services.find((s) => s.id === id)
report(list.status === 200 && by('cluster-stt')?.available === true && by('cluster-tts')?.available === true,
  `GET /api/services: ${list.status}, cluster-stt ${by('cluster-stt')?.available}, cluster-tts ${by('cluster-tts')?.available}`)
report(by('xiaomi-mimo')?.available === false, `xiaomi-mimo unavailable: ${by('xiaomi-mimo')?.available} (${by('xiaomi-mimo')?.reason})`)
if (list.status !== 200) console.log(`  ${list.body.toString().slice(0, 300)}`)

// 2. STT, each model.
for (const model of ['parakeet-tdt-0.6b-v3', 'whisper-large-v3-turbo']) {
  const form = new FormData()
  form.append('service', 'cluster-stt')
  form.append('model', model)
  form.append('language', 'fr')
  form.append('file', new Blob([readFileSync(FIXTURE)], { type: 'audio/ogg' }), 'fr-mls-1406_1028_000000.opus')
  const r = await send('/api/stt', { method: 'POST', body: form })
  const body = json(r)
  const text = body?.text ?? ''
  const missing = WORDS.filter((w) => !text.toLowerCase().includes(w))
  report(r.status === 200 && missing.length === 0,
    `POST /api/stt ${model}: ${r.status} in ${r.ms} ms (service ${body?.upstream?.ms} ms): « ${text.trim() || r.body.toString().slice(0, 300)} »` +
      (missing.length ? ` — missing: ${missing.join(', ')}` : ''))
}

// 3. TTS, Kokoro with ff_siwis.
const tts = await send('/api/tts', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ service: 'cluster-tts', model: 'kokoro', voice: 'ff_siwis', input: TEXT }),
})
const mp3 = tts.body.subarray(0, 3).toString() === 'ID3' || (tts.body[0] === 0xff && (tts.body[1] & 0xe0) === 0xe0)
report(tts.status === 200 && tts.type === 'audio/mpeg' && mp3 && tts.body.length > 4000,
  `POST /api/tts kokoro/ff_siwis: ${tts.status} ${tts.type}, ${tts.body.length} bytes, ${mp3 ? 'MP3' : 'not MP3'}, in ${tts.ms} ms, ${tts.timing}`)

// 4. Xiaomi, refused: no key in a preview.
const mimo = await send('/api/tts', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ service: 'xiaomi-mimo', model: 'mimo-v2.5-tts', voice: 'mimo_default', input: TEXT }),
})
report(mimo.status === 503, `POST /api/tts xiaomi-mimo: ${mimo.status} ${mimo.body.toString().slice(0, 200)}`)

process.exit(failures)
