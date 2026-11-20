// A stand-in for the cluster's model services (stt.speech, tts.speech): OpenAI's
// POST /v1/audio/transcriptions and POST /v1/audio/speech, answering what fakeTranscript and fakeSpeech
// make of the request, so the test knows exactly what the playground must relay. GET /_received lists
// the requests it got. A text containing CUT gets an answer that breaks off after 20 of the 10000 bytes it
// announces. Serves when FAKE_SERVE=1; the test imports it for fakeTranscript and fakeSpeech.
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'

export const fakeTranscript = (model, audio) =>
  `fake transcript by ${model} of ${audio.length} bytes sha256:${createHash('sha256').update(audio).digest('hex').slice(0, 16)}`
export const fakeSpeech = ({ model, voice, input, response_format }) =>
  Buffer.from(`FAKE-SPEECH|${model}|${voice}|${response_format}|${input}`, 'utf8')

if (process.env.FAKE_SERVE === "1") {
  const received = []
  createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.method === 'GET' && req.url === '/healthz') return json(200, { ok: true })
    if (req.method === 'GET' && req.url === '/_received') return json(200, received)
    if (req.method === 'POST' && req.url === '/v1/audio/transcriptions') {
      const form = await new Request('http://fake/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: Readable.toWeb(req), duplex: 'half' }).formData()
      const file = form.get('file')
      const audio = Buffer.from(await file.arrayBuffer())
      received.push({ path: req.url, headers: req.headers, model: form.get('model'), language: form.get('language'), filename: file.name, bytes: audio.length })
      return json(200, { text: fakeTranscript(form.get('model'), audio) })
    }
    if (req.method === 'POST' && req.url === '/v1/audio/speech') {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      received.push({ path: req.url, headers: req.headers, body })
      if (body.input.includes('CUT')) {
        // Announces 10000 bytes, sends 20, and hangs up: a service that breaks off mid-stream.
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': 10000 })
        res.write(fakeSpeech(body).subarray(0, 20))
        return setTimeout(() => req.socket.destroy(), 50)
      }
      res.writeHead(200, { 'content-type': 'audio/mpeg' })
      return res.end(fakeSpeech(body))
    }
    json(404, { error: 'not found' })
  }).listen(Number(process.env.PORT || 8080), () => console.log('fake-openai up'))
}
