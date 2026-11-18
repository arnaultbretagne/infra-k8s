// The playground, running (TARGET=kind or local, targets.mjs), against the two fakes: STT and TTS requests passed
// through it come back as the fakes answered them; the fake Xiaomi gets the test key; no answer sent to the browser
// (API or page, success or error, headers included) holds the key; without the key the playground runs and lists
// Xiaomi as unavailable. On kind, also: the Pods are admitted by PSS restricted, the Secret is seen without a
// restart, the reconciler may write the oauth2-proxy's Secret and nothing else, and the oauth2-proxy turns away an
// unauthenticated request to the IdP.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start, kubectl } from './targets.mjs'
import { fakeTranscript, fakeSpeech } from './fake-openai.mjs'
import { fakeMimoAudio } from './fake-mimo.mjs'
import { drivePage } from './browser.mjs'

const KEY = `test-mimo-key-${randomBytes(12).toString('hex')}`
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
const CONFIG = JSON.parse(readFileSync(new URL("../../apps/speech-playground/services.json", import.meta.url), "utf8"))
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

test('with the Secret, Xiaomi becomes available, without a restart', { timeout: 240000 }, async () => {
  const pod = t.name === 'kind' ? kubectl('-n', 'speech-playground', 'get', 'pods', '-l', 'app=speech-playground', '-o', 'jsonpath={.items[*].metadata.name} {.items[*].status.containerStatuses[0].restartCount}') : null
  await t.setKey()
  const end = Date.now() + 200000
  while (!(await services()).find((s) => s.id === 'xiaomi-mimo').available) {
    assert.ok(Date.now() < end, 'Xiaomi still unavailable 200 s after its Secret')
    await sleep(2000)
  }
  if (pod) {
    assert.equal(kubectl('-n', 'speech-playground', 'get', 'pods', '-l', 'app=speech-playground', '-o', 'jsonpath={.items[*].metadata.name} {.items[*].status.containerStatuses[0].restartCount}'), pod)
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

test('the page: STT from the microphone and from a file, TTS from both services, with their timings', { timeout: 180000 }, async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'speech-audio-')), 'tone.wav')
  writeFileSync(file, AUDIO)
  const asks = [
    { service: 'cluster-tts', model: 'kokoro', voice: 'ff_siwis', input: 'Salut depuis la page' },
    { service: 'xiaomi-mimo', model: 'mimo-v2.5-tts', voice: 'Milo', input: 'Hello from the page' },
  ]
  const { shown, answers } = await drivePage(t.base, { audioFile: file, tts: asks })
  for (const a of answers) seen.push({ what: `page ${a.url}`, status: a.status, headers: a.headers, body: a.body })
  assert.deepEqual(shown.errors, [])

  assert.match(shown.micInput, /^micro\.wav/)
  assert.match(shown.micText, new RegExp(`^fake transcript by ${STT_MODELS[0].replace(/\./g, '\\.')} of \\d+ bytes`))
  assert.match(shown.micMetrics, /Durée de la requête : \d+ ms/)
  assert.equal(shown.fileText, fakeTranscript(STT_MODELS[1], AUDIO))
  assert.match(shown.fileMetrics, /Durée de la requête : \d+ ms/)

  const ttsAnswers = answers.filter((a) => a.url.endsWith('/api/tts'))
  assert.equal(ttsAnswers.length, 2)
  assert.deepEqual(ttsAnswers[0].body, fakeSpeech({ ...asks[0], response_format: 'mp3' }))
  assert.deepEqual(ttsAnswers[1].body, fakeMimoAudio({ model: asks[1].model, messages: [{ role: 'assistant', content: asks[1].input }], audio: { format: 'wav', voice: 'Milo' } }))
  for (const s of shown.tts) {
    assert.match(s.metrics, /^Premier octet : \d+ ms · Durée totale : \d+ ms$/)
    assert.equal(s.error, '')
    assert.match(s.audioSrc, /^blob:/)
  }
  assert.equal(shown.history.length, 4)
})

