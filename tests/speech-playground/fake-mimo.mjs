// A stand-in for Xiaomi MiMo's TTS: POST /v1/chat/completions, which answers only the key it was given
// (MIMO_EXPECTED_KEY) in the api-key header, as the real API answers 401 "Invalid API Key" otherwise.
// The audio is fakeMimoAudio's, base64 in choices[0].message.audio.data. A text containing ECHO-KEY gets a 400
// that echoes the api-key header back: what the playground must never relay. A text containing SLOW is answered
// only once POST /_release comes, so that a test can rotate the key while the request is in flight.
// GET /_received lists the requests it got, headers included. Serves when FAKE_SERVE=1; the test imports it for
// fakeMimoAudio.
import { createServer } from 'node:http'

export const fakeMimoAudio = ({ model, messages, audio }) =>
  Buffer.from(`FAKE-MIMO|${model}|${audio.voice}|${audio.format}|${messages.find((m) => m.role === 'assistant')?.content}`, 'utf8')

if (process.env.FAKE_SERVE === "1") {
  const expected = process.env.MIMO_EXPECTED_KEY
  const received = []
  const held = [] // the answers of SLOW requests, waiting for POST /_release
  createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.method === 'GET' && req.url === '/healthz') return json(200, { ok: true })
    if (req.method === 'GET' && req.url === '/_received') return json(200, received)
    if (req.method === 'POST' && req.url === '/_release') { const n = held.length; held.splice(0).forEach((go) => go()); return json(200, { released: n }) }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      received.push({ path: req.url, headers: req.headers, body })
      if (!expected || req.headers['api-key'] !== expected) {
        return json(401, { error: { message: 'Invalid API Key', param: 'Please provide valid API Key', code: '401', type: 'invalid_key' } })
      }
      const text = body.messages?.find((m) => m.role === 'assistant')?.content ?? ''
      if (text.includes('SLOW')) await new Promise((go) => held.push(go))
      if (text.includes('ECHO-KEY')) return json(400, { error: { message: `bad request for key ${req.headers['api-key']}` } })
      return json(200, {
        id: 'fake', object: 'chat.completion', model: body.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '', audio: { id: 'a', data: fakeMimoAudio(body).toString('base64') } } }],
      })
    }
    json(404, { error: 'not found' })
  }).listen(Number(process.env.PORT || 8080), () => console.log('fake-mimo up'))
}
