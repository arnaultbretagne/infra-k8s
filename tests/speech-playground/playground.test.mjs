// The playground's API, running locally (targets.mjs), against the two fakes: STT and TTS requests passed through it
// come back as the fakes answered them; the fake Xiaomi gets the test key; no answer sent to the browser (success or
// error, headers included) holds the key, not even the key a request read before it was rotated or removed; a stream
// the service breaks off reaches the browser broken off; without the key the playground runs and lists Xiaomi as
// unavailable. The page itself is page.test.mjs; the live proof, with the real speech bricks, is the preview of the
// pull request (README.md).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { start } from './targets.mjs'
import { fakeTranscript, fakeSpeech } from './fake-openai.mjs'
import { fakeMimoAudio } from './fake-mimo.mjs'

const KEY = `test-mimo-key-${randomBytes(12).toString('hex')}`
const ROTATED = `test-mimo-key-rotated-${randomBytes(12).toString('hex')}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let t
const seen = [] // every answer the playground gave: { what, status, headers, body }

async function call(path, init) {
  const r = await fetch(t.base + path, init)
  const body = Buffer.from(await r.arrayBuffer())
  seen.push({ what: `${init?.method ?? 'GET'} ${path}`, status: r.status, headers: Object.fromEntries(r.headers), body })
  return { status: r.status, headers: r.headers, body, json: () => JSON.parse(body.toString('utf8')) }
}
const tts = (body) => call('/api/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const stt = (fields, audio, name = 'clip.wav') => {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  if (audio) form.append('file', new Blob([audio], { type: 'audio/wav' }), name)
  return call('/api/stt', { method: 'POST', body: form })
}
const received = async (fake) => (await fetch(`${fake}/_received`)).json()
const services = async () => (await call('/api/services')).json().services

// A real 0.2 s WAV, 16 kHz mono, of a 440 Hz tone.
function wav() {
  const n = 3200
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * 12000), 44 + i * 2)
  return b
}
const AUDIO = wav()
const CONFIG = JSON.parse(readFileSync(new URL("../../apps/speech-playground/workload/services.json", import.meta.url), "utf8"))
const STT_MODELS = CONFIG.services.find((s) => s.id === "cluster-stt").models

before(async () => { t = await start(KEY) }, { timeout: 600000 })
after(async () => { await t?.close() })

test('without the Secret, the playground runs and lists Xiaomi as unavailable', async () => {
  const list = await services()
  const mimo = list.find((s) => s.id === 'xiaomi-mimo')
  assert.equal(mimo.available, false)
  assert.match(mimo.reason, /key/)
  assert.ok(list.filter((s) => s.id !== 'xiaomi-mimo').every((s) => s.available))
  const r = await tts({ service: 'xiaomi-mimo', model: 'mimo-v2.5-tts', voice: 'mimo_default', input: 'Bonjour' })
  assert.equal(r.status, 503)
  assert.equal((await received(t.fakeMimo)).length, 0, 'nothing reached the fake Xiaomi')
})

test('STT through the playground: the fake service\'s transcript, for each model', async () => {
  for (const model of STT_MODELS) {
    const r = await stt({ service: 'cluster-stt', model, language: 'fr' }, AUDIO)
    assert.equal(r.status, 200, r.body.toString())
    const body = r.json()
    assert.equal(body.text, fakeTranscript(model, AUDIO))
    assert.equal(typeof body.upstream.ms, 'number')
  }
  const got = (await received(t.fakeOpenai)).filter((x) => x.path === '/v1/audio/transcriptions')
  assert.deepEqual(got.map((x) => [x.model, x.language, x.filename, x.bytes]), STT_MODELS.map((m) => [m, 'fr', 'clip.wav', AUDIO.length]))
})

test('TTS through the playground: the fake service\'s audio, byte for byte', async () => {
  const ask = { service: 'cluster-tts', model: 'kokoro', voice: 'ff_siwis', input: 'Bonjour à tous' }
  const r = await tts(ask)
  assert.equal(r.status, 200, r.body.toString())
  assert.equal(r.headers.get('content-type'), 'audio/mpeg')
  assert.match(r.headers.get('server-timing'), /^upstream;dur=\d+/)
  assert.deepEqual(r.body, fakeSpeech({ model: 'kokoro', voice: 'ff_siwis', input: 'Bonjour à tous', response_format: 'mp3' }))
})

test('what the page may not choose is refused', async () => {
  assert.equal((await tts({ service: 'cluster-tts', model: 'tts-1', voice: 'ff_siwis', input: 'x' })).status, 400)
  assert.equal((await tts({ service: 'cluster-tts', model: 'kokoro', voice: 'alloy', input: 'x' })).status, 400)
  assert.equal((await tts({ service: 'elsewhere', model: 'kokoro', voice: 'ff_siwis', input: 'x' })).status, 404)
  assert.equal((await tts({ service: 'cluster-stt', model: 'kokoro', voice: 'ff_siwis', input: 'x' })).status, 404)
  assert.equal((await stt({ service: 'cluster-stt', model: 'other' }, AUDIO)).status, 400)
  assert.equal((await stt({ service: 'cluster-stt', model: 'parakeet-tdt-0.6b-v3' }, null)).status, 400)
})

test('with the Secret, Xiaomi becomes available, without a restart', { timeout: 60000 }, async () => {
  await t.setKey()
  const end = Date.now() + 30000
  while (!(await services()).find((s) => s.id === 'xiaomi-mimo').available) {
    assert.ok(Date.now() < end, 'Xiaomi still unavailable 30 s after its key')
    await sleep(500)
  }
})

test('Xiaomi TTS through the playground: the fake\'s audio, and the fake got the test key', async () => {
  const r = await tts({ service: 'xiaomi-mimo', model: 'mimo-v2.5-tts', voice: 'Chloe', input: 'Hello there' })
  assert.equal(r.status, 200, r.body.toString())
  assert.equal(r.headers.get('content-type'), 'audio/wav')
  const got = (await received(t.fakeMimo)).at(-1)
  assert.equal(got.headers['api-key'], KEY)
  assert.deepEqual(got.body, {
    model: 'mimo-v2.5-tts',
    messages: [{ role: 'assistant', content: 'Hello there' }],
    audio: { format: 'wav', voice: 'Chloe' },
  })
  assert.deepEqual(r.body, fakeMimoAudio(got.body))
})

test('an upstream error that echoes the key reaches the browser with the key scrubbed', async () => {
  const r = await tts({ service: 'xiaomi-mimo', model: 'mimo-v2.5-tts', voice: 'Mia', input: 'ECHO-KEY please' })
  assert.equal(r.status, 502)
  const body = r.json()
  assert.match(body.upstream.body, /\[redacted\]/)
  assert.equal((await received(t.fakeMimo)).at(-1).headers['api-key'], KEY, 'the fake did get the key, and echoed it')
})

test('a key rotated or removed while a request is in flight is still scrubbed from its answer', { timeout: 30000 }, async () => {
  for (const [what, change] of [['rotated', () => t.setKey(ROTATED)], ['removed', () => t.removeKey()]]) {
    await t.setKey()
    const before = (await received(t.fakeMimo)).length
    // The fake holds its answer (SLOW) until released, then echoes the key it got (ECHO-KEY): the key the request
    // read when it started, which the file no longer holds by then.
    const pending = tts({ service: 'xiaomi-mimo', model: 'mimo-v2.5-tts', voice: 'Mia', input: 'ECHO-KEY SLOW please' })
    while ((await received(t.fakeMimo)).length === before) await sleep(20)
    await change()
    await fetch(`${t.fakeMimo}/_release`, { method: 'POST' })
    const r = await pending
    assert.equal((await received(t.fakeMimo)).at(-1).headers['api-key'], KEY, `${what}: the request carried the key it read first`)
    assert.equal(r.status, 502)
    assert.ok(!r.body.includes(KEY), `${what}: the key of the request in the answer: ${r.body}`)
    assert.match(r.json().upstream.body, /\[redacted\]/, what)
  }
  await t.setKey()
})

test('an audio stream the service breaks off reaches the browser broken off, not as a complete answer', async () => {
  // fake-openai announces 10000 bytes, sends 20 and hangs up.
  const r = await fetch(`${t.base}/api/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ service: 'cluster-tts', model: 'kokoro', voice: 'ff_siwis', input: 'CUT here' }),
  })
  assert.equal(r.status, 200, 'the headers were sent before the service broke off')
  await assert.rejects(r.arrayBuffer(), TypeError, 'reading the answer must fail')
  // The playground still serves the next request.
  assert.equal((await tts({ service: 'cluster-tts', model: 'kokoro', voice: 'ff_siwis', input: 'after the cut' })).status, 200)
})

test('no answer sent to the browser holds the key', async () => {
  for (const path of ['/', '/app.js', '/api/services', '/healthz', '/nope']) await call(path)
  const forms = [KEY, ROTATED].flatMap((k) => [k, Buffer.from(k).toString('base64'), Buffer.from(k).toString('base64url'), Buffer.from(k).toString('hex')])
  assert.ok(seen.length >= 20, `${seen.length} answers checked`)
  const leaks = seen.filter((a) => forms.some((f) => a.body.includes(f) || JSON.stringify(a.headers).includes(f))).map((a) => `${a.what} (${a.status})`)
  assert.deepEqual(leaks, [])
  const logs = await t.logs()
  assert.ok(![KEY, ROTATED].some((k) => logs.includes(k)), 'nor do its logs')
  console.log(`ℹ ${seen.length} answers checked, none holds the key`)
})