test('no answer sent to the browser holds the key', async () => {
  for (const path of ['/', '/app.js', '/api/services', '/healthz', '/nope']) await call(path)
  const forms = [KEY, Buffer.from(KEY).toString('base64'), Buffer.from(KEY).toString('base64url'), Buffer.from(KEY).toString('hex')]
  assert.ok(seen.length >= 20, `${seen.length} answers checked`)
  const leaks = seen.filter((a) => forms.some((f) => a.body.includes(f) || JSON.stringify(a.headers).includes(f))).map((a) => `${a.what} (${a.status})`)
  assert.deepEqual(leaks, [])
  assert.ok(!(await t.logs()).includes(KEY), 'nor do its logs')
  console.log(`ℹ ${seen.length} answers checked, none holds the key`)
})

test('kind: the Pods run under PSS restricted', { skip: process.env.TARGET !== 'kind' }, () => {
  assert.equal(kubectl('get', 'ns', 'speech-playground', '-o', 'jsonpath={.metadata.labels.pod-security\\.kubernetes\\.io/enforce}'), 'restricted')
  const phases = kubectl('-n', 'speech-playground', 'get', 'pods', '-l', 'app=speech-playground', '-o', 'jsonpath={.items[*].status.phase}')
  assert.equal(phases, 'Running')
})

test('kind: the reconciler may write the oauth2-proxy\'s Secret, and no other', { skip: process.env.TARGET !== 'kind' }, () => {
  const can = (...args) => {
    try {
      return kubectl('auth', 'can-i', ...args, '-n', 'speech-playground', '--as=system:serviceaccount:pocket-id:oidc-reconciler').trim()
    } catch (e) {
      return String(e.stdout).trim()
    }
  }
  assert.equal(can('get', 'secret/oauth2-proxy-client'), 'yes')
  assert.equal(can('update', 'secret/oauth2-proxy-client'), 'yes')
  assert.equal(can('get', 'secret/xiaomi-mimo'), 'no')
  assert.equal(can('list', 'secrets'), 'no')
})

test('kind: with the client the reconciler writes, the oauth2-proxy sends an unauthenticated browser to Pocket-ID', { skip: process.env.TARGET !== 'kind', timeout: 300000 }, async () => {
  // What the reconciler does (reconcile.py, ensure_secret): GET the Secret, PUT it back with the client's id and secret.
  const as = '--as=system:serviceaccount:pocket-id:oidc-reconciler'
  const current = JSON.parse(kubectl('-n', 'speech-playground', 'get', 'secret', 'oauth2-proxy-client', '-o', 'json', as))
  const clientId = 'b6a3c0de-0000-4000-8000-000000000001'
  current.data = {
    client_id: Buffer.from(clientId).toString('base64'),
    client_secret: Buffer.from(randomBytes(16).toString('hex')).toString('base64'),
    secret_id: Buffer.from('s-1').toString('base64'),
  }
  const file = join(mkdtempSync(join(tmpdir(), 'secret-')), 'secret.json')
  writeFileSync(file, JSON.stringify(current))
  kubectl('replace', '-f', file, as)
  // Until then it had no client id and restarted; delete the Pod rather than wait out its back-off.
  kubectl('-n', 'speech-playground', 'delete', 'pod', '-l', 'app=oauth2-proxy', '--wait=false')
  kubectl('-n', 'speech-playground', 'rollout', 'status', 'deployment/oauth2-proxy', '--timeout=180s')
  kubectl('-n', 'speech-playground', 'wait', 'pod', '-l', 'app=oauth2-proxy', '--for=condition=Ready', '--timeout=120s')
  const proxy = await t.portForward('speech-playground', 'svc/oauth2-proxy', 4180)
  try {
    for (const path of ['/', '/api/services']) {
      const r = await fetch(proxy.url + path, { redirect: 'manual', headers: { accept: 'text/html' } })
      const body = await r.text()
      assert.equal(r.status, 302, `${path}: ${r.status} ${body.slice(0, 200)}`)
      const to = new URL(r.headers.get('location'))
      assert.equal(`${to.origin}${to.pathname}`, 'https://id.bretagne.dev/authorize')
      assert.equal(to.searchParams.get('client_id'), clientId)
      assert.equal(to.searchParams.get('redirect_uri'), 'https://speech.bretagne.dev/oidc/callback')
      assert.match(to.searchParams.get('scope'), /\bgroups\b/)
      assert.ok(!body.includes('Speech playground') && !body.includes('xiaomi'), 'nothing of the playground behind the gate')
    }
  } finally {
    proxy.close()
  }
})
