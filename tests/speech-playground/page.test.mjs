// The page itself, in headless Chromium (browser.mjs), on the playground running locally beside the two fakes
// (targets.mjs): STT from the microphone (Chromium's fake device) and from a file, TTS from both services with their
// timings, a TTS whose service breaks off shown as an error and kept out of the history, and no answer the page got
// holding the key. Needs Playwright's Chromium: npx playwright install --with-deps chromium (README.md).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from './targets.mjs'
import { fakeTranscript, fakeSpeech } from './fake-openai.mjs'
import { fakeMimoAudio } from './fake-mimo.mjs'
import { drivePage } from './browser.mjs'

const KEY = `test-mimo-key-${randomBytes(12).toString('hex')}`
const CONFIG = JSON.parse(readFileSync(new URL('../../apps/speech-playground/workload/services.json', import.meta.url), 'utf8'))
const STT_MODELS = CONFIG.services.find((s) => s.id === 'cluster-stt').models
let t

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

before(async () => {
  t = await start(KEY)
  await t.setKey()
})
after(async () => { await t?.close() })

test('the page: STT from the microphone and from a file, TTS from both services with their timings, a cut TTS as an error', { timeout: 180000 }, async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'speech-audio-')), 'tone.wav')
  writeFileSync(file, AUDIO)
  const asks = [
    { service: 'cluster-tts', model: 'kokoro', voice: 'ff_siwis', input: 'Salut depuis la page' },
    { service: 'xiaomi-mimo', model: 'mimo-v2.5-tts', voice: 'Milo', input: 'Hello from the page' },
    // fake-openai breaks off after 20 of the 10000 bytes it announces.
    { service: 'cluster-tts', model: 'kokoro', voice: 'ff_siwis', input: 'CUT from the page' },
  ]
  const { shown, answers } = await drivePage(t.base, { audioFile: file, tts: asks })
  assert.deepEqual(shown.errors, [])

  assert.match(shown.micInput, /^micro\.wav/)
  assert.match(shown.micText, new RegExp(`^fake transcript by ${STT_MODELS[0].replace(/\./g, '\\.')} of \\d+ bytes`))
  assert.match(shown.micMetrics, /Durée de la requête : \d+ ms/)
  assert.equal(shown.fileText, fakeTranscript(STT_MODELS[1], AUDIO))
  assert.match(shown.fileMetrics, /Durée de la requête : \d+ ms/)

  const ttsAnswers = answers.filter((a) => a.url.endsWith('/api/tts'))
  assert.deepEqual(ttsAnswers[0].body, fakeSpeech({ ...asks[0], response_format: 'mp3' }))
  assert.deepEqual(ttsAnswers[1].body, fakeMimoAudio({ model: asks[1].model, messages: [{ role: 'assistant', content: asks[1].input }], audio: { format: 'wav', voice: 'Milo' } }))
  for (const s of shown.tts.slice(0, 2)) {
    assert.match(s.metrics, /^Premier octet : \d+ ms · Durée totale : \d+ ms$/)
    assert.equal(s.error, '')
    assert.match(s.audioSrc, /^blob:/)
    assert.equal(s.audioHidden, false)
  }
  const cut = shown.tts[2]
  assert.match(cut.error, /^Réponse interrompue : /, 'the cut answer is shown as an error')
  assert.equal(cut.metrics, '', 'no timings for it')
  assert.equal(cut.audioHidden, true, 'no audio for it')
  // Two STT and two TTS: the cut synthesis is not in the history.
  assert.equal(shown.history.length, 4)

  const forms = [KEY, Buffer.from(KEY).toString('base64'), Buffer.from(KEY).toString('base64url'), Buffer.from(KEY).toString('hex')]
  const leaks = answers.filter((a) => forms.some((f) => a.body.includes(f) || JSON.stringify(a.headers).includes(f))).map((a) => a.url)
  assert.deepEqual(leaks, [], 'no answer the page got holds the key')
  console.log(`ℹ ${answers.length} answers the page got, none holds the key`)
})
